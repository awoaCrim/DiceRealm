import { nanoid } from 'nanoid';
import {
  mechanicalResolvedOutcomeSchema,
  normalizedActionIntentSchema,
  type ActionIntentProposal,
  type AdjudicationDecision,
  type MechanicalResolvedOutcome,
  type RollPlan,
  type RollRecord,
} from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { AppError } from '../../platform/http/AppError.js';
import { CharacterRepository, type CharacterRow } from '../characters/CharacterRepository.js';
import { CombatRepository, type CombatantRow } from '../combat/CombatRepository.js';
import { TurnRepository } from '../turns/TurnRepository.js';
import { AdjudicationRepository } from './AdjudicationRepository.js';
import { AdjudicationService, type ActorMechanics, type MechanicalEffect, type TargetMechanics } from './AdjudicationService.js';
import { ActorRuntimeStateService } from '../actors/ActorRuntimeStateService.js';

export interface ActionSnapshot {
  id: string;
  playerId: string;
  body: string;
  submittedAt: string;
  updatedAt: string;
}

export interface MechanicalResolutionInput {
  campaignId: string;
  turnId: string;
  executionId: string;
  mutationId: string;
  basedOnStateRevision: number;
  appliedStateRevision: number;
  actorUserId: string;
  proposals: readonly ActionIntentProposal[];
  /** Decision-scoped path: resolve only these actions, not the whole legacy Turn. */
  actionIds?: readonly string[];
  /** Immutable action captured by the claim transaction. */
  actionSnapshot?: ActionSnapshot;
}

export interface MechanicalResolutionResult {
  outcome: MechanicalResolvedOutcome;
  effects: MechanicalEffect[];
  outcomeId: string;
}

interface LoadedState {
  actors: Map<string, ActorMechanics>;
  targets: Map<string, TargetMechanics>;
  charactersByPlayer: Map<string, CharacterRow[]>;
  charactersByActor: Map<string, CharacterRow>;
  combatantsById: Map<string, CombatantRow>;
  rulesetId: string;
  rulesetVersion: string;
}

/**
 * Orchestrates intent normalization, deterministic adjudication, server dice,
 * mechanical writes and audit persistence inside the caller's coordinator tx.
 */
export class MechanicalResolutionService {
  private readonly repository: AdjudicationRepository;
  private readonly runtime: ActorRuntimeStateService;

  constructor(
    private readonly executor: QueryExecutor,
    private readonly outbox?: EventPublisherPort,
    private readonly adjudicator: AdjudicationService = new AdjudicationService(),
  ) {
    this.repository = new AdjudicationRepository(executor);
    this.runtime = new ActorRuntimeStateService(executor);
  }

  async resolveDecisionIn(
    tx: QueryExecutor,
    input: Omit<MechanicalResolutionInput, 'proposals' | 'actionIds'> & { proposal: ActionIntentProposal },
  ): Promise<MechanicalResolutionResult> {
    return this.resolveIn(tx, {
      ...input,
      actionIds: [input.proposal.actionId],
      proposals: [input.proposal],
    });
  }

  async resolveIn(tx: QueryExecutor, input: MechanicalResolutionInput): Promise<MechanicalResolutionResult> {
    const existing = await this.repository.findOutcomeByExecution(tx, input.executionId);
    if (existing) {
      const parsed = mechanicalResolvedOutcomeSchema.parse(JSON.parse(existing.outcome_json));
      return {
        outcome: parsed as MechanicalResolvedOutcome,
        effects: parsed.effects as MechanicalEffect[],
        outcomeId: existing.id,
      };
    }
    const turns = new TurnRepository(tx);
    const allActions = await turns.listActionsByTurn(input.turnId);
    const actions = input.actionIds
      ? allActions.filter((action) => input.actionIds?.includes(action.id))
      : allActions;
    if (input.actionSnapshot) {
      const persisted = allActions.find((action) => action.id === input.actionSnapshot?.id);
      if (!persisted || persisted.campaign_id !== input.campaignId
        || persisted.player_id !== input.actionSnapshot.playerId) {
        throw new AppError('STATE_CONFLICT', 'claim 时的玩家行动已不存在。');
      }
      const index = actions.findIndex((action) => action.id === input.actionSnapshot?.id);
      if (index < 0) throw new AppError('STATE_CONFLICT', 'claim 时的玩家行动不在当前决策中。');
      actions[index] = {
        ...actions[index],
        body: input.actionSnapshot.body,
        submitted_at: input.actionSnapshot.submittedAt,
        updated_at: input.actionSnapshot.updatedAt,
      };
    }
    if (actions.length === 0) {
      throw new AppError('AI_OUTPUT_INVALID', '当前回合没有可解释的玩家行动。');
    }
    if (input.actionIds && actions.length !== input.actionIds.length) {
      throw new AppError('AI_OUTPUT_INVALID', '叙事决策引用的玩家行动不存在。');
    }
    const byActionId = new Map(input.proposals.map((proposal) => [proposal.actionId, proposal]));
    if (byActionId.size !== input.proposals.length || byActionId.size !== actions.length) {
      throw new AppError('AI_OUTPUT_INVALID', '每个已提交行动必须对应唯一的语义 Intent。');
    }
    for (const action of actions) {
      if (!byActionId.has(action.id)) {
        throw new AppError('AI_OUTPUT_INVALID', '语义 Intent 未覆盖全部已提交行动。');
      }
    }

    const campaign = (await tx.query<{ ruleset: string }>(
      'SELECT ruleset FROM campaigns WHERE id = ?', [input.campaignId],
    ))[0];
    if (!campaign) throw new AppError('NOT_FOUND', '战役不存在。');
    const loaded = await this.loadState(tx, input.campaignId, campaign.ruleset);
    const intents = [] as MechanicalResolvedOutcome['intents'];
    const decisions: AdjudicationDecision[] = [];
    const plans: RollPlan[] = [];
    const records: RollRecord[] = [];
    const effects: MechanicalEffect[] = [];

    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      const proposal = byActionId.get(action.id)!;
      if (proposal.actorId !== action.player_id || proposal.mode !== 'player_action') {
        throw new AppError('AI_OUTPUT_INVALID', 'Intent actor 或 mode 与玩家行动不匹配。');
      }
      const intent = normalizedActionIntentSchema.parse({
        ...proposal,
        intentId: nanoid(24),
        campaignId: input.campaignId,
        input: action.body,
        sourceInput: action.body,
        basedOnStateRevision: input.basedOnStateRevision,
      });
      intents.push(intent);
      await this.repository.insertIntent(tx, {
        ...intent,
        turnId: input.turnId,
        executionId: input.executionId,
        intentOrder: index,
        createdAt: new Date().toISOString(),
      });

      const context = {
        campaignId: input.campaignId,
        turnId: input.turnId,
        executionId: input.executionId,
        stateRevision: input.basedOnStateRevision,
        appliedStateRevision: input.appliedStateRevision,
        rulesetId: loaded.rulesetId,
        rulesetVersion: loaded.rulesetVersion,
        actors: loaded.actors,
        targets: loaded.targets,
      };
      const resolved = this.adjudicator.resolve(intent, context, input.mutationId);
      const decision = { ...resolved.decision, intentId: intent.intentId };
      decisions.push(decision);
      await this.repository.insertDecision(tx, {
        ...decision,
        campaignId: input.campaignId,
        turnId: input.turnId,
        executionId: input.executionId,
        createdAt: new Date().toISOString(),
      });
      for (const plan of resolved.plans) {
        plans.push(plan);
        await this.repository.insertRollPlan(tx, { ...plan, turnId: input.turnId });
      }
      for (const record of resolved.records) {
        records.push(record);
        await this.repository.insertRollRecord(tx, {
          ...record, campaignId: input.campaignId, turnId: input.turnId,
        });
      }
      for (const effect of resolved.effects) {
        await this.applyEffect(tx, input, loaded, effect);
        effects.push(effect);
      }
      if (decision.kind === 'gm_adjudication_required' || decision.kind === 'unsupported' || decision.kind === 'player_choice_required') {
        throw new AppError('GM_ADJUDICATION_REQUIRED', '该行动需要 Owner 裁定后才能继续。');
      }
    }

    const outcomeId = nanoid(24);
    const outcome = {
      id: outcomeId,
      executionId: input.executionId,
      campaignId: input.campaignId,
      turnId: input.turnId,
      basedOnStateRevision: input.basedOnStateRevision,
      appliedStateRevision: input.appliedStateRevision,
      intents,
      decisions,
      rollPlans: plans,
      rollRecords: records,
      stateChanges: [],
      worldFactCreations: [],
      encounterStarts: [],
      interactionRequests: [],
      effects,
    };
    await this.repository.insertOutcome(tx, {
      id: outcomeId,
      campaignId: input.campaignId,
      turnId: input.turnId,
      executionId: input.executionId,
      mutationId: input.mutationId,
      basedOnStateRevision: input.basedOnStateRevision,
      appliedStateRevision: input.appliedStateRevision,
      outcomeJson: JSON.stringify(outcome),
      createdAt: new Date().toISOString(),
    });
    return { outcome: outcome as MechanicalResolvedOutcome, effects, outcomeId };
  }

  private async loadState(tx: QueryExecutor, campaignId: string, ruleset: string): Promise<LoadedState> {
    const characters = new CharacterRepository(tx);
    const characterRows = (await characters.listByCampaign(campaignId)).filter((row) => row.status === 'approved');
    const actors = new Map<string, ActorMechanics>();
    const charactersByPlayer = new Map<string, CharacterRow[]>();
    const charactersByActor = new Map<string, CharacterRow>();
    for (const row of characterRows) {
      const sheet = parseObject(row.sheet_json);
      const actorId = 'actor:character:' + row.id;
      const mechanics = {
        id: actorId,
        characterId: row.id,
        abilityModifiers: numericRecord(sheet.abilityModifiers ?? sheet.abilities),
        savingThrowModifiers: numericRecord(sheet.savingThrowModifiers ?? sheet.savingThrows),
        attackModifier: numberValue(sheet.attackModifier),
        hpCurrent: numberValue(sheet.hpCurrent),
        hpMax: numberValue(sheet.hpMax),
      };
      actors.set(actorId, mechanics);
      if (!actors.has(row.player_id)) actors.set(row.player_id, { ...mechanics, id: row.player_id });
      const playerRows = charactersByPlayer.get(row.player_id) ?? [];
      playerRows.push(row);
      charactersByPlayer.set(row.player_id, playerRows);
      charactersByActor.set(actorId, row);
    }
    const combatRepo = new CombatRepository(tx);
    const combatants = (await combatRepo.listEncountersByCampaign(campaignId))
      .flatMap(async (encounter) => combatRepo.listCombatantsByEncounter(encounter.id));
    const resolvedCombatants = (await Promise.all(combatants)).flat();
    const targets = new Map<string, TargetMechanics>();
    const combatantsById = new Map<string, CombatantRow>();
    for (const combatant of resolvedCombatants) {
      targets.set(combatant.id, { id: combatant.id, ac: combatant.ac, hpCurrent: combatant.hp_current, hpMax: combatant.hp_max });
      combatantsById.set(combatant.id, combatant);
    }
    return {
      actors, targets, charactersByPlayer, charactersByActor, combatantsById,
      rulesetId: ruleset || 'dnd5e',
      rulesetVersion: 'v0.1',
    };
  }

  private async applyEffect(
    tx: QueryExecutor,
    input: MechanicalResolutionInput,
    loaded: LoadedState,
    effect: MechanicalEffect,
  ): Promise<void> {
    const combatant = loaded.combatantsById.get(effect.targetId);
    if (combatant) {
      let hpCurrent = Math.max(0, Math.min(combatant.hp_max, combatant.hp_current + effect.delta));
      if (combatant.actor_id) {
        const state = await this.runtime.applyIn(tx, input.campaignId, combatant.actor_id,
          effect.delta < 0 ? { kind: 'damage', amount: -effect.delta } : { kind: 'healing', amount: effect.delta },
          input.appliedStateRevision);
        hpCurrent = Math.min(combatant.hp_max, state.currentHp);
      }
      const updated = { ...combatant, hp_current: hpCurrent, updated_at: new Date().toISOString() };
      await new CombatRepository(tx).updateCombatant(updated);
      loaded.combatantsById.set(effect.targetId, updated);
      loaded.targets.set(effect.targetId, { id: effect.targetId, ac: updated.ac, hpCurrent, hpMax: updated.hp_max });
      if (this.outbox) {
        await this.outbox.publishIn(tx, { type: 'combat.updated', campaignId: input.campaignId, encounterId: combatant.encounter_id });
      }
      return;
    }
    const character = loaded.charactersByActor.get(effect.targetId)
      ?? (loaded.charactersByPlayer.get(effect.targetId)?.length === 1 ? loaded.charactersByPlayer.get(effect.targetId)![0] : null);
    if (!character) throw new AppError('GM_ADJUDICATION_REQUIRED', '机械效果目标不明确或不在当前战役中。');
    const actorId = effect.targetId.startsWith('actor:') ? effect.targetId : 'actor:character:' + character.id;
    const state = await this.runtime.applyIn(tx, input.campaignId, actorId,
      effect.delta < 0 ? { kind: 'damage', amount: -effect.delta } : { kind: 'healing', amount: effect.delta },
      input.appliedStateRevision);
    const mechanics = loaded.actors.get(actorId);
    if (mechanics) loaded.actors.set(actorId, { ...mechanics, hpCurrent: state.currentHp });
    const legacy = loaded.actors.get(effect.targetId);
    if (legacy) loaded.actors.set(effect.targetId, { ...legacy, hpCurrent: state.currentHp });
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function numericRecord(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'number' && Number.isInteger(raw)) result[key] = raw;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
