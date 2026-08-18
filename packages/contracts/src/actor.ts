import { z } from 'zod';

/** Stable identity of a world actor inside one campaign. */
export const actorCharacterTypeSchema = z.enum(['player_character', 'npc']);
export type ActorCharacterType = z.infer<typeof actorCharacterTypeSchema>;

export const actorControlModeSchema = z.enum(['player', 'ai', 'gm', 'shared', 'scripted']);
export type ActorControlMode = z.infer<typeof actorControlModeSchema>;

export const actorMechanicsModeSchema = z.enum(['pc_build', 'npc_statblock', 'lightweight']);
export type ActorMechanicsMode = z.infer<typeof actorMechanicsModeSchema>;

export const campaignActorSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  displayName: z.string().trim().min(1).max(160),
  characterType: actorCharacterTypeSchema,
  controlMode: actorControlModeSchema,
  mechanicsMode: actorMechanicsModeSchema,
  characterId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict().superRefine((actor, ctx) => {
  if (actor.characterType === 'player_character' && actor.characterId === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['characterId'], message: 'player_character 必须关联 authoring character。' });
  }
  if (actor.characterType === 'npc' && actor.mechanicsMode === 'pc_build') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mechanicsMode'], message: 'npc 不能使用 pc_build mechanicsMode。' });
  }
});
export type CampaignActor = z.infer<typeof campaignActorSchema>;

export const actorBindingRoleSchema = z.enum(['player', 'gm', 'operator']);
export type ActorBindingRole = z.infer<typeof actorBindingRoleSchema>;

export const actorControlBindingSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  actorId: z.string().min(1),
  userId: z.string().min(1).nullable(),
  bindingRole: actorBindingRoleSchema,
  active: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict().superRefine((binding, ctx) => {
  if (binding.bindingRole === 'player' && binding.userId === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['userId'], message: 'player binding 必须绑定 user。' });
  }
});
export type ActorControlBinding = z.infer<typeof actorControlBindingSchema>;

export const characterRuntimeStatusSchema = z.enum(['active', 'incapacitated', 'defeated', 'inactive']);
export type CharacterRuntimeStatus = z.infer<typeof characterRuntimeStatusSchema>;

export const runtimeConditionSchema = z.string().trim().min(1).max(64);
export const characterRuntimeStateSchema = z.object({
  campaignId: z.string().min(1),
  actorId: z.string().min(1),
  currentHp: z.number().int().nonnegative(),
  temporaryHp: z.number().int().nonnegative(),
  conditions: z.array(runtimeConditionSchema).max(32),
  runtimeStatus: characterRuntimeStatusSchema,
  stateRevision: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
}).strict().superRefine((state, ctx) => {
  if (new Set(state.conditions).size !== state.conditions.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['conditions'], message: 'conditions 不得重复。' });
  }
});
export type CharacterRuntimeState = z.infer<typeof characterRuntimeStateSchema>;

export const createNpcActorInputSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  controlMode: z.enum(['ai', 'gm', 'shared', 'scripted']).default('ai'),
  mechanicsMode: z.enum(['npc_statblock', 'lightweight']).default('lightweight'),
  currentHp: z.number().int().nonnegative().default(1),
  temporaryHp: z.number().int().nonnegative().default(0),
  conditions: z.array(runtimeConditionSchema).max(32).default([]),
}).strict();
export type CreateNpcActorInput = z.input<typeof createNpcActorInputSchema>;

export const runtimeMutationEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('damage'), amount: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('healing'), amount: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('add_condition'), condition: runtimeConditionSchema }).strict(),
  z.object({ kind: z.literal('remove_condition'), condition: runtimeConditionSchema }).strict(),
]);
export type RuntimeMutationEffect = z.infer<typeof runtimeMutationEffectSchema>;
