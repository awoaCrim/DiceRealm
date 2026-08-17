import { z } from 'zod';
import { visibilitySchema } from './visibility.js';
import { damageDieSchema } from './combat.js';

/** Authority is a fact-source/precedence label, not an audience permission. */
export const authoritySchema = z.enum(['system', 'ruleset', 'campaign', 'gm', 'world', 'scene', 'actor', 'ai_inferred']);
export type Authority = z.infer<typeof authoritySchema>;

/** Context-only audience semantics. Existing persisted Visibility remains unchanged. */
export const contextVisibilitySchema = z.enum(['server_only', 'gm_only', 'actor_private', 'party', 'campaign', 'public']);
export type ContextVisibility = z.infer<typeof contextVisibilitySchema>;

export const contextBlockTypeSchema = z.enum([
  'system_policy', 'ruleset_policy', 'campaign_runtime', 'scene_state',
  'actor_state', 'actor_knowledge', 'recent_action', 'player_input', 'resolution_contract',
]);
export type ContextBlockType = z.infer<typeof contextBlockTypeSchema>;

export const contextSourceRefSchema = z.string().regex(/^[a-z][a-z0-9_-]*:[A-Za-z0-9._~:/-]+$/).max(256);
export type ContextSourceRef = z.infer<typeof contextSourceRefSchema>;
export const contextPrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export type ContextPriority = z.infer<typeof contextPrioritySchema>;

export const contextBlockSchema = z.object({
  id: z.string().min(1).max(128),
  type: contextBlockTypeSchema,
  content: z.string().max(100_000),
  sourceRefs: z.array(contextSourceRefSchema).max(32),
  authority: authoritySchema,
  visibility: contextVisibilitySchema,
  priority: contextPrioritySchema,
  /** Actor scope for actor-private blocks; omitted for public/GM-scoped blocks. */
  audienceActorIds: z.array(z.string().min(1)).max(32).optional(),
  estimatedTokens: z.number().int().nonnegative().max(1_000_000).optional(),
}).strict();
export type ContextBlock = z.infer<typeof contextBlockSchema>;

export const contextTraceReasonSchema = z.enum([
  'required', 'scope_match', 'actor_knowledge', 'visibility_denied',
  'not_relevant', 'budget_dropped', 'legacy_source',
]);
export type ContextTraceReason = z.infer<typeof contextTraceReasonSchema>;
export const contextTraceEntrySchema = z.object({
  actionId: z.string().min(1).max(128), blockId: z.string().min(1).max(128), sourceRef: contextSourceRefSchema,
  included: z.boolean(), reason: contextTraceReasonSchema,
  estimatedTokens: z.number().int().nonnegative().max(1_000_000).optional(),
}).strict();
export type ContextTraceEntry = z.infer<typeof contextTraceEntrySchema>;
export const contextTraceSchema = z.object({ actionId: z.string().min(1).max(128), entries: z.array(contextTraceEntrySchema).max(10_000) }).strict();
export type ContextTrace = z.infer<typeof contextTraceSchema>;

export const stateRevisionSchema = z.object({
  campaignId: z.string().min(1), revision: z.number().int().nonnegative(), mutationId: z.string().min(1),
  causeType: z.string().trim().min(1).max(80), causeId: z.string().min(1).optional(), createdAt: z.string().min(1),
}).strict();
export type StateRevision = z.infer<typeof stateRevisionSchema>;

export const actionModeSchema = z.enum(['player_action', 'npc_action', 'owner_command']);
export type ActionMode = z.infer<typeof actionModeSchema>;

export const actionTypeSchema = z.enum([
  'ability_check',
  'attack',
  'saving_throw',
  'healing',
  'use_action',
  'improvised_action',
]);
export type ActionType = z.infer<typeof actionTypeSchema>;

export const fallbackPolicySchema = z.enum(['stop_on_failure', 'continue', 'ask_player']);
export type FallbackPolicy = z.infer<typeof fallbackPolicySchema>;

/** Provider-facing action interpretation. Mechanical values are deliberately absent. */
export const actionIntentProposalSchema = z.object({
  actionId: z.string().min(1),
  actorId: z.string().min(1),
  mode: actionModeSchema,
  actionType: actionTypeSchema,
  actionRef: z.string().trim().min(1).max(160).optional(),
  targetIds: z.array(z.string().min(1)).max(64).default([]),
  declaredApproach: z.string().max(4_000).optional(),
  desiredOutcome: z.string().max(4_000).optional(),
  resourceChoices: z.array(z.string().trim().min(1).max(160)).max(32).default([]),
  fallbackPolicy: fallbackPolicySchema.optional(),
}).strict();
export type ActionIntentProposal = z.infer<typeof actionIntentProposalSchema>;

/**
 * Normalized runtime intent. Optional defaults keep the pre-adjudication
 * compatibility contract readable, while formal server paths should use the
 * stricter normalizedActionIntentSchema exported from adjudication.ts.
 */
export const actionIntentSchema = z.object({
  actionId: z.string().min(1),
  campaignId: z.string().min(1),
  actorId: z.string().min(1),
  input: z.string().min(1),
  mode: actionModeSchema.default('player_action'),
  actionType: actionTypeSchema.default('improvised_action'),
  actionRef: z.string().trim().min(1).max(160).optional(),
  targetIds: z.array(z.string().min(1)).max(64).default([]),
  declaredApproach: z.string().max(4_000).optional(),
  desiredOutcome: z.string().max(4_000).optional(),
  resourceChoices: z.array(z.string().trim().min(1).max(160)).max(32).default([]),
  fallbackPolicy: fallbackPolicySchema.optional(),
  basedOnStateRevision: z.number().int().nonnegative().optional(),
}).strict();
export type ActionIntent = z.infer<typeof actionIntentSchema>;
/**
 * Generic runtime summary contract. This is not the formal AI turn outcome;
 * the turn module owns the ResolvedOutcome contract.
 */
export const runtimeOutcomeSchema = z.object({ summary: z.string().min(1), facts: z.array(z.string().min(1)).default([]) }).strict();
export type RuntimeOutcome = z.infer<typeof runtimeOutcomeSchema>;

export const narrativeOutputSchema = z.object({
  publicNarrative: z.string().min(1),
  privateUpdates: z.array(z.object({ playerId: z.string().min(1), content: z.string() }).strict()).default([]),
}).strict();
export type NarrativeOutput = z.infer<typeof narrativeOutputSchema>;

export const characterPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  sheet: z.object({
    hpCurrent: z.number().int().optional(), hpMax: z.number().int().optional(), ac: z.number().int().optional(),
    gold: z.number().int().optional(), level: z.number().int().optional(), experience: z.number().int().optional(),
    conditions: z.array(z.string()).optional(), inventory: z.array(z.string()).optional(),
  }).strict().optional(),
}).strict();
export const worldPatchSchema = z.object({
  title: z.string().trim().min(1).optional(), content: z.string().optional(), visibility: visibilitySchema.optional(), knownBy: z.array(z.string().min(1)).optional(),
}).strict();
const combatCommandPatch = z.discriminatedUnion('command', [
  z.object({ command: z.literal('roll_initiative') }).strict(),
  z.object({ command: z.literal('advance_turn') }).strict(),
  z.object({
    command: z.literal('apply_attack'),
    actorCombatantId: z.string().min(1), targetCombatantId: z.string().min(1),
    attackBonus: z.number().int(), damageDie: damageDieSchema,
    damageDice: z.number().int().min(1).max(20), damageBonus: z.number().int(),
  }).strict(),
  z.object({
    command: z.literal('apply_saving_throw'),
    actorCombatantId: z.string().min(1), targetCombatantId: z.string().min(1),
    saveBonus: z.number().int(), dc: z.number().int().min(0), damageOnFailure: z.number().int().min(0),
  }).strict(),
  z.object({
    command: z.literal('apply_damage'),
    actorCombatantId: z.string().min(1), targetCombatantId: z.string().min(1), amount: z.number().int().min(0),
  }).strict(),
  z.object({
    command: z.literal('apply_healing'),
    actorCombatantId: z.string().min(1), targetCombatantId: z.string().min(1), amount: z.number().int().min(0),
  }).strict(),
  z.object({
    command: z.literal('add_condition'),
    actorCombatantId: z.string().min(1), targetCombatantId: z.string().min(1), condition: z.string().trim().min(1),
  }).strict(),
  z.object({
    command: z.literal('remove_condition'),
    actorCombatantId: z.string().min(1), targetCombatantId: z.string().min(1), condition: z.string().trim().min(1),
  }).strict(),
  z.object({ command: z.literal('end_encounter') }).strict(),
]);
// Legacy combat output used a direct hpCurrent patch. Keep that narrow
// compatibility input at the shared boundary; CombatAiAdapter still rejects it
// unless its domain command adapter explicitly supports the operation.
const combatPatch = z.union([
  combatCommandPatch,
  z.object({ hpCurrent: z.number().int() }).strict(),
]);
export const characterStateChangeSchema = z.object({ kind: z.literal('character'), targetId: z.string().min(1), patch: characterPatchSchema, visibility: visibilitySchema }).strict();
export const worldStateChangeSchema = z.object({ kind: z.literal('world'), targetId: z.string().min(1), patch: worldPatchSchema, visibility: visibilitySchema }).strict();
export const questStateChangeSchema = z.object({ kind: z.literal('quest'), targetId: z.string().min(1), patch: worldPatchSchema, visibility: visibilitySchema }).strict();
export const combatStateChangeSchema = z.object({ kind: z.literal('combat'), targetId: z.string().min(1), patch: combatPatch, visibility: visibilitySchema }).strict();
export const stateChangeSchema = z.discriminatedUnion('kind', [characterStateChangeSchema, worldStateChangeSchema, questStateChangeSchema, combatStateChangeSchema]);
export type StateChange = z.infer<typeof stateChangeSchema>;

/**
 * A StateChange emitted by the Provider is a proposal only. It becomes
 * authoritative only after the server has checked its schema, campaign
 * ownership, and domain constraints.
 */
export const proposedStateChangeSchema = stateChangeSchema;
export type ProposedStateChange = z.infer<typeof proposedStateChangeSchema>;

const validatedStateChangeBrand = Symbol('validatedStateChangeBrand');
export type ValidatedStateChange = ProposedStateChange & {
  readonly [validatedStateChangeBrand]: true;
};

/** Internal boundary helper: only call after all server/domain checks pass. */
export function markStateChangeValidated(change: ProposedStateChange): ValidatedStateChange {
  return { ...change, [validatedStateChangeBrand]: true } as ValidatedStateChange;
}

/** Runtime guard used by materializers to fail closed if a proposal crosses the seam. */
export function isValidatedStateChange(change: unknown): change is ValidatedStateChange {
  return Boolean(change && typeof change === 'object' && (change as Record<PropertyKey, unknown>)[validatedStateChangeBrand] === true);
}

export function contextVisibilityFromPersisted(visibility: z.infer<typeof visibilitySchema>): ContextVisibility {
  if (visibility === 'owner_only') return 'gm_only';
  if (visibility === 'player_private') return 'actor_private';
  return 'public';
}
