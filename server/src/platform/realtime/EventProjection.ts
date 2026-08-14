import { campaignEventSchema, canReadEvent, type CampaignEvent, type EventViewer } from '@dnd/contracts';
import type { OutboxEventRow } from '../events/OutboxRepository.js';

/** 投影失败：受控内部错误，绝不携带原始 payload / parse 细节。 */
export class EventProjectionError extends Error {
  constructor(readonly sequence: number) {
    super('事件投影失败');
    this.name = 'EventProjectionError';
  }
}

/**
 * 唯一事件投影：replay 与 live 共用同一函数，保证重连前后一致。
 * 1. JSON parse + campaignEventSchema.parse；
 * 2. 校验 payload campaignId/type 与行一致；
 * 3. canReadEvent(viewer, event) 可见性过滤；
 * 4. 返回 CampaignEvent | null（不可见）；parse/行列不一致抛 EventProjectionError（不含原始 payload）。
 */
export function projectEvent(viewer: EventViewer, row: OutboxEventRow): CampaignEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    throw new EventProjectionError(row.sequence);
  }
  const event = campaignEventSchema.safeParse(parsed);
  if (!event.success) {
    throw new EventProjectionError(row.sequence);
  }
  if (event.data.campaignId !== row.campaign_id || event.data.type !== row.event_type) {
    throw new EventProjectionError(row.sequence);
  }
  return canReadEvent(viewer, event.data) ? event.data : null;
}
