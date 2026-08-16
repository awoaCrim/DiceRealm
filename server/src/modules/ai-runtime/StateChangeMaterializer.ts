import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  characterPatchSchema,
  isValidatedStateChange,
  markStateChangeValidated,
  proposedStateChangeSchema,
  worldPatchSchema,
  type EncounterStartInput,
  type ProposedStateChange,
  type ValidatedStateChange,
  type WorldFactInput,
} from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { CharacterRepository, type CharacterRow } from '../characters/CharacterRepository.js';
import { WorldFactRepository } from '../world/WorldFactRepository.js';
import { computeDerived } from '../characters/CharacterService.js';
import type { CombatStateChangeApplier } from './CombatStateChangeApplier.js';

export class StateChangeMaterializer {
  constructor(
    private readonly executor: QueryExecutor,
    private readonly combatApplier?: CombatStateChangeApplier,
  ) {}

  /** AI 创建式字段：世界事实新增 + 遭遇发起（均为服务端生成 id）。 */
  async applyAll(
    tx: QueryExecutor,
    campaignId: string,
    stateChanges: readonly ValidatedStateChange[],
    actorUserId: string,
    creations: { worldFactCreations: WorldFactInput[]; encounterStarts: EncounterStartInput[] } = { worldFactCreations: [], encounterStarts: [] },
  ): Promise<void> {
    // The formal seam accepts only server-validated changes. Keep a runtime
    // guard as well as the TypeScript brand so an unvalidated proposal cannot
    // be smuggled in through an adapter or an `as` cast.
    if (!stateChanges.every((change) => isValidatedStateChange(change))) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges 尚未完成服务端校验。');
    }
    for (const change of stateChanges) {
      switch (change.kind) {
        case 'combat':
          if (!this.combatApplier) {
            throw new AppError('STATE_CONFLICT', '结构化战斗尚未启用（Phase 3 提供）。');
          }
          await this.combatApplier.apply(tx, campaignId, change);
          break;
        case 'character':
          await this.applyCharacter(tx, campaignId, change, actorUserId);
          break;
        case 'world':
        case 'quest':
          await this.applyWorldFact(tx, campaignId, change);
          break;
        default:
          throw new AppError('AI_OUTPUT_INVALID', '未知 stateChange kind。');
      }
    }
    // 创建式：世界事实插入 + 遭遇发起（combat 未注入 applier 时保留能力门禁 STATE_CONFLICT，安全默认）。
    for (const creation of creations.worldFactCreations) {
      await this.insertWorldFact(tx, campaignId, creation);
    }
    for (const start of creations.encounterStarts) {
      if (!this.combatApplier) {
        throw new AppError('STATE_CONFLICT', '结构化战斗尚未启用（Phase 3 提供）。');
      }
      await this.combatApplier.startEncounter(tx, campaignId, start);
    }
  }

  /**
   * Compatibility seam for direct proposal callers. Parsing and branding are
   * completed before formal application begins; callers that already have a
   * validator-produced outcome must use applyAll instead.
   */
  async applyProposals(
    tx: QueryExecutor,
    campaignId: string,
    proposals: readonly unknown[],
    actorUserId: string,
    creations: { worldFactCreations: WorldFactInput[]; encounterStarts: EncounterStartInput[] } = { worldFactCreations: [], encounterStarts: [] },
  ): Promise<void> {
    const parsed = z.array(proposedStateChangeSchema).safeParse(proposals);
    if (!parsed.success) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges 提案不符合结构化契约。');
    }
    const validated = parsed.data.map((change) => markStateChangeValidated(change));
    await this.applyAll(tx, campaignId, validated, actorUserId, creations);
  }

  private async insertWorldFact(tx: QueryExecutor, campaignId: string, creation: WorldFactInput): Promise<void> {
    const facts = new WorldFactRepository(tx);
    const knownBy = await this.validateKnownBy(tx, campaignId, creation.visibility, creation.knownBy ?? []);
    const now = new Date().toISOString();
    await facts.insert({
      id: nanoid(24), campaign_id: campaignId, title: creation.title, kind: creation.kind,
      content: creation.content, visibility: creation.visibility, known_by_json: JSON.stringify(knownBy),
      created_at: now, updated_at: now,
    });
  }

  private async applyCharacter(tx: QueryExecutor, campaignId: string, change: ValidatedStateChange, actorUserId: string): Promise<void> {
    const patch = characterPatchSchema.safeParse(change.patch);
    if (!patch.success) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.character patch 不在白名单内。');
    }
    const characters = new CharacterRepository(tx);
    const existing = await characters.findById(change.targetId);
    if (!existing || existing.campaign_id !== campaignId) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.character 目标不属于该战役。');
    }
    const sheet = { ...(JSON.parse(existing.sheet_json) as Record<string, unknown>), ...patch.data.sheet };
    const derived = computeDerived(sheet);
    const updated: CharacterRow = {
      ...existing, name: patch.data.name ?? existing.name, sheet_json: JSON.stringify(sheet),
      derived_json: JSON.stringify(derived), updated_at: new Date().toISOString(),
    };
    await characters.updateContent(updated, existing.status);
    await characters.insertAudit({
      id: nanoid(24), character_id: existing.id, campaign_id: campaignId,
      actor_user_id: actorUserId, action: 'state_change',
      before_json: JSON.stringify(existing), after_json: JSON.stringify(updated),
      created_at: updated.updated_at,
    });
  }

  private async applyWorldFact(tx: QueryExecutor, campaignId: string, change: ValidatedStateChange): Promise<void> {
    const patch = worldPatchSchema.safeParse(change.patch);
    if (!patch.success) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.world patch 不在白名单内。');
    }
    const facts = new WorldFactRepository(tx);
    const existing = await facts.findById(change.targetId);
    if (!existing || existing.campaign_id !== campaignId) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.world 目标不属于该战役。');
    }
    if (change.kind === 'quest' && existing.kind !== 'quest') {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.quest 目标不是 quest 世界事实。');
    }
    const visibility = patch.data.visibility ?? existing.visibility;
    const knownByRaw = patch.data.knownBy ?? (existing.known_by_json ? (JSON.parse(existing.known_by_json) as string[]) : []);
    const knownBy = await this.validateKnownBy(tx, campaignId, visibility, knownByRaw);
    const ok = await facts.updateContent(existing.id, campaignId, {
      title: patch.data.title ?? existing.title, kind: existing.kind,
      content: patch.data.content ?? existing.content, visibility,
      known_by_json: JSON.stringify(knownBy), updated_at: new Date().toISOString(),
    });
    if (!ok) throw new AppError('NOT_FOUND', '世界事实不存在。');
  }

  private async validateKnownBy(tx: QueryExecutor, campaignId: string, visibility: string, knownBy: string[]): Promise<string[]> {
    if (visibility !== 'player_private') return [];
    if (knownBy.length === 0) throw new AppError('AI_OUTPUT_INVALID', 'player_private 世界事实必须指定可见玩家。');
    const members = new Set((await new WorldFactRepository(tx).listPlayerMemberIds(campaignId)));
    for (const playerId of knownBy) {
      if (!members.has(playerId)) throw new AppError('AI_OUTPUT_INVALID', '世界事实 knownBy 不是该战役玩家成员。');
    }
    return [...new Set(knownBy)];
  }
}
