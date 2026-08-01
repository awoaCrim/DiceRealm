import { z } from 'zod';

/** 领域事件：SSE 推送的是领域事件而非原始数据库行。 */

export const campaignEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('player.joined'),
    campaignId: z.string(),
    playerId: z.string(),
  }),
  z.object({
    type: z.literal('turn.action_submitted'),
    turnId: z.string(),
    playerId: z.string(),
  }),
  z.object({
    type: z.literal('turn.locked'),
    turnId: z.string(),
  }),
  z.object({
    type: z.literal('ai.preview.started'),
    runId: z.string(),
  }),
  z.object({
    type: z.literal('ai.preview.delta'),
    runId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('ai.preview.failed'),
    runId: z.string(),
    code: z.string(),
  }),
  z.object({
    type: z.literal('turn.resolved'),
    turnId: z.string(),
    archiveId: z.string(),
  }),
  z.object({
    type: z.literal('combat.updated'),
    encounterId: z.string(),
  }),
  z.object({
    type: z.literal('interaction.requested'),
    requestId: z.string(),
  }),
]);

export type CampaignEvent = z.infer<typeof campaignEventSchema>;

/** 事件名联合：用于事件投影和 Outbox 的轻量枚举。 */
export const campaignEventTypeSchema = z.enum([
  'player.joined',
  'turn.action_submitted',
  'turn.locked',
  'ai.preview.started',
  'ai.preview.delta',
  'ai.preview.failed',
  'turn.resolved',
  'combat.updated',
  'interaction.requested',
]);

export type CampaignEventType = z.infer<typeof campaignEventTypeSchema>;
