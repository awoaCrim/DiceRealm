import type { QueryExecutor } from '../platform/database/DatabasePort.js';

/**
 * Explicitly models a historical Turn that predates NarrativeRound.
 *
 * New live Turns must always retain their NarrativeRound. This helper is only
 * for legacy whole-turn compatibility tests, so those tests can prove the old
 * adapter remains readable without reopening a second live resolution path.
 */
export async function removeNarrativeRoundForLegacyTurn(executor: QueryExecutor, turnId: string): Promise<void> {
  const rounds = await executor.query<{ id: string }>(
    'SELECT id FROM platform_narrative_rounds WHERE turn_id = ?',
    [turnId],
  );
  for (const round of rounds) {
    await executor.execute('DELETE FROM platform_narrative_round_facts WHERE round_id = ?', [round.id]);
    await executor.execute('DELETE FROM platform_narrative_round_fact_sets WHERE round_id = ?', [round.id]);
    await executor.execute('DELETE FROM platform_narrative_working_facts WHERE round_id = ?', [round.id]);
    await executor.execute('DELETE FROM platform_narrative_decisions WHERE round_id = ?', [round.id]);
    await executor.execute('DELETE FROM platform_narrative_round_participants WHERE round_id = ?', [round.id]);
    await executor.execute('DELETE FROM platform_narrative_rounds WHERE id = ?', [round.id]);
  }
}
