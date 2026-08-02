import { nanoid } from 'nanoid';
import { campaignEventSchema, eventDefaultAudience, type CampaignEvent } from '@dnd/contracts';
import type { QueryExecutor } from '../database/DatabasePort.js';
import type { EventPublisherPort } from './EventPublisherPort.js';

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
}

/**
 * Outbox 具体实现：publishIn 使用传入的 tx（业务事务内）完成 schema 校验、
 * 计数器分配 + 事件插入，与业务写同事务提交/回滚；绝不持有外部 executor 后在 tx 中绕开。
 */
export class OutboxRepository implements EventPublisherPort {
  constructor(private readonly executor: QueryExecutor) {}

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

  async listByCampaign(campaignId: string): Promise<OutboxEventRow[]> {
    return this.executor.query<OutboxEventRow>(
      'SELECT * FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence ASC',
      [campaignId],
    );
  }

  async listUnpublished(campaignId: string): Promise<OutboxEventRow[]> {
    return this.executor.query<OutboxEventRow>(
      'SELECT * FROM platform_outbox_events WHERE campaign_id = ? AND published_at IS NULL ORDER BY sequence ASC',
      [campaignId],
    );
  }
}

/**
 * 每战役 sequence 原子分配：upsert 计数器 + RETURNING（SQLite >=3.35 与 Postgres 通用）。
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
