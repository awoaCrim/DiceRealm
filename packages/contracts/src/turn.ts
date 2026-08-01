import { z } from 'zod';

/** 回合状态机与结构化 AI 结算 contract。 */

export const turnStatusSchema = z.enum([
  'waiting_for_actions',
  'locked',
  'resolving',
  'needs_owner_attention',
  'completed',
]);

export type TurnStatus = z.infer<typeof turnStatusSchema>;

/** 结果可见性：任何产出内容都只按该枚举投影。 */
export const visibilitySchema = z.enum(['public', 'player_private', 'owner_only']);

export type Visibility = z.infer<typeof visibilitySchema>;

export const privateUpdateSchema = z.object({
  playerId: z.string().min(1),
  content: z.string(),
});

export type PrivateUpdate = z.infer<typeof privateUpdateSchema>;

export const diceResultSchema = z.object({
  id: z.string().min(1),
  formula: z.string().min(1),
  total: z.number().int(),
  visibility: visibilitySchema,
});

export type DiceResult = z.infer<typeof diceResultSchema>;

export const stateChangeKindSchema = z.enum(['character', 'world', 'combat', 'quest']);

export type StateChangeKind = z.infer<typeof stateChangeKindSchema>;

export const stateChangeSchema = z.object({
  kind: stateChangeKindSchema,
  targetId: z.string().min(1),
  patch: z.record(z.string(), z.unknown()),
  visibility: visibilitySchema,
});

export type StateChange = z.infer<typeof stateChangeSchema>;

export const interactionRequestSchema = z.object({
  id: z.string().min(1),
  targetPlayerId: z.string().min(1),
  prompt: z.string(),
});

export type InteractionRequest = z.infer<typeof interactionRequestSchema>;

export const turnResolutionSchema = z.object({
  publicNarrative: z.string(),
  privateUpdates: z.array(privateUpdateSchema),
  diceResults: z.array(diceResultSchema),
  stateChanges: z.array(stateChangeSchema),
  interactionRequests: z.array(interactionRequestSchema),
});

export type TurnResolution = z.infer<typeof turnResolutionSchema>;
