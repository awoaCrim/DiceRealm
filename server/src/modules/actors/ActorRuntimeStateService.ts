import { runtimeMutationEffectSchema, characterRuntimeStateSchema, type CharacterRuntimeState, type RuntimeMutationEffect } from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';
import { ActorRepository, mapRuntimeState } from './ActorRepository.js';

export class ActorRuntimeStateService {
  private readonly mutations: CampaignMutationCoordinator;
  constructor(private readonly database: DatabasePort | QueryExecutor, mutations?: CampaignMutationCoordinator) {
    if (mutations) this.mutations = mutations;
    else if ('transaction' in database) this.mutations = new CampaignMutationCoordinator(database);
    else throw new AppError('INTERNAL_ERROR', 'ActorRuntimeStateService 需要 coordinator 或 DatabasePort。');
  }

  async get(campaignId: string, actorId: string): Promise<CharacterRuntimeState> {
    const row = await new ActorRepository(this.database).findRuntimeState(campaignId, actorId);
    if (!row) throw new AppError('NOT_FOUND', 'Actor runtime state 不存在。');
    return characterRuntimeStateSchema.parse(mapRuntimeState(row));
  }

  async apply(campaignId: string, actorId: string, effect: RuntimeMutationEffect, mutationId: string, expectedRevision?: number): Promise<{ replayed: boolean; state: CharacterRuntimeState; revision: number }> {
    const parsed = runtimeMutationEffectSchema.parse(effect);
    if (!('transaction' in this.database)) throw new AppError('INTERNAL_ERROR', 'runtime mutation 需要 DatabasePort。');
    return this.database.transaction(async (tx) => {
      const execution = await this.mutations.mutateIn(tx, {
        campaignId, expectedRevision, mutationId, causeType: 'character_runtime_mutation', causeId: actorId,
      }, async ({ stateRevision }) => this.applyIn(tx, campaignId, actorId, parsed, stateRevision));
      if (!execution.result) {
        const state = await this.getIn(tx, campaignId, actorId);
        return { replayed: true, state, revision: execution.revision.revision };
      }
      return { replayed: execution.replayed, state: execution.result, revision: execution.revision.revision };
    });
  }

  /** Caller-owned coordinator transaction seam. It does not allocate a revision. */
  async applyIn(tx: QueryExecutor, campaignId: string, actorId: string, effect: RuntimeMutationEffect, stateRevision: number): Promise<CharacterRuntimeState> {
    return this.applyEffectsIn(tx, campaignId, actorId, [effect], stateRevision);
  }

  async applyEffectsIn(tx: QueryExecutor, campaignId: string, actorId: string, effects: RuntimeMutationEffect[], stateRevision: number): Promise<CharacterRuntimeState> {
    const parsedEffects = effects.map((effect) => runtimeMutationEffectSchema.parse(effect));
    const actors = new ActorRepository(tx);
    const actor = await actors.findById(actorId);
    if (!actor || actor.campaign_id !== campaignId) throw new AppError('NOT_FOUND', 'Actor 不属于当前战役。');
    const existing = await actors.findRuntimeState(campaignId, actorId);
    if (!existing) throw new AppError('STATE_CONFLICT', 'Actor 缺少 runtime state。');
    const conditions = parseConditions(existing.conditions_json);
    let currentHp = Number(existing.current_hp);
    let temporaryHp = Number(existing.temporary_hp);
    for (const parsed of parsedEffects) {
      switch (parsed.kind) {
        case 'damage': {
          const absorbed = Math.min(temporaryHp, parsed.amount);
          temporaryHp -= absorbed;
          currentHp = Math.max(0, currentHp - (parsed.amount - absorbed));
          break;
        }
        case 'healing': currentHp = Math.max(0, currentHp + parsed.amount); break;
        case 'add_condition': if (!conditions.includes(parsed.condition)) conditions.push(parsed.condition); break;
        case 'remove_condition': {
          const index = conditions.indexOf(parsed.condition); if (index >= 0) conditions.splice(index, 1); break;
        }
      }
    }
    if (conditions.length > 32) throw new AppError('VALIDATION_ERROR', 'runtime conditions 超出上限。');
    const next: CharacterRuntimeState = characterRuntimeStateSchema.parse({
      campaignId, actorId, currentHp, temporaryHp, conditions,
      runtimeStatus: currentHp === 0 ? 'defeated' : 'active', stateRevision, updatedAt: new Date().toISOString(),
    });
    const ok = await actors.updateRuntimeState({
      campaign_id: campaignId, actor_id: actorId, current_hp: next.currentHp, temporary_hp: next.temporaryHp,
      conditions_json: JSON.stringify(next.conditions), runtime_status: next.runtimeStatus,
      state_revision: stateRevision, updated_at: next.updatedAt,
    }, Number(existing.state_revision));
    if (!ok) throw new AppError('STALE_STATE_REVISION', 'Actor runtime state 已被并发修改。');
    return next;
  }

  private async getIn(tx: QueryExecutor, campaignId: string, actorId: string): Promise<CharacterRuntimeState> {
    const row = await new ActorRepository(tx).findRuntimeState(campaignId, actorId);
    if (!row) throw new AppError('NOT_FOUND', 'Actor runtime state 不存在。');
    return characterRuntimeStateSchema.parse(mapRuntimeState(row));
  }
}

function parseConditions(json: string): string[] {
  try { const value: unknown = JSON.parse(json); return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...new Set(value)] : []; }
  catch { return []; }
}
