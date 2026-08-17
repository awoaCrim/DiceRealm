import type { NarrativeDecision } from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';
import { NarrativeRoundRepository, mapNarrativeDecision } from './NarrativeRoundRepository.js';
import { NarrativeRoundService, type DecisionClaim } from './NarrativeRoundService.js';

export interface NarrativeWorkItem {
  claim: DecisionClaim;
  decision: NarrativeDecision;
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
    outbox: EventPublisherPort,
    mutations = new CampaignMutationCoordinator(executor),
  ) {
    this.narrative = new NarrativeRoundService(executor, outbox, mutations);
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

  /** Test/diagnostic seam for asserting the worker's ordering query. */
  async peekNext(campaignId: string, roundId: string): Promise<NarrativeDecision | null> {
    return this.executor.transaction(async (tx: QueryExecutor) => {
      const repository = new NarrativeRoundRepository(tx);
      const round = await repository.findById(roundId);
      if (!round || round.campaign_id !== campaignId || round.status === 'closed') return null;
      const decision = await repository.findEarliestUnresolvedDecision(roundId);
      return decision ? mapNarrativeDecision(decision) : null;
    });
  }
}
