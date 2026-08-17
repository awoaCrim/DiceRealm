import type {
  FactAuthority,
  FactSourceKind,
  FactValidationStatus,
  MechanicalResolvedOutcome,
  WorkingFactInput,
} from '@dnd/contracts';

export interface DeterministicFactInput {
  id?: string;
  campaignId: string;
  roundId: string;
  decisionId?: string | null;
  actionId?: string | null;
  factKind: string;
  payload: Record<string, unknown>;
  visibility: 'public' | 'player_private' | 'owner_only';
  audienceActorIds?: string[];
  executionId?: string | null;
  outcomeId?: string | null;
  eventId?: string | null;
  basedOnStateRevision: number;
  appliedStateRevision?: number | null;
  sourceRefs: string[];
}

export interface MechanicalOutcomeFactInput {
  campaignId: string;
  roundId: string;
  decisionId?: string | null;
  actionId?: string | null;
  executionId: string;
  outcomeId: string;
  basedOnStateRevision: number;
  appliedStateRevision: number;
  outcome: Pick<MechanicalResolvedOutcome, 'intents' | 'effects'>;
}

/**
 * Pure, server-owned fact contributors.
 *
 * These methods only normalize deterministic mechanical/state/event inputs into
 * WorkingFact records. They never call a Provider and never promote narration
 * output to authoritative runtime state.
 */
export class FactProvenanceService {
  mechanicalOutcomeFacts(input: MechanicalOutcomeFactInput): WorkingFactInput[] {
    const sourceRefs = [
      `round:${input.roundId}`,
      ...(input.decisionId ? [`decision:${input.decisionId}`] : []),
      `execution:${input.executionId}`,
      `outcome:${input.outcomeId}`,
      `state-revision:${input.campaignId}:${input.appliedStateRevision}`,
    ];
    const common = {
      campaignId: input.campaignId,
      roundId: input.roundId,
      decisionId: input.decisionId ?? null,
      actionId: input.actionId ?? null,
      visibility: 'public' as const,
      audienceActorIds: [] as string[],
      executionId: input.executionId,
      outcomeId: input.outcomeId,
      eventId: null,
      basedOnStateRevision: input.basedOnStateRevision,
      appliedStateRevision: input.appliedStateRevision,
      sourceRefs,
    };

    if (input.outcome.effects.length > 0) {
      return input.outcome.effects.map((effect, index) => this.authoritative({
        ...common,
        actionId: input.decisionId ? input.actionId ?? null : effect.sourceActionId ?? input.actionId ?? null,
        id: `working-fact:${input.executionId}:effect:${index}`,
        factKind: effect.kind,
        payload: { targetId: effect.targetId, delta: effect.delta, reason: effect.reason },
      }, 'server_mechanical', 'mechanical_resolved_outcome'));
    }

    const intent = input.outcome.intents[0];
    return [this.authoritative({
      ...common,
      id: `working-fact:${input.executionId}:decision-resolved`,
      factKind: 'decision.resolved',
      payload: {
        actionType: intent?.actionType ?? 'unknown',
        actionRef: intent?.actionRef ?? null,
        targetIds: intent?.targetIds ?? [],
      },
    }, 'runtime_state', 'narrative_decision')];
  }

  stateTransaction(input: DeterministicFactInput): WorkingFactInput {
    return this.authoritative(input, 'runtime_state', 'state_transaction');
  }

  eventEvidence(input: DeterministicFactInput): WorkingFactInput {
    return this.authoritative(input, 'event_evidence', 'turn_or_narrative_event');
  }

  gmAuthored(
    input: DeterministicFactInput,
    authority: 'runtime_state' | 'event_evidence' = 'runtime_state',
  ): WorkingFactInput {
    return this.authoritative(input, authority, 'gm_authored');
  }

  private authoritative(
    input: DeterministicFactInput,
    authority: FactAuthority,
    sourceKind: FactSourceKind,
  ): WorkingFactInput {
    const validationStatus: FactValidationStatus = 'authoritative';
    return {
      id: input.id,
      campaignId: input.campaignId,
      roundId: input.roundId,
      decisionId: input.decisionId ?? null,
      actionId: input.actionId ?? null,
      factKind: input.factKind,
      payload: input.payload,
      visibility: input.visibility,
      audienceActorIds: [...new Set(input.audienceActorIds ?? [])],
      authority,
      validationStatus,
      sourceKind,
      provenance: {
        roundId: input.roundId,
        decisionId: input.decisionId ?? null,
        actionId: input.actionId ?? null,
        executionId: input.executionId ?? null,
        outcomeId: input.outcomeId ?? null,
        eventId: input.eventId ?? null,
        basedOnStateRevision: input.basedOnStateRevision,
        appliedStateRevision: input.appliedStateRevision ?? null,
        sourceRefs: [...new Set(input.sourceRefs)],
      },
    };
  }
}
