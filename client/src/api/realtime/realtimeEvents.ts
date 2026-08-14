import { campaignEventSchema, type CampaignEvent } from '@dnd/contracts';

/** 解析 SSE frame：id 必须是安全非负整数；无法解析返回 null（脱敏丢弃）。 */
export function parseSequence(lastEventId: string): number | null {
  if (lastEventId === '' || typeof lastEventId !== 'string') {
    return null;
  }
  const value = Number(lastEventId);
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/** 解析 SSE data JSON 为领域事件；contract 失败返回 null（脱敏跳过，不重放）。 */
export function parseCampaignEvent(
  rawData: string,
): CampaignEvent | null {
  if (typeof rawData !== 'string' || rawData.length === 0) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(rawData);
  } catch {
    return null;
  }
  const parsed = campaignEventSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}
