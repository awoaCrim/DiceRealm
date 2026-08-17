import type {
  AdjudicationDecision,
  NormalizedActionIntent,
  RollPlan,
  RollRecord,
} from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface ActionIntentInsert extends NormalizedActionIntent {
  turnId: string;
  executionId: string;
  intentOrder: number;
  createdAt: string;
}

export interface AdjudicationDecisionInsert extends AdjudicationDecision {
  campaignId: string;
  turnId: string;
  executionId: string;
  createdAt: string;
}

export interface RollPlanInsert extends RollPlan {
  turnId: string;
}

export interface RollRecordInsert extends RollRecord {
  campaignId: string;
  turnId: string;
}

export interface ResolvedOutcomeInsert {
  id: string;
  campaignId: string;
  turnId: string;
  executionId: string;
  mutationId: string;
  basedOnStateRevision: number;
  appliedStateRevision: number;
  outcomeJson: string;
  createdAt: string;
}

export interface ResolvedOutcomeRow {
  id: string;
  campaign_id: string;
  turn_id: string;
  execution_id: string;
  mutation_id: string;
  based_on_state_revision: number;
  applied_state_revision: number;
  outcome_json: string;
  created_at: string;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
}

export interface NarrationAttemptInsert {
  id: string;
  campaignId: string;
  turnId: string;
  executionId: string;
  outcomeId: string;
  idempotencyKey: string;
  stateRevision: number;
  attempt: number;
  status: 'running' | 'succeeded' | 'failed';
  requestJson: string;
  resultJson: string | null;
  errorJson: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface NarrationAttemptRow {
  id: string;
  campaign_id: string;
  turn_id: string;
  execution_id: string;
  outcome_id: string;
  idempotency_key: string;
  state_revision: number;
  attempt: number;
  status: NarrationAttemptInsert['status'];
  request_json: string;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  completed_at: string | null;
}

/** Persistence seam for the server-owned adjudication records. */
export class AdjudicationRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async insertIntent(tx: QueryExecutor, row: ActionIntentInsert): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_action_intents
       (id, action_id, campaign_id, turn_id, actor_id, execution_id, intent_order,
        source_input, mode, action_type, action_ref, target_ids_json, declared_approach,
        desired_outcome, resource_choices_json, fallback_policy, based_on_state_revision,
        created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.intentId, row.actionId, row.campaignId, row.turnId, row.actorId, row.executionId,
       row.intentOrder, row.sourceInput, row.mode, row.actionType, row.actionRef ?? null,
       JSON.stringify(row.targetIds), row.declaredApproach ?? null, row.desiredOutcome ?? null,
       JSON.stringify(row.resourceChoices), row.fallbackPolicy ?? null, row.basedOnStateRevision,
       row.createdAt],
    );
  }

  async insertDecision(tx: QueryExecutor, row: AdjudicationDecisionInsert): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_adjudication_decisions
       (id, campaign_id, turn_id, intent_id, execution_id, kind, reason_code, rule_ref,
        roll_plan_id, based_on_state_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaignId, row.turnId, row.intentId, row.executionId, row.kind,
       row.reasonCode, row.ruleRef ?? null, row.rollPlanId ?? null, row.basedOnStateRevision,
       row.createdAt],
    );
  }

  async insertRollPlan(tx: QueryExecutor, row: RollPlanInsert): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_roll_plans
       (id, campaign_id, turn_id, intent_id, execution_id, actor_id, target_ids_json,
        roll_kind, dice_expression, modifier_breakdown_json, advantage_state, target_type,
        target_value, success_effects_json, failure_effects_json, rule_refs_json,
        ruleset_id, ruleset_version, based_on_state_revision, plan_hash, locked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaignId, row.turnId, row.intentId, row.executionId, row.actorId,
       JSON.stringify(row.targetIds), row.rollKind, row.diceExpression,
       JSON.stringify(row.modifierBreakdown), row.advantageState, row.targetType,
       row.targetValue, JSON.stringify(row.successEffects), JSON.stringify(row.failureEffects),
       JSON.stringify(row.ruleRefs), row.rulesetId, row.rulesetVersion,
       row.basedOnStateRevision, row.planHash, row.lockedAt],
    );
  }

  async findRollRecord(tx: QueryExecutor, executionId: string, rollPlanId: string): Promise<RollRecord | null> {
    const rows = await tx.query<RollRecordRow>(
      'SELECT * FROM platform_roll_records WHERE execution_id = ? AND roll_plan_id = ? AND superseded_at IS NULL',
      [executionId, rollPlanId],
    );
    return rows[0] ? mapRollRecord(rows[0]) : null;
  }

  async insertRollRecord(tx: QueryExecutor, row: RollRecordInsert): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_roll_records
       (id, campaign_id, turn_id, roll_plan_id, action_intent_id, execution_id, mutation_id,
        raw_dice_json, selected_dice_json, modifier_breakdown_json, total, target_value,
        result, ruleset_id, ruleset_version, state_revision, rolled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaignId, row.turnId, row.rollPlanId, row.actionIntentId, row.executionId,
       row.mutationId, JSON.stringify(row.rawDice), JSON.stringify(row.selectedDice),
       JSON.stringify(row.modifierBreakdown), row.total, row.targetValue, row.result,
       row.rulesetId, row.rulesetVersion, row.stateRevision, row.rolledAt],
    );
  }

  async insertOutcome(tx: QueryExecutor, row: ResolvedOutcomeInsert): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_resolved_outcomes
       (id, campaign_id, turn_id, execution_id, mutation_id, based_on_state_revision,
        applied_state_revision, outcome_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaignId, row.turnId, row.executionId, row.mutationId,
       row.basedOnStateRevision, row.appliedStateRevision, row.outcomeJson, row.createdAt],
    );
  }

  async findOutcomeByExecution(tx: QueryExecutor, executionId: string): Promise<ResolvedOutcomeRow | null> {
    const rows = await tx.query<ResolvedOutcomeRow>(
      'SELECT * FROM platform_resolved_outcomes WHERE execution_id = ? AND superseded_at IS NULL',
      [executionId],
    );
    return rows[0] ?? null;
  }

  async findLatestNarrationAttempt(tx: QueryExecutor, executionId: string): Promise<NarrationAttemptRow | null> {
    const rows = await tx.query<NarrationAttemptRow>(
      'SELECT * FROM platform_narration_attempts WHERE execution_id = ? AND superseded_at IS NULL ORDER BY attempt DESC LIMIT 1',
      [executionId],
    );
    return rows[0] ?? null;
  }

  async listNarrationAttempts(tx: QueryExecutor, executionId: string): Promise<NarrationAttemptRow[]> {
    return tx.query<NarrationAttemptRow>(
      'SELECT * FROM platform_narration_attempts WHERE execution_id = ? AND superseded_at IS NULL ORDER BY attempt ASC',
      [executionId],
    );
  }

  async nextNarrationAttempt(tx: QueryExecutor, executionId: string): Promise<number> {
    const rows = await tx.query<{ max: number | null }>(
      'SELECT MAX(attempt) AS max FROM platform_narration_attempts WHERE execution_id = ?',
      [executionId],
    );
    return Number(rows[0]?.max ?? 0) + 1;
  }

  async insertNarrationAttempt(tx: QueryExecutor, row: NarrationAttemptInsert): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_narration_attempts
       (id, campaign_id, turn_id, execution_id, outcome_id, idempotency_key, state_revision,
        attempt, status, request_json, result_json, error_json, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaignId, row.turnId, row.executionId, row.outcomeId, row.idempotencyKey,
       row.stateRevision, row.attempt, row.status, row.requestJson, row.resultJson, row.errorJson,
       row.createdAt, row.completedAt],
    );
  }

  async updateNarrationAttempt(
    tx: QueryExecutor,
    id: string,
    status: NarrationAttemptInsert['status'],
    resultJson: string | null,
    errorJson: string | null,
    completedAt: string | null,
  ): Promise<boolean> {
    const result = await tx.execute(
      `UPDATE platform_narration_attempts
       SET status = ?, result_json = ?, error_json = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
      [status, resultJson, errorJson, completedAt, id],
    );
    return result.changes === 1;
  }
}

interface RollRecordRow {
  id: string;
  roll_plan_id: string;
  action_intent_id: string;
  execution_id: string;
  mutation_id: string;
  raw_dice_json: string;
  selected_dice_json: string;
  modifier_breakdown_json: string;
  total: number;
  target_value: number | null;
  result: RollRecord['result'];
  ruleset_id: string;
  ruleset_version: string;
  state_revision: number;
  rolled_at: string;
}

function mapRollRecord(row: RollRecordRow): RollRecord {
  return {
    id: row.id,
    rollPlanId: row.roll_plan_id,
    actionIntentId: row.action_intent_id,
    executionId: row.execution_id,
    mutationId: row.mutation_id,
    rawDice: JSON.parse(row.raw_dice_json) as number[],
    selectedDice: JSON.parse(row.selected_dice_json) as number[],
    modifierBreakdown: JSON.parse(row.modifier_breakdown_json) as RollRecord['modifierBreakdown'],
    total: row.total,
    targetValue: row.target_value,
    result: row.result,
    rulesetId: row.ruleset_id,
    rulesetVersion: row.ruleset_version,
    stateRevision: row.state_revision,
    rolledAt: row.rolled_at,
  };
}
