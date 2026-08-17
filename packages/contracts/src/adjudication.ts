import { z } from 'zod';
import {
  actionIntentProposalSchema,
  actionIntentSchema,
  stateChangeSchema,
  type ActionIntent,
  type ActionIntentProposal,
  type ValidatedStateChange,
} from './runtime.js';
import { encounterStartSchema } from './combat.js';
import { interactionRequestSchema } from './turn.js';
import { worldFactInputSchema } from './world.js';

/** Server-controlled adjudication result kinds. */
export const adjudicationDecisionKindSchema = z.enum([
  'automatic_success',
  'automatic_failure',
  'roll_required',
  'player_choice_required',
  'gm_adjudication_required',
  'unsupported',
]);
export type AdjudicationDecisionKind = z.infer<typeof adjudicationDecisionKindSchema>;

export const adjudicationDecisionSchema = z.object({
  id: z.string().min(1),
  intentId: z.string().min(1),
  kind: adjudicationDecisionKindSchema,
  reasonCode: z.string().trim().min(1).max(120),
  ruleRef: z.string().min(1).max(160).optional(),
  rollPlanId: z.string().min(1).optional(),
  basedOnStateRevision: z.number().int().nonnegative(),
}).strict();
export type AdjudicationDecision = z.infer<typeof adjudicationDecisionSchema>;

export const rollKindSchema = z.enum(['d20_check', 'attack', 'saving_throw', 'damage', 'healing']);
export type RollKind = z.infer<typeof rollKindSchema>;

export const advantageStateSchema = z.enum(['normal', 'advantage', 'disadvantage']);
export type AdvantageState = z.infer<typeof advantageStateSchema>;

export const targetTypeSchema = z.enum(['dc', 'ac', 'none']);
export type TargetType = z.infer<typeof targetTypeSchema>;

export const modifierBreakdownSchema = z.object({
  source: z.string().trim().min(1).max(160),
  value: z.number().int(),
}).strict();
export type ModifierBreakdown = z.infer<typeof modifierBreakdownSchema>;

export const rollPlanSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  intentId: z.string().min(1),
  executionId: z.string().min(1),
  actorId: z.string().min(1),
  targetIds: z.array(z.string().min(1)).max(64),
  rollKind: rollKindSchema,
  diceExpression: z.string().regex(/^([1-9]|1[0-9]|20)d(4|6|8|10|12|20|100)$/),
  modifierBreakdown: z.array(modifierBreakdownSchema).max(32),
  advantageState: advantageStateSchema,
  targetType: targetTypeSchema,
  targetValue: z.number().int().nullable(),
  successEffects: z.array(z.string().trim().min(1).max(160)).max(32),
  failureEffects: z.array(z.string().trim().min(1).max(160)).max(32),
  ruleRefs: z.array(z.string().trim().min(1).max(160)).max(32),
  rulesetId: z.string().trim().min(1).max(160),
  rulesetVersion: z.string().trim().min(1).max(80),
  basedOnStateRevision: z.number().int().nonnegative(),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  lockedAt: z.string().min(1),
}).strict();
export type RollPlan = z.infer<typeof rollPlanSchema>;

export const rollRecordResultSchema = z.enum([
  'success',
  'failure',
  'critical_success',
  'critical_failure',
  'not_applicable',
]);
export type RollRecordResult = z.infer<typeof rollRecordResultSchema>;

export const rollRecordSchema = z.object({
  id: z.string().min(1),
  rollPlanId: z.string().min(1),
  actionIntentId: z.string().min(1),
  executionId: z.string().min(1),
  mutationId: z.string().min(1),
  rawDice: z.array(z.number().int().min(1).max(100)).max(64),
  selectedDice: z.array(z.number().int().min(1).max(100)).max(64),
  modifierBreakdown: z.array(modifierBreakdownSchema).max(32),
  total: z.number().int(),
  targetValue: z.number().int().nullable(),
  result: rollRecordResultSchema,
  rulesetId: z.string().trim().min(1).max(160),
  rulesetVersion: z.string().trim().min(1).max(80),
  stateRevision: z.number().int().nonnegative(),
  rolledAt: z.string().min(1),
}).strict();
export type RollRecord = z.infer<typeof rollRecordSchema>;

/** Provider-facing semantic interpretation. This schema is intentionally strict. */
export { actionIntentProposalSchema };
export type { ActionIntentProposal };

/** Server-normalized intent record. */
export const normalizedActionIntentSchema = actionIntentSchema.extend({
  intentId: z.string().min(1),
  sourceInput: z.string().min(1),
  basedOnStateRevision: z.number().int().nonnegative(),
}).strict();
export type NormalizedActionIntent = z.infer<typeof normalizedActionIntentSchema>;

/**
 * Shape-only mechanical outcome. Runtime validation brands are supplied by the
 * server validator, never by this schema parser.
 */
export const mechanicalEffectSchema = z.object({
  kind: z.literal('hp_delta'),
  targetId: z.string().min(1),
  delta: z.number().int(),
  reason: z.string().trim().min(1).max(160),
}).strict();
export type MechanicalEffect = z.infer<typeof mechanicalEffectSchema>;

export const mechanicalResolvedOutcomeSchema = z.object({
  id: z.string().min(1).optional(),
  executionId: z.string().min(1),
  campaignId: z.string().min(1),
  turnId: z.string().min(1),
  basedOnStateRevision: z.number().int().nonnegative(),
  appliedStateRevision: z.number().int().nonnegative().optional(),
  intents: z.array(normalizedActionIntentSchema).max(128),
  decisions: z.array(adjudicationDecisionSchema).max(128),
  rollPlans: z.array(rollPlanSchema).max(256),
  rollRecords: z.array(rollRecordSchema).max(256),
  stateChanges: z.array(stateChangeSchema).max(256),
  worldFactCreations: z.array(worldFactInputSchema).max(128),
  encounterStarts: z.array(encounterStartSchema).max(16),
  interactionRequests: z.array(interactionRequestSchema).max(128),
  effects: z.array(mechanicalEffectSchema).max(256),
}).strict();
export type MechanicalResolvedOutcome = Omit<z.infer<typeof mechanicalResolvedOutcomeSchema>, 'stateChanges'> & {
  stateChanges: ValidatedStateChange[];
};

export const narrationAudienceSchema = z.enum(['player_public', 'player_private', 'owner']);
export type NarrationAudience = z.infer<typeof narrationAudienceSchema>;

/** Player-observable roll projection. Internal targets, modifiers and raw dice stay Owner-only. */
export const observableRollSchema = z.object({
  kind: rollKindSchema,
  selectedDice: z.array(z.number().int().min(1).max(100)).max(64),
  total: z.number().int(),
  result: rollRecordResultSchema,
}).strict();
export type ObservableRoll = z.infer<typeof observableRollSchema>;

export const narrationRequestSchema = z.object({
  outcomeId: z.string().min(1),
  executionId: z.string().min(1),
  campaignId: z.string().min(1),
  turnId: z.string().min(1),
  stateRevision: z.number().int().nonnegative(),
  audience: narrationAudienceSchema,
  actionSummaries: z.array(z.object({ actionId: z.string().min(1), actorId: z.string().min(1), text: z.string() }).strict()).max(128),
  observableOutcome: z.object({
    publicNarrative: z.string().min(1).optional(),
    effects: z.array(z.string().trim().min(1)).max(256),
    rolls: z.array(observableRollSchema).max(256),
  }).strict(),
}).strict();
export type NarrationRequest = z.infer<typeof narrationRequestSchema>;

export const narrationOutputSchema = z.object({
  publicNarrative: z.string().min(1),
  privateUpdates: z.array(z.object({ playerId: z.string().min(1), content: z.string() }).strict()).default([]),
}).strict();
export type NarrationOutput = z.infer<typeof narrationOutputSchema>;
