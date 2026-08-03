import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { StateChange } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { CharacterRepository, type CharacterRow } from '../characters/CharacterRepository.js';
import { WorldFactRepository } from '../world/WorldFactRepository.js';
import { computeDerived } from '../characters/CharacterService.js';

/** 角色 sheet 白名单：只允许这些叶子键，禁止任意 JSON patch。 */
const sheetPatchSchema = z.object({
  hpCurrent: z.number().int().optional(),
  hpMax: z.number().int().optional(),
  ac: z.number().int().optional(),
  gold: z.number().int().optional(),
  level: z.number().int().optional(),
  experience: z.number().int().optional(),
  conditions: z.array(z.string()).optional(),
  inventory: z.array(z.string()).optional(),
}).strict();

const characterPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  sheet: sheetPatchSchema.optional(),
}).strict();

const worldFactPatchSchema = z.object({
  title: z.string().trim().min(1).optional(),
  content: z.string().optional(),
  visibility: z.enum(['public', 'player_private', 'owner_only']).optional(),
  knownBy: z.array(z.string().min(1)).optional(),
}).strict();

export class StateChangeMaterializer {
  constructor(private readonly executor: QueryExecutor) {}

  async applyAll(tx: QueryExecutor, campaignId: string, stateChanges: StateChange[], actorUserId: string): Promise<void> {
    // 未知 kind 在写任何正式状态之前以 AI_OUTPUT_INVALID 拒绝（与 member/duplicate 校验同一原则：
    // 绝不把非法输出拖到 DB 层）；combat 走能力门禁 STATE_CONFLICT。
    for (const change of stateChanges) {
      if (change.kind !== 'character' && change.kind !== 'world' && change.kind !== 'quest' && change.kind !== 'combat') {
        throw new AppError('AI_OUTPUT_INVALID', '未知 stateChange kind。');
      }
    }
    for (const change of stateChanges) {
      switch (change.kind) {
        case 'combat':
          throw new AppError('STATE_CONFLICT', '结构化战斗尚未启用（Phase 3 提供）。');
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
  }

  private async applyCharacter(tx: QueryExecutor, campaignId: string, change: StateChange, actorUserId: string): Promise<void> {
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

  private async applyWorldFact(tx: QueryExecutor, campaignId: string, change: StateChange): Promise<void> {
    const patch = worldFactPatchSchema.safeParse(change.patch);
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
