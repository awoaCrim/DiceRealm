import { z } from 'zod';
import { visibilitySchema } from './visibility.js';

/** Runtime lifecycle of the narrative round. Turn status remains a compatibility projection. */
export const narrativeRoundStatusSchema = z.enum([
  'collecting',
  'ready',
  'processing',
  'needs_owner_attention',
  'closed',
]);
export type NarrativeRoundStatus = z.infer<typeof narrativeRoundStatusSchema>;

export const narrativeParticipantStatusSchema = z.enum([
  'waiting',
  'submitted',
  'processing',
  'resolved',
  'skipped',
  'needs_owner_attention',
]);
export type NarrativeParticipantStatus = z.infer<typeof narrativeParticipantStatusSchema>;

export const narrativeDecisionStatusSchema = narrativeParticipantStatusSchema;
export type NarrativeDecisionStatus = z.infer<typeof narrativeDecisionStatusSchema>;

/** Projection audience is deliberately distinct from persisted Visibility. */
export const narrativeProjectionAudienceSchema = z.enum([
  'party',
  'actor_private',
  'gm_only',
  'server_only',
]);
export type NarrativeProjectionAudience = z.infer<typeof narrativeProjectionAudienceSchema>;

/** Fact authority is not the same enum as ContextBlock authority. */
export const factAuthoritySchema = z.enum([
  'server_mechanical',
  'runtime_state',
  'event_evidence',
  'ai_candidate',
]);
export type FactAuthority = z.infer<typeof factAuthoritySchema>;

export const factSourceKindSchema = z.enum([
  'state_transaction',
  'mechanical_resolved_outcome',
  'narrative_decision',
  'narration_result',
  'turn_or_narrative_event',
  'gm_authored',
]);
export type FactSourceKind = z.infer<typeof factSourceKindSchema>;

export const factValidationStatusSchema = z.enum([
  'authoritative',
  'candidate',
  'pending',
  'rejected',
]);
export type FactValidationStatus = z.infer<typeof factValidationStatusSchema>;

/** Stable, bounded source reference. Never contains raw Provider text or database JSON. */
export const factSourceRefSchema = z.string().regex(/^[a-z][a-z0-9_-]*:[A-Za-z0-9._~:/-]+$/).max(256);
export type FactSourceRef = z.infer<typeof factSourceRefSchema>;

export const factProvenanceSchema = z.object({
  roundId: z.string().min(1),
  decisionId: z.string().min(1).nullable(),
  actionId: z.string().min(1).nullable(),
  executionId: z.string().min(1).nullable(),
  outcomeId: z.string().min(1).nullable(),
  eventId: z.string().min(1).nullable(),
  basedOnStateRevision: z.number().int().nonnegative(),
  appliedStateRevision: z.number().int().nonnegative().nullable(),
  sourceRefs: z.array(factSourceRefSchema).min(1).max(32),
}).strict();
export type FactProvenance = z.infer<typeof factProvenanceSchema>;

export const narrativeRoundSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  turnId: z.string().min(1),
  number: z.number().int().nonnegative(),
  status: narrativeRoundStatusSchema,
  decisionCursor: z.number().int().nonnegative(),
  lastStateRevision: z.number().int().nonnegative(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  superseded: z.boolean(),
}).strict();
export type NarrativeRound = z.infer<typeof narrativeRoundSchema>;

export const narrativeRoundParticipantSchema = z.object({
  roundId: z.string().min(1),
  campaignId: z.string().min(1),
  playerId: z.string().min(1),
  /** New live identity; null only for legacy participant rows. */
  actorId: z.string().min(1).nullable(),
  characterId: z.string().min(1).nullable(),
  participantOrder: z.number().int().nonnegative(),
  required: z.boolean(),
  status: narrativeParticipantStatusSchema,
}).strict();
export type NarrativeRoundParticipant = z.infer<typeof narrativeRoundParticipantSchema>;

export const narrativeDecisionSchema = z.object({
  id: z.string().min(1),
  roundId: z.string().min(1),
  campaignId: z.string().min(1),
  turnId: z.string().min(1),
  actionId: z.string().min(1).nullable(),
  actorId: z.string().min(1),
  decisionOrder: z.number().int().nonnegative(),
  status: narrativeDecisionStatusSchema,
  executionId: z.string().min(1).nullable(),
  outcomeId: z.string().min(1).nullable(),
  claimRevision: z.number().int().nonnegative().nullable(),
  appliedStateRevision: z.number().int().nonnegative().nullable(),
  failureCode: z.string().min(1).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  superseded: z.boolean(),
}).strict();
export type NarrativeDecision = z.infer<typeof narrativeDecisionSchema>;

const factPayloadSchema = z.record(z.string(), z.unknown());

export const workingFactSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  roundId: z.string().min(1),
  decisionId: z.string().min(1).nullable(),
  actionId: z.string().min(1).nullable(),
  factKind: z.string().trim().min(1).max(120),
  payload: factPayloadSchema,
  visibility: visibilitySchema,
  audienceActorIds: z.array(z.string().min(1)).max(32),
  authority: factAuthoritySchema,
  validationStatus: factValidationStatusSchema,
  sourceKind: factSourceKindSchema,
  provenance: factProvenanceSchema,
  createdAt: z.string(),
  superseded: z.boolean(),
}).strict();
export type WorkingFact = z.infer<typeof workingFactSchema>;
export type WorkingFactInput = Omit<WorkingFact, 'id' | 'createdAt' | 'superseded'> & {
  id?: string;
  createdAt?: string;
};

export const roundFactSchema = workingFactSchema.extend({
  factSetId: z.string().min(1),
}).strict();
export type RoundFact = z.infer<typeof roundFactSchema>;

export const roundFactSetSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  roundId: z.string().min(1),
  sourceStateRevision: z.number().int().nonnegative(),
  closedAt: z.string(),
  facts: z.array(roundFactSchema),
  superseded: z.boolean(),
}).strict();
export type RoundFactSet = z.infer<typeof roundFactSetSchema>;

export const projectedRoundSummarySchema = z.object({
  roundId: z.string().min(1),
  roundNumber: z.number().int().nonnegative(),
  factSetId: z.string().min(1),
  audience: narrativeProjectionAudienceSchema,
  actorId: z.string().min(1).nullable(),
  stateRevision: z.number().int().nonnegative(),
  facts: z.array(roundFactSchema),
  sourceRefs: z.array(factSourceRefSchema).max(256),
}).strict();
export type ProjectedRoundSummary = z.infer<typeof projectedRoundSummarySchema>;

export interface RuntimeFactPromotionCommand {
  campaignId: string;
  roundFact: RoundFact;
  requestedBy: string;
}

export interface RuntimeFactPromotionResult {
  accepted: boolean;
  runtimeFactId?: string;
  reason?: 'candidate_pending' | 'already_promoted' | 'rejected';
}

/** Future long-term persistence port; this task intentionally has no SQL implementation. */
export interface RuntimeFactRepository {
  promote(command: RuntimeFactPromotionCommand): Promise<RuntimeFactPromotionResult>;
}

export interface ActorKnowledgeUpdateProposal {
  campaignId: string;
  actorId: string;
  roundFactId: string;
  relation: 'known' | 'believed' | 'suspected';
  confidence?: number;
  sourceRefs: FactSourceRef[];
}

/** Future epistemic projection port; no belief/propagation implementation in this task. */
export interface ActorKnowledgeRepository {
  proposeUpdate(proposal: ActorKnowledgeUpdateProposal): Promise<{ accepted: boolean }>;
  listForActor(campaignId: string, actorId: string): Promise<readonly RoundFact[]>;
}

export interface NarrativeFactExtractionInput {
  campaignId: string;
  roundId: string;
  decisionId: string;
  narrationResult: unknown;
  sourceRefs: FactSourceRef[];
}

export interface CandidateNarrativeFact extends Omit<WorkingFact, 'id' | 'createdAt' | 'superseded' | 'authority' | 'validationStatus' | 'sourceKind'> {
  authority: 'ai_candidate';
  validationStatus: 'candidate' | 'pending' | 'rejected';
  sourceKind: 'narration_result';
}

/** Future text extraction seam; implementation must never write authoritative facts directly. */
export interface NarrativeFactExtractor {
  extract(input: NarrativeFactExtractionInput): Promise<readonly CandidateNarrativeFact[]>;
}

export interface RoundCloseContributorInput {
  campaignId: string;
  round: NarrativeRound;
  participants: readonly NarrativeRoundParticipant[];
  decisions: readonly NarrativeDecision[];
  workingFacts: readonly WorkingFact[];
}

/** Close-time seam for future world ticks/authored contributors. */
export interface RoundCloseContributor {
  contribute(input: RoundCloseContributorInput): Promise<readonly WorkingFactInput[]>;
}
