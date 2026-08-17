import type {
  FactAuthority,
  FactSourceKind,
  FactValidationStatus,
  NarrativeDecision,
  NarrativeDecisionStatus,
  NarrativeParticipantStatus,
  NarrativeRound,
  NarrativeRoundParticipant,
  NarrativeRoundStatus,
  RoundFact,
  RoundFactSet,
  WorkingFact,
} from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface NarrativeRoundRow {
  id: string;
  campaign_id: string;
  turn_id: string;
  number: number;
  status: NarrativeRoundStatus;
  decision_cursor: number;
  last_state_revision: number;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
}

export interface NarrativeParticipantRow {
  round_id: string;
  campaign_id: string;
  player_id: string;
  character_id: string | null;
  participant_order: number;
  required: number;
  status: NarrativeParticipantStatus;
  created_at: string;
  updated_at: string;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
}

export interface NarrativeDecisionRow {
  id: string;
  round_id: string;
  campaign_id: string;
  turn_id: string;
  action_id: string | null;
  actor_id: string;
  decision_order: number;
  status: NarrativeDecisionStatus;
  execution_id: string | null;
  outcome_id: string | null;
  claim_revision: number | null;
  applied_state_revision: number | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
}

export interface NarrativeFactRow {
  id: string;
  campaign_id: string;
  round_id: string;
  decision_id: string | null;
  action_id: string | null;
  fact_kind: string;
  payload_json: string;
  visibility: 'public' | 'player_private' | 'owner_only';
  audience_actor_ids_json: string;
  authority: FactAuthority;
  validation_status: FactValidationStatus;
  source_kind: FactSourceKind;
  source_refs_json: string;
  based_on_state_revision: number;
  applied_state_revision: number | null;
  execution_id: string | null;
  outcome_id: string | null;
  event_id: string | null;
  created_at: string;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
}

export interface RoundFactSetRow {
  id: string;
  campaign_id: string;
  round_id: string;
  source_state_revision: number;
  closed_at: string;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
}

export interface InsertNarrativeRound {
  id: string;
  campaign_id: string;
  turn_id: string;
  number: number;
  status: NarrativeRoundStatus;
  decision_cursor?: number;
  last_state_revision?: number;
  closed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertNarrativeParticipant {
  round_id: string;
  campaign_id: string;
  player_id: string;
  character_id?: string | null;
  participant_order: number;
  required?: boolean;
  status?: NarrativeParticipantStatus;
  created_at: string;
  updated_at: string;
}

export interface InsertNarrativeDecision {
  id: string;
  round_id: string;
  campaign_id: string;
  turn_id: string;
  action_id?: string | null;
  actor_id: string;
  decision_order: number;
  status?: NarrativeDecisionStatus;
  created_at: string;
  updated_at: string;
}

export interface InsertNarrativeFact {
  id: string;
  campaign_id: string;
  round_id: string;
  decision_id?: string | null;
  action_id?: string | null;
  fact_kind: string;
  payload_json: string;
  visibility: 'public' | 'player_private' | 'owner_only';
  audience_actor_ids_json: string;
  authority: FactAuthority;
  validation_status: FactValidationStatus;
  source_kind: FactSourceKind;
  source_refs_json: string;
  based_on_state_revision: number;
  applied_state_revision?: number | null;
  execution_id?: string | null;
  outcome_id?: string | null;
  event_id?: string | null;
  created_at: string;
}

export class NarrativeRoundRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async insertRound(row: InsertNarrativeRound): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_narrative_rounds
       (id, campaign_id, turn_id, number, status, decision_cursor, last_state_revision,
        closed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.turn_id, row.number, row.status,
       row.decision_cursor ?? 0, row.last_state_revision ?? 0, row.closed_at ?? null,
       row.created_at, row.updated_at],
    );
  }

  async findById(id: string, includeSuperseded = false): Promise<NarrativeRoundRow | null> {
    const rows = await this.executor.query<NarrativeRoundRow>(
      includeSuperseded
        ? 'SELECT * FROM platform_narrative_rounds WHERE id = ?'
        : 'SELECT * FROM platform_narrative_rounds WHERE id = ? AND superseded_at IS NULL',
      [id],
    );
    return rows[0] ?? null;
  }

  async findByTurnId(turnId: string, includeSuperseded = false): Promise<NarrativeRoundRow | null> {
    const rows = await this.executor.query<NarrativeRoundRow>(
      includeSuperseded
        ? 'SELECT * FROM platform_narrative_rounds WHERE turn_id = ?'
        : 'SELECT * FROM platform_narrative_rounds WHERE turn_id = ? AND superseded_at IS NULL',
      [turnId],
    );
    return rows[0] ?? null;
  }

  async listByCampaign(campaignId: string, includeSuperseded = false): Promise<NarrativeRoundRow[]> {
    return this.executor.query<NarrativeRoundRow>(
      includeSuperseded
        ? 'SELECT * FROM platform_narrative_rounds WHERE campaign_id = ? ORDER BY number ASC'
        : 'SELECT * FROM platform_narrative_rounds WHERE campaign_id = ? AND superseded_at IS NULL ORDER BY number ASC',
      [campaignId],
    );
  }

  async findLatestClosedBefore(campaignId: string, number: number): Promise<NarrativeRoundRow | null> {
    const rows = await this.executor.query<NarrativeRoundRow>(
      `SELECT * FROM platform_narrative_rounds
       WHERE campaign_id = ? AND number < ? AND status = 'closed' AND superseded_at IS NULL
       ORDER BY number DESC LIMIT 1`,
      [campaignId, number],
    );
    return rows[0] ?? null;
  }

  async findActiveByCampaign(campaignId: string, excludeRoundId?: string): Promise<NarrativeRoundRow | null> {
    const rows = await this.executor.query<NarrativeRoundRow>(
      `SELECT * FROM platform_narrative_rounds
       WHERE campaign_id = ? AND status <> 'closed' AND superseded_at IS NULL
         AND (? IS NULL OR id <> ?)
       ORDER BY number ASC LIMIT 1`,
      [campaignId, excludeRoundId ?? null, excludeRoundId ?? null],
    );
    return rows[0] ?? null;
  }

  async updateStatus(
    id: string,
    from: readonly NarrativeRoundStatus[],
    status: NarrativeRoundStatus,
    updatedAt: string,
    closedAt?: string | null,
  ): Promise<boolean> {
    const placeholders = from.map(() => '?').join(',');
    const result = await this.executor.execute(
      `UPDATE platform_narrative_rounds
       SET status = ?, closed_at = ?, updated_at = ?
       WHERE id = ? AND superseded_at IS NULL AND status IN (${placeholders})`,
      [status, closedAt ?? null, updatedAt, id, ...from],
    );
    return result.changes === 1;
  }

  async updateCursor(id: string, cursor: number, stateRevision: number, updatedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_narrative_rounds
       SET decision_cursor = ?, last_state_revision = ?, updated_at = ?
       WHERE id = ? AND superseded_at IS NULL`,
      [cursor, stateRevision, updatedAt, id],
    );
    return result.changes === 1;
  }

  async insertParticipant(row: InsertNarrativeParticipant): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_narrative_round_participants
       (round_id, campaign_id, player_id, character_id, participant_order, required, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.round_id, row.campaign_id, row.player_id, row.character_id ?? null,
       row.participant_order, row.required === false ? 0 : 1, row.status ?? 'waiting',
       row.created_at, row.updated_at],
    );
  }

  async listParticipants(roundId: string, includeSuperseded = false): Promise<NarrativeParticipantRow[]> {
    return this.executor.query<NarrativeParticipantRow>(
      includeSuperseded
        ? 'SELECT * FROM platform_narrative_round_participants WHERE round_id = ? ORDER BY participant_order ASC'
        : 'SELECT * FROM platform_narrative_round_participants WHERE round_id = ? AND superseded_at IS NULL ORDER BY participant_order ASC',
      [roundId],
    );
  }

  async updateParticipantStatus(roundId: string, playerId: string, status: NarrativeParticipantStatus, updatedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_narrative_round_participants
       SET status = ?, updated_at = ?
       WHERE round_id = ? AND player_id = ? AND superseded_at IS NULL`,
      [status, updatedAt, roundId, playerId],
    );
    return result.changes === 1;
  }

  async insertDecision(row: InsertNarrativeDecision): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_narrative_decisions
       (id, round_id, campaign_id, turn_id, action_id, actor_id, decision_order, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.round_id, row.campaign_id, row.turn_id, row.action_id ?? null, row.actor_id,
       row.decision_order, row.status ?? 'waiting', row.created_at, row.updated_at],
    );
  }

  async findDecisionById(id: string, includeSuperseded = false): Promise<NarrativeDecisionRow | null> {
    const rows = await this.executor.query<NarrativeDecisionRow>(
      includeSuperseded
        ? 'SELECT * FROM platform_narrative_decisions WHERE id = ?'
        : 'SELECT * FROM platform_narrative_decisions WHERE id = ? AND superseded_at IS NULL',
      [id],
    );
    return rows[0] ?? null;
  }

  async findDecisionByActor(roundId: string, actorId: string): Promise<NarrativeDecisionRow | null> {
    const rows = await this.executor.query<NarrativeDecisionRow>(
      'SELECT * FROM platform_narrative_decisions WHERE round_id = ? AND actor_id = ? AND superseded_at IS NULL',
      [roundId, actorId],
    );
    return rows[0] ?? null;
  }

  async findDecisionByAction(roundId: string, actionId: string): Promise<NarrativeDecisionRow | null> {
    const rows = await this.executor.query<NarrativeDecisionRow>(
      'SELECT * FROM platform_narrative_decisions WHERE round_id = ? AND action_id = ? AND superseded_at IS NULL',
      [roundId, actionId],
    );
    return rows[0] ?? null;
  }

  async listDecisions(roundId: string, includeSuperseded = false): Promise<NarrativeDecisionRow[]> {
    return this.executor.query<NarrativeDecisionRow>(
      includeSuperseded
        ? 'SELECT * FROM platform_narrative_decisions WHERE round_id = ? ORDER BY decision_order ASC, id ASC'
        : 'SELECT * FROM platform_narrative_decisions WHERE round_id = ? AND superseded_at IS NULL ORDER BY decision_order ASC, id ASC',
      [roundId],
    );
  }

  /**
   * The worker ordering source is the submitted action timestamp, not the
   * participant/decision insertion order. The first unresolved row is also
   * the blocking row when it needs owner attention or is already processing.
   */
  async findEarliestUnresolvedDecision(roundId: string): Promise<NarrativeDecisionRow | null> {
    const rows = await this.executor.query<NarrativeDecisionRow>(
      `SELECT d.*
       FROM platform_narrative_decisions d
       JOIN platform_actions a
         ON a.id = d.action_id AND a.turn_id = d.turn_id AND a.superseded_at IS NULL
       WHERE d.round_id = ? AND d.superseded_at IS NULL AND d.action_id IS NOT NULL
         AND d.status NOT IN ('resolved', 'skipped')
       ORDER BY a.submitted_at ASC, a.id ASC
       LIMIT 1`,
      [roundId],
    );
    return rows[0] ?? null;
  }

  async listProcessingDecisions(): Promise<NarrativeDecisionRow[]> {
    return this.executor.query<NarrativeDecisionRow>(
      `SELECT * FROM platform_narrative_decisions
       WHERE superseded_at IS NULL AND status = 'processing'
       ORDER BY updated_at ASC, id ASC`,
    );
  }

  async hasProcessingDecision(roundId: string, excludeDecisionId?: string): Promise<boolean> {
    const rows = await this.executor.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM platform_narrative_decisions
       WHERE round_id = ? AND superseded_at IS NULL AND status = 'processing'
         AND (? IS NULL OR id <> ?)`,
      [roundId, excludeDecisionId ?? null, excludeDecisionId ?? null],
    );
    return Number(rows[0]?.count ?? 0) > 0;
  }

  /**
   * CAS claim used by both the explicit decision facade and the worker. The
   * ordering and single-in-flight guards live in the UPDATE so two workers
   * cannot both observe and claim the same eligible position.
   */
  async claimDecision(
    roundId: string,
    decisionId: string,
    executionId: string,
    claimRevision: number,
    updatedAt: string,
    allowOwnerAttention = true,
  ): Promise<boolean> {
    const claimable = allowOwnerAttention ? "('submitted','needs_owner_attention')" : "('submitted')";
    const result = await this.executor.execute(
      `UPDATE platform_narrative_decisions AS d
       SET status = 'processing', execution_id = ?, claim_revision = ?, failure_code = NULL, updated_at = ?
       WHERE d.id = ? AND d.round_id = ? AND d.superseded_at IS NULL
         AND d.status IN ${claimable}
         AND NOT EXISTS (
           SELECT 1 FROM platform_narrative_decisions busy
           WHERE busy.round_id = d.round_id AND busy.superseded_at IS NULL
             AND busy.status = 'processing' AND busy.id <> d.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM platform_narrative_decisions prior
           JOIN platform_actions prior_action
             ON prior_action.id = prior.action_id
            AND prior_action.turn_id = prior.turn_id
            AND prior_action.superseded_at IS NULL
           JOIN platform_actions current_action
             ON current_action.id = d.action_id
            AND current_action.turn_id = d.turn_id
            AND current_action.superseded_at IS NULL
           WHERE prior.round_id = d.round_id AND prior.superseded_at IS NULL
             AND prior.action_id IS NOT NULL
             AND prior.status NOT IN ('resolved', 'skipped')
             AND (prior_action.submitted_at < current_action.submitted_at
               OR (prior_action.submitted_at = current_action.submitted_at AND prior_action.id < current_action.id))
         )`,
      [executionId, claimRevision, updatedAt, decisionId, roundId],
    );
    return result.changes === 1;
  }

  async updateDecisionOrder(decisionId: string, decisionOrder: number, updatedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      'UPDATE platform_narrative_decisions SET decision_order = ?, updated_at = ? WHERE id = ? AND superseded_at IS NULL',
      [decisionOrder, updatedAt, decisionId],
    );
    return result.changes === 1;
  }

  async linkActionAndSubmit(decisionId: string, actionId: string, updatedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_narrative_decisions
       SET action_id = ?, status = 'submitted', updated_at = ?
       WHERE id = ? AND superseded_at IS NULL AND status IN ('waiting','submitted')`,
      [actionId, updatedAt, decisionId],
    );
    return result.changes === 1;
  }

  async markProcessing(decisionId: string, executionId: string, claimRevision: number, updatedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_narrative_decisions
       SET status = 'processing', execution_id = ?, claim_revision = ?, failure_code = NULL, updated_at = ?
       WHERE id = ? AND superseded_at IS NULL AND status IN ('submitted','needs_owner_attention')`,
      [executionId, claimRevision, updatedAt, decisionId],
    );
    return result.changes === 1;
  }

  /** Fence an abandoned claim; the timestamp is the claim lease heartbeat. */
  async expireProcessingDecision(
    roundId: string,
    decisionId: string,
    executionId: string,
    failureCode: string,
    expiredBefore: string,
    updatedAt: string,
  ): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_narrative_decisions
       SET status = 'needs_owner_attention', failure_code = ?, updated_at = ?
       WHERE id = ? AND round_id = ? AND superseded_at IS NULL
         AND status = 'processing' AND execution_id = ? AND updated_at <= ?`,
      [failureCode, updatedAt, decisionId, roundId, executionId, expiredBefore],
    );
    return result.changes === 1;
  }

  async markResolved(
    decisionId: string,
    outcomeId: string | null,
    appliedRevision: number,
    updatedAt: string,
    executionId?: string | null,
  ): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_narrative_decisions
       SET status = 'resolved', outcome_id = ?, applied_state_revision = ?, failure_code = NULL, updated_at = ?
       WHERE id = ? AND superseded_at IS NULL AND status = 'processing'
         AND (? IS NULL OR execution_id = ?)`,
      [outcomeId, appliedRevision, updatedAt, decisionId, executionId ?? null, executionId ?? null],
    );
    return result.changes === 1;
  }

  async markNeedsOwnerAttention(decisionId: string, failureCode: string, updatedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_narrative_decisions
       SET status = 'needs_owner_attention', failure_code = ?, updated_at = ?
       WHERE id = ? AND superseded_at IS NULL AND status IN ('processing','submitted','needs_owner_attention')`,
      [failureCode, updatedAt, decisionId],
    );
    return result.changes === 1;
  }

  async markSkipped(decisionId: string, updatedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_narrative_decisions
       SET status = 'skipped', failure_code = NULL, updated_at = ?
       WHERE id = ? AND superseded_at IS NULL AND status IN ('submitted','needs_owner_attention')`,
      [updatedAt, decisionId],
    );
    return result.changes === 1;
  }

  async insertWorkingFact(row: InsertNarrativeFact): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_narrative_working_facts
       (id, campaign_id, round_id, decision_id, action_id, fact_kind, payload_json, visibility,
        audience_actor_ids_json, authority, validation_status, source_kind, source_refs_json,
        based_on_state_revision, applied_state_revision, execution_id, outcome_id, event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.round_id, row.decision_id ?? null, row.action_id ?? null,
       row.fact_kind, row.payload_json, row.visibility, row.audience_actor_ids_json,
       row.authority, row.validation_status, row.source_kind, row.source_refs_json,
       row.based_on_state_revision, row.applied_state_revision ?? null, row.execution_id ?? null,
       row.outcome_id ?? null, row.event_id ?? null, row.created_at],
    );
  }

  async listWorkingFacts(roundId: string, includeSuperseded = false): Promise<NarrativeFactRow[]> {
    return this.executor.query<NarrativeFactRow>(
      includeSuperseded
        ? 'SELECT * FROM platform_narrative_working_facts WHERE round_id = ? ORDER BY created_at ASC, id ASC'
        : 'SELECT * FROM platform_narrative_working_facts WHERE round_id = ? AND superseded_at IS NULL ORDER BY created_at ASC, id ASC',
      [roundId],
    );
  }

  async listWorkingFactsByExecution(roundId: string, executionId: string): Promise<NarrativeFactRow[]> {
    return this.executor.query<NarrativeFactRow>(
      `SELECT * FROM platform_narrative_working_facts
       WHERE round_id = ? AND execution_id = ? AND superseded_at IS NULL
       ORDER BY created_at ASC, id ASC`,
      [roundId, executionId],
    );
  }

  async insertFactSet(row: RoundFactSetRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_narrative_round_fact_sets
       (id, campaign_id, round_id, source_state_revision, closed_at)
       VALUES (?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.round_id, row.source_state_revision, row.closed_at],
    );
  }

  async findFactSetByRound(roundId: string, includeSuperseded = false): Promise<RoundFactSetRow | null> {
    const rows = await this.executor.query<RoundFactSetRow>(
      includeSuperseded
        ? 'SELECT * FROM platform_narrative_round_fact_sets WHERE round_id = ?'
        : 'SELECT * FROM platform_narrative_round_fact_sets WHERE round_id = ? AND superseded_at IS NULL',
      [roundId],
    );
    return rows[0] ?? null;
  }

  async insertRoundFact(row: InsertNarrativeFact & { fact_set_id: string }): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_narrative_round_facts
       (id, fact_set_id, campaign_id, round_id, decision_id, action_id, fact_kind, payload_json,
        visibility, audience_actor_ids_json, authority, validation_status, source_kind, source_refs_json,
        based_on_state_revision, applied_state_revision, execution_id, outcome_id, event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.fact_set_id, row.campaign_id, row.round_id, row.decision_id ?? null, row.action_id ?? null,
       row.fact_kind, row.payload_json, row.visibility, row.audience_actor_ids_json,
       row.authority, row.validation_status, row.source_kind, row.source_refs_json,
       row.based_on_state_revision, row.applied_state_revision ?? null, row.execution_id ?? null,
       row.outcome_id ?? null, row.event_id ?? null, row.created_at],
    );
  }

  async listRoundFacts(factSetId: string, includeSuperseded = false): Promise<NarrativeFactRow[]> {
    return this.executor.query<NarrativeFactRow>(
      includeSuperseded
        ? 'SELECT * FROM platform_narrative_round_facts WHERE fact_set_id = ? ORDER BY created_at ASC, id ASC'
        : 'SELECT * FROM platform_narrative_round_facts WHERE fact_set_id = ? AND superseded_at IS NULL ORDER BY created_at ASC, id ASC',
      [factSetId],
    );
  }

  async supersedeAfterRoundNumber(campaignId: string, number: number, archiveId: string, now: string): Promise<void> {
    await this.executor.execute(
      `UPDATE platform_narrative_rounds
       SET superseded_at = ?, superseded_by_archive_id = ?
       WHERE campaign_id = ? AND superseded_at IS NULL AND number > ?`,
      [now, archiveId, campaignId, number],
    );
    for (const table of [
      'platform_narrative_round_participants',
      'platform_narrative_decisions',
      'platform_narrative_working_facts',
      'platform_narrative_round_fact_sets',
      'platform_narrative_round_facts',
    ]) {
      await this.executor.execute(
        `UPDATE ${table}
         SET superseded_at = ?, superseded_by_archive_id = ?
         WHERE campaign_id = ? AND superseded_at IS NULL
           AND round_id IN (SELECT id FROM platform_narrative_rounds WHERE campaign_id = ? AND number > ?)`,
        [now, archiveId, campaignId, campaignId, number],
      );
    }
  }

  async restoreRound(row: NarrativeRoundRow, turnId: string, updatedAt: string): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_narrative_rounds
       (id, campaign_id, turn_id, number, status, decision_cursor, last_state_revision, closed_at, created_at, updated_at, superseded_at, superseded_by_archive_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         turn_id = excluded.turn_id,
         number = excluded.number,
         status = excluded.status,
         decision_cursor = excluded.decision_cursor,
         last_state_revision = excluded.last_state_revision,
         closed_at = excluded.closed_at,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         superseded_at = NULL,
         superseded_by_archive_id = NULL`,
      [row.id, row.campaign_id, turnId, row.number, row.status, row.decision_cursor,
       row.last_state_revision, row.closed_at, row.created_at, updatedAt],
    );
  }

  async supersedeRoundContents(roundId: string, archiveId: string, now: string): Promise<void> {
    for (const table of [
      'platform_narrative_round_participants',
      'platform_narrative_decisions',
      'platform_narrative_working_facts',
      'platform_narrative_round_fact_sets',
      'platform_narrative_round_facts',
    ]) {
      await this.executor.execute(
        `UPDATE ${table} SET superseded_at = ?, superseded_by_archive_id = ? WHERE round_id = ? AND superseded_at IS NULL`,
        [now, archiveId, roundId],
      );
    }
  }

  async restoreParticipant(row: NarrativeParticipantRow, updatedAt: string): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_narrative_round_participants
       (round_id, campaign_id, player_id, character_id, participant_order, required, status, created_at, updated_at, superseded_at, superseded_by_archive_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (round_id, player_id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         character_id = excluded.character_id,
         participant_order = excluded.participant_order,
         required = excluded.required,
         status = excluded.status,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         superseded_at = NULL,
         superseded_by_archive_id = NULL`,
      [row.round_id, row.campaign_id, row.player_id, row.character_id, row.participant_order,
       row.required, row.status, row.created_at, updatedAt],
    );
  }

  async restoreDecision(row: NarrativeDecisionRow, updatedAt: string): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_narrative_decisions
       (id, round_id, campaign_id, turn_id, action_id, actor_id, decision_order, status, execution_id, outcome_id,
        claim_revision, applied_state_revision, failure_code, created_at, updated_at, superseded_at, superseded_by_archive_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         round_id = excluded.round_id,
         campaign_id = excluded.campaign_id,
         turn_id = excluded.turn_id,
         action_id = excluded.action_id,
         actor_id = excluded.actor_id,
         decision_order = excluded.decision_order,
         status = excluded.status,
         execution_id = excluded.execution_id,
         outcome_id = excluded.outcome_id,
         claim_revision = excluded.claim_revision,
         applied_state_revision = excluded.applied_state_revision,
         failure_code = excluded.failure_code,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         superseded_at = NULL,
         superseded_by_archive_id = NULL`,
      [row.id, row.round_id, row.campaign_id, row.turn_id, row.action_id, row.actor_id,
       row.decision_order, row.status, row.execution_id, row.outcome_id, row.claim_revision,
       row.applied_state_revision, row.failure_code, row.created_at, updatedAt],
    );
  }

  async restoreWorkingFact(row: InsertNarrativeFact, updatedAt: string): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_narrative_working_facts
       (id, campaign_id, round_id, decision_id, action_id, fact_kind, payload_json, visibility,
        audience_actor_ids_json, authority, validation_status, source_kind, source_refs_json,
        based_on_state_revision, applied_state_revision, execution_id, outcome_id, event_id, created_at, superseded_at, superseded_by_archive_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         round_id = excluded.round_id,
         decision_id = excluded.decision_id,
         action_id = excluded.action_id,
         fact_kind = excluded.fact_kind,
         payload_json = excluded.payload_json,
         visibility = excluded.visibility,
         audience_actor_ids_json = excluded.audience_actor_ids_json,
         authority = excluded.authority,
         validation_status = excluded.validation_status,
         source_kind = excluded.source_kind,
         source_refs_json = excluded.source_refs_json,
         based_on_state_revision = excluded.based_on_state_revision,
         applied_state_revision = excluded.applied_state_revision,
         execution_id = excluded.execution_id,
         outcome_id = excluded.outcome_id,
         event_id = excluded.event_id,
         created_at = excluded.created_at,
         superseded_at = NULL,
         superseded_by_archive_id = NULL`,
      [row.id, row.campaign_id, row.round_id, row.decision_id ?? null, row.action_id ?? null,
       row.fact_kind, row.payload_json, row.visibility, row.audience_actor_ids_json, row.authority,
       row.validation_status, row.source_kind, row.source_refs_json, row.based_on_state_revision,
       row.applied_state_revision ?? null, row.execution_id ?? null, row.outcome_id ?? null,
       row.event_id ?? null, row.created_at ?? updatedAt],
    );
  }

  async restoreFactSet(row: RoundFactSetRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_narrative_round_fact_sets
       (id, campaign_id, round_id, source_state_revision, closed_at, superseded_at, superseded_by_archive_id)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         round_id = excluded.round_id,
         source_state_revision = excluded.source_state_revision,
         closed_at = excluded.closed_at,
         superseded_at = NULL,
         superseded_by_archive_id = NULL`,
      [row.id, row.campaign_id, row.round_id, row.source_state_revision, row.closed_at],
    );
  }

  async restoreRoundFact(row: InsertNarrativeFact & { fact_set_id: string }, updatedAt: string): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_narrative_round_facts
       (id, fact_set_id, campaign_id, round_id, decision_id, action_id, fact_kind, payload_json,
        visibility, audience_actor_ids_json, authority, validation_status, source_kind, source_refs_json,
        based_on_state_revision, applied_state_revision, execution_id, outcome_id, event_id, created_at, superseded_at, superseded_by_archive_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         fact_set_id = excluded.fact_set_id,
         campaign_id = excluded.campaign_id,
         round_id = excluded.round_id,
         decision_id = excluded.decision_id,
         action_id = excluded.action_id,
         fact_kind = excluded.fact_kind,
         payload_json = excluded.payload_json,
         visibility = excluded.visibility,
         audience_actor_ids_json = excluded.audience_actor_ids_json,
         authority = excluded.authority,
         validation_status = excluded.validation_status,
         source_kind = excluded.source_kind,
         source_refs_json = excluded.source_refs_json,
         based_on_state_revision = excluded.based_on_state_revision,
         applied_state_revision = excluded.applied_state_revision,
         execution_id = excluded.execution_id,
         outcome_id = excluded.outcome_id,
         event_id = excluded.event_id,
         created_at = excluded.created_at,
         superseded_at = NULL,
         superseded_by_archive_id = NULL`,
      [row.id, row.fact_set_id, row.campaign_id, row.round_id, row.decision_id ?? null, row.action_id ?? null,
       row.fact_kind, row.payload_json, row.visibility, row.audience_actor_ids_json, row.authority,
       row.validation_status, row.source_kind, row.source_refs_json, row.based_on_state_revision,
       row.applied_state_revision ?? null, row.execution_id ?? null, row.outcome_id ?? null,
       row.event_id ?? null, row.created_at ?? updatedAt],
    );
  }

  async rebindRoundToTurn(roundId: string, turnId: string): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_narrative_rounds SET turn_id = ? WHERE id = ?', [turnId, roundId],
    );
    await this.executor.execute(
      'UPDATE platform_narrative_decisions SET turn_id = ? WHERE round_id = ?', [turnId, roundId],
    );
  }

  async clearSupersededForRound(roundId: string): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_narrative_rounds SET superseded_at = NULL, superseded_by_archive_id = NULL WHERE id = ?', [roundId],
    );
    for (const table of [
      'platform_narrative_round_participants',
      'platform_narrative_decisions',
      'platform_narrative_working_facts',
      'platform_narrative_round_fact_sets',
      'platform_narrative_round_facts',
    ]) {
      await this.executor.execute(
        `UPDATE ${table} SET superseded_at = NULL, superseded_by_archive_id = NULL WHERE round_id = ?`, [roundId],
      );
    }
  }
}

export function mapNarrativeRound(row: NarrativeRoundRow): NarrativeRound {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    turnId: row.turn_id,
    number: Number(row.number),
    status: row.status,
    decisionCursor: Number(row.decision_cursor),
    lastStateRevision: Number(row.last_state_revision),
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    superseded: row.superseded_at !== null,
  };
}

export function mapNarrativeParticipant(row: NarrativeParticipantRow): NarrativeRoundParticipant {
  return {
    roundId: row.round_id,
    campaignId: row.campaign_id,
    playerId: row.player_id,
    characterId: row.character_id,
    participantOrder: Number(row.participant_order),
    required: Number(row.required) === 1,
    status: row.status,
  };
}

export function mapNarrativeDecision(row: NarrativeDecisionRow): NarrativeDecision {
  return {
    id: row.id,
    roundId: row.round_id,
    campaignId: row.campaign_id,
    turnId: row.turn_id,
    actionId: row.action_id,
    actorId: row.actor_id,
    decisionOrder: Number(row.decision_order),
    status: row.status,
    executionId: row.execution_id,
    outcomeId: row.outcome_id,
    claimRevision: row.claim_revision === null ? null : Number(row.claim_revision),
    appliedStateRevision: row.applied_state_revision === null ? null : Number(row.applied_state_revision),
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    superseded: row.superseded_at !== null,
  };
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function mapFactRow(row: NarrativeFactRow, factSetId?: string): WorkingFact | RoundFact {
  const base = {
    id: row.id,
    campaignId: row.campaign_id,
    roundId: row.round_id,
    decisionId: row.decision_id,
    actionId: row.action_id,
    factKind: row.fact_kind,
    payload: parsePayload(row.payload_json),
    visibility: row.visibility,
    audienceActorIds: parseStringArray(row.audience_actor_ids_json),
    authority: row.authority,
    validationStatus: row.validation_status,
    sourceKind: row.source_kind,
    provenance: {
      roundId: row.round_id,
      decisionId: row.decision_id,
      actionId: row.action_id,
      executionId: row.execution_id,
      outcomeId: row.outcome_id,
      eventId: row.event_id,
      basedOnStateRevision: Number(row.based_on_state_revision),
      appliedStateRevision: row.applied_state_revision === null ? null : Number(row.applied_state_revision),
      sourceRefs: parseStringArray(row.source_refs_json),
    },
    createdAt: row.created_at,
    superseded: row.superseded_at !== null,
  } satisfies Omit<WorkingFact, 'factSetId'>;
  return factSetId ? { ...base, factSetId } : base;
}

export function mapWorkingFact(row: NarrativeFactRow): WorkingFact {
  return mapFactRow(row) as WorkingFact;
}

export function narrativeFactToInsertRow(fact: WorkingFact): InsertNarrativeFact {
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

export function mapRoundFact(row: NarrativeFactRow, factSetId: string): RoundFact {
  return mapFactRow(row, factSetId) as RoundFact;
}

export function mapRoundFactSet(row: RoundFactSetRow, facts: RoundFact[]): RoundFactSet {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    roundId: row.round_id,
    sourceStateRevision: Number(row.source_state_revision),
    closedAt: row.closed_at,
    facts,
    superseded: row.superseded_at !== null,
  };
}
