import { z } from 'zod';
import { visibilitySchema } from './turn.js';

/** AI Provider 与结构化结算 contract。 */

export const aiPromptSchema = z.object({
  campaignId: z.string().min(1),
  audience: visibilitySchema,
  system: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    }),
  ),
  /** 结构化已批准角色（id/playerId/name）：provider 与测试脚本直接从该字段读成员 id，
   *  不再解析人类可读 prompt 字符串；不含 sheet/derived 之外的敏感详情。 */
  characters: z.array(
    z.object({
      id: z.string().min(1),
      playerId: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
});
export type AiPrompt = z.infer<typeof aiPromptSchema>;

export const aiProviderKindSchema = z.enum(['mock', 'scripted', 'unavailable', 'openai-compatible']);
export type AiProviderKind = z.infer<typeof aiProviderKindSchema>;

export const aiProviderConfigSchema = z.object({
  provider: aiProviderKindSchema,
  baseUrl: z.string().min(1).default(''),
  model: z.string().min(1).default(''),
  apiKey: z.string().default(''),
});
export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;

/** 返回给前端的脱敏 Provider 配置，永远不包含 API Key。 */
export const aiProviderPublicConfigSchema = z.object({
  provider: aiProviderKindSchema,
  baseUrl: z.string().min(1).default(''),
  model: z.string().min(1).default(''),
  configured: z.boolean(),
});
export type AiProviderPublicConfig = z.infer<typeof aiProviderPublicConfigSchema>;

/** AI run 结算生命周期：claim 置 running，成功 succeeded / 失败 failed。 */
export const aiRunStatusSchema = z.enum(['running', 'succeeded', 'failed']);
export type AiRunStatus = z.infer<typeof aiRunStatusSchema>;

/** resolve 请求体：idempotencyKey 必填受限长度。 */
export const resolveTurnInputSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(64),
});
export type ResolveTurnInput = z.infer<typeof resolveTurnInputSchema>;

/** AI run 视图（owner 可读；不含 context/result/rawDebug 敏感字段）。 */
export const aiRunViewSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  campaignSequence: z.number().int(),
  turnId: z.string().min(1),
  attempt: z.number().int(),
  idempotencyKey: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  status: aiRunStatusSchema,
  errorCode: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  superseded: z.boolean(),
});
export type AiRunView = z.infer<typeof aiRunViewSchema>;

/** owner AI run 详情：附加 context/result/rawDebug（仅 owner view，普通 player 不可读）。 */
export const aiRunDetailSchema = aiRunViewSchema.extend({
  context: z.unknown(),
  result: z.unknown(),
  rawDebug: z.unknown(),
});
export type AiRunDetail = z.infer<typeof aiRunDetailSchema>;

export const turnEntryKindSchema = z.enum(['narrative', 'private_update', 'dice_result']);
export type TurnEntryKind = z.infer<typeof turnEntryKindSchema>;

/** turn entry DTO：owner 全量；player 只见 public + 自己的 private（投影在 service）。 */
export const turnEntrySchema = z.object({
  id: z.string().min(1),
  aiRunId: z.string().min(1),
  turnId: z.string().min(1),
  campaignId: z.string().min(1),
  entryKind: turnEntryKindSchema,
  entryIndex: z.number().int(),
  visibility: visibilitySchema,
  targetPlayerId: z.string().nullable(),
  payload: z.unknown(),
  createdAt: z.string(),
});
export type TurnEntry = z.infer<typeof turnEntrySchema>;

export const interactionRequestViewSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  turnId: z.string().min(1),
  aiRunId: z.string().min(1),
  targetPlayerId: z.string().min(1),
  prompt: z.string(),
  status: z.enum(['pending', 'answered']),
  createdAt: z.string(),
});
export type InteractionRequestView = z.infer<typeof interactionRequestViewSchema>;
