import type { NarrativeDecision } from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { AdjudicationRepository } from '../adjudication/AdjudicationRepository.js';
import { AppError } from '../../platform/http/AppError.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';
import { findDecisionForParticipant, NarrativeRoundRepository, mapNarrativeDecision } from './NarrativeRoundRepository.js';
import { NarrativeRoundService, type DecisionClaim } from './NarrativeRoundService.js';

export interface NarrativeWorkItem {
  claim: DecisionClaim;
  decision: NarrativeDecision;
}

export interface NarrativeAdvanceResult {
  presentationTerminal: boolean;
  action: 'pending' | 'waiting' | 'blocked' | 'scheduled' | 'closed';
  /** Keep the original wake-up when a resolved predecessor has no terminal presentation yet. */
  retainSignal?: boolean;
  nextDecisionId?: string;
}

/**
 * Query/recovery boundary for live NarrativeRound work.
 *
 * Production `NarrativeWorkRuntime` uses only `peekNext()` here. The resolver
 * owns the claim transaction, creates the AI run and binds its execution id to
 * the Decision. `claimNext()` remains a deterministic compatibility seam for
 * existing lower-level tests and must not precede resolver-owned work.
 */
export class NarrativeWorkCoordinator {
  private readonly narrative: NarrativeRoundService;

  constructor(
    private readonly executor: DatabasePort,
    private readonly outbox: EventPublisherPort,
    mutations = new CampaignMutationCoordinator(executor),
    narrative = new NarrativeRoundService(executor, outbox, mutations),
  ) {
    // Production composition injects the shared Actor-aware NarrativeRoundService;
    // the default keeps lower-level legacy/compatibility fixtures self-contained.
    this.narrative = narrative;
  }

  /**
   * @deprecated Test/compatibility seam only. Production must not pre-claim
   * before calling NarrativeDecisionResolutionService.
   */
  async claimNext(
    campaignId: string,
    roundId: string,
    executionId?: string,
  ): Promise<NarrativeWorkItem | null> {
    const claim = await this.narrative.claimEarliestDecision(campaignId, roundId, executionId);
    if (!claim) return null;
    return { claim, decision: claim.decision };
  }

  /** @deprecated Test/compatibility seam only; use NarrativeWorkRuntime. */
  async runOnce<T>(
    campaignId: string,
    roundId: string,
    worker: (item: NarrativeWorkItem) => Promise<T>,
    executionId?: string,
  ): Promise<T | null> {
    const item = await this.claimNext(campaignId, roundId, executionId);
    return item ? worker(item) : null;
  }

  /**
   * Sweep every active processing claim. This path intentionally only expires
   * abandoned claims; it does not decide or apply submitted work.
   */
  async sweepExpiredClaims(): Promise<number> {
    const claims = await this.executor.transaction(async (tx: QueryExecutor) => {
      return new NarrativeRoundRepository(tx).listProcessingDecisions();
    });
    let expired = 0;
    for (const claim of claims) {
      if (!claim.execution_id) continue;
      if (await this.narrative.expireExpiredDecisionClaim(
        claim.campaign_id,
        claim.round_id,
        claim.id,
        claim.execution_id,
      )) {
        expired += 1;
      }
    }
    return expired;
  }

  /**
   * Orchestrator-owned post-presentation transition. A resolved Decision is
   * not eligible to wake the next one until its latest narration attempt is
   * terminal; a failed narration is still terminal for scheduling purposes.
   */
  async advanceAfterDecision(
    campaignId: string,
    roundId: string,
    decisionId: string,
  ): Promise<NarrativeAdvanceResult> {
    const gate = await this.executor.transaction(async (tx: QueryExecutor) => {
      const repository = new NarrativeRoundRepository(tx);
      const round = await repository.findById(roundId);
      const decision = await repository.findDecisionById(decisionId);
      if (!round || round.campaign_id !== campaignId || !decision
        || decision.campaign_id !== campaignId || decision.round_id !== roundId) {
        return { presentationTerminal: false, action: 'pending' as const };
      }

      let presentationTerminal = decision.status === 'skipped';
      if (decision.status === 'resolved') {
        if (!decision.execution_id) return { presentationTerminal: false, action: 'pending' as const };
        const attempt = await new AdjudicationRepository(tx).findLatestNarrationAttempt(tx, decision.execution_id);
        presentationTerminal = Boolean(attempt && (attempt.status === 'succeeded' || attempt.status === 'failed'));
      }
      if (!presentationTerminal) {
        return {
          presentationTerminal: false,
          action: 'pending' as const,
          retainSignal: decision.status === 'resolved' || decision.status === 'processing',
        };
      }
      if (round.status === 'closed') return { presentationTerminal: true, action: 'closed' as const };

      const next = await repository.findEarliestUnresolvedDecision(roundId);
      if (next) {
        if (next.status === 'needs_owner_attention') {
          return { presentationTerminal: true, action: 'blocked' as const };
        }
        if (next.status === 'submitted' || next.status === 'processing') {
          await this.outbox.publishIn(tx, {
            type: 'narrative.round.work_available',
            campaignId,
            roundId,
            decisionId: next.id,
          });
          return { presentationTerminal: true, action: 'scheduled' as const, nextDecisionId: next.id };
        }
        return { presentationTerminal: true, action: 'waiting' as const };
      }

      const participants = await repository.listParticipants(roundId);
      const decisions = await repository.listDecisions(roundId);
      const incomplete = participants.find((participant) => {
        if (Number(participant.required) !== 1) return false;
        const participantDecision = findDecisionForParticipant(participant, decisions);
        return !participantDecision || !['resolved', 'skipped'].includes(participantDecision.status);
      });
      if (incomplete) {
        return {
          presentationTerminal: true,
          action: incomplete.status === 'needs_owner_attention' ? 'blocked' as const : 'waiting' as const,
        };
      }
      return { presentationTerminal: true, action: 'closed' as const };
    });

    if (gate.action !== 'closed' || !gate.presentationTerminal) return gate;
    try {
      await this.narrative.closeRound(campaignId, roundId);
    } catch (error) {
      // A concurrent submit/skip/close wins the race; the next signal or the
      // idempotent close call will re-evaluate the same authoritative state.
      if (!(error instanceof AppError && error.code === 'STATE_CONFLICT')) throw error;
      return { ...gate, action: 'waiting' };
    }
    return gate;
  }

  /** Test/diagnostic seam for asserting the worker's ordering query. */
  async peekNext(campaignId: string, roundId: string): Promise<NarrativeDecision | null> {
    return this.executor.transaction(async (tx: QueryExecutor) => {
      const repository = new NarrativeRoundRepository(tx);
      const round = await repository.findById(roundId);
      if (!round || round.campaign_id !== campaignId || round.status === 'closed') return null;
      if (await this.hasPendingPresentationIn(tx, roundId)) return null;
      const decision = await repository.findEarliestUnresolvedDecision(roundId);
      return decision ? mapNarrativeDecision(decision) : null;
    });
  }

  private async hasPendingPresentationIn(tx: QueryExecutor, roundId: string): Promise<boolean> {
    const repository = new NarrativeRoundRepository(tx);
    const decisions = await repository.listDecisions(roundId);
    const adjudication = new AdjudicationRepository(tx);
    for (const decision of decisions) {
      if (decision.status === 'skipped') continue;
      if (decision.status !== 'resolved') break;
      if (!decision.execution_id) return true;
      const attempt = await adjudication.findLatestNarrationAttempt(tx, decision.execution_id);
      if (!attempt || !['succeeded', 'failed'].includes(attempt.status)) return true;
    }
    return false;
  }
}
