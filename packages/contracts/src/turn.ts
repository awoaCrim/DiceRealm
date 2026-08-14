import { z } from 'zod';
import { visibilitySchema, type Visibility } from './visibility.js';
import { worldFactInputSchema } from './world.js';
import { encounterStartSchema } from './combat.js';

export { visibilitySchema };
export type { Visibility };

/** 回合状态机与结构化 AI 结算 contract。 */

export const turnStatusSchema = z.enum([
  'waiting_for_actions',
  'locked',
  'resolving',
  'needs_owner_attention',
  'completed',
]);

export type TurnStatus = z.infer<typeof turnStatusSchema>;

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
  /** player_private 必填非空；public/owner_only 必为 null。 */
  targetPlayerId: z.string().min(1).nullable(),
}).superRefine((dice, ctx) => {
  if (dice.visibility === 'player_private' && !dice.targetPlayerId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'player_private dice result 必须指定 targetPlayerId。' });
  }
  if (dice.visibility !== 'player_private' && dice.targetPlayerId !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'public/owner_only dice result 的 targetPlayerId 必须为 null。' });
  }
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

/** 公开叙事必填非空：空叙事视为无效输出（invalid 测试不再依赖 combat 触发）。 */
export const turnResolutionSchema = z.object({
  publicNarrative: z.string().min(1),
  /** 这些集合语义上允许“无条目”；Provider 省略时统一规范化为 []，已提供条目仍走原嵌套 schema。 */
  privateUpdates: z.array(privateUpdateSchema).default([]),
  diceResults: z.array(diceResultSchema).default([]),
  stateChanges: z.array(stateChangeSchema).default([]),
  interactionRequests: z.array(interactionRequestSchema).default([]),
  /** AI 新增世界事实（创建式：id/时间戳由服务端生成）；旧 provider 输出缺省解析为 []。 */
  worldFactCreations: z.array(worldFactInputSchema).default([]),
  /** AI 发起遭遇（创建式：encounter/combatant id 由服务端生成；rollInitiative 默认 true 服务端掷先攻）。 */
  encounterStarts: z.array(encounterStartSchema).default([]),
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
