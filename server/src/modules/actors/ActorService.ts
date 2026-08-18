import { nanoid } from 'nanoid';
import { campaignActorSchema, createNpcActorInputSchema, type CampaignActor, type CreateNpcActorInput } from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';
import type { CharacterRow } from '../characters/CharacterRepository.js';
import { ActorRepository, mapActor, mapBinding, mapRuntimeState, type ActorRow } from './ActorRepository.js';
import type { CharacterRuntimeState } from '@dnd/contracts';

export class ActorService {
  private readonly mutations: CampaignMutationCoordinator;
  constructor(private readonly database: DatabasePort, mutations?: CampaignMutationCoordinator) {
    this.mutations = mutations ?? new CampaignMutationCoordinator(database);
  }

  async list(ctx: CampaignAuthContext): Promise<CampaignActor[]> {
    return (await new ActorRepository(this.database).listByCampaign(ctx.campaignId)).map((row) => campaignActorSchema.parse(mapActor(row)));
  }
  async listControlled(ctx: CampaignAuthContext): Promise<CampaignActor[]> {
    return (await new ActorRepository(this.database).listControlledByUser(ctx.campaignId, ctx.userId)).map((row) => campaignActorSchema.parse(mapActor(row)));
  }
  async listIn(tx: QueryExecutor, campaignId: string): Promise<ActorRow[]> {
    return new ActorRepository(tx).listByCampaign(campaignId);
  }

  /** Creates a userless NPC; only the campaign owner can create campaign actors in this slice. */
  async createNpc(ctx: CampaignAuthContext, input: CreateNpcActorInput): Promise<CampaignActor> {
    requireOwner(ctx);
    const parsed = createNpcActorInputSchema.parse(input);
    const id = nanoid(24);
    return this.database.transaction(async (tx) => {
      const execution = await this.mutations.mutateIn(tx, {
        campaignId: ctx.campaignId, mutationId: `actor-create:${id}`, causeType: 'actor_create', causeId: id,
      }, async ({ stateRevision }) => this.createNpcIn(tx, ctx.campaignId, id, parsed, stateRevision));
      if (!execution.result) throw new AppError('INTERNAL_ERROR', 'Actor 创建结果读取失败。');
      return campaignActorSchema.parse(mapActor(execution.result));
    });
  }

  async createNpcIn(tx: QueryExecutor, campaignId: string, id: string, input: CreateNpcActorInput, stateRevision: number): Promise<ActorRow> {
    const parsed = createNpcActorInputSchema.parse(input);
    const now = new Date().toISOString();
    const repo = new ActorRepository(tx);
    const row: ActorRow = {
      id, campaign_id: campaignId, display_name: parsed.displayName,
      character_type: 'npc', control_mode: parsed.controlMode, mechanics_mode: parsed.mechanicsMode,
      character_id: null, created_at: now, updated_at: now,
    };
    await repo.insert(row);
    await repo.insertRuntimeState({
      campaign_id: campaignId, actor_id: id, current_hp: parsed.currentHp, temporary_hp: parsed.temporaryHp,
      conditions_json: JSON.stringify([...new Set(parsed.conditions)]), runtime_status: 'active',
      state_revision: stateRevision, updated_at: now,
    });
    return row;
  }

  /** Idempotent Character approval/bootstrap seam. It never changes sheet_json. */
  async ensureCharacterActorIn(tx: QueryExecutor, character: CharacterRow, stateRevision: number): Promise<ActorRow> {
    if (character.status !== 'approved') throw new AppError('CHARACTER_NOT_APPROVED', '只有 approved Character 可以绑定 Actor。');
    const repo = new ActorRepository(tx);
    const existing = await repo.findByCharacter(character.campaign_id, character.id);
    if (existing) {
      await this.ensureCharacterBindingAndRuntimeIn(tx, existing, character, stateRevision);
      return existing;
    }
    const now = character.updated_at || new Date().toISOString();
    const row: ActorRow = {
      id: `actor:character:${character.id}`, campaign_id: character.campaign_id, display_name: character.name,
      character_type: 'player_character', control_mode: 'player', mechanics_mode: 'pc_build',
      character_id: character.id, created_at: character.created_at, updated_at: now,
    };
    await repo.insert(row);
    await this.ensureCharacterBindingAndRuntimeIn(tx, row, character, stateRevision);
    return row;
  }

  async ensureCharacterActor(campaignId: string, character: CharacterRow): Promise<ActorRow> {
    return this.database.transaction(async (tx) => {
      const execution = await this.mutations.mutateIn(tx, {
        campaignId, mutationId: `actor-bootstrap:${character.id}`, causeType: 'actor_bootstrap', causeId: character.id,
      }, async ({ stateRevision }) => this.ensureCharacterActorIn(tx, character, stateRevision));
      if (!execution.result) throw new AppError('INTERNAL_ERROR', 'Actor bootstrap 结果读取失败。');
      return execution.result;
    });
  }

  async resolveControlledActorIn(tx: QueryExecutor, campaignId: string, userId: string, actorId?: string): Promise<ActorRow> {
    const repository = new ActorRepository(tx);
    if (actorId) {
      const row = await repository.findControlledActor(campaignId, userId, actorId);
      if (!row) throw new AppError('FORBIDDEN', '当前用户没有控制该 Actor 的有效绑定。');
      return row;
    }
    const controlled = await repository.listControlledByUser(campaignId, userId);
    if (controlled.length === 0) throw new AppError('FORBIDDEN', '当前用户没有控制该 Actor 的有效绑定。');
    if (controlled.length > 1) {
      throw new AppError('STATE_CONFLICT', '当前用户控制多个 Actor，提交行动时必须明确指定 actorId。');
    }
    return controlled[0];
  }

  async assertActorIn(tx: QueryExecutor, campaignId: string, actorId: string): Promise<ActorRow> {
    const row = await new ActorRepository(tx).findById(actorId);
    if (!row || row.campaign_id !== campaignId) throw new AppError('NOT_FOUND', 'Actor 不存在。');
    return row;
  }

  async runtimeState(ctx: CampaignAuthContext, actorId: string): Promise<CharacterRuntimeState> {
    const row = await new ActorRepository(this.database).findRuntimeState(ctx.campaignId, actorId);
    if (!row) throw new AppError('NOT_FOUND', 'Actor runtime state 不存在。');
    const actor = await new ActorRepository(this.database).findControlledActor(ctx.campaignId, ctx.userId, actorId);
    if (ctx.role !== 'owner' && !actor) throw new AppError('FORBIDDEN', '当前用户没有访问该 Actor 的权限。');
    return mapRuntimeState(row) as CharacterRuntimeState;
  }

  private async ensureCharacterBindingAndRuntimeIn(tx: QueryExecutor, actor: ActorRow, character: CharacterRow, stateRevision: number): Promise<void> {
    const repo = new ActorRepository(tx);
    const now = new Date().toISOString();
    await repo.insertBinding({
      id: `binding:character:${character.id}:user:${character.player_id}`, campaign_id: character.campaign_id,
      actor_id: actor.id, user_id: character.player_id, binding_role: 'player', active: 1,
      created_at: character.created_at, updated_at: now,
    });
    if (!(await repo.findRuntimeState(character.campaign_id, actor.id))) {
      const sheet = parseObject(character.sheet_json);
      const hp = integerAt(sheet.hpCurrent) ?? 0;
      await repo.insertRuntimeState({
        campaign_id: character.campaign_id, actor_id: actor.id, current_hp: Math.max(0, hp), temporary_hp: 0,
        conditions_json: '[]', runtime_status: 'active', state_revision: stateRevision, updated_at: now,
      });
    }
  }
}

function parseObject(value: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}
function integerAt(value: unknown): number | null { return typeof value === 'number' && Number.isInteger(value) ? value : null; }
