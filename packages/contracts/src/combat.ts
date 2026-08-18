import { z } from 'zod';
import { visibilitySchema, type Visibility } from './visibility.js';

/** 结构化战斗 contract。 */

export const encounterStatusSchema = z.enum(['preparation', 'active', 'completed']);

export type EncounterStatus = z.infer<typeof encounterStatusSchema>;

/** 战斗员：visibility/targetPlayerId 配对与 turn dice results 同构。 */
export const combatantSchema = z.object({
  id: z.string().min(1),
  /** CampaignActor identity; legacy rows may be null until explicitly linked. */
  actorId: z.string().min(1).nullable().optional(),
  name: z.string().min(1),
  /** NPC 为 null；PC 关联同 campaign 且 approved 的 platform_character。 */
  characterId: z.string().min(1).nullable(),
  /** preparation 阶段为 null；roll_initiative 后服务端赋值。 */
  initiative: z.number().int().nullable(),
  initiativeBonus: z.number().int(),
  hpCurrent: z.number().int(),
  hpMax: z.number().int(),
  ac: z.number().int(),
  conditions: z.array(z.string()).default([]),
  visibility: visibilitySchema,
  /** player_private 必填非空；public/owner_only 必为 null。 */
  targetPlayerId: z.string().min(1).nullable(),
}).superRefine((combatant, ctx) => {
  if (combatant.visibility === 'player_private' && !combatant.targetPlayerId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'player_private combatant 必须指定 targetPlayerId。' });
  }
  if (combatant.visibility !== 'player_private' && combatant.targetPlayerId !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'public/owner_only combatant 的 targetPlayerId 必须为 null。' });
  }
});

export type Combatant = z.infer<typeof combatantSchema>;

export const encounterSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  name: z.string().min(1),
  status: encounterStatusSchema,
  activeCombatantId: z.string().min(1).nullable(),
  round: z.number().int(),
  combatants: z.array(combatantSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Encounter = z.infer<typeof encounterSchema>;

/** start_encounter 的 HTTP 输入：服务端生成 encounter/combatant id 与时间戳。 */
export const startEncounterInputSchema = z.object({
  name: z.string().trim().min(1),
  combatants: z.array(z.object({
    actorId: z.string().min(1).nullable().optional(),
    name: z.string().trim().min(1),
    characterId: z.string().min(1).nullable(),
    initiativeBonus: z.number().int(),
    hpCurrent: z.number().int().min(0),
    hpMax: z.number().int().min(1),
    ac: z.number().int().min(0),
    conditions: z.array(z.string()).default([]),
    visibility: visibilitySchema,
    targetPlayerId: z.string().min(1).nullable(),
  }).superRefine((combatant, ctx) => {
    if (combatant.visibility === 'player_private' && !combatant.targetPlayerId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'player_private combatant 必须指定 targetPlayerId。' });
    }
    if (combatant.visibility !== 'player_private' && combatant.targetPlayerId !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'public/owner_only combatant 的 targetPlayerId 必须为 null。' });
    }
  })).min(1),
});

export type StartEncounterInput = z.infer<typeof startEncounterInputSchema>;

/** AI 发起遭遇的结算输入：复用 startEncounterInputSchema，另加 rollInitiative（默认 true，服务端同事务掷先攻）。 */
export const encounterStartSchema = startEncounterInputSchema.extend({
  rollInitiative: z.boolean().default(true),
});

/** 解析后输出：rollInitiative 已施加默认值（必填 boolean）。 */
export type EncounterStart = z.infer<typeof encounterStartSchema>;

/** 输入侧：rollInitiative 可省略（缺省 true）；seam 内防御性重解析施加默认值。 */
export type EncounterStartInput = z.input<typeof encounterStartSchema>;

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

/** 伤害骰面白名单。 */
export const damageDieSchema = z.enum(['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100']);

export type DamageDie = z.infer<typeof damageDieSchema>;

/**
 * 严格白名单命令：payload 全部 `.strict()`，未知额外字段一律拒绝。
 * attack/save 的 roll/total 只能由服务端注入 RNG 产生，调用方不得自报。
 */
export const combatCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('start_encounter'),
    payload: z.object({
      name: z.string().trim().min(1),
      combatants: z.array(z.object({
        actorId: z.string().min(1).nullable().optional(),
        name: z.string().trim().min(1),
        characterId: z.string().min(1).nullable(),
        initiativeBonus: z.number().int(),
        hpCurrent: z.number().int().min(0),
        hpMax: z.number().int().min(1),
        ac: z.number().int().min(0),
        conditions: z.array(z.string()).default([]),
        visibility: visibilitySchema,
        targetPlayerId: z.string().min(1).nullable(),
      }).superRefine((combatant, ctx) => {
        if (combatant.visibility === 'player_private' && !combatant.targetPlayerId) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'player_private combatant 必须指定 targetPlayerId。' });
        }
        if (combatant.visibility !== 'player_private' && combatant.targetPlayerId !== null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'public/owner_only combatant 的 targetPlayerId 必须为 null。' });
        }
      })).min(1),
    }).strict(),
  }),
  z.object({
    kind: z.literal('roll_initiative'),
    payload: z.object({}).strict(),
  }),
  z.object({
    kind: z.literal('advance_turn'),
    payload: z.object({}).strict(),
  }),
  z.object({
    kind: z.literal('apply_attack'),
    payload: z.object({
      actorCombatantId: z.string().min(1),
      targetCombatantId: z.string().min(1),
      attackBonus: z.number().int(),
      damageDie: damageDieSchema,
      damageDice: z.number().int().min(1).max(20),
      damageBonus: z.number().int(),
    }).strict(),
  }),
  z.object({
    kind: z.literal('apply_saving_throw'),
    payload: z.object({
      actorCombatantId: z.string().min(1),
      targetCombatantId: z.string().min(1),
      saveBonus: z.number().int(),
      dc: z.number().int().min(0),
      damageOnFailure: z.number().int().min(0),
    }).strict(),
  }),
  z.object({
    kind: z.literal('apply_damage'),
    payload: z.object({
      actorCombatantId: z.string().min(1),
      targetCombatantId: z.string().min(1),
      amount: z.number().int().min(0),
    }).strict(),
  }),
  z.object({
    kind: z.literal('apply_healing'),
    payload: z.object({
      actorCombatantId: z.string().min(1),
      targetCombatantId: z.string().min(1),
      amount: z.number().int().min(0),
    }).strict(),
  }),
  z.object({
    kind: z.literal('add_condition'),
    payload: z.object({
      actorCombatantId: z.string().min(1),
      targetCombatantId: z.string().min(1),
      condition: z.string().trim().min(1),
    }).strict(),
  }),
  z.object({
    kind: z.literal('remove_condition'),
    payload: z.object({
      actorCombatantId: z.string().min(1),
      targetCombatantId: z.string().min(1),
      condition: z.string().trim().min(1),
    }).strict(),
  }),
  z.object({
    kind: z.literal('end_encounter'),
    payload: z.object({}).strict(),
  }),
]);

export type CombatCommand = z.infer<typeof combatCommandSchema>;

export type { Visibility };
