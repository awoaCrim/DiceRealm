import { z } from 'zod';

/** 角色创建、审核与角色卡 contract。 */

export const characterStatusSchema = z.enum([
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'archived',
]);

export type CharacterStatus = z.infer<typeof characterStatusSchema>;

/** 角色基础信息：草稿与已审核角色共用，业务细节由后续任务扩展。 */
export const characterBaseSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  playerId: z.string().min(1),
  name: z.string().min(1),
  status: characterStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CharacterBase = z.infer<typeof characterBaseSchema>;

/** 玩家可编辑的角色草稿。 */
export const characterDraftSchema = characterBaseSchema.extend({
  status: z.literal('draft'),
  sheet: z.record(z.string(), z.unknown()).default({}),
});

export type CharacterDraft = z.infer<typeof characterDraftSchema>;

/** 提交审核后的角色。 */
export const characterReviewSchema = characterBaseSchema.extend({
  status: z.literal('pending_review'),
  sheet: z.record(z.string(), z.unknown()).default({}),
  submittedAt: z.string(),
});

export type CharacterReview = z.infer<typeof characterReviewSchema>;

/** 拥有者审核通过后生效的角色卡，含审计来源的派生值。 */
export const approvedCharacterSchema = characterBaseSchema.extend({
  status: z.literal('approved'),
  sheet: z.record(z.string(), z.unknown()).default({}),
  approvedAt: z.string(),
  derived: z.record(z.string(), z.unknown()).default({}),
});

export type ApprovedCharacter = z.infer<typeof approvedCharacterSchema>;

/** 派生值来源记录，用于 AC/HP/速度/豁免/技能的审计。 */
export const derivedValueSourceSchema = z.object({
  value: z.number(),
  sources: z.array(z.string()).default([]),
});

export type DerivedValueSource = z.infer<typeof derivedValueSourceSchema>;

/** 派生值集合：key 为派生值名（ac/hp/speed/saves/skills 等）。 */
export const characterDerivedValuesSchema = z.record(
  z.string(),
  derivedValueSourceSchema,
).default({});

export type CharacterDerivedValues = z.infer<typeof characterDerivedValuesSchema>;

/** 玩家创建/更新角色的输入：名称去空格后非空，sheet 默认空对象。 */
export const characterDraftInputSchema = z.object({
  name: z.string().trim().min(1),
  sheet: z.record(z.string(), z.unknown()).default({}),
});

export type CharacterDraftInput = z.infer<typeof characterDraftInputSchema>;

/** 拥有者审核动作：approve 通过 / reject 退回。 */
export const characterReviewActionSchema = z.enum(['approve', 'reject']);

export type CharacterReviewAction = z.infer<typeof characterReviewActionSchema>;

/** 拥有者退回后的角色：可再次编辑并重新提交。 */
export const characterRejectedSchema = characterBaseSchema.extend({
  status: z.literal('rejected'),
  sheet: z.record(z.string(), z.unknown()).default({}),
});

export type CharacterRejected = z.infer<typeof characterRejectedSchema>;

/** 玩家可见的其它已批准角色安全摘要（不含他人 sheet/derived 内部结构）。 */
export const approvedCharacterSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  playerId: z.string().min(1),
});

export type ApprovedCharacterSummary = z.infer<typeof approvedCharacterSummarySchema>;

/** 角色投影：我的草稿/我的待审/我的已退回/我的已批准（完整角色）+ owner 待审队列 + party 已批准安全摘要。 */
export const characterProjectionSchema = z.object({
  myDrafts: z.array(characterDraftSchema),
  myPending: z.array(characterReviewSchema),
  myRejected: z.array(characterRejectedSchema),
  myApproved: z.array(approvedCharacterSchema),
  reviews: z.array(characterReviewSchema),
  approvedSummaries: z.array(approvedCharacterSummarySchema),
});

export type CharacterProjection = z.infer<typeof characterProjectionSchema>;
