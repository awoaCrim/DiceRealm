import type { AiRunStatus } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface AiRunRow {
  id: string;
  campaign_id: string;
  campaign_sequence: number;
  turn_id: string;
  attempt: number;
  idempotency_key: string;
  provider: string;
  model: string;
  status: AiRunStatus;
  context_json: string;
  result_json: string | null;
  error_code: string | null;
  error_json: string | null;
  raw_debug_json: string | null;
  started_at: string;
  completed_at: string | null;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
}

export interface AiRunInsertRow {
  id: string;
  campaign_id: string;
  campaign_sequence: number;
  turn_id: string;
  attempt: number;
  idempotency_key: string;
  provider: string;
  model: string;
  status: AiRunStatus;
  context_json: string;
  result_json: string | null;
  error_code: string | null;
  error_json: string | null;
  raw_debug_json: string | null;
  started_at: string;
  completed_at: string | null;
}

export class AiRunRepository {
  constructor(private readonly executor: QueryExecutor) {}

  /** 每战役 AI run 序列原子分配：upsert 计数器 + RETURNING（与 outbox nextSequence 同模式）。 */
  async nextCampaignSequence(tx: QueryExecutor, campaignId: string): Promise<number> {
    const rows = await tx.query<{ last_seq: number }>(
      `INSERT INTO platform_ai_run_sequences (campaign_id, last_seq)
       VALUES (?, 1)
       ON CONFLICT (campaign_id) DO UPDATE SET last_seq = platform_ai_run_sequences.last_seq + 1
       RETURNING last_seq`,
      [campaignId],
    );
    return Number(rows[0].last_seq);
  }

  /** attempt 在 turn 锁内单调分配：该 turn 已有最大 attempt + 1。 */
  async maxAttempt(tx: QueryExecutor, turnId: string): Promise<number> {
    const rows = await tx.query<{ max: number | null }>(
      'SELECT MAX(attempt) AS max FROM platform_ai_runs WHERE turn_id = ?',
      [turnId],
    );
    return Number(rows[0].max ?? 0);
  }

  async insertRun(tx: QueryExecutor, row: AiRunInsertRow): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_ai_runs
        (id, campaign_id, campaign_sequence, turn_id, attempt, idempotency_key,
         provider, model, status, context_json, result_json, error_code, error_json,
         raw_debug_json, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.campaign_sequence, row.turn_id, row.attempt,
       row.idempotency_key, row.provider, row.model, row.status, row.context_json,
       row.result_json, row.error_code, row.error_json, row.raw_debug_json,
       row.started_at, row.completed_at],
    );
  }

  /** 幂等查询：同 key 同 campaign 的既有 run（claim 前置检查）。 */
  async findByIdempotencyKey(tx: QueryExecutor, campaignId: string, idempotencyKey: string): Promise<AiRunRow | null> {
    const rows = await tx.query<AiRunRow>(
      'SELECT * FROM platform_ai_runs WHERE campaign_id = ? AND idempotency_key = ?',
      [campaignId, idempotencyKey],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<AiRunRow | null> {
    const rows = await this.executor.query<AiRunRow>('SELECT * FROM platform_ai_runs WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  /** 默认 active 查询：排除 superseded 的 run。 */
  async listByTurn(turnId: string): Promise<AiRunRow[]> {
    return this.executor.query<AiRunRow>(
      'SELECT * FROM platform_ai_runs WHERE turn_id = ? AND superseded_at IS NULL ORDER BY attempt ASC',
      [turnId],
    );
  }

  async findRunningRun(campaignId: string): Promise<AiRunRow | null> {
    const rows = await this.executor.query<AiRunRow>(
      "SELECT * FROM platform_ai_runs WHERE campaign_id = ? AND status = 'running' AND superseded_at IS NULL ORDER BY campaign_sequence ASC LIMIT 1",
      [campaignId],
    );
    return rows[0] ?? null;
  }

  /** 条件成功：仅当仍为 running 时置 succeeded（防并发重复应用）。 */
  async markSucceeded(tx: QueryExecutor, runId: string, resultJson: string, rawDebugJson: string, completedAt: string): Promise<boolean> {
    const result = await tx.execute(
      `UPDATE platform_ai_runs SET status = 'succeeded', result_json = ?, raw_debug_json = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
      [resultJson, rawDebugJson, completedAt, runId],
    );
    return result.changes === 1;
  }

  /** 条件失败：仅当仍为 running 时置 failed。 */
  async markFailed(tx: QueryExecutor, runId: string, errorCode: string, errorJson: string, rawDebugJson: string, completedAt: string): Promise<boolean> {
    const result = await tx.execute(
      `UPDATE platform_ai_runs SET status = 'failed', error_code = ?, error_json = ?, raw_debug_json = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
      [errorCode, errorJson, rawDebugJson, completedAt, runId],
    );
    return result.changes === 1;
  }

  /** 恢复：按 AI run campaign watermark 标记 run 及其 entries/requests superseded。 */
  async supersedeByWatermark(tx: QueryExecutor, campaignId: string, archiveId: string, watermark: number, now: string): Promise<void> {
    await tx.execute(
      'UPDATE platform_ai_runs SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL AND campaign_sequence > ?',
      [now, archiveId, campaignId, watermark],
    );
    await tx.execute(
      `UPDATE platform_turn_entries SET superseded_at = ?, superseded_by_archive_id = ?
       WHERE campaign_id = ? AND superseded_at IS NULL
         AND ai_run_id IN (SELECT id FROM platform_ai_runs WHERE campaign_id = ? AND campaign_sequence > ?)`,
      [now, archiveId, campaignId, campaignId, watermark],
    );
    await tx.execute(
      `UPDATE platform_interaction_requests SET superseded_at = ?, superseded_by_archive_id = ?
       WHERE campaign_id = ? AND superseded_at IS NULL
         AND ai_run_id IN (SELECT id FROM platform_ai_runs WHERE campaign_id = ? AND campaign_sequence > ?)`,
      [now, archiveId, campaignId, campaignId, watermark],
    );
  }
}
