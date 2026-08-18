import type { EncounterStatus, Visibility } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

/**
 * 结构化战斗行：platform_encounters / platform_combatants。
 * 普通 find/list/load 查询一律默认过滤 `superseded_at IS NULL`（恢复后的历史 encounter/combatant
 * 对 HTTP/AI 表现为不存在）；恢复专用的 upsert/clear 方法显式操作 superseded 语义。
 */

export interface EncounterRow {
  id: string;
  campaign_id: string;
  name: string;
  status: EncounterStatus;
  active_combatant_id: string | null;
  round: number;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CombatantRow {
  id: string;
  encounter_id: string;
  campaign_id: string;
  actor_id: string | null;
  character_id: string | null;
  name: string;
  initiative: number | null;
  initiative_bonus: number;
  hp_current: number;
  hp_max: number;
  ac: number;
  conditions_json: string;
  visibility: Visibility;
  target_player_id: string | null;
  position: number;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
  created_at: string;
  updated_at: string;
}

export class CombatRepository {
  constructor(public readonly executor: QueryExecutor) {}

  // ---------- encounters（active-only 默认查询） ----------

  async findEncounterById(id: string): Promise<EncounterRow | null> {
    const rows = await this.executor.query<EncounterRow>(
      'SELECT * FROM platform_encounters WHERE id = ? AND superseded_at IS NULL',
      [id],
    );
    return rows[0] ?? null;
  }

  /** 该 campaign 当前未完成的 unsuperseded encounter（preparation 或 active）。 */
  async findUnfinishedEncounter(campaignId: string): Promise<EncounterRow | null> {
    const rows = await this.executor.query<EncounterRow>(
      "SELECT * FROM platform_encounters WHERE campaign_id = ? AND superseded_at IS NULL AND status IN ('preparation','active') ORDER BY created_at ASC LIMIT 1",
      [campaignId],
    );
    return rows[0] ?? null;
  }

  async listEncountersByCampaign(campaignId: string): Promise<EncounterRow[]> {
    return this.executor.query<EncounterRow>(
      'SELECT * FROM platform_encounters WHERE campaign_id = ? AND superseded_at IS NULL ORDER BY created_at ASC',
      [campaignId],
    );
  }

  /** 存档捕获：全部 unsuperseded encounters（含 completed 历史，恢复时按快照还原）。 */
  async listAllEncountersByCampaign(campaignId: string): Promise<EncounterRow[]> {
    return this.executor.query<EncounterRow>(
      'SELECT * FROM platform_encounters WHERE campaign_id = ? AND superseded_at IS NULL ORDER BY created_at ASC',
      [campaignId],
    );
  }

  async insertEncounter(row: EncounterRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_encounters
        (id, campaign_id, name, status, active_combatant_id, round, superseded_at, superseded_by_archive_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.name, row.status, row.active_combatant_id, row.round,
       row.superseded_at, row.superseded_by_archive_id, row.created_at, row.updated_at],
    );
  }

  /** 条件更新：仅当行存在、属于该 campaign 且当前 status 等于 expectedStatus 时更新，返回是否命中。 */
  async updateEncounter(row: EncounterRow, expectedStatus: EncounterStatus): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_encounters
         SET name = ?, status = ?, active_combatant_id = ?, round = ?, updated_at = ?
       WHERE id = ? AND campaign_id = ? AND superseded_at IS NULL AND status = ?`,
      [row.name, row.status, row.active_combatant_id, row.round, row.updated_at,
       row.id, row.campaign_id, expectedStatus],
    );
    return result.changes === 1;
  }

  // ---------- combatants（active-only 默认查询） ----------

  async listCombatantsByEncounter(encounterId: string): Promise<CombatantRow[]> {
    return this.executor.query<CombatantRow>(
      'SELECT * FROM platform_combatants WHERE encounter_id = ? AND superseded_at IS NULL ORDER BY position ASC',
      [encounterId],
    );
  }

  /** 存档捕获：encounter 的全部 unsuperseded combatants。 */
  async listAllCombatantsByEncounter(encounterId: string): Promise<CombatantRow[]> {
    return this.executor.query<CombatantRow>(
      'SELECT * FROM platform_combatants WHERE encounter_id = ? AND superseded_at IS NULL ORDER BY position ASC',
      [encounterId],
    );
  }

  async findCombatantById(id: string): Promise<CombatantRow | null> {
    const rows = await this.executor.query<CombatantRow>(
      'SELECT * FROM platform_combatants WHERE id = ? AND superseded_at IS NULL',
      [id],
    );
    return rows[0] ?? null;
  }

  async insertCombatant(row: CombatantRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_combatants
        (id, encounter_id, campaign_id, actor_id, character_id, name, initiative, initiative_bonus,
         hp_current, hp_max, ac, conditions_json, visibility, target_player_id, position,
         superseded_at, superseded_by_archive_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.encounter_id, row.campaign_id, row.actor_id, row.character_id, row.name, row.initiative,
       row.initiative_bonus, row.hp_current, row.hp_max, row.ac, row.conditions_json,
       row.visibility, row.target_player_id, row.position, row.superseded_at,
       row.superseded_by_archive_id, row.created_at, row.updated_at],
    );
  }

  async updateCombatant(row: CombatantRow): Promise<void> {
    await this.executor.execute(
      `UPDATE platform_combatants
         SET initiative = ?, hp_current = ?, conditions_json = ?, position = ?, updated_at = ?
       WHERE id = ? AND superseded_at IS NULL`,
      [row.initiative, row.hp_current, row.conditions_json, row.position, row.updated_at, row.id],
    );
  }

  /** 两阶段重排第一阶段：同 encounter 全部 positions 加安全 offset，避免 UNIQUE 瞬时冲突。 */
  async offsetAllPositions(encounterId: string, offset: number): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_combatants SET position = position + ? WHERE encounter_id = ? AND superseded_at IS NULL',
      [offset, encounterId],
    );
  }

  /** 恢复专用两阶段重排：同 encounter 全部 positions（含 superseded 历史行）加安全 offset。
   *  UNIQUE(encounter_id, position) 覆盖 superseded 行，因此恢复必须先整体偏移再写最终值。 */
  async offsetAllPositionsIncludingSuperseded(encounterId: string, offset: number): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_combatants SET position = position + ? WHERE encounter_id = ?',
      [offset, encounterId],
    );
  }

  /** 两阶段重排第二阶段：写最终 position。 */
  async setPosition(id: string, position: number, updatedAt: string): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_combatants SET position = ?, updated_at = ? WHERE id = ? AND superseded_at IS NULL',
      [position, updatedAt, id],
    );
  }

  // ---------- superseded 历史语义（archive restore 专用） ----------

  /** 快照内 encounter upsert + 解除 superseded（保留历史行不物理删除）。 */
  async upsertRestoredEncounter(row: EncounterRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_encounters
        (id, campaign_id, name, status, active_combatant_id, round, superseded_at, superseded_by_archive_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         name = excluded.name,
         status = excluded.status,
         active_combatant_id = excluded.active_combatant_id,
         round = excluded.round,
         superseded_at = NULL,
         superseded_by_archive_id = NULL,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [row.id, row.campaign_id, row.name, row.status, row.active_combatant_id, row.round,
       row.created_at, row.updated_at],
    );
  }

  /** 快照内 combatant upsert + 解除 superseded；position 冲突由调用方两阶段处理。 */
  async upsertRestoredCombatant(row: CombatantRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_combatants
        (id, encounter_id, campaign_id, actor_id, character_id, name, initiative, initiative_bonus,
         hp_current, hp_max, ac, conditions_json, visibility, target_player_id, position,
         superseded_at, superseded_by_archive_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         encounter_id = excluded.encounter_id,
         campaign_id = excluded.campaign_id,
         actor_id = excluded.actor_id,
         character_id = excluded.character_id,
         name = excluded.name,
         initiative = excluded.initiative,
         initiative_bonus = excluded.initiative_bonus,
         hp_current = excluded.hp_current,
         hp_max = excluded.hp_max,
         ac = excluded.ac,
         conditions_json = excluded.conditions_json,
         visibility = excluded.visibility,
         target_player_id = excluded.target_player_id,
         position = excluded.position,
         superseded_at = NULL,
         superseded_by_archive_id = NULL,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [row.id, row.encounter_id, row.campaign_id, row.actor_id, row.character_id, row.name, row.initiative,
       row.initiative_bonus, row.hp_current, row.hp_max, row.ac, row.conditions_json,
       row.visibility, row.target_player_id, row.position, row.created_at, row.updated_at],
    );
  }

  /** v1 restore：当前 unsuperseded 战斗全部标记为快照后历史（不物理删除）。 */
  async supersedeAllByCampaign(campaignId: string, archiveId: string, now: string): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_encounters SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL',
      [now, archiveId, campaignId],
    );
    await this.executor.execute(
      'UPDATE platform_combatants SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL',
      [now, archiveId, campaignId],
    );
  }

  /** v2 restore：快照外 encounter/combatant 标记为历史；快照内由 restoreSnapshotState 解除。
   *  空列表不得生成无效的 `NOT IN ()`：与 WorldFactRepository.supersedeFactsNotIn /
   *  CharacterRepository.archiveCharactersNotIn 同构——空列表退化为无 NOT IN 条件的 UPDATE。 */
  async supersedeNotIn(campaignId: string, keptEncounterIds: string[], keptCombatantIds: string[], archiveId: string, now: string): Promise<void> {
    const encounterPlaceholders = keptEncounterIds.map(() => '?').join(',');
    await this.executor.execute(
      keptEncounterIds.length > 0
        ? `UPDATE platform_encounters SET superseded_at = ?, superseded_by_archive_id = ?
           WHERE campaign_id = ? AND superseded_at IS NULL AND id NOT IN (${encounterPlaceholders})`
        : `UPDATE platform_encounters SET superseded_at = ?, superseded_by_archive_id = ?
           WHERE campaign_id = ? AND superseded_at IS NULL`,
      keptEncounterIds.length > 0 ? [now, archiveId, campaignId, ...keptEncounterIds] : [now, archiveId, campaignId],
    );
    const combatantPlaceholders = keptCombatantIds.map(() => '?').join(',');
    await this.executor.execute(
      keptCombatantIds.length > 0
        ? `UPDATE platform_combatants SET superseded_at = ?, superseded_by_archive_id = ?
           WHERE campaign_id = ? AND superseded_at IS NULL AND id NOT IN (${combatantPlaceholders})`
        : `UPDATE platform_combatants SET superseded_at = ?, superseded_by_archive_id = ?
           WHERE campaign_id = ? AND superseded_at IS NULL`,
      keptCombatantIds.length > 0 ? [now, archiveId, campaignId, ...keptCombatantIds] : [now, archiveId, campaignId],
    );
  }
}
