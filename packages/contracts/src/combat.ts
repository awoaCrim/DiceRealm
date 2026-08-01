import { z } from 'zod';
import { visibilitySchema, type Visibility } from './turn';

/** 结构化战斗 contract。 */

export const encounterStatusSchema = z.enum(['preparation', 'active', 'completed']);

export type EncounterStatus = z.infer<typeof encounterStatusSchema>;

export const combatantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  initiative: z.number().int().optional(),
  hpCurrent: z.number().int(),
  hpMax: z.number().int(),
  ac: z.number().int(),
  conditions: z.array(z.string()).default([]),
  visibility: visibilitySchema,
});

export type Combatant = z.infer<typeof combatantSchema>;

export const encounterSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  name: z.string().min(1),
  status: encounterStatusSchema,
  activeCombatantId: z.string().min(1).nullable(),
  combatants: z.array(combatantSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Encounter = z.infer<typeof encounterSchema>;

/** 战斗中允许的领域命令种类：所有战斗状态变更走白名单命令。 */
export const combatCommandKindSchema = z.enum([
  'start_encounter',
  'roll_initiative',
  'advance_turn',
  'apply_attack',
  'apply_saving_throw',
  'apply_damage',
  'apply_healing',
  'add_condition',
  'remove_condition',
  'end_encounter',
]);

export type CombatCommandKind = z.infer<typeof combatCommandKindSchema>;

export type { Visibility };
