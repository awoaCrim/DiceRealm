import { z } from 'zod';

/** 战役与成员 contract。 */

export const campaignStatusSchema = z.enum(['setup', 'active', 'archived']);

export type CampaignStatus = z.infer<typeof campaignStatusSchema>;

export const campaignSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().min(1),
  status: campaignStatusSchema,
  ruleset: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Campaign = z.infer<typeof campaignSchema>;

export const campaignMemberSchema = z.object({
  campaignId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(['owner', 'player']),
  joinedAt: z.string(),
});

export type CampaignMember = z.infer<typeof campaignMemberSchema>;

export const campaignSummarySchema = campaignSchema
  .pick({ id: true, name: true, status: true, ruleset: true, updatedAt: true })
  .extend({ role: z.enum(['owner', 'player']) });

export type CampaignSummary = z.infer<typeof campaignSummarySchema>;

export const campaignViewSchema = z.object({
  campaign: campaignSchema,
  members: z.array(campaignMemberSchema),
});

export type CampaignView = z.infer<typeof campaignViewSchema>;

export const createCampaignInputSchema = z.object({
  name: z.string().min(1),
  ruleset: z.string().min(1),
});

export type CreateCampaignInput = z.infer<typeof createCampaignInputSchema>;

/**
 * 创建战役的响应：战役本身 + 仅在创建时向创建者返回的一次性邀请码。
 * 邀请码不落库（库中只存哈希），也不出现在后续任何列表/详情 DTO 中。
 */
export const createCampaignResultSchema = z.object({
  campaign: campaignSchema,
  inviteCode: z.string().min(1),
});

export type CreateCampaignResult = z.infer<typeof createCampaignResultSchema>;

export const campaignSettingsPatchSchema = z.object({
  name: z.string().min(1).optional(),
});

export type CampaignSettingsPatch = z.infer<typeof campaignSettingsPatchSchema>;
