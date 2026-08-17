import { z } from 'zod';
import { visibilitySchema } from './visibility.js';
import { turnSummarySchema, turnActionSchema } from './turn.js';
import { worldFactKindSchema } from './world.js';
import { characterStatusSchema } from './character.js';
import { encounterStatusSchema } from './combat.js';
import {
  narrativeDecisionSchema,
  narrativeRoundParticipantSchema,
  narrativeRoundSchema,
  roundFactSetSchema,
  workingFactSchema,
} from './narrative.js';

/** 存档 contract：owner 创建/恢复；真实快照 + 真实恢复，不物理删除历史。 */

export const archiveKindSchema = z.enum(['automatic', 'manual']);
export type ArchiveKind = z.infer<typeof archiveKindSchema>;

/** manual 存档输入：label 必填 trimmed。automatic label=null（不经此 schema）。 */
export const manualArchiveInputSchema = z.object({
  label: z.string().trim().min(1),
});
export type ManualArchiveInput = z.infer<typeof manualArchiveInputSchema>;

export const archiveSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  kind: archiveKindSchema,
  turnId: z.string().nullable(),
  label: z.string().nullable(),
  version: z.number().int(),
  superseded: z.boolean(),
  createdByUserId: z.string().min(1),
  createdAt: z.string(),
});
export type Archive = z.infer<typeof archiveSchema>;

/** 快照角色：完整 owner current state（draft/pending_review/rejected/approved/archived 全保留），
 *  不含 audit / password / invite hash / 原始 DB 列名。 */
export const archiveSnapshotCharacterSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  playerId: z.string().min(1),
  name: z.string().min(1),
  status: characterStatusSchema,
  sheet: z.record(z.string(), z.unknown()),
  derived: z.record(z.string(), z.unknown()),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ArchiveSnapshotCharacter = z.infer<typeof archiveSnapshotCharacterSchema>;

/** 快照世界事实：与 WorldFact DTO 同形（不含 *_json 内部字段）。 */
export const archiveSnapshotWorldFactSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  title: z.string().min(1),
  kind: worldFactKindSchema,
  content: z.string(),
  visibility: visibilitySchema,
  knownBy: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ArchiveSnapshotWorldFact = z.infer<typeof archiveSnapshotWorldFactSchema>;

export const archiveSnapshotRequirementSchema = z.object({
  playerId: z.string().min(1),
  submitted: z.boolean(),
});
export type ArchiveSnapshotRequirement = z.infer<typeof archiveSnapshotRequirementSchema>;

export const archiveSnapshotTurnSchema = z.object({
  turn: turnSummarySchema,
  actions: z.array(turnActionSchema),
  requirements: z.array(archiveSnapshotRequirementSchema),
});
export type ArchiveSnapshotTurn = z.infer<typeof archiveSnapshotTurnSchema>;

/** 快照：schemaVersion=1；currentTurn 可为 null（setup / 无进行中回合）；watermarks 记录历史边界。 */
export const archiveSnapshotV1Schema = z.object({
  schemaVersion: z.literal(1),
  campaignId: z.string().min(1),
  ruleset: z.string().min(1),
  characters: z.array(archiveSnapshotCharacterSchema),
  worldFacts: z.array(archiveSnapshotWorldFactSchema),
  currentTurn: archiveSnapshotTurnSchema.nullable(),
  watermarks: z.object({
    outboxSequence: z.number().int(),
    aiRunCampaignSequence: z.number().int(),
    /** 捕获时 unsuperseded 历史最大 turn number（setup 无回合 = 0）。 */
    turnNumber: z.number().int(),
  }),
});
export type ArchiveSnapshotV1 = z.infer<typeof archiveSnapshotV1Schema>;

/** 快照战斗员：完整 unsuperseded 战斗员行（无 superseded_at/superseded_by_archive_id，恢复时按快照语义 upsert）。 */
export const archiveSnapshotCombatantSchema = z.object({
  id: z.string().min(1),
  encounterId: z.string().min(1),
  campaignId: z.string().min(1),
  characterId: z.string().min(1).nullable(),
  name: z.string().min(1),
  initiative: z.number().int().nullable(),
  initiativeBonus: z.number().int(),
  hpCurrent: z.number().int(),
  hpMax: z.number().int(),
  ac: z.number().int(),
  conditions: z.array(z.string()).default([]),
  visibility: visibilitySchema,
  targetPlayerId: z.string().min(1).nullable(),
  position: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict().superRefine((combatant, ctx) => {
  if (combatant.visibility === 'player_private' && !combatant.targetPlayerId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'player_private combatant 必须指定 targetPlayerId。' });
  }
  if (combatant.visibility !== 'player_private' && combatant.targetPlayerId !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'public/owner_only combatant 的 targetPlayerId 必须为 null。' });
  }
});
export type ArchiveSnapshotCombatant = z.infer<typeof archiveSnapshotCombatantSchema>;

/** 快照遭遇（encounter 行 + 其战斗员）。 */
export const archiveSnapshotEncounterSchema = z.object({
  encounter: z.object({
    id: z.string().min(1),
    campaignId: z.string().min(1),
    name: z.string().min(1),
    status: encounterStatusSchema,
    activeCombatantId: z.string().min(1).nullable(),
    round: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  combatants: z.array(archiveSnapshotCombatantSchema),
});
export type ArchiveSnapshotEncounter = z.infer<typeof archiveSnapshotEncounterSchema>;

/** 当前 active NarrativeRound 的可选快照；旧 v2 snapshot 没有此字段时走兼容恢复。 */
export const archiveSnapshotNarrativeSchema = z.object({
  round: narrativeRoundSchema,
  participants: z.array(narrativeRoundParticipantSchema),
  decisions: z.array(narrativeDecisionSchema),
  workingFacts: z.array(workingFactSchema),
  factSet: roundFactSetSchema.nullable(),
}).strict();
export type ArchiveSnapshotNarrative = z.infer<typeof archiveSnapshotNarrativeSchema>;

/** 快照：schemaVersion=2；在 v1 公共字段基础上加入必填完整 encounters（可空数组，无战斗=[]）。 */
export const archiveSnapshotV2Schema = z.object({
  schemaVersion: z.literal(2),
  campaignId: z.string().min(1),
  ruleset: z.string().min(1),
  characters: z.array(archiveSnapshotCharacterSchema),
  worldFacts: z.array(archiveSnapshotWorldFactSchema),
  currentTurn: archiveSnapshotTurnSchema.nullable(),
  encounters: z.array(archiveSnapshotEncounterSchema),
  /** Optional so old v2 archives remain readable without inventing facts. */
  narrative: archiveSnapshotNarrativeSchema.nullable().optional(),
  watermarks: z.object({
    outboxSequence: z.number().int(),
    aiRunCampaignSequence: z.number().int(),
    /** 捕获时 unsuperseded 历史最大 turn number（setup 无回合 = 0）。 */
    turnNumber: z.number().int(),
  }),
});
export type ArchiveSnapshotV2 = z.infer<typeof archiveSnapshotV2Schema>;

/** 快照 v1/v2 判别联合：consumers 必须按 schemaVersion 显式 narrow。 */
export const archiveSnapshotSchema = z.discriminatedUnion('schemaVersion', [
  archiveSnapshotV1Schema,
  archiveSnapshotV2Schema,
]);
export type ArchiveSnapshot = z.infer<typeof archiveSnapshotSchema>;

export const archiveRestoreResultSchema = z.object({
  archive: archiveSchema,
  restoredTurnId: z.string().nullable(),
});
export type ArchiveRestoreResult = z.infer<typeof archiveRestoreResultSchema>;

export const archiveListEntrySchema = archiveSchema;
export type ArchiveListEntry = z.infer<typeof archiveListEntrySchema>;
