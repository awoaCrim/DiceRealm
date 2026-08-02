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

export const turnActionInputSchema = z.object({
  body: z.string().trim().min(1),
});
export type TurnActionInput = z.infer<typeof turnActionInputSchema>;

export const turnSummarySchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  number: z.number().int(),
  status: turnStatusSchema,
  lockedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TurnSummary = z.infer<typeof turnSummarySchema>;

export const turnActionSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  campaignId: z.string().min(1),
  playerId: z.string().min(1),
  body: z.string(),
  submittedAt: z.string(),
  updatedAt: z.string(),
});
export type TurnAction = z.infer<typeof turnActionSchema>;

export const turnProgressSchema = z.object({
  requiredPlayerIds: z.array(z.string().min(1)),
  submittedPlayerIds: z.array(z.string().min(1)),
  locked: z.boolean(),
});
export type TurnProgress = z.infer<typeof turnProgressSchema>;

/** 回合列表项：不含任何 action 正文。 */
export const turnListEntrySchema = z.object({
  turn: turnSummarySchema,
  progress: turnProgressSchema,
});
export type TurnListEntry = z.infer<typeof turnListEntrySchema>;

/** 玩家视角：只能看到自己的 action 正文。 */
export const turnPlayerViewSchema = z.object({
  turn: turnSummarySchema,
  myAction: turnActionSchema.nullable(),
  progress: turnProgressSchema,
});
export type TurnPlayerView = z.infer<typeof turnPlayerViewSchema>;

/** owner 视角：看到全部 action 正文。 */
export const turnOwnerViewSchema = z.object({
  turn: turnSummarySchema,
  actions: z.array(turnActionSchema),
  progress: turnProgressSchema,
});
export type TurnOwnerView = z.infer<typeof turnOwnerViewSchema>;
