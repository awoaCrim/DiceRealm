import type { ActorBindingRole, ActorCharacterType, ActorControlMode, ActorMechanicsMode, CharacterRuntimeStatus } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface ActorRow {
  id: string; campaign_id: string; display_name: string;
  character_type: ActorCharacterType; control_mode: ActorControlMode;
  mechanics_mode: ActorMechanicsMode; character_id: string | null;
  created_at: string; updated_at: string;
}
export interface ActorBindingRow {
  id: string; campaign_id: string; actor_id: string; user_id: string | null;
  binding_role: ActorBindingRole; active: number; created_at: string; updated_at: string;
}
export interface RuntimeStateRow {
  campaign_id: string; actor_id: string; current_hp: number; temporary_hp: number;
  conditions_json: string; runtime_status: CharacterRuntimeStatus; state_revision: number; updated_at: string;
}

export class ActorRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async findById(id: string): Promise<ActorRow | null> {
    const rows = await this.executor.query<ActorRow>('SELECT * FROM platform_campaign_actors WHERE id = ?', [id]);
    return rows[0] ?? null;
  }
  async findByCharacter(campaignId: string, characterId: string): Promise<ActorRow | null> {
    const rows = await this.executor.query<ActorRow>('SELECT * FROM platform_campaign_actors WHERE campaign_id = ? AND character_id = ?', [campaignId, characterId]);
    return rows[0] ?? null;
  }
  async listByCampaign(campaignId: string): Promise<ActorRow[]> {
    return this.executor.query<ActorRow>('SELECT * FROM platform_campaign_actors WHERE campaign_id = ? ORDER BY created_at ASC, id ASC', [campaignId]);
  }
  async listControlledByUser(campaignId: string, userId: string): Promise<ActorRow[]> {
    return this.executor.query<ActorRow>(
      `SELECT a.* FROM platform_campaign_actors a
       JOIN platform_actor_control_bindings b ON b.actor_id = a.id
       WHERE a.campaign_id = ? AND b.campaign_id = ? AND b.user_id = ? AND b.active = 1
       ORDER BY a.created_at ASC, a.id ASC`, [campaignId, campaignId, userId],
    );
  }
  async insert(row: ActorRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_campaign_actors
       (id, campaign_id, display_name, character_type, control_mode, mechanics_mode, character_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.display_name, row.character_type, row.control_mode, row.mechanics_mode, row.character_id, row.created_at, row.updated_at],
    );
  }

  async insertBinding(row: ActorBindingRow): Promise<void> {
    await this.executor.execute(
      `INSERT OR IGNORE INTO platform_actor_control_bindings
       (id, campaign_id, actor_id, user_id, binding_role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.actor_id, row.user_id, row.binding_role, row.active, row.created_at, row.updated_at],
    );
  }
  async listBindings(campaignId: string, actorId?: string): Promise<ActorBindingRow[]> {
    return actorId
      ? this.executor.query<ActorBindingRow>('SELECT * FROM platform_actor_control_bindings WHERE campaign_id = ? AND actor_id = ? ORDER BY created_at ASC', [campaignId, actorId])
      : this.executor.query<ActorBindingRow>('SELECT * FROM platform_actor_control_bindings WHERE campaign_id = ? ORDER BY created_at ASC', [campaignId]);
  }
  async findControlledActor(campaignId: string, userId: string, actorId?: string): Promise<ActorRow | null> {
    const rows = await this.executor.query<ActorRow>(
      `SELECT a.* FROM platform_campaign_actors a
       JOIN platform_actor_control_bindings b ON b.actor_id = a.id
       WHERE a.campaign_id = ? AND b.campaign_id = ? AND b.user_id = ? AND b.active = 1
         AND (? IS NULL OR a.id = ?)
       ORDER BY a.created_at ASC, a.id ASC LIMIT 1`,
      [campaignId, campaignId, userId, actorId ?? null, actorId ?? null],
    );
    return rows[0] ?? null;
  }

  async findRuntimeState(campaignId: string, actorId: string): Promise<RuntimeStateRow | null> {
    const rows = await this.executor.query<RuntimeStateRow>('SELECT * FROM platform_character_runtime_states WHERE campaign_id = ? AND actor_id = ?', [campaignId, actorId]);
    return rows[0] ?? null;
  }
  async insertRuntimeState(row: RuntimeStateRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_character_runtime_states
       (campaign_id, actor_id, current_hp, temporary_hp, conditions_json, runtime_status, state_revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.campaign_id, row.actor_id, row.current_hp, row.temporary_hp, row.conditions_json, row.runtime_status, row.state_revision, row.updated_at],
    );
  }
  async updateRuntimeState(row: RuntimeStateRow, expectedRevision: number): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_character_runtime_states
       SET current_hp = ?, temporary_hp = ?, conditions_json = ?, runtime_status = ?, state_revision = ?, updated_at = ?
       WHERE campaign_id = ? AND actor_id = ? AND state_revision = ?`,
      [row.current_hp, row.temporary_hp, row.conditions_json, row.runtime_status, row.state_revision, row.updated_at, row.campaign_id, row.actor_id, expectedRevision],
    );
    return result.changes === 1;
  }
}

export function mapActor(row: ActorRow) {
  return {
    id: row.id, campaignId: row.campaign_id, displayName: row.display_name,
    characterType: row.character_type, controlMode: row.control_mode,
    mechanicsMode: row.mechanics_mode, characterId: row.character_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
export function mapBinding(row: ActorBindingRow) {
  return {
    id: row.id, campaignId: row.campaign_id, actorId: row.actor_id, userId: row.user_id,
    bindingRole: row.binding_role, active: row.active === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function parseConditions(json: string): string[] {
  try { const value: unknown = JSON.parse(json); return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : []; }
  catch { return []; }
}
export function mapRuntimeState(row: RuntimeStateRow) {
  return {
    campaignId: row.campaign_id, actorId: row.actor_id, currentHp: Number(row.current_hp),
    temporaryHp: Number(row.temporary_hp), conditions: parseConditions(row.conditions_json),
    runtimeStatus: row.runtime_status, stateRevision: Number(row.state_revision), updatedAt: row.updated_at,
  };
}
