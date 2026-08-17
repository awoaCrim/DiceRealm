import { nanoid } from 'nanoid';
import {
  factProvenanceSchema,
  narrativeDecisionSchema,
  narrativeRoundSchema,
  projectedRoundSummarySchema,
  workingFactSchema,
  type FactAuthority,
  type FactSourceKind,
  type FactValidationStatus,
  type MechanicalResolvedOutcome,
  type NarrativeDecision,
  type NarrativeProjectionAudience,
  type NarrativeRound,
  type ProjectedRoundSummary,
  type RoundFactSet,
  type WorkingFact,
} from '@dnd/contracts';
import type { DatabasePort, QueryExecutor, QueryReader } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { AppError } from '../../platform/http/AppError.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';
import { TurnRepository, type TurnRow } from '../turns/TurnRepository.js';
import {
  NarrativeRoundRepository,
  type InsertNarrativeDecision,
  type InsertNarrativeFact,
  type InsertNarrativeParticipant,
  mapNarrativeDecision,
  mapNarrativeParticipant,
  mapNarrativeRound,
  mapRoundFact,
  mapRoundFactSet,
  mapWorkingFact,
} from './NarrativeRoundRepository.js';

export interface NarrativeRoundView {
  round: NarrativeRound;
  participants: ReturnType<typeof mapNarrativeParticipant>[];
  decisions: NarrativeDecision[];
  workingFacts: WorkingFact[];
}

export interface DecisionClaim {
  replayed: boolean;
  decision: NarrativeDecision;
  stateRevision: number;
}

export interface CloseRoundResult {
  factSet: RoundFactSet;
  nextTurnId: string | null;
  stateRevision: number;
  replayed: boolean;
}

export interface RecordWorkingFactOptions {
  id?: string;
  campaignId: string;
  roundId: string;
  decisionId?: string | null;
  actionId?: string | null;
  factKind: string;
  payload: Record<string, unknown>;
  visibility: 'public' | 'player_private' | 'owner_only';
  audienceActorIds?: string[];
  authority: FactAuthority;
  validationStatus: FactValidationStatus;
  sourceKind: FactSourceKind;
  provenance: WorkingFact['provenance'];
  createdAt?: string;
}

/**
 * Authoritative runtime boundary for one narrative round.
 *
 * The service intentionally keeps Turn as a compatibility container while all
 * live round state/fact transitions go through this module. Callers that own a
 * transaction must use the `*In` methods; the public methods own only their
 * short transaction and never hold a transaction across Provider work.
 */
export class NarrativeRoundService {
  private readonly mutations: CampaignMutationCoordinator;

  constructor(
    private readonly executor: DatabasePort,
    private readonly outbox: EventPublisherPort,
    mutations?: CampaignMutationCoordinator,
  ) {
    this.mutations = mutations ?? new CampaignMutationCoordinator(executor);
  }

  async getByTurn(campaignId: string, turnId: string): Promise<NarrativeRoundView | null> {
    const repository = new NarrativeRoundRepository(this.executor);
    const row = await repository.findByTurnId(turnId);
    if (!row || row.campaign_id !== campaignId) return null;
    return this.loadView(this.executor, row.id);
  }

  async getRequiredByTurn(campaignId: string, turnId: string): Promise<NarrativeRoundView> {
    const existing = await this.getByTurn(campaignId, turnId);
    if (!existing) throw new AppError('NOT_FOUND', '叙事回合不存在。');
    return existing;
  }

  /** Create/repair a round association inside a caller-owned transaction. */
  async ensureForTurnIn(tx: QueryExecutor, campaignId: string, turnId: string): Promise<NarrativeRound> {
    const turns = new TurnRepository(tx);
    const turn = await turns.findTurnById(turnId);
    if (!turn || turn.campaign_id !== campaignId) throw new AppError('NOT_FOUND', '回合不存在。');
    const repository = new NarrativeRoundRepository(tx);
    const existing = await repository.findByTurnId(turnId, true);
    const active = await repository.findActiveByCampaign(campaignId, existing?.id);
    if (active) {
      // Legacy callers may have completed the compatibility Turn directly.
      // Repair that stale mirror boundary instead of creating a second live
      // round; a genuinely live round remains a hard conflict.
      const activeTurn = await turns.findTurnById(active.turn_id);
      if (!activeTurn || activeTurn.status === 'completed' || activeTurn.superseded_at !== null) {
        await repository.updateStatus(active.id, [active.status], 'closed', new Date().toISOString(), new Date().toISOString());
      } else {
        throw new AppError('STATE_CONFLICT', '战役已有进行中的叙事回合。');
      }
    }
    if (existing) {
      if (existing.superseded_at !== null) await repository.clearSupersededForRound(existing.id);
      await this.ensureParticipantsAndDecisionsIn(tx, turn, existing.id);
      const current = await repository.findById(existing.id);
      if (!current) throw new AppError('INTERNAL_ERROR', '叙事回合读取失败。');
      return mapNarrativeRound(current);
    }

    const now = new Date().toISOString();
    const roundId = turn.id;
    await repository.insertRound({
      id: roundId,
      campaign_id: campaignId,
      turn_id: turn.id,
      number: turn.number,
      status: roundStatusFromTurn(turn.status),
      last_state_revision: 0,
      created_at: now,
      updated_at: now,
    });
    await this.ensureParticipantsAndDecisionsIn(tx, turn, roundId);
    const created = await repository.findById(roundId);
    if (!created) throw new AppError('INTERNAL_ERROR', '叙事回合创建结果读取失败。');
    return mapNarrativeRound(created);
  }

  async ensureForTurn(campaignId: string, turnId: string): Promise<NarrativeRound> {
    return this.executor.transaction((tx) => this.ensureForTurnIn(tx, campaignId, turnId));
  }

  /** Link a submitted action to its single participant decision. */
  async linkSubmittedActionIn(
    tx: QueryExecutor,
    campaignId: string,
    turnId: string,
    playerId: string,
    actionId: string,
    now = new Date().toISOString(),
  ): Promise<NarrativeDecision> {
    const round = await this.ensureForTurnIn(tx, campaignId, turnId);
    const repository = new NarrativeRoundRepository(tx);
    const decision = await repository.findDecisionByActor(round.id, playerId);
    if (!decision) throw new AppError('FORBIDDEN', '你不是该叙事回合的参与者。');
    if (!(await repository.linkActionAndSubmit(decision.id, actionId, now))) {
      throw new AppError('STATE_CONFLICT', '叙事决策已被并发修改。');
    }
    if (!(await repository.updateParticipantStatus(round.id, playerId, 'submitted', now))) {
      throw new AppError('STATE_CONFLICT', '叙事参与者状态已被并发修改。');
    }
    await this.refreshDecisionOrderIn(tx, round.id, turnId, now);
    const updated = await repository.findDecisionById(decision.id);
    if (!updated) throw new AppError('INTERNAL_ERROR', '叙事决策读取失败。');
    return mapNarrativeDecision(updated);
  }

  async markReadyIn(
    tx: QueryExecutor,
    roundId: string,
    now = new Date().toISOString(),
    stateRevision?: number,
  ): Promise<boolean> {
    const repository = new NarrativeRoundRepository(tx);
    const participants = await repository.listParticipants(roundId);
    const decisions = await repository.listDecisions(roundId);
    const decisionByActor = new Map(decisions.map((decision) => [decision.actor_id, decision]));
    const allSubmitted = participants.filter((participant) => Number(participant.required) === 1)
      .every((participant) => {
        const decision = decisionByActor.get(participant.player_id);
        return Boolean(decision?.action_id) && (decision?.status === 'submitted' || decision?.status === 'resolved' || decision?.status === 'skipped');
      });
    if (!allSubmitted) return false;
    const changed = await repository.updateStatus(roundId, ['collecting'], 'ready', now, null);
    if (changed && stateRevision !== undefined) {
      await repository.updateCursor(roundId, 0, stateRevision, now);
    }
    return changed;
  }

  async markProcessingForTurnIn(tx: QueryExecutor, turnId: string, stateRevision: number, now = new Date().toISOString()): Promise<boolean> {
    const repository = new NarrativeRoundRepository(tx);
    const round = await repository.findByTurnId(turnId);
    if (!round) return false;
    const changed = await repository.updateStatus(round.id, ['ready', 'needs_owner_attention'], 'processing', now, null);
    if (changed) await repository.updateCursor(round.id, round.decision_cursor, stateRevision, now);
    return changed;
  }

  /** Compatibility failure mirror for the legacy whole-turn AI path. */
  async markNeedsOwnerAttentionForTurnIn(
    tx: QueryExecutor,
    turnId: string,
    stateRevision: number,
    now = new Date().toISOString(),
  ): Promise<boolean> {
    const repository = new NarrativeRoundRepository(tx);
    const round = await repository.findByTurnId(turnId);
    if (!round) return false;
    const changed = await repository.updateStatus(round.id, ['processing', 'ready'], 'needs_owner_attention', now, null);
    if (changed || round.status === 'needs_owner_attention') {
      await repository.updateCursor(round.id, round.decision_cursor, stateRevision, now);
      return true;
    }
    return false;
  }

  async claimDecision(
    campaignId: string,
    roundId: string,
    decisionId: string,
    executionId = nanoid(24),
  ): Promise<DecisionClaim> {
    return this.executor.transaction(async (tx) => {
      const repository = new NarrativeRoundRepository(tx);
      const existing = await repository.findDecisionById(decisionId);
      if (!existing || existing.campaign_id !== campaignId || existing.round_id !== roundId) {
        throw new AppError('NOT_FOUND', '叙事决策不存在。');
      }
      if (existing.status === 'processing' && existing.execution_id) {
        return { replayed: true, decision: mapNarrativeDecision(existing), stateRevision: Number(existing.claim_revision ?? 0) };
      }
      if (existing.status === 'resolved' || existing.status === 'skipped') {
        return { replayed: true, decision: mapNarrativeDecision(existing), stateRevision: Number(existing.applied_state_revision ?? existing.claim_revision ?? 0) };
      }
      if (!existing.action_id) throw new AppError('STATE_CONFLICT', '叙事决策尚未提交玩家行动。');
      await this.assertPriorDecisionsComplete(tx, roundId, existing.decision_order);
      const round = await repository.findById(roundId);
      if (!round) throw new AppError('NOT_FOUND', '叙事回合不存在。');
      const mutation = await this.mutations.mutateIn(tx, {
        campaignId,
        mutationId: `narrative-decision-claim:${executionId}`,
        causeType: 'narrative_decision_claim',
        causeId: decisionId,
      }, async ({ stateRevision }) => {
        if (!(await repository.updateStatus(roundId, ['ready', 'processing', 'needs_owner_attention'], 'processing', new Date().toISOString(), null))) {
          throw new AppError('STATE_CONFLICT', '叙事回合不在可处理状态。');
        }
        const currentRound = await repository.findById(roundId);
        if (!currentRound || !(await repository.updateCursor(roundId, currentRound.decision_cursor, stateRevision, new Date().toISOString()))) {
          throw new AppError('STATE_CONFLICT', '叙事回合版本更新失败。');
        }
        if (!(await repository.markProcessing(decisionId, executionId, stateRevision, new Date().toISOString()))) {
          throw new AppError('STATE_CONFLICT', '叙事决策不在可处理状态。');
        }
        await tx.execute(
          "UPDATE platform_turns SET status = 'resolving', updated_at = ? WHERE id = ? AND status IN ('locked','needs_owner_attention')",
          [new Date().toISOString(), existing.turn_id],
        );
        await repository.updateParticipantStatus(roundId, existing.actor_id, 'processing', new Date().toISOString());
        await this.outbox.publishIn(tx, {
          type: 'narrative.decision.claimed', campaignId, roundId, decisionId, actorId: existing.actor_id,
        });
        const claimed = await repository.findDecisionById(decisionId);
        if (!claimed) throw new AppError('INTERNAL_ERROR', '叙事决策 claim 结果读取失败。');
        return { decision: mapNarrativeDecision(claimed), stateRevision };
      });
      if (!mutation.result) {
        const replay = await repository.findDecisionById(decisionId);
        if (!replay) throw new AppError('INTERNAL_ERROR', '叙事决策 claim replay 读取失败。');
        return { replayed: true, decision: mapNarrativeDecision(replay), stateRevision: Number(replay.claim_revision ?? 0) };
      }
      return { replayed: mutation.replayed, ...mutation.result };
    });
  }

  /** Claim a single decision inside the caller's coordinator transaction. */
  async claimDecisionIn(
    tx: QueryExecutor,
    input: { campaignId: string; roundId: string; decisionId: string; executionId: string; stateRevision: number },
    now = new Date().toISOString(),
  ): Promise<NarrativeDecision> {
    const repository = new NarrativeRoundRepository(tx);
    const decision = await repository.findDecisionById(input.decisionId);
    if (!decision || decision.campaign_id !== input.campaignId || decision.round_id !== input.roundId) {
      throw new AppError('NOT_FOUND', '叙事决策不存在。');
    }
    if (decision.status === 'processing' && decision.execution_id === input.executionId) {
      return mapNarrativeDecision(decision);
    }
    if (!decision.action_id) throw new AppError('STATE_CONFLICT', '叙事决策尚未提交玩家行动。');
    await this.assertPriorDecisionsComplete(tx, input.roundId, decision.decision_order);
    const round = await repository.findById(input.roundId);
    if (!round) throw new AppError('NOT_FOUND', '叙事回合不存在。');
    if (!(await repository.updateStatus(input.roundId, ['ready', 'processing', 'needs_owner_attention'], 'processing', now, null))) {
      throw new AppError('STATE_CONFLICT', '叙事回合不在可处理状态。');
    }
    if (!(await repository.updateCursor(input.roundId, round.decision_cursor, input.stateRevision, now))) {
      throw new AppError('STATE_CONFLICT', '叙事回合版本更新失败。');
    }
    if (!(await repository.markProcessing(input.decisionId, input.executionId, input.stateRevision, now))) {
      throw new AppError('STATE_CONFLICT', '叙事决策不在可处理状态。');
    }
    await repository.updateParticipantStatus(input.roundId, decision.actor_id, 'processing', now);
    await this.outbox.publishIn(tx, {
      type: 'narrative.decision.claimed', campaignId: input.campaignId,
      roundId: input.roundId, decisionId: input.decisionId, actorId: decision.actor_id,
    });
    const claimed = await repository.findDecisionById(input.decisionId);
    if (!claimed) throw new AppError('INTERNAL_ERROR', '叙事决策 claim 结果读取失败。');
    return mapNarrativeDecision(claimed);
  }

  /** Called inside the Decision's coordinator transaction after mechanics/facts are written. */
  async markDecisionResolvedIn(
    tx: QueryExecutor,
    input: { campaignId: string; roundId: string; decisionId: string; outcomeId?: string | null; stateRevision: number },
    now = new Date().toISOString(),
  ): Promise<NarrativeDecision> {
    const repository = new NarrativeRoundRepository(tx);
    const decision = await repository.findDecisionById(input.decisionId);
    if (!decision || decision.campaign_id !== input.campaignId || decision.round_id !== input.roundId) {
      throw new AppError('NOT_FOUND', '叙事决策不存在。');
    }
    if (decision.status === 'resolved') return mapNarrativeDecision(decision);
    if (!(await repository.markResolved(input.decisionId, input.outcomeId ?? null, input.stateRevision, now))) {
      throw new AppError('STATE_CONFLICT', '叙事决策不在处理中。');
    }
    await repository.updateParticipantStatus(input.roundId, decision.actor_id, 'resolved', now);
    const round = await repository.findById(input.roundId);
    if (round) {
      await repository.updateCursor(input.roundId, Math.max(round.decision_cursor, decision.decision_order + 1), input.stateRevision, now);
    }
    await this.outbox.publishIn(tx, {
      type: 'narrative.decision.resolved', campaignId: input.campaignId, roundId: input.roundId,
      decisionId: input.decisionId, stateRevision: input.stateRevision,
    });
    const updated = await repository.findDecisionById(input.decisionId);
    if (!updated) throw new AppError('INTERNAL_ERROR', '叙事决策完成结果读取失败。');
    return mapNarrativeDecision(updated);
  }

  async markDecisionNeedsOwnerAttention(
    campaignId: string,
    roundId: string,
    decisionId: string,
    failureCode: string,
  ): Promise<void> {
    await this.executor.transaction(async (tx) => {
      const repository = new NarrativeRoundRepository(tx);
      await this.mutations.mutateIn(tx, {
        campaignId,
        mutationId: `narrative-decision-failure:${decisionId}:${failureCode}`,
        causeType: 'narrative_decision_failure',
        causeId: decisionId,
      }, async ({ stateRevision }) => {
        const now = new Date().toISOString();
        if (!(await repository.markNeedsOwnerAttention(decisionId, failureCode, now))) {
          throw new AppError('STATE_CONFLICT', '叙事决策无法进入 Owner attention。');
        }
        const decision = await repository.findDecisionById(decisionId);
        if (decision) await repository.updateParticipantStatus(roundId, decision.actor_id, 'needs_owner_attention', now);
        await repository.updateStatus(roundId, ['processing', 'ready'], 'needs_owner_attention', now, null);
        const round = await repository.findById(roundId);
        if (round) await repository.updateCursor(roundId, round.decision_cursor, stateRevision, now);
      });
    });
  }

  async skipDecision(campaignId: string, roundId: string, decisionId: string): Promise<NarrativeDecision> {
    return this.executor.transaction(async (tx) => {
      const repository = new NarrativeRoundRepository(tx);
      const decision = await repository.findDecisionById(decisionId);
      if (!decision || decision.campaign_id !== campaignId || decision.round_id !== roundId) {
        throw new AppError('NOT_FOUND', '叙事决策不存在。');
      }
      const execution = await this.mutations.mutateIn(tx, {
        campaignId,
        mutationId: `narrative-decision-skip:${decisionId}`,
        causeType: 'narrative_decision_skip',
        causeId: decisionId,
      }, async ({ stateRevision }) => {
        const now = new Date().toISOString();
        if (decision.status === 'skipped') return mapNarrativeDecision(decision);
        await this.assertPriorDecisionsComplete(tx, roundId, decision.decision_order);
        if (!(await repository.markSkipped(decisionId, now))) {
          throw new AppError('STATE_CONFLICT', '叙事决策不在可跳过状态。');
        }
        await repository.updateParticipantStatus(roundId, decision.actor_id, 'skipped', now);
        const round = await repository.findById(roundId);
        if (round) await repository.updateCursor(roundId, Math.max(round.decision_cursor, decision.decision_order + 1), stateRevision, now);
        const updated = await repository.findDecisionById(decisionId);
        if (!updated) throw new AppError('INTERNAL_ERROR', '叙事决策跳过结果读取失败。');
        return mapNarrativeDecision(updated);
      });
      if (!execution.result) {
        const current = await repository.findDecisionById(decisionId);
        if (!current) throw new AppError('INTERNAL_ERROR', '叙事决策跳过 replay 读取失败。');
        return mapNarrativeDecision(current);
      }
      return execution.result;
    });
  }

  async recordWorkingFactIn(tx: QueryExecutor, input: RecordWorkingFactOptions): Promise<WorkingFact> {
    validateFactInput(input);
    const repository = new NarrativeRoundRepository(tx);
    const round = await repository.findById(input.roundId);
    if (!round || round.campaign_id !== input.campaignId) throw new AppError('NOT_FOUND', '叙事回合不存在。');
    if (round.status === 'closed') throw new AppError('STATE_CONFLICT', '已关闭的叙事回合不能追加 WorkingFact。');
    if (input.decisionId) {
      const decision = await repository.findDecisionById(input.decisionId);
      if (!decision || decision.campaign_id !== input.campaignId || decision.round_id !== input.roundId) {
        throw new AppError('NOT_FOUND', '叙事决策不存在。');
      }
      if ((input.actionId ?? null) !== decision.action_id) {
        throw new AppError('VALIDATION_ERROR', 'fact action provenance 与叙事决策不一致。');
      }
    }
    const id = input.id ?? nanoid(24);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const fact = workingFactSchema.parse({
      id,
      campaignId: input.campaignId,
      roundId: input.roundId,
      decisionId: input.decisionId ?? null,
      actionId: input.actionId ?? null,
      factKind: input.factKind,
      payload: input.payload,
      visibility: input.visibility,
      audienceActorIds: [...new Set(input.audienceActorIds ?? [])],
      authority: input.authority,
      validationStatus: input.validationStatus,
      sourceKind: input.sourceKind,
      provenance: input.provenance,
      createdAt,
      superseded: false,
    });
    const row = toFactRow(fact);
    await new NarrativeRoundRepository(tx).insertWorkingFact(row);
    return fact;
  }

  async projectWorkingFacts(
    roundId: string,
    audience: NarrativeProjectionAudience,
    actorId?: string,
  ): Promise<WorkingFact[]> {
    const repository = new NarrativeRoundRepository(this.executor);
    const round = await repository.findById(roundId);
    if (!round || round.status === 'closed') return [];
    const rows = await repository.listWorkingFacts(roundId);
    return rows.map(mapWorkingFact).filter((fact) => factVisibleTo(fact, audience, actorId));
  }

  async closeRound(campaignId: string, roundId: string): Promise<CloseRoundResult> {
    const repository = new NarrativeRoundRepository(this.executor);
    const existingSet = await repository.findFactSetByRound(roundId);
    if (existingSet) {
      if (existingSet.campaign_id !== campaignId) throw new AppError('NOT_FOUND', '叙事回合不存在。');
      const facts = (await repository.listRoundFacts(existingSet.id)).map((row) => mapRoundFact(row, existingSet.id));
      return {
        factSet: mapRoundFactSet(existingSet, facts),
        nextTurnId: await this.findNextTurnId(campaignId, roundId),
        stateRevision: Number(existingSet.source_state_revision),
        replayed: true,
      };
    }

    return this.executor.transaction(async (tx) => {
      const txRepository = new NarrativeRoundRepository(tx);
      const round = await txRepository.findById(roundId);
      if (!round || round.campaign_id !== campaignId) throw new AppError('NOT_FOUND', '叙事回合不存在。');
      const participants = await txRepository.listParticipants(roundId);
      const decisions = await txRepository.listDecisions(roundId);
      const decisionByActor = new Map(decisions.map((decision) => [decision.actor_id, decision]));
      const incomplete = participants.find((participant) => {
        if (Number(participant.required) !== 1) return false;
        const decision = decisionByActor.get(participant.player_id);
        return !decision || !['resolved', 'skipped'].includes(decision.status);
      });
      if (incomplete) throw new AppError('STATE_CONFLICT', '仍有未完成的叙事决策，无法关闭回合。');

      const now = new Date().toISOString();
      const factSetId = nanoid(24);
      const mutation = await this.mutations.mutateIn(tx, {
        campaignId,
        mutationId: `narrative-round-close:${roundId}`,
        causeType: 'narrative_round_close',
        causeId: roundId,
      }, async ({ stateRevision }) => {
        const existingInside = await txRepository.findFactSetByRound(roundId);
        if (existingInside) {
          const facts = (await txRepository.listRoundFacts(existingInside.id)).map((row) => mapRoundFact(row, existingInside.id));
          return { factSet: mapRoundFactSet(existingInside, facts), nextTurnId: await this.findNextTurnIdIn(tx, campaignId, roundId), stateRevision, replayed: true };
        }
        const workingRows = await txRepository.listWorkingFacts(roundId);
        await txRepository.insertFactSet({
          id: factSetId, campaign_id: campaignId, round_id: roundId,
          source_state_revision: stateRevision, closed_at: now,
          superseded_at: null, superseded_by_archive_id: null,
        });
        for (const row of workingRows) {
          await txRepository.insertRoundFact({
            ...row,
            fact_set_id: factSetId,
            created_at: row.created_at,
          });
        }
        if (!(await txRepository.updateStatus(roundId, ['ready', 'processing', 'needs_owner_attention'], 'closed', now, now))) {
          throw new AppError('STATE_CONFLICT', '叙事回合无法进入 closed 状态。');
        }
        await tx.execute(
          "UPDATE platform_turns SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND superseded_at IS NULL AND status <> 'completed'",
          [now, now, round.turn_id],
        );
        const nextTurnId = await this.createNextTurnIn(tx, campaignId);
        if (nextTurnId) await txRepository.updateCursor(nextTurnId, 0, stateRevision, now);
        await this.outbox.publishIn(tx, {
          type: 'narrative.round.closed', campaignId, roundId, factSetId, stateRevision,
        });
        const factRows = await txRepository.listRoundFacts(factSetId);
        const factSet = mapRoundFactSet(
          { id: factSetId, campaign_id: campaignId, round_id: roundId, source_state_revision: stateRevision,
            closed_at: now, superseded_at: null, superseded_by_archive_id: null },
          factRows.map((row) => mapRoundFact(row, factSetId)),
        );
        return { factSet, nextTurnId, stateRevision, replayed: false };
      });
      if (!mutation.result) {
        const factSet = await txRepository.findFactSetByRound(roundId);
        if (!factSet) throw new AppError('INTERNAL_ERROR', '叙事回合关闭结果读取失败。');
        const facts = (await txRepository.listRoundFacts(factSet.id)).map((row) => mapRoundFact(row, factSet.id));
        return {
          factSet: mapRoundFactSet(factSet, facts),
          nextTurnId: await this.findNextTurnIdIn(tx, campaignId, roundId),
          stateRevision: Number(factSet.source_state_revision),
          replayed: true,
        };
      }
      return mutation.result;
    });
  }

  async projectRoundFacts(
    roundId: string,
    audience: NarrativeProjectionAudience,
    actorId?: string,
  ): Promise<ProjectedRoundSummary | null> {
    const repository = new NarrativeRoundRepository(this.executor);
    const round = await repository.findById(roundId);
    if (!round || round.status !== 'closed') return null;
    const factSet = await repository.findFactSetByRound(roundId);
    if (!factSet) return null;
    const facts = (await repository.listRoundFacts(factSet.id)).map((row) => mapRoundFact(row, factSet.id))
      .filter((fact) => factVisibleTo(fact, audience, actorId));
    return projectedRoundSummarySchema.parse({
      roundId,
      roundNumber: Number(round.number),
      factSetId: factSet.id,
      audience,
      actorId: actorId ?? null,
      stateRevision: Number(factSet.source_state_revision),
      facts,
      sourceRefs: [...new Set(facts.flatMap((fact) => fact.provenance.sourceRefs))],
    });
  }

  async getProjectionForNextRound(campaignId: string, number: number, audience: NarrativeProjectionAudience, actorId?: string): Promise<ProjectedRoundSummary | null> {
    const repository = new NarrativeRoundRepository(this.executor);
    const prior = await repository.findLatestClosedBefore(campaignId, number);
    return prior ? this.projectRoundFacts(prior.id, audience, actorId) : null;
  }

  async finalizeLegacyTurnIn(
    tx: QueryExecutor,
    campaignId: string,
    turnId: string,
    stateRevision: number,
    executionId?: string | null,
    outcome?: MechanicalResolvedOutcome,
  ): Promise<void> {
    const round = await this.ensureForTurnIn(tx, campaignId, turnId);
    const repository = new NarrativeRoundRepository(tx);
    const decisions = await repository.listDecisions(round.id);
    for (const decision of decisions) {
      if (decision.status !== 'resolved' && decision.status !== 'skipped') {
        await repository.markResolved(decision.id, null, stateRevision, new Date().toISOString());
        await repository.updateParticipantStatus(round.id, decision.actor_id, 'resolved', new Date().toISOString());
      }
    }
    const existing = await repository.findFactSetByRound(round.id);
    if (existing) return;
    const now = new Date().toISOString();
    const factSetId = nanoid(24);
    await repository.insertFactSet({
      id: factSetId, campaign_id: campaignId, round_id: round.id,
      source_state_revision: stateRevision, closed_at: now,
      superseded_at: null, superseded_by_archive_id: null,
    });
    const workingRows = await repository.listWorkingFacts(round.id);
    if (workingRows.length === 0 && executionId) {
      const sourceRefs = [`round:${round.id}`, `turn:${turnId}`, `execution:${executionId}`, `state-revision:${campaignId}:${stateRevision}`];
      if (outcome && outcome.effects.length > 0) {
        for (const effect of outcome.effects) {
          await this.recordWorkingFactIn(tx, {
            campaignId, roundId: round.id, actionId: effect.sourceActionId ?? null, factKind: effect.kind,
            payload: { targetId: effect.targetId, delta: effect.delta, reason: effect.reason },
            visibility: 'public', authority: 'server_mechanical', validationStatus: 'authoritative',
            sourceKind: 'mechanical_resolved_outcome',
            provenance: {
              roundId: round.id, decisionId: null, actionId: effect.sourceActionId ?? null, executionId,
              outcomeId: outcome.id ?? null, eventId: null, basedOnStateRevision: outcome.basedOnStateRevision,
              appliedStateRevision: stateRevision, sourceRefs,
            },
          });
        }
      } else {
        await this.recordWorkingFactIn(tx, {
          campaignId, roundId: round.id, factKind: 'turn.resolved',
          payload: { turnId, executionId }, visibility: 'public', authority: 'event_evidence',
          validationStatus: 'authoritative', sourceKind: 'turn_or_narrative_event',
          provenance: {
            roundId: round.id, decisionId: null, actionId: null, executionId,
            outcomeId: outcome?.id ?? null, eventId: null, basedOnStateRevision: outcome?.basedOnStateRevision ?? stateRevision,
            appliedStateRevision: stateRevision, sourceRefs,
          },
        });
      }
    }
    const finalRows = await repository.listWorkingFacts(round.id);
    for (const row of finalRows) await repository.insertRoundFact({ ...row, fact_set_id: factSetId });
    await repository.updateStatus(round.id, ['ready', 'processing', 'needs_owner_attention'], 'closed', now, now);
  }

  private async assertPriorDecisionsComplete(tx: QueryExecutor, roundId: string, decisionOrder: number): Promise<void> {
    const pending = (await new NarrativeRoundRepository(tx).listDecisions(roundId))
      .find((decision) => decision.decision_order < decisionOrder && !['resolved', 'skipped'].includes(decision.status));
    if (pending) throw new AppError('STATE_CONFLICT', '必须先完成前序叙事决策。');
  }

  private async refreshDecisionOrderIn(tx: QueryExecutor, roundId: string, turnId: string, updatedAt: string): Promise<void> {
    const repository = new NarrativeRoundRepository(tx);
    const actions = await new TurnRepository(tx).listActionsByTurn(turnId);
    const actionOrder = new Map(actions.map((action, index) => [action.id, index]));
    const decisions = await repository.listDecisions(roundId);
    for (const decision of decisions) {
      const nextOrder = decision.action_id
        ? actionOrder.get(decision.action_id)
        : actions.length + decision.decision_order;
      if (nextOrder !== undefined && nextOrder !== decision.decision_order) {
        await repository.updateDecisionOrder(decision.id, nextOrder, updatedAt);
      }
    }
  }

  private async ensureParticipantsAndDecisionsIn(tx: QueryExecutor, turn: TurnRow, roundId: string): Promise<void> {
    const repository = new NarrativeRoundRepository(tx);
    const turns = new TurnRepository(tx);
    const requirements = await turns.listRequirements(turn.id);
    const actions = await turns.listActionsByTurn(turn.id);
    const approvedCharacters = new Map(
      (await new CharacterRepository(tx).listByCampaign(turn.campaign_id))
        .filter((character) => character.status === 'approved')
        .map((character) => [character.player_id, character.id]),
    );
    const actionByPlayer = new Map(actions.map((action) => [action.player_id, action]));
    const actionOrder = new Map(actions.map((action, index) => [action.id, index]));
    for (let index = 0; index < requirements.length; index += 1) {
      const requirement = requirements[index];
      const existingParticipant = (await repository.listParticipants(roundId, true))
        .find((participant) => participant.player_id === requirement.player_id);
      const action = actionByPlayer.get(requirement.player_id);
      const status = action ? 'submitted' : (existingParticipant?.status ?? 'waiting');
      if (!existingParticipant) {
        const participant: InsertNarrativeParticipant = {
          round_id: roundId, campaign_id: turn.campaign_id, player_id: requirement.player_id,
          character_id: approvedCharacters.get(requirement.player_id) ?? null,
          participant_order: index, required: true,
          status, created_at: turn.created_at, updated_at: turn.updated_at,
        };
        await repository.insertParticipant(participant);
      }
      const existingDecision = await repository.findDecisionByActor(roundId, requirement.player_id);
      if (!existingDecision) {
        const decision: InsertNarrativeDecision = {
          id: `narrative-decision:${roundId}:${requirement.player_id}`,
          round_id: roundId, campaign_id: turn.campaign_id, turn_id: turn.id,
          action_id: action?.id ?? null, actor_id: requirement.player_id,
          decision_order: action ? Number(actionOrder.get(action.id)) : actions.length + index,
          status, created_at: turn.created_at, updated_at: turn.updated_at,
        };
        await repository.insertDecision(decision);
      } else if (action && !existingDecision.action_id) {
        await repository.linkActionAndSubmit(existingDecision.id, action.id, turn.updated_at);
      }
    }
  }

  private async loadView(executor: QueryExecutor, roundId: string): Promise<NarrativeRoundView> {
    const repository = new NarrativeRoundRepository(executor);
    const row = await repository.findById(roundId);
    if (!row) throw new AppError('NOT_FOUND', '叙事回合不存在。');
    const round = mapNarrativeRound(row);
    const participants = (await repository.listParticipants(roundId)).map(mapNarrativeParticipant);
    const decisions = (await repository.listDecisions(roundId)).map(mapNarrativeDecision);
    const workingFacts = (await repository.listWorkingFacts(roundId)).map(mapWorkingFact);
    narrativeRoundSchema.parse(round);
    narrativeDecisionSchema.array().parse(decisions);
    return { round, participants, decisions, workingFacts };
  }

  private async findNextTurnId(campaignId: string, roundId: string): Promise<string | null> {
    return this.executor.readCommitted
      ? this.executor.readCommitted(async (reader) => this.findNextTurnIdIn(reader, campaignId, roundId))
      : this.findNextTurnIdIn(this.executor, campaignId, roundId);
  }

  private async findNextTurnIdIn(tx: QueryReader, campaignId: string, roundId: string): Promise<string | null> {
    const roundRows = await tx.query<{ number: number }>(
      'SELECT number FROM platform_narrative_rounds WHERE id = ?', [roundId],
    );
    const round = roundRows[0];
    if (!round) return null;
    const rows = await tx.query<{ id: string }>(
      'SELECT id FROM platform_turns WHERE campaign_id = ? AND number > ? AND superseded_at IS NULL ORDER BY number ASC LIMIT 1',
      [campaignId, round.number],
    );
    return rows[0]?.id ?? null;
  }

  private async createNextTurnIn(tx: QueryExecutor, campaignId: string): Promise<string | null> {
    const turns = new TurnRepository(tx);
    const characters = new CharacterRepository(tx);
    const playerIds = await characters.listApprovedPlayerIds(campaignId);
    if (playerIds.length === 0) return null;
    const number = (await turns.maxTurnNumber(campaignId)) + 1;
    const now = new Date().toISOString();
    const turnId = nanoid(24);
    await turns.insertTurn({
      id: turnId, campaign_id: campaignId, number, status: 'waiting_for_actions',
      locked_at: null, completed_at: null, created_at: now, updated_at: now,
    });
    for (const playerId of playerIds) await turns.insertRequirement(turnId, campaignId, playerId);
    await this.ensureForTurnIn(tx, campaignId, turnId);
    return turnId;
  }
}

function roundStatusFromTurn(status: TurnRow['status']): NarrativeRound['status'] {
  switch (status) {
    case 'waiting_for_actions': return 'collecting';
    case 'locked': return 'ready';
    case 'resolving': return 'processing';
    case 'needs_owner_attention': return 'needs_owner_attention';
    case 'completed': return 'closed';
  }
}

function toFactRow(fact: WorkingFact): InsertNarrativeFact {
  return {
    id: fact.id,
    campaign_id: fact.campaignId,
    round_id: fact.roundId,
    decision_id: fact.decisionId,
    action_id: fact.actionId,
    fact_kind: fact.factKind,
    payload_json: JSON.stringify(fact.payload),
    visibility: fact.visibility,
    audience_actor_ids_json: JSON.stringify(fact.audienceActorIds),
    authority: fact.authority,
    validation_status: fact.validationStatus,
    source_kind: fact.sourceKind,
    source_refs_json: JSON.stringify(fact.provenance.sourceRefs),
    based_on_state_revision: fact.provenance.basedOnStateRevision,
    applied_state_revision: fact.provenance.appliedStateRevision,
    execution_id: fact.provenance.executionId,
    outcome_id: fact.provenance.outcomeId,
    event_id: fact.provenance.eventId,
    created_at: fact.createdAt,
  };
}

function validateFactInput(input: RecordWorkingFactOptions): void {
  if (input.authority === 'ai_candidate' && input.validationStatus === 'authoritative') {
    throw new AppError('AI_OUTPUT_INVALID', 'AI candidate 不能直接成为 authoritative fact。');
  }
  if (input.authority === 'ai_candidate' && input.sourceKind !== 'narration_result') {
    throw new AppError('AI_OUTPUT_INVALID', 'AI candidate 必须引用 narration_result。');
  }
  if (input.visibility === 'player_private' && (!input.audienceActorIds || input.audienceActorIds.length === 0)) {
    throw new AppError('VALIDATION_ERROR', 'player_private fact 必须指定 actor audience。');
  }
  if (input.visibility !== 'player_private' && (input.audienceActorIds?.length ?? 0) > 0) {
    throw new AppError('VALIDATION_ERROR', 'public/owner_only fact 不能指定 actor audience。');
  }
  factProvenanceSchema.parse(input.provenance);
  if (input.provenance.roundId !== input.roundId
    || input.provenance.decisionId !== (input.decisionId ?? null)
    || input.provenance.actionId !== (input.actionId ?? null)) {
    throw new AppError('VALIDATION_ERROR', 'fact provenance 与 round/decision/action 不一致。');
  }
}

function factVisibleTo(fact: WorkingFact | import('@dnd/contracts').RoundFact, audience: NarrativeProjectionAudience, actorId?: string): boolean {
  if (audience === 'server_only') return true;
  if (audience === 'gm_only') return true;
  if (fact.validationStatus !== 'authoritative') return false;
  if (fact.visibility === 'owner_only') return false;
  if (fact.visibility === 'public') return audience === 'party' || audience === 'actor_private';
  return audience === 'actor_private' && Boolean(actorId && fact.audienceActorIds.includes(actorId));
}
