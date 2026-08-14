import type { TurnResolution } from '@dnd/contracts';
import { turnResolutionSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { WorldFactRepository } from '../world/WorldFactRepository.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';

const MAX_SCHEMA_ISSUES = 20;
const MAX_SCHEMA_PATH_SEGMENTS = 12;
const MAX_SCHEMA_PATH_STRING_LENGTH = 64;

export interface AiOutputValidationDiagnostic {
  kind: 'turn_resolution_schema_validation' | 'turn_resolution_domain_validation';
  issues: Array<{ path: Array<string | number>; code: string }>;
  truncated: boolean;
}

/**
 * AI 输出校验专用受控错误：只携带有界的 path/code，不保留 rejected value、issue message
 * 或 Provider 原文。AiResolutionService 仅把 diagnostic 写入 Owner-only rawDebug。
 */
export class AiOutputValidationError extends AppError {
  readonly diagnostic: AiOutputValidationDiagnostic;

  constructor(diagnostic: AiOutputValidationDiagnostic) {
    super('AI_OUTPUT_INVALID', 'AI 输出不符合结构化结算契约。');
    this.diagnostic = diagnostic;
  }
}

function projectSchemaIssues(issues: ReadonlyArray<{ code: string; path: ReadonlyArray<PropertyKey> }>): AiOutputValidationDiagnostic {
  const selected = issues.slice(0, MAX_SCHEMA_ISSUES);
  let truncated = issues.length > MAX_SCHEMA_ISSUES;
  const projected = selected.map((issue) => {
    if (issue.path.length > MAX_SCHEMA_PATH_SEGMENTS) truncated = true;
    const path = issue.path.slice(0, MAX_SCHEMA_PATH_SEGMENTS).map((segment) => {
      if (typeof segment === 'number') return segment;
      const text = typeof segment === 'string' ? segment : String(segment);
      if (text.length > MAX_SCHEMA_PATH_STRING_LENGTH) truncated = true;
      return text.slice(0, MAX_SCHEMA_PATH_STRING_LENGTH);
    });
    return { path, code: issue.code };
  });
  return { kind: 'turn_resolution_schema_validation', issues: projected, truncated };
}

function domainValidationError(path: Array<string | number>, code: string): AiOutputValidationError {
  return new AiOutputValidationError({
    kind: 'turn_resolution_domain_validation',
    issues: [{ path, code }],
    truncated: false,
  });
}

export class TurnResolutionValidator {
  constructor(private readonly executor: QueryExecutor) {}

  async validate(campaignId: string, output: unknown): Promise<TurnResolution> {
    const parsed = turnResolutionSchema.safeParse(output);
    if (!parsed.success) {
      throw new AiOutputValidationError(projectSchemaIssues(parsed.error.issues));
    }
    const resolution = parsed.data;
    const memberIds = new Set(
      (await this.executor.query<{ user_id: string }>(
        "SELECT user_id FROM campaign_members WHERE campaign_id = ? AND role = 'player'", [campaignId],
      )).map((row) => row.user_id),
    );
    // 在 SQL 之前拒绝重复 id：diceResults / interactionRequests 的 id 必须是唯一条目身份，
    // 重复会让条目身份不唯一，映射 AI_OUTPUT_INVALID，绝不能把 DB 唯一约束错误误报为 AI_PROVIDER_FAILED。
    const diceIds = resolution.diceResults.map((d) => d.id);
    if (new Set(diceIds).size !== diceIds.length) {
      throw domainValidationError(['diceResults'], 'duplicate_id');
    }
    const interactionIds = resolution.interactionRequests.map((i) => i.id);
    if (new Set(interactionIds).size !== interactionIds.length) {
      throw domainValidationError(['interactionRequests'], 'duplicate_id');
    }
    // 一次性最多发起一个遭遇：同战役未完成遭遇不变量由 formal apply 内的 STATE_CONFLICT 保证，
    // 但同一次结算请求多个新遭遇无论如何都违反该语义 → 直接拒绝。
    if (resolution.encounterStarts.length > 1) {
      throw domainValidationError(['encounterStarts'], 'too_many_items');
    }
    for (const [index, update] of resolution.privateUpdates.entries()) {
      if (!memberIds.has(update.playerId)) {
        throw domainValidationError(['privateUpdates', index, 'playerId'], 'not_campaign_member');
      }
    }
    for (const [index, dice] of resolution.diceResults.entries()) {
      if (dice.visibility === 'player_private' && dice.targetPlayerId && !memberIds.has(dice.targetPlayerId)) {
        throw domainValidationError(['diceResults', index, 'targetPlayerId'], 'not_campaign_member');
      }
    }
    for (const [index, interaction] of resolution.interactionRequests.entries()) {
      if (!memberIds.has(interaction.targetPlayerId)) {
        throw domainValidationError(['interactionRequests', index, 'targetPlayerId'], 'not_campaign_member');
      }
    }
    await this.validateStateChangeTargets(campaignId, resolution);
    return resolution;
  }

  private async validateStateChangeTargets(campaignId: string, resolution: TurnResolution): Promise<void> {
    const characters = new CharacterRepository(this.executor);
    const facts = new WorldFactRepository(this.executor);
    for (const [index, change] of resolution.stateChanges.entries()) {
      if (change.kind === 'character') {
        const row = await characters.findById(change.targetId);
        if (!row || row.campaign_id !== campaignId) {
          throw domainValidationError(['stateChanges', index, 'targetId'], 'target_not_in_campaign');
        }
      } else if (change.kind === 'world' || change.kind === 'quest') {
        const row = await facts.findById(change.targetId);
        if (!row || row.campaign_id !== campaignId) {
          throw domainValidationError(['stateChanges', index, 'targetId'], 'target_not_in_campaign');
        }
        if (change.kind === 'quest' && row.kind !== 'quest') {
          throw domainValidationError(['stateChanges', index, 'targetId'], 'target_not_quest');
        }
      } else if (change.kind === 'combat') {
        // 战斗目标做 campaign 归属预校验；命令细节由 CombatAiAdapter 在 formal apply 内解析。
        const rows = await this.executor.query<{ campaign_id: string }>(
          'SELECT campaign_id FROM platform_encounters WHERE id = ? AND superseded_at IS NULL',
          [change.targetId],
        );
        if (rows.length === 0 || rows[0].campaign_id !== campaignId) {
          throw domainValidationError(['stateChanges', index, 'targetId'], 'target_not_in_campaign');
        }
      }
    }
  }
}
