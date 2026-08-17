import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import {
  NarrativeRoundRepository,
  type InsertNarrativeFact,
  type NarrativeFactRow,
} from './NarrativeRoundRepository.js';

/** Focused persistence port for current-round WorkingFacts. */
export class WorkingFactRepository {
  private readonly rounds: NarrativeRoundRepository;

  constructor(executor: QueryExecutor) {
    this.rounds = new NarrativeRoundRepository(executor);
  }

  async insert(row: InsertNarrativeFact): Promise<void> {
    return this.rounds.insertWorkingFact(row);
  }

  async listByRound(roundId: string, includeSuperseded = false): Promise<NarrativeFactRow[]> {
    return this.rounds.listWorkingFacts(roundId, includeSuperseded);
  }
}
