import type {
  NarrativeProjectionAudience,
  ProjectedRoundSummary,
  RoundFact,
  WorkingFact,
} from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import {
  NarrativeRoundRepository,
  mapRoundFact,
  mapWorkingFact,
} from './NarrativeRoundRepository.js';

/** Deterministic, server-owned projection over active WorkingFacts/RoundFactSet rows. */
export class RoundProjectionService {
  constructor(private readonly executor: QueryExecutor) {}

  async projectWorkingFacts(roundId: string, audience: NarrativeProjectionAudience, actorId?: string): Promise<WorkingFact[]> {
    const repository = new NarrativeRoundRepository(this.executor);
    const round = await repository.findById(roundId);
    if (!round || round.status === 'closed') return [];
    const rows = await repository.listWorkingFacts(roundId);
    return rows.map(mapWorkingFact).filter((fact) => isFactVisible(fact, audience, actorId));
  }

  async projectRoundFacts(roundId: string, audience: NarrativeProjectionAudience, actorId?: string): Promise<ProjectedRoundSummary | null> {
    const repository = new NarrativeRoundRepository(this.executor);
    const round = await repository.findById(roundId);
    if (!round || round.status !== 'closed') return null;
    const factSet = await repository.findFactSetByRound(roundId);
    if (!factSet) return null;
    const facts = (await repository.listRoundFacts(factSet.id)).map((row) => mapRoundFact(row, factSet.id))
      .filter((fact) => isFactVisible(fact, audience, actorId));
    return {
      roundId,
      roundNumber: Number(round.number),
      factSetId: factSet.id,
      audience,
      actorId: actorId ?? null,
      stateRevision: Number(factSet.source_state_revision),
      facts,
      sourceRefs: [...new Set(facts.flatMap((fact) => fact.provenance.sourceRefs))],
    };
  }

  async projectLatestClosedBefore(
    campaignId: string,
    roundNumber: number,
    audience: NarrativeProjectionAudience,
    actorId?: string,
  ): Promise<ProjectedRoundSummary | null> {
    const repository = new NarrativeRoundRepository(this.executor);
    const round = await repository.findLatestClosedBefore(campaignId, roundNumber);
    return round ? this.projectRoundFacts(round.id, audience, actorId) : null;
  }
}

export function isFactVisible(
  fact: WorkingFact | RoundFact,
  audience: NarrativeProjectionAudience,
  actorId?: string,
): boolean {
  // GM/server projections are explicitly requested by trusted server code. They
  // may inspect candidates for audit, while actor/party context never treats a
  // candidate as authoritative truth.
  if (audience === 'gm_only' || audience === 'server_only') return true;
  if (fact.validationStatus !== 'authoritative') return false;
  if (fact.visibility === 'owner_only') return false;
  if (fact.visibility === 'public') return audience === 'party' || audience === 'actor_private';
  return audience === 'actor_private' && Boolean(actorId && fact.audienceActorIds.includes(actorId));
}
