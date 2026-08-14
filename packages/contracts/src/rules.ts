import { z } from 'zod';

/**
 * Rule-source registry stores immutable provenance metadata only. Neither this
 * contract nor the backing table contains imported rule text.
 */
export const ruleSourceScopeSchema = z.enum(['platform', 'campaign', 'user']);
export type RuleSourceScope = z.infer<typeof ruleSourceScopeSchema>;

/** SHA-256 of the external source file, computed locally before registration. */
export const ruleSourceContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/i);

/**
 * Owner registration input. Platform scope is deliberately excluded: global
 * sources may only be registered through a trusted server-side interface.
 */
export const ruleSourceRegistrationInputSchema = z.object({
  sourceName: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(100),
  license: z.string().trim().min(1).max(500),
  attribution: z.string().trim().min(1).max(1000),
  contentHash: ruleSourceContentHashSchema,
  scope: z.enum(['campaign', 'user']),
}).strict();

export type RuleSourceRegistrationInput = z.infer<typeof ruleSourceRegistrationInputSchema>;

/** Public metadata DTO. User ids and rule bodies are intentionally absent. */
export const ruleSourceSchema = z.object({
  id: z.string().min(1),
  sourceName: z.string().min(1),
  version: z.string().min(1),
  license: z.string().min(1),
  attribution: z.string().min(1),
  contentHash: ruleSourceContentHashSchema,
  scope: ruleSourceScopeSchema,
  campaignId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
}).strict();

export type RuleSource = z.infer<typeof ruleSourceSchema>;

export const ruleSourceListSchema = z.array(ruleSourceSchema);
