import { z } from 'zod';
import { visibilitySchema } from './turn';

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
});

export type AiPrompt = z.infer<typeof aiPromptSchema>;

export type AiProviderKind = 'mock' | 'openai-compatible';

export const aiProviderKindSchema = z.enum(['mock', 'openai-compatible']);

export const aiProviderConfigSchema = z.object({
  provider: aiProviderKindSchema,
  baseUrl: z.string().min(1),
  model: z.string().min(1),
  apiKey: z.string(),
});

export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;

/** 返回给前端的脱敏 Provider 配置，永远不包含 API Key。 */
export const aiProviderPublicConfigSchema = z.object({
  provider: aiProviderKindSchema,
  baseUrl: z.string().min(1),
  model: z.string().min(1),
  configured: z.boolean(),
});

export type AiProviderPublicConfig = z.infer<typeof aiProviderPublicConfigSchema>;

export const aiRunStatusSchema = z.enum([
  'pending',
  'previewing',
  'resolved',
  'failed',
]);

export type AiRunStatus = z.infer<typeof aiRunStatusSchema>;
