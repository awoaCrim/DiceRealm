import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import {
  NarrativeRoundRepository,
  type InsertNarrativeFact,
  type NarrativeFactRow,
  type RoundFactSetRow,
} from './NarrativeRoundRepository.js';

/** Focused persistence port for immutable RoundFactSet snapshots. */
export class RoundFactSetRepository {
  private readonly rounds: NarrativeRoundRepository;

  constructor(executor: QueryExecutor) {
    this.rounds = new NarrativeRoundRepository(executor);
  }

  async insert(row: RoundFactSetRow): Promise<void> {
    return this.rounds.insertFactSet(row);
  }

  async findByRound(roundId: string, includeSuperseded = false): Promise<RoundFactSetRow | null> {
    return this.rounds.findFactSetByRound(roundId, includeSuperseded);
  }

  async insertFact(row: InsertNarrativeFact & { fact_set_id: string }): Promise<void> {
    return this.rounds.insertRoundFact(row);
  }

  async listFacts(factSetId: string, includeSuperseded = false): Promise<NarrativeFactRow[]> {
    return this.rounds.listRoundFacts(factSetId, includeSuperseded);
  }
}
