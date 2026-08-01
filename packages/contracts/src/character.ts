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
