import { z } from 'zod';
import {
  aiRunDetailSchema,
  aiRunViewSchema,
  aiProviderPublicConfigSchema,
  aiProviderTestResultSchema,
  approvedCharacterSchema,
  archiveRestoreResultSchema,
  archiveSchema,
  authenticatedUserSchema,
  campaignMemberSchema,
  campaignSummarySchema,
  campaignViewSchema,
  characterDraftSchema,
  characterProjectionSchema,
  characterRejectedSchema,
  characterReviewSchema,
  createCampaignResultSchema,
  encounterSchema,
  ruleSourceSchema,
  sessionSchema,
  turnEntrySchema,
  turnListEntrySchema,
  turnOwnerViewSchema,
  turnPlayerViewSchema,
  turnSummarySchema,
  worldFactProjectionSchema,
  worldFactSchema,
} from '@dnd/contracts';

/** HTTP envelope schema 组合：feature API 模块只组合 URL/input/response，不做 unknown as。 */

export const userEnvelopeSchema = z.object({ user: authenticatedUserSchema });
export type UserEnvelope = z.infer<typeof userEnvelopeSchema>;

export const sessionEnvelopeSchema = z.object({ session: sessionSchema }).strict();
export type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

export const okEnvelopeSchema = z.object({ ok: z.literal(true) });
export type OkEnvelope = z.infer<typeof okEnvelopeSchema>;

export const campaignListEnvelopeSchema = z.object({ campaigns: z.array(campaignSummarySchema) });
export type CampaignListEnvelope = z.infer<typeof campaignListEnvelopeSchema>;

/** GET /api/campaigns/:campaignId 直接返回 campaign view（非包装）。 */
export const campaignDetailEnvelopeSchema = campaignViewSchema;

export const createCampaignEnvelopeSchema = createCampaignResultSchema;
export type CreateCampaignEnvelope = z.infer<typeof createCampaignEnvelopeSchema>;

export const joinEnvelopeSchema = z.object({ member: campaignMemberSchema });
export type JoinEnvelope = z.infer<typeof joinEnvelopeSchema>;

/** 204 / 空响应体（z.void 解析 undefined）。 */
export const noContentSchema = z.void();

/* ===== characters ===== */

export const characterProjectionEnvelopeSchema = z.object({
  projection: characterProjectionSchema,
});
export type CharacterProjectionEnvelope = z.infer<typeof characterProjectionEnvelopeSchema>;

export const characterDraftEnvelopeSchema = z.object({ character: characterDraftSchema });
export type CharacterDraftEnvelope = z.infer<typeof characterDraftEnvelopeSchema>;

export const characterReviewEnvelopeSchema = z.object({ character: characterReviewSchema });
export type CharacterReviewEnvelope = z.infer<typeof characterReviewEnvelopeSchema>;

/** review 动作结果：approve → approved；reject → rejected。 */
export const characterReviewResultEnvelopeSchema = z.object({
  character: z.union([approvedCharacterSchema, characterRejectedSchema]),
});
export type CharacterReviewResultEnvelope = z.infer<typeof characterReviewResultEnvelopeSchema>;

/* ===== turns ===== */

export const turnListEnvelopeSchema = z.object({ turns: z.array(turnListEntrySchema) });
export type TurnListEnvelope = z.infer<typeof turnListEnvelopeSchema>;

export const turnSummaryEnvelopeSchema = z.object({ turn: turnSummarySchema });
export type TurnSummaryEnvelope = z.infer<typeof turnSummaryEnvelopeSchema>;

/** GET /turns/:turnId 的 view：owner 见 actions，player 见 myAction。 */
export const turnViewEnvelopeSchema = z.object({
  view: z.union([turnOwnerViewSchema, turnPlayerViewSchema]),
});
export type TurnViewEnvelope = z.infer<typeof turnViewEnvelopeSchema>;

/* ===== ai ===== */

export const aiProviderStatusEnvelopeSchema = z.object({ provider: aiProviderPublicConfigSchema });
export type AiProviderStatusEnvelope = z.infer<typeof aiProviderStatusEnvelopeSchema>;

export const aiProviderTestResultEnvelopeSchema = aiProviderTestResultSchema;
export type AiProviderTestResultEnvelope = z.infer<typeof aiProviderTestResultEnvelopeSchema>;

export const aiRunHistoryEnvelopeSchema = z.object({ runs: z.array(aiRunViewSchema) });
export type AiRunHistoryEnvelope = z.infer<typeof aiRunHistoryEnvelopeSchema>;

export const aiRunEnvelopeSchema = z.object({ run: aiRunViewSchema });
export type AiRunEnvelope = z.infer<typeof aiRunEnvelopeSchema>;


export const aiRunListEnvelopeSchema = z.object({ runs: z.array(aiRunViewSchema) });
export type AiRunListEnvelope = z.infer<typeof aiRunListEnvelopeSchema>;

export const aiRunDetailEnvelopeSchema = z.object({ run: aiRunDetailSchema });
export type AiRunDetailEnvelope = z.infer<typeof aiRunDetailEnvelopeSchema>;

export const turnEntryListEnvelopeSchema = z.object({ entries: z.array(turnEntrySchema) });
export type TurnEntryListEnvelope = z.infer<typeof turnEntryListEnvelopeSchema>;

/* ===== rules ===== */

export const ruleSourceListEnvelopeSchema = z.object({ sources: z.array(ruleSourceSchema) });
export type RuleSourceListEnvelope = z.infer<typeof ruleSourceListEnvelopeSchema>;

export const ruleSourceEnvelopeSchema = z.object({ source: ruleSourceSchema });
export type RuleSourceEnvelope = z.infer<typeof ruleSourceEnvelopeSchema>;

/* ===== world ===== */

export const worldProjectionEnvelopeSchema = z.object({ projection: worldFactProjectionSchema });
export type WorldProjectionEnvelope = z.infer<typeof worldProjectionEnvelopeSchema>;

export const worldFactEnvelopeSchema = z.object({ fact: worldFactSchema });
export type WorldFactEnvelope = z.infer<typeof worldFactEnvelopeSchema>;

/* ===== combat ===== */

export const encounterListEnvelopeSchema = z.object({ encounters: z.array(encounterSchema) });
export type EncounterListEnvelope = z.infer<typeof encounterListEnvelopeSchema>;

export const encounterEnvelopeSchema = z.object({ encounter: encounterSchema });
export type EncounterEnvelope = z.infer<typeof encounterEnvelopeSchema>;

/* ===== archives ===== */

export const archiveListEnvelopeSchema = z.object({ archives: z.array(archiveSchema) });
export type ArchiveListEnvelope = z.infer<typeof archiveListEnvelopeSchema>;

export const archiveEnvelopeSchema = z.object({ archive: archiveSchema });
export type ArchiveEnvelope = z.infer<typeof archiveEnvelopeSchema>;

/** restore 响应是 { result: archiveRestoreResultSchema }，不是顶层 shape。 */
export const archiveRestoreEnvelopeSchema = z.object({ result: archiveRestoreResultSchema });
export type ArchiveRestoreEnvelope = z.infer<typeof archiveRestoreEnvelopeSchema>;
