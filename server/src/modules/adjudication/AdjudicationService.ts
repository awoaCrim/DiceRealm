import { nanoid } from 'nanoid';
import {
  adjudicationDecisionSchema,
  actionTypeSchema,
  type ActionIntent,
  type AdjudicationDecision,
  type RollPlan,
  type RollRecord,
  rollRecordSchema,
  rollPlanSchema,
} from '@dnd/contracts';
import { AppError } from '../../platform/http/AppError.js';
import { DiceService, parseDiceExpression } from './DiceService.js';

export interface ActionDefinition {
  actionRef: string;
  actionType: ActionIntent['actionType'];
  rollKind: RollPlan['rollKind'];
  diceExpression: string;
  targetType: RollPlan['targetType'];
  targetValue?: number;
  /** Server-owned rule state; Provider resourceChoices never supplies this value. */
  advantageState?: RollPlan['advantageState'];
  ability?: string;
  modifierSource: string;
  successEffects?: string[];
  failureEffects?: string[];
}

export interface ActorMechanics {
  id: string;
  characterId?: string;
  abilityModifiers?: Record<string, number>;
  savingThrowModifiers?: Record<string, number>;
  attackModifier?: number;
  hpCurrent?: number;
  hpMax?: number;
}

export interface TargetMechanics {
  id: string;
  ac?: number;
  hpCurrent?: number;
  hpMax?: number;
}

export interface AdjudicationContext {
  campaignId: string;
  turnId: string;
  executionId: string;
  /** Revision used to validate the input intent and bind the RollPlan. */
  stateRevision: number;
  /** Revision created by the enclosing authoritative mutation. */
  appliedStateRevision?: number;
  rulesetId: string;
  rulesetVersion: string;
  actors: ReadonlyMap<string, ActorMechanics> | Record<string, ActorMechanics>;
  targets?: ReadonlyMap<string, TargetMechanics> | Record<string, TargetMechanics>;
  actionDefinitions?: ReadonlyMap<string, ActionDefinition> | Record<string, ActionDefinition>;
}

export interface MechanicalEffect {
  kind: 'hp_delta';
  targetId: string;
  delta: number;
  reason: string;
}

export interface AdjudicationResult {
  decision: AdjudicationDecision;
  plans: RollPlan[];
  records: RollRecord[];
  effects: MechanicalEffect[];
}

const DEFAULT_ACTION_DEFINITIONS: Record<string, ActionDefinition> = {
  'ability_check:perception': {
    actionRef: 'ability_check:perception', actionType: 'ability_check', rollKind: 'd20_check',
    diceExpression: '1d20', targetType: 'dc', targetValue: 12, ability: 'perception', modifierSource: 'ability:perception',
  },
  'saving_throw:basic': {
    actionRef: 'saving_throw:basic', actionType: 'saving_throw', rollKind: 'saving_throw',
    diceExpression: '1d20', targetType: 'dc', targetValue: 10, ability: 'basic', modifierSource: 'save:basic',
    failureEffects: ['saving_throw_failure'],
  },
  'attack:basic': {
    actionRef: 'attack:basic', actionType: 'attack', rollKind: 'attack',
    diceExpression: '1d20', targetType: 'ac', ability: 'strength', modifierSource: 'attack:basic',
    successEffects: ['attack_hit'], failureEffects: ['attack_miss'],
  },
  'healing:basic': {
    actionRef: 'healing:basic', actionType: 'healing', rollKind: 'healing',
    diceExpression: '1d6', targetType: 'none', modifierSource: 'healing:basic',
    successEffects: ['healing_applied'],
  },
};

/**
 * Deterministic server adjudication for the intentionally small rules slice.
 * The Provider can choose an allow-listed semantic action, but every target,
 * modifier, target value and formula is read from this service's context.
 */
export class AdjudicationService {
  constructor(
    private readonly dice: DiceService = new DiceService(),
    private readonly definitions: ReadonlyMap<string, ActionDefinition> | Record<string, ActionDefinition> = DEFAULT_ACTION_DEFINITIONS,
  ) {}

  adjudicate(intent: ActionIntent, context: AdjudicationContext): { decision: AdjudicationDecision; plan?: RollPlan } {
    this.assertRevision(intent, context);
    const actor = getById(context.actors, intent.actorId);
    if (!actor) return this.controlledDecision(intent, context, 'gm_adjudication_required', 'actor_not_available');
    if (!actionTypeSchema.safeParse(intent.actionType).success) {
      return this.controlledDecision(intent, context, 'unsupported', 'action_type_not_supported');
    }
    if (intent.mode !== 'player_action') {
      return this.controlledDecision(intent, context, 'gm_adjudication_required', 'non_player_intent_requires_owner_path');
    }
    const definition = this.definitionFor(intent, context);
    if (!definition || definition.actionType !== intent.actionType) {
      return this.controlledDecision(intent, context, 'gm_adjudication_required', 'action_definition_unavailable');
    }
    if (intent.actionType === 'use_action' || intent.actionType === 'improvised_action') {
      return this.controlledDecision(intent, context, 'unsupported', 'open_ended_action_not_in_rules_slice');
    }
    const targetIds = [...intent.targetIds];
    // A saving throw's actorId is the creature making the save and therefore
    // the consequence target. targetIds identify the triggering source/context
    // required by this rules slice, not the creature that takes the failure HP delta.
    const targetRequired = definition.targetType === 'ac' || intent.actionType === 'saving_throw';
    if (targetRequired && targetIds.length === 0) {
      return this.controlledDecision(intent, context, 'player_choice_required', 'target_required');
    }
    if (targetIds.some((id) => !getById(context.targets, id))) {
      return this.controlledDecision(intent, context, 'gm_adjudication_required', 'target_not_available');
    }
    const modifier = this.modifierFor(actor, definition);
    if (modifier === null && definition.rollKind !== 'healing') {
      return this.controlledDecision(intent, context, 'gm_adjudication_required', 'modifier_source_unavailable');
    }
    const targetValue = definition.targetType === 'ac'
      ? getById(context.targets, targetIds[0])?.ac ?? null
      : definition.targetType === 'dc'
        ? definition.targetValue ?? null
        : null;
    if ((definition.targetType === 'ac' || definition.targetType === 'dc') && targetValue === null) {
      return this.controlledDecision(intent, context, 'gm_adjudication_required', 'target_value_unavailable');
    }
    const plan = this.createPlan(intent, context, definition, targetIds, targetValue, modifier ?? 0);
    const decision = adjudicationDecisionSchema.parse({
      id: nanoid(24), intentId: intentIdentity(intent), kind: 'roll_required', reasonCode: 'server_rules_require_roll',
      ruleRef: definition.actionRef, rollPlanId: plan.id, basedOnStateRevision: context.stateRevision,
    });
    return { decision, plan };
  }

  resolve(intent: ActionIntent, context: AdjudicationContext, mutationId: string): AdjudicationResult {
    const adjudicated = this.adjudicate(intent, context);
    if (!adjudicated.plan) return { decision: adjudicated.decision, plans: [], records: [], effects: [] };
    const plans = [adjudicated.plan];
    const records: RollRecord[] = [];
    const effects: MechanicalEffect[] = [];
    const firstRecord = this.rollRecord(adjudicated.plan, mutationId, context);
    records.push(firstRecord);

    if (intent.actionType === 'attack' && isSuccessfulAttack(firstRecord)) {
      const definition = this.definitionFor(intent, context);
      if (!definition) throw new AppError('INTERNAL_ERROR', '攻击规则定义读取失败。');
      const targetId = intent.targetIds[0];
      const damageExpression = definition.diceExpression === '1d20' ? '1d6' : definition.diceExpression;
      const damagePlan = this.createPlan(
        intent,
        context,
        { ...definition, rollKind: 'damage', diceExpression: firstRecord.result === 'critical_success' ? doubleDice(damageExpression) : damageExpression, targetType: 'none' },
        [targetId],
        null,
        0,
      );
      plans.push(damagePlan);
      const damageRecord = this.rollRecord(damagePlan, mutationId, context);
      records.push(damageRecord);
      effects.push({ kind: 'hp_delta', targetId, delta: -Math.max(0, damageRecord.total), reason: firstRecord.result === 'critical_success' ? 'critical_attack_damage' : 'attack_damage' });
    } else if (intent.actionType === 'healing') {
      const targetId = intent.targetIds[0] ?? intent.actorId;
      effects.push({ kind: 'hp_delta', targetId, delta: Math.max(0, firstRecord.total), reason: 'healing_roll' });
    } else if (intent.actionType === 'saving_throw' && firstRecord.result === 'failure') {
      const actor = getById(context.actors, intent.actorId);
      const failureDamage = actor?.hpCurrent === undefined ? 0 : 1;
      effects.push({ kind: 'hp_delta', targetId: intent.actorId, delta: -failureDamage, reason: 'saving_throw_failure' });
    }
    return { decision: adjudicated.decision, plans, records, effects };
  }

  private createPlan(
    intent: ActionIntent,
    context: AdjudicationContext,
    definition: ActionDefinition,
    targetIds: string[],
    targetValue: number | null,
    modifier: number,
  ): RollPlan {
    // resourceChoices is persisted as semantic intent metadata for future
    // server-authorized resources, but raw Provider strings never grant a
    // mechanical advantage. The current rules slice has no such resource, so
    // only the server-owned ActionDefinition can select it.
    const advantageState = definition.advantageState ?? 'normal';
    return this.dice.lockPlan({
      id: nanoid(24), campaignId: context.campaignId, intentId: intentIdentity(intent),
      executionId: context.executionId, actorId: intent.actorId, targetIds,
      rollKind: definition.rollKind, diceExpression: definition.diceExpression,
      modifierBreakdown: modifier === 0 ? [] : [{ source: definition.modifierSource, value: modifier }],
      advantageState, targetType: definition.targetType, targetValue,
      successEffects: definition.successEffects ?? [], failureEffects: definition.failureEffects ?? [],
      ruleRefs: [definition.actionRef], rulesetId: context.rulesetId,
      rulesetVersion: context.rulesetVersion, basedOnStateRevision: context.stateRevision,
    });
  }

  private rollRecord(plan: RollPlan, mutationId: string, context: AdjudicationContext): RollRecord {
    const rolled = this.dice.rollExpression(plan.diceExpression, plan.advantageState);
    const modifier = plan.modifierBreakdown.reduce((sum, item) => sum + item.value, 0);
    const total = rolled.total + modifier;
    const natural = plan.rollKind === 'attack' && rolled.selectedDice.length === 1 ? rolled.selectedDice[0] : null;
    const result = plan.targetValue === null
      ? 'not_applicable'
      : natural === 20
        ? 'critical_success'
        : natural === 1
          ? 'critical_failure'
          : total >= plan.targetValue ? 'success' : 'failure';
    return rollRecordSchema.parse({
      id: nanoid(24), rollPlanId: plan.id, actionIntentId: plan.intentId,
      executionId: plan.executionId, mutationId, rawDice: rolled.rawDice, selectedDice: rolled.selectedDice,
      modifierBreakdown: plan.modifierBreakdown, total, targetValue: plan.targetValue, result,
      rulesetId: plan.rulesetId, rulesetVersion: plan.rulesetVersion,
      stateRevision: context.appliedStateRevision ?? context.stateRevision, rolledAt: new Date().toISOString(),
    });
  }

  private definitionFor(intent: ActionIntent, context?: AdjudicationContext): ActionDefinition | undefined {
    const ref = intent.actionRef ?? defaultRef(intent.actionType);
    return getById(context?.actionDefinitions ?? this.definitions, ref);
  }

  private modifierFor(actor: ActorMechanics, definition: ActionDefinition): number | null {
    if (definition.actionType === 'healing') return 0;
    if (definition.actionType === 'attack' && actor.attackModifier !== undefined) return actor.attackModifier;
    const values = definition.actionType === 'saving_throw' ? actor.savingThrowModifiers : actor.abilityModifiers;
    if (!values || !definition.ability || values[definition.ability] === undefined) return null;
    return values[definition.ability];
  }

  private controlledDecision(
    intent: ActionIntent,
    context: AdjudicationContext,
    kind: AdjudicationDecision['kind'],
    reasonCode: string,
  ): { decision: AdjudicationDecision } {
    return {
      decision: adjudicationDecisionSchema.parse({
        id: nanoid(24), intentId: intentIdentity(intent), kind, reasonCode,
        basedOnStateRevision: context.stateRevision,
      }),
    };
  }

  private assertRevision(intent: ActionIntent, context: AdjudicationContext): void {
    if (intent.basedOnStateRevision !== undefined && intent.basedOnStateRevision !== context.stateRevision) {
      throw new AppError('STALE_STATE_REVISION', '行动基于过期的战役状态。');
    }
  }
}

function intentIdentity(intent: ActionIntent): string {
  return (intent as ActionIntent & { intentId?: string }).intentId ?? intent.actionId;
}

function getById<T>(source: ReadonlyMap<string, T> | Record<string, T> | undefined, id: string | undefined): T | undefined {
  if (!source || !id) return undefined;
  if (typeof (source as ReadonlyMap<string, T>).get === 'function') {
    return (source as ReadonlyMap<string, T>).get(id);
  }
  return (source as Record<string, T>)[id];
}

function defaultRef(actionType: ActionIntent['actionType']): string | undefined {
  switch (actionType) {
    case 'ability_check': return 'ability_check:perception';
    case 'saving_throw': return 'saving_throw:basic';
    case 'attack': return 'attack:basic';
    case 'healing': return 'healing:basic';
    default: return undefined;
  }
}

function isSuccessfulAttack(record: RollRecord): boolean {
  return record.result === 'success' || record.result === 'critical_success';
}

function doubleDice(expression: string): string {
  const { count, sides } = parseDiceExpression(expression);
  return `${Math.min(20, count * 2)}d${sides}`;
}
