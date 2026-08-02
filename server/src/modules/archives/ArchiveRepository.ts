import type { ArchiveKind } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface ArchiveRow {
  id: string;
  campaign_id: string;
  kind: ArchiveKind;
  turn_id: string | null;
  label: string | null;
  version: number;
  state_json: string;
  created_by_user_id: string;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
  created_at: string;
}

export class ArchiveRepository {
  constructor(private readonly executor: QueryExecutor) {}

  /** per-campaign version 原子分配：upsert 计数器 + RETURNING；绝不 MAX+1。 */
  async nextVersion(tx: QueryExecutor, campaignId: string): Promise<number> {
    const rows = await tx.query<{ last_version: number }>(
      `INSERT INTO platform_archive_sequences (campaign_id, last_version)
       VALUES (?, 1)
       ON CONFLICT (campaign_id) DO UPDATE SET last_version = platform_archive_sequences.last_version + 1
       RETURNING last_version`,
      [campaignId],
    );
    return Number(rows[0].last_version);
  }

  async insert(tx: QueryExecutor, row: ArchiveRow): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_archives
        (id, campaign_id, kind, turn_id, label, version, state_json, created_by_user_id, superseded_at, superseded_by_archive_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.kind, row.turn_id, row.label, row.version,
       row.state_json, row.created_by_user_id, row.superseded_at, row.superseded_by_archive_id, row.created_at],
    );
  }

  async findById(id: string): Promise<ArchiveRow | null> {
    const rows = await this.executor.query<ArchiveRow>('SELECT * FROM platform_archives WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  async listByCampaign(campaignId: string): Promise<ArchiveRow[]> {
    return this.executor.query<ArchiveRow>(
      'SELECT * FROM platform_archives WHERE campaign_id = ? AND superseded_at IS NULL ORDER BY version ASC', [campaignId],
    );
  }

  /** 恢复：选中 archive 自身解除 superseded 标记，重新成为当前 active checkpoint
   *  （version > target 的更新存档仍保持 superseded；version counter 不回退）。 */
  async clearSuperseded(archiveId: string): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_archives SET superseded_at = NULL, superseded_by_archive_id = NULL WHERE id = ?', [archiveId],
    );
  }

  async maxOutboxSequence(campaignId: string): Promise<number> {
    const rows = await this.executor.query<{ max: number | null }>(
      'SELECT MAX(sequence) AS max FROM platform_outbox_events WHERE campaign_id = ?', [campaignId],
    );
    return Number(rows[0].max ?? 0);
  }

  async maxAiRunSequence(campaignId: string): Promise<number> {
    const rows = await this.executor.query<{ max: number | null }>(
      'SELECT MAX(campaign_sequence) AS max FROM platform_ai_runs WHERE campaign_id = ?', [campaignId],
    );
    return Number(rows[0].max ?? 0);
  }
}
