import { z } from 'zod';

/** 领域事件：SSE 推送的是领域事件而非原始数据库行。每个 variant 都带 campaignId（outbox 按 campaign 分片）。 */

export const campaignEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('player.joined'), campaignId: z.string().min(1), playerId: z.string().min(1) }),
  z.object({ type: z.literal('turn.action_submitted'), campaignId: z.string().min(1), turnId: z.string().min(1), playerId: z.string().min(1) }),
  z.object({ type: z.literal('turn.locked'), campaignId: z.string().min(1), turnId: z.string().min(1) }),
  z.object({ type: z.literal('ai.preview.started'), campaignId: z.string().min(1), runId: z.string().min(1) }),
  z.object({ type: z.literal('ai.preview.delta'), campaignId: z.string().min(1), runId: z.string().min(1), text: z.string() }),
  z.object({ type: z.literal('ai.preview.failed'), campaignId: z.string().min(1), runId: z.string().min(1), code: z.string() }),
  z.object({ type: z.literal('turn.resolved'), campaignId: z.string().min(1), turnId: z.string().min(1), archiveId: z.string().min(1) }),
  z.object({ type: z.literal('narrative.decision.claimed'), campaignId: z.string().min(1), roundId: z.string().min(1), decisionId: z.string().min(1), actorId: z.string().min(1) }),
  z.object({ type: z.literal('narrative.decision.resolved'), campaignId: z.string().min(1), roundId: z.string().min(1), decisionId: z.string().min(1), stateRevision: z.number().int().nonnegative() }),
  z.object({ type: z.literal('narrative.round.closed'), campaignId: z.string().min(1), roundId: z.string().min(1), factSetId: z.string().min(1), stateRevision: z.number().int().nonnegative() }),
  z.object({ type: z.literal('combat.updated'), campaignId: z.string().min(1), encounterId: z.string().min(1) }),
  z.object({ type: z.literal('interaction.requested'), campaignId: z.string().min(1), requestId: z.string().min(1), targetPlayerId: z.string().min(1) }),
  z.object({ type: z.literal('archive.restored'), campaignId: z.string().min(1), archiveId: z.string().min(1), version: z.number().int() }),
  // owner-only debug（AI 上下文、输入输出原始记录等）；Phase 2A 定义但不 emit，Phase 3 由 AI 结算写入。
  z.object({ type: z.literal('owner.debug'), campaignId: z.string().min(1), runId: z.string().min(1), kind: z.string().min(1) }),
]);

export type CampaignEvent = z.infer<typeof campaignEventSchema>;

export const campaignEventTypeSchema = z.enum([
  'player.joined',
  'turn.action_submitted',
  'turn.locked',
  'ai.preview.started',
  'ai.preview.delta',
  'ai.preview.failed',
  'turn.resolved',
  'narrative.decision.claimed',
  'narrative.decision.resolved',
  'narrative.round.closed',
  'combat.updated',
  'interaction.requested',
  'archive.restored',
  'owner.debug',
]);

export type CampaignEventType = z.infer<typeof campaignEventTypeSchema>;

/** 事件可见性受众：public/owner_only 无目标玩家（targetPlayerId 必为 null）；player_private 必填目标玩家。 */
export const campaignEventAudienceSchema = z.discriminatedUnion('visibility', [
  z.object({ visibility: z.literal('public'), targetPlayerId: z.null() }),
  z.object({ visibility: z.literal('owner_only'), targetPlayerId: z.null() }),
  z.object({ visibility: z.literal('player_private'), targetPlayerId: z.string().min(1) }),
]);

export type CampaignEventAudience = z.infer<typeof campaignEventAudienceSchema>;

/** 每个事件的默认受众：owner.debug → owner_only；interaction.requested → 目标玩家；其余 → public。
 *  ai.preview.* 与 ai.preview.failed 对 player 可见（失败时客户端丢弃预览并显示可恢复错误）。 */
export function eventDefaultAudience(event: CampaignEvent): CampaignEventAudience {
  switch (event.type) {
    case 'owner.debug':
      return { visibility: 'owner_only', targetPlayerId: null };
    case 'interaction.requested':
      return { visibility: 'player_private', targetPlayerId: event.targetPlayerId };
    default:
      return { visibility: 'public', targetPlayerId: null };
  }
}

/** 事件观看者：owner 全量；player 只见 public + 自己的 player_private。 */
export interface EventViewer {
  role: 'owner' | 'player';
  playerId: string | null;
}

/** 唯一事件投影规则：Phase 3 的 SSE live 与 replay 复用同一函数，保证重连前后一致。 */
export function canReadEvent(viewer: EventViewer, event: CampaignEvent): boolean {
  if (viewer.role === 'owner') {
    return true;
  }
  const audience = eventDefaultAudience(event);
  if (audience.visibility === 'public') {
    return true;
  }
  if (audience.visibility === 'player_private') {
    return viewer.playerId != null && audience.targetPlayerId === viewer.playerId;
  }
  return false;
}
