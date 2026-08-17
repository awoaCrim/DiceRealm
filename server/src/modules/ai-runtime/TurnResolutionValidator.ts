import type { ProposedStateChange, ResolvedOutcome } from '@dnd/contracts';
import { aiResolutionProposalSchema, resolvedOutcomeSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { WorldFactRepository } from '../world/WorldFactRepository.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';
import { createValidatedStateChange } from './ValidatedStateChangeFactory.js';

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

  async validate(campaignId: string, output: unknown): Promise<ResolvedOutcome> {
    const parsed = aiResolutionProposalSchema.safeParse(output);
    if (!parsed.success) {
      throw new AiOutputValidationError(projectSchemaIssues(parsed.error.issues));
    }
    const proposal = parsed.data;
    // Dice are mechanical authority. A Provider may omit the collection for
    // compatibility, but it may never author a dice result that reaches formal
    // entries or combat state. Keep this as a controlled domain rejection so
    // no provider-supplied formula/total can become game fact.
    if (proposal.diceResults.length > 0) {
      throw domainValidationError(['diceResults'], 'provider_dice_results_not_allowed');
    }
    // Once the semantic intent path is used, no legacy mechanical proposal may
    // travel beside it. This prevents a Provider from selecting an intent while
    // smuggling numeric combat commands/creation payloads through the legacy
    // state-change union.
    if (proposal.actionIntents.length > 0 && (proposal.stateChanges.length > 0 || proposal.worldFactCreations.length > 0 || proposal.encounterStarts.length > 0)) {
      throw domainValidationError(['actionIntents'], 'provider_mechanical_fields_not_allowed');
    }
    const memberIds = new Set(
      (await this.executor.query<{ user_id: string }>(
        "SELECT user_id FROM campaign_members WHERE campaign_id = ? AND role = 'player'", [campaignId],
      )).map((row) => row.user_id),
    );
    // 在 SQL 之前拒绝重复 id：diceResults / interactionRequests 的 id 必须是唯一条目身份，
    // 重复会让条目身份不唯一，映射 AI_OUTPUT_INVALID，绝不能把 DB 唯一约束错误误报为 AI_PROVIDER_FAILED。
    const diceIds = proposal.diceResults.map((d) => d.id);
    if (new Set(diceIds).size !== diceIds.length) {
      throw domainValidationError(['diceResults'], 'duplicate_id');
    }
    const interactionIds = proposal.interactionRequests.map((i) => i.id);
    if (new Set(interactionIds).size !== interactionIds.length) {
      throw domainValidationError(['interactionRequests'], 'duplicate_id');
    }
    // 一次性最多发起一个遭遇：同战役未完成遭遇不变量由 formal apply 内的 STATE_CONFLICT 保证，
    // 但同一次结算请求多个新遭遇无论如何都违反该语义 → 直接拒绝。
    if (proposal.encounterStarts.length > 1) {
      throw domainValidationError(['encounterStarts'], 'too_many_items');
    }
    for (const [index, update] of proposal.privateUpdates.entries()) {
      if (!memberIds.has(update.playerId)) {
        throw domainValidationError(['privateUpdates', index, 'playerId'], 'not_campaign_member');
      }
    }
    for (const [index, dice] of proposal.diceResults.entries()) {
      if (dice.visibility === 'player_private' && dice.targetPlayerId && !memberIds.has(dice.targetPlayerId)) {
        throw domainValidationError(['diceResults', index, 'targetPlayerId'], 'not_campaign_member');
      }
    }
    for (const [index, interaction] of proposal.interactionRequests.entries()) {
      if (!memberIds.has(interaction.targetPlayerId)) {
        throw domainValidationError(['interactionRequests', index, 'targetPlayerId'], 'not_campaign_member');
      }
    }
    for (const [index, change] of proposal.stateChanges.entries()) {
      if (change.kind === 'combat') {
        throw domainValidationError(['stateChanges', index], 'provider_combat_commands_not_allowed');
      }
    }
    const normalizedCreations = await this.validateCreationMembers(campaignId, proposal, memberIds);
    await this.validateStateChangeTargets(campaignId, proposal.stateChanges);
    // Parse the formal shape only after all server/domain checks pass, then add
    // the opaque runtime brand at the server-owned seam. The exported formal
    // schema itself never manufactures ValidatedStateChange values.
    const formal = resolvedOutcomeSchema.parse({
      ...proposal,
      ...normalizedCreations,
      diceResults: [],
    });
    return {
      ...formal,
      stateChanges: formal.stateChanges.map(createValidatedStateChange),
    };
  }

  private async validateCreationMembers(
    campaignId: string,
    proposal: {
      worldFactCreations: Array<{ visibility: string; knownBy: string[] }>;
      encounterStarts: Array<{ combatants: Array<{ characterId: string | null; hpCurrent: number; hpMax: number; visibility: string; targetPlayerId: string | null }> }>;
    },
    memberIds: ReadonlySet<string>,
  ): Promise<{ worldFactCreations: typeof proposal.worldFactCreations }> {
    const worldFactCreations = proposal.worldFactCreations.map((creation, index) => {
      const knownBy = [...new Set(creation.knownBy)];
      if (creation.visibility === 'player_private') {
        if (knownBy.length === 0) {
          throw domainValidationError(['worldFactCreations', index, 'knownBy'], 'known_by_required');
        }
        for (const playerId of knownBy) {
          if (!memberIds.has(playerId)) {
            throw domainValidationError(['worldFactCreations', index, 'knownBy'], 'not_campaign_member');
          }
        }
      } else if (knownBy.length > 0) {
        throw domainValidationError(['worldFactCreations', index, 'knownBy'], 'visibility_scope_mismatch');
      }
      return { ...creation, knownBy };
    });

    const characters = new Map(
      (await new CharacterRepository(this.executor).listByCampaign(campaignId))
        .filter((character) => character.status === 'approved')
        .map((character) => [character.id, character]),
    );
    for (const [encounterIndex, encounter] of proposal.encounterStarts.entries()) {
      for (const [combatantIndex, combatant] of encounter.combatants.entries()) {
        if (combatant.hpCurrent > combatant.hpMax) {
          throw domainValidationError(['encounterStarts', encounterIndex, 'combatants', combatantIndex, 'hpCurrent'], 'hp_above_max');
        }
        if (combatant.visibility === 'player_private' && combatant.targetPlayerId && !memberIds.has(combatant.targetPlayerId)) {
          throw domainValidationError(['encounterStarts', encounterIndex, 'combatants', combatantIndex, 'targetPlayerId'], 'not_campaign_member');
        }
        if (combatant.characterId !== null && !characters.has(combatant.characterId)) {
          throw domainValidationError(['encounterStarts', encounterIndex, 'combatants', combatantIndex, 'characterId'], 'character_not_approved_in_campaign');
        }
      }
    }
    return { worldFactCreations };
  }

  private async validateStateChangeTargets(campaignId: string, stateChanges: readonly ProposedStateChange[]): Promise<void> {
    const characters = new CharacterRepository(this.executor);
    const facts = new WorldFactRepository(this.executor);
    for (const [index, change] of stateChanges.entries()) {
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
