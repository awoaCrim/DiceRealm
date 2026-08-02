import { nanoid } from 'nanoid';
import type { CharacterStatus } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface CharacterRow {
  id: string;
  campaign_id: string;
  player_id: string;
  name: string;
  status: CharacterStatus;
  sheet_json: string;
  derived_json: string;
  submitted_at: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CharacterAuditRow {
  id: string;
  character_id: string;
  campaign_id: string;
  actor_user_id: string;
  action: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

/**
 * CharacterRepository：通过 QueryExecutor 端口访问角色与审计表。
 * 每个方法都接收 executor，可在 DatabasePort.transaction 内用 tx 重新构造，
 * 保证读 + 状态检查 + 条件更新 + 审计在同一事务内完成。
 * 不包含权限策略与业务规则（这些属于 CharacterService）。
 */
export class CharacterRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async findById(id: string): Promise<CharacterRow | null> {
    const rows = await this.executor.query<CharacterRow>(
      'SELECT * FROM platform_characters WHERE id = ?',
      [id],
    );
    return rows[0] ?? null;
  }

  async listByCampaign(campaignId: string): Promise<CharacterRow[]> {
    return this.executor.query<CharacterRow>(
      'SELECT * FROM platform_characters WHERE campaign_id = ? ORDER BY created_at ASC',
      [campaignId],
    );
  }

  /** 只读：该 campaign 已批准角色数量。 */
  async countApproved(campaignId: string): Promise<number> {
    const rows = await this.executor.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_characters WHERE campaign_id = ? AND status = ?',
      [campaignId, 'approved'],
    );
    return Number(rows[0].count);
  }

  /** 只读：该 campaign 已批准角色的 DISTINCT player_id（决定回合必需玩家）。 */
  async listApprovedPlayerIds(campaignId: string): Promise<string[]> {
    const rows = await this.executor.query<{ player_id: string }>(
      'SELECT DISTINCT player_id FROM platform_characters WHERE campaign_id = ? AND status = ? ORDER BY player_id',
      [campaignId, 'approved'],
    );
    return rows.map((row) => row.player_id);
  }

  async insert(row: CharacterRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_characters
        (id, campaign_id, player_id, name, status, sheet_json, derived_json,
         submitted_at, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.player_id, row.name, row.status, row.sheet_json,
       row.derived_json, row.submitted_at, row.approved_at, row.created_at, row.updated_at],
    );
  }

  /**
   * 条件更新：仅当行存在、属于该 campaign 且当前 status 等于 expectedStatus 时更新，
   * 返回是否命中（changes === 1）。服务用返回值判定并发冲突：未命中 → STATE_CONFLICT。
   */
  async updateContent(row: CharacterRow, expectedStatus: CharacterStatus): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_characters
         SET name = ?, sheet_json = ?, status = ?, derived_json = ?, submitted_at = ?, approved_at = ?, updated_at = ?
       WHERE id = ? AND campaign_id = ? AND status = ?`,
      [row.name, row.sheet_json, row.status, row.derived_json, row.submitted_at,
       row.approved_at, row.updated_at, row.id, row.campaign_id, expectedStatus],
    );
    return result.changes === 1;
  }

  async insertAudit(row: CharacterAuditRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_character_audits
        (id, character_id, campaign_id, actor_user_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.character_id, row.campaign_id, row.actor_user_id, row.action,
       row.before_json, row.after_json, row.created_at],
    );
  }

  /** 恢复：无条件 upsert 快照角色（INSERT ... ON CONFLICT(id) DO UPDATE）。返回 void；
   *  恢复本身由调用方在 restore tx 内写 `archive_restore` audit 记录（不依赖返回值）。 */
  async upsertRestored(row: CharacterRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_characters
        (id, campaign_id, player_id, name, status, sheet_json, derived_json, submitted_at, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         player_id = excluded.player_id,
         name = excluded.name,
         status = excluded.status,
         sheet_json = excluded.sheet_json,
         derived_json = excluded.derived_json,
         submitted_at = excluded.submitted_at,
         approved_at = excluded.approved_at,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [row.id, row.campaign_id, row.player_id, row.name, row.status, row.sheet_json,
       row.derived_json, row.submitted_at, row.approved_at, row.created_at, row.updated_at],
    );
  }

  /** 恢复：快照外（存档后新建）的角色一律 archived（不物理删除审计历史）。
   *  每个真实状态变化都在 restore tx 内写 character audit（action=archive_restore_supersede，
   *  before/after、actor=owner），使恢复过程可审计。 */
  async archiveCharactersNotIn(tx: QueryExecutor, campaignId: string, keptIds: string[], now: string, actorUserId: string): Promise<void> {
    const placeholders = keptIds.map(() => '?').join(',');
    const rows = await tx.query<CharacterRow>(
      keptIds.length > 0
        ? `SELECT * FROM platform_characters WHERE campaign_id = ? AND id NOT IN (${placeholders}) AND status != 'archived'`
        : `SELECT * FROM platform_characters WHERE campaign_id = ? AND status != 'archived'`,
      keptIds.length > 0 ? [campaignId, ...keptIds] : [campaignId],
    );
    for (const row of rows) {
      const archived: CharacterRow = { ...row, status: 'archived', updated_at: now };
      await tx.execute(
        "UPDATE platform_characters SET status = 'archived', updated_at = ? WHERE id = ? AND status != 'archived'",
        [now, row.id],
      );
      await tx.execute(
        `INSERT INTO platform_character_audits
          (id, character_id, campaign_id, actor_user_id, action, before_json, after_json, created_at)
         VALUES (?, ?, ?, ?, 'archive_restore_supersede', ?, ?, ?)`,
        [nanoid(24), row.id, campaignId, actorUserId,
         JSON.stringify(row), JSON.stringify(archived), now],
      );
    }
  }
}
