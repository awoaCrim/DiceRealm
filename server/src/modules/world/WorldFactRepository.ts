import type { WorldFactKind, Visibility } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface WorldFactRow {
  id: string;
  campaign_id: string;
  title: string;
  kind: WorldFactKind;
  content: string;
  visibility: Visibility;
  known_by_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * WorldFactRepository：通过 QueryExecutor 端口访问世界事实表。
 * 每个方法都接收 executor，可在 DatabasePort.transaction 内用 tx 重新构造，
 * 保证 knownBy 成员校验与写入在同一事务内完成。
 * 不包含权限策略与业务规则（这些属于 WorldFactService）。
 */
export class WorldFactRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async insert(row: WorldFactRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_world_facts
        (id, campaign_id, title, kind, content, visibility, known_by_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.title, row.kind, row.content, row.visibility,
       row.known_by_json, row.created_at, row.updated_at],
    );
  }

  /** 默认 active 列表：只含未 superseded 的事实（存档恢复覆盖的历史事实默认不可见）。 */
  async listByCampaign(campaignId: string): Promise<WorldFactRow[]> {
    return this.executor.query<WorldFactRow>(
      'SELECT * FROM platform_world_facts WHERE campaign_id = ? AND superseded_at IS NULL ORDER BY created_at ASC',
      [campaignId],
    );
  }

  /** 审计全量列表：含被存档恢复 supersede 的历史事实（供恢复与审计）。 */
  async listAllByCampaign(campaignId: string): Promise<WorldFactRow[]> {
    return this.executor.query<WorldFactRow>(
      'SELECT * FROM platform_world_facts WHERE campaign_id = ? ORDER BY created_at ASC',
      [campaignId],
    );
  }

  async findById(id: string): Promise<WorldFactRow | null> {
    const rows = await this.executor.query<WorldFactRow>(
      'SELECT * FROM platform_world_facts WHERE id = ? AND superseded_at IS NULL',
      [id],
    );
    return rows[0] ?? null;
  }

  /** 条件更新：仅当行存在、属于该 campaign 且未 superseded 时更新；未命中返回 false → NOT_FOUND。 */
  async updateContent(
    factId: string,
    campaignId: string,
    patch: Pick<WorldFactRow, 'title' | 'kind' | 'content' | 'visibility' | 'known_by_json' | 'updated_at'>,
  ): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_world_facts
         SET title = ?, kind = ?, content = ?, visibility = ?, known_by_json = ?, updated_at = ?
       WHERE id = ? AND campaign_id = ? AND superseded_at IS NULL`,
      [patch.title, patch.kind, patch.content, patch.visibility, patch.known_by_json,
       patch.updated_at, factId, campaignId],
    );
    return result.changes === 1;
  }

  /** 条件删除：仅当行存在、属于该 campaign 且未 superseded 时删除；未命中返回 false → NOT_FOUND。 */
  async delete(factId: string, campaignId: string): Promise<boolean> {
    const result = await this.executor.execute(
      'DELETE FROM platform_world_facts WHERE id = ? AND campaign_id = ? AND superseded_at IS NULL',
      [factId, campaignId],
    );
    return result.changes === 1;
  }

  /** 该 campaign 的 player 角色成员 id 列表（用于校验 player_private 的 knownBy）。 */
  async listPlayerMemberIds(campaignId: string): Promise<string[]> {
    const rows = await this.executor.query<{ user_id: string }>(
      "SELECT user_id FROM campaign_members WHERE campaign_id = ? AND role = 'player' ORDER BY user_id",
      [campaignId],
    );
    return rows.map((row) => row.user_id);
  }

  /** 恢复：快照内事实 upsert 并清 superseded；快照外事实 supersede（archiveId 由调用方传入）。 */
  async upsertRestored(row: WorldFactRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_world_facts
        (id, campaign_id, title, kind, content, visibility, known_by_json, created_at, updated_at, superseded_at, superseded_by_archive_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         title = excluded.title,
         kind = excluded.kind,
         content = excluded.content,
         visibility = excluded.visibility,
         known_by_json = excluded.known_by_json,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         superseded_at = NULL,
         superseded_by_archive_id = NULL`,
      [row.id, row.campaign_id, row.title, row.kind, row.content, row.visibility,
       row.known_by_json, row.created_at, row.updated_at],
    );
  }

  async supersedeFactsNotIn(campaignId: string, keptIds: string[], archiveId: string, now: string): Promise<void> {
    const placeholders = keptIds.map(() => '?').join(',');
    const sql = keptIds.length > 0
      ? `UPDATE platform_world_facts SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL AND id NOT IN (${placeholders})`
      : `UPDATE platform_world_facts SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL`;
    await this.executor.execute(sql, keptIds.length > 0 ? [now, archiveId, campaignId, ...keptIds] : [now, archiveId, campaignId]);
  }
}
