import { nanoid } from 'nanoid';
import { campaignEventSchema, eventDefaultAudience, type CampaignEvent, type CampaignEventType } from '@dnd/contracts';
import type { QueryExecutor, QueryReader } from '../database/DatabasePort.js';
import type { EventPublisherPort } from './EventPublisherPort.js';

/** Outbox 数据源：publishIn 需要写能力（QueryExecutor）；listAfter 只读（QueryReader）。 */
type OutboxExecutor = QueryExecutor | QueryReader;

export interface OutboxEventRow {
  id: string;
  campaign_id: string;
  sequence: number;
  event_type: string;
  visibility: 'public' | 'owner_only' | 'player_private';
  target_player_id: string | null;
  payload_json: string;
  published_at: string | null;
  created_at: string;
  /** 007 superseded-history：被存档恢复覆盖的历史事件。publishIn 不写这两列（默认 NULL），读取时必可访问。 */
  superseded_at?: string | null;
  superseded_by_archive_id?: string | null;
}

/**
 * Outbox 具体实现：publishIn 使用传入的 tx（业务事务内）完成 schema 校验、
 * 计数器分配 + 事件插入，与业务写同事务提交/回滚；绝不持有外部 executor 后在 tx 中绕开。
 */
export class OutboxRepository implements EventPublisherPort {
  constructor(private readonly executor: OutboxExecutor) {}

  async publishIn(tx: QueryExecutor, event: CampaignEvent): Promise<number> {
    const parsed = campaignEventSchema.parse(event); // 校验每个 variant 的 campaignId 等
    const audience = eventDefaultAudience(parsed);
    const sequence = await nextSequence(tx, parsed.campaignId);
    await tx.execute(
      `INSERT INTO platform_outbox_events
        (id, campaign_id, sequence, event_type, visibility, target_player_id, payload_json, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [nanoid(24), parsed.campaignId, sequence, parsed.type, audience.visibility,
       audience.targetPlayerId, JSON.stringify(parsed), null, new Date().toISOString()],
    );
    return sequence;
  }

  /**
   * SSE tail：只读 active（未 superseded）事件，sequence > after 升序，带 LIMIT。
   * 生产只由 TransactionalOutboxTailReader 在 readCommitted callback 内调用，
   * 绝不从长期持有的外层 executor 裸读（SQLite 会看到未提交事务行）。
   */
  async listAfter(campaignId: string, after: number, limit: number): Promise<OutboxEventRow[]> {
    return this.executor.query<OutboxEventRow>(
      'SELECT * FROM platform_outbox_events WHERE campaign_id = ? AND superseded_at IS NULL AND sequence > ? ORDER BY sequence ASC LIMIT ?',
      [campaignId, after, limit],
    );
  }

  /** 默认 active 列表：只含未 superseded 的事件（存档恢复覆盖的历史事件默认不可见）。 */
  async listByCampaign(campaignId: string): Promise<OutboxEventRow[]> {
    return this.executor.query<OutboxEventRow>(
      'SELECT * FROM platform_outbox_events WHERE campaign_id = ? AND superseded_at IS NULL ORDER BY sequence ASC',
      [campaignId],
    );
  }

  async listUnpublished(campaignId: string): Promise<OutboxEventRow[]> {
    return this.executor.query<OutboxEventRow>(
      'SELECT * FROM platform_outbox_events WHERE campaign_id = ? AND published_at IS NULL AND superseded_at IS NULL ORDER BY sequence ASC',
      [campaignId],
    );
  }

  /**
   * Durable consumers use the outbox as a level-triggered wake-up feed.
   * `published_at` remains untouched because SSE delivery has its own cursor;
   * each consumer advances through its own durable receipt stream.
   */
  async listPendingByConsumer(
    eventType: CampaignEventType,
    consumerName: string,
    limit = 200,
  ): Promise<OutboxEventRow[]> {
    const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 200;
    const boundedLimit = Math.max(1, Math.min(normalizedLimit, 1000));
    return this.executor.query<OutboxEventRow>(
      `SELECT e.*
       FROM platform_outbox_events e
       LEFT JOIN platform_outbox_consumer_receipts r
         ON r.event_id = e.id AND r.consumer_name = ?
       WHERE e.event_type = ?
         AND e.published_at IS NULL
         AND e.superseded_at IS NULL
         AND r.event_id IS NULL
       ORDER BY e.created_at ASC, e.id ASC LIMIT ?`,
      [consumerName, eventType, boundedLimit],
    );
  }

  /** Record a handled event in the caller-owned transaction; duplicate receipts are harmless. */
  async markConsumerReceiptIn(
    tx: QueryExecutor,
    consumerName: string,
    eventId: string,
    handledAt = new Date().toISOString(),
  ): Promise<boolean> {
    const result = await tx.execute(
      `INSERT INTO platform_outbox_consumer_receipts (consumer_name, event_id, handled_at)
       VALUES (?, ?, ?)
       ON CONFLICT (consumer_name, event_id) DO NOTHING`,
      [consumerName, eventId, handledAt],
    );
    return result.changes === 1;
  }

  /** 审计全量列表：含被存档恢复 supersede 的历史事件（供 SSE replayable 未来使用与恢复 supersede 依据）。 */
  async listAllByCampaign(campaignId: string): Promise<OutboxEventRow[]> {
    return this.executor.query<OutboxEventRow>(
      'SELECT * FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence ASC',
      [campaignId],
    );
  }
}

/**
 * 每战役 sequence 原子分配：SQLite upsert 计数器 + RETURNING。
 * 绝不用“读取后 MAX+1”；UNIQUE(campaign_id, sequence) 仅作不变量兜底。
 * 在事务内调用：counter 与事件同事务，回滚时两者都不留。
 */
export async function nextSequence(tx: QueryExecutor, campaignId: string): Promise<number> {
  const rows = await tx.query<{ last_seq: number }>(
    `INSERT INTO platform_outbox_sequences (campaign_id, last_seq)
     VALUES (?, 1)
     ON CONFLICT (campaign_id) DO UPDATE SET last_seq = platform_outbox_sequences.last_seq + 1
     RETURNING last_seq`,
    [campaignId],
  );
  return Number(rows[0].last_seq);
}
