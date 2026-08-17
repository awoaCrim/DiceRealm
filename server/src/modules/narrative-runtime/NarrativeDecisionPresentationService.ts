import { nanoid } from 'nanoid';
import {
  mechanicalResolvedOutcomeSchema,
  narrationOutputSchema,
  narrationRequestSchema,
  type AiPrompt,
  type MechanicalResolvedOutcome,
  type NarrationOutput,
  type NarrationRequest,
} from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { AppError } from '../../platform/http/AppError.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';
import { AdjudicationRepository, type NarrationAttemptRow } from '../adjudication/AdjudicationRepository.js';
import { NarrationService } from '../adjudication/NarrationService.js';
import { AiRunRepository, type AiRunRow } from '../ai-runtime/AiRunRepository.js';
import { TurnEntryRepository } from '../ai-runtime/TurnEntryRepository.js';
import { TurnRepository } from '../turns/TurnRepository.js';
import type { AiProviderPort } from '../ai-runtime/AiProviderPort.js';

export type NarrativePresentationStatus = 'running' | 'succeeded' | 'failed';

/** A crashed Provider call must not leave the presentation checkpoint forever running. */
export const NARRATIVE_PRESENTATION_ATTEMPT_LEASE_MS = 5 * 60 * 1000;
export const NARRATION_ATTEMPT_EXPIRED_CODE = 'NARRATION_ATTEMPT_EXPIRED';

export interface NarrativePresentationResult {
  status: NarrativePresentationStatus;
}

/**
 * Presentation failures are deliberately separate from mechanics failures.
 * The caller may schedule the next Decision while retaining this error for an
 * explicit narration retry against the same committed execution.
 */
export class NarrativePresentationRetryableError extends AppError {
  constructor(
    code: 'AI_PROVIDER_FAILED' | 'AI_OUTPUT_INVALID' | 'STALE_STATE_REVISION' | 'INTERNAL_ERROR',
    message: string,
  ) {
    super(code, message);
    this.name = 'NarrativePresentationRetryableError';
  }
}

interface PreparedAttempt {
  kind: 'running' | 'succeeded' | 'started' | 'failed';
  attempt?: NarrationAttemptRow;
  output?: NarrationOutput;
  request?: NarrationRequest;
  error?: NarrativePresentationRetryableError;
}

interface MechanicalOutcomeRow {
  id: string;
  campaign_id: string;
  turn_id: string;
  execution_id: string;
  applied_state_revision: number;
  outcome_json: string;
}

/**
 * Decision-scoped presentation checkpoint.
 *
 * Mechanics, WorkingFacts and the Decision lifecycle are committed before
 * this service runs. This service only owns narration attempts, presentation
 * entries and the final AI-run metadata; it never allocates a StateRevision or
 * changes authoritative combat/world state.
 */
export class NarrativeDecisionPresentationService {
  constructor(
    private readonly executor: DatabasePort,
    private readonly outbox: EventPublisherPort,
  ) {}

  async present(
    campaignId: string,
    turnId: string,
    runId: string,
    provider: AiProviderPort,
    basePrompt: AiPrompt,
  ): Promise<NarrativePresentationResult> {
    let prepared: PreparedAttempt;
    try {
      prepared = await this.prepare(campaignId, turnId, runId);
    } catch (error) {
      throw this.asRetryable(error);
    }

    if (prepared.kind === 'running') return { status: 'running' };
    if (prepared.kind === 'failed') throw prepared.error!;
    if (prepared.kind === 'succeeded') {
      await this.finalize(campaignId, turnId, runId, prepared.attempt!.id, prepared.output!);
      return { status: 'succeeded' };
    }

    let output: NarrationOutput;
    try {
      output = await new NarrationService(provider).generate(prepared.request!, basePrompt, {
        onDelta: async (delta) => {
          try {
            await this.executor.transaction((tx) => this.outbox.publishIn(tx, {
              type: 'ai.preview.delta', campaignId, runId, text: delta.text,
            }));
          } catch {
            throw new AppError('INTERNAL_ERROR', 'AI 叙事预览写入内部错误。');
          }
        },
      });
    } catch (error) {
      const retryable = this.asRetryable(error);
      await this.recordFailure(prepared.attempt!.id, retryable);
      throw retryable;
    }

    try {
      await this.finalize(campaignId, turnId, runId, prepared.attempt!.id, output);
    } catch (error) {
      const retryable = this.asRetryable(error);
      await this.recordFailure(prepared.attempt!.id, retryable);
      throw retryable;
    }
    return { status: 'succeeded' };
  }

  private async prepare(campaignId: string, turnId: string, runId: string): Promise<PreparedAttempt> {
    return this.executor.transaction(async (tx) => {
      const runs = new AiRunRepository(tx);
      const run = await runs.findById(runId);
      if (!run || run.campaign_id !== campaignId || run.turn_id !== turnId
        || run.status !== 'running' || run.run_kind !== 'mechanical_resolution') {
        throw new AppError('STATE_CONFLICT', '机械结果不在可叙事状态。');
      }
      const turn = await new TurnRepository(tx).findTurnById(turnId);
      if (!turn || turn.campaign_id !== campaignId || !['resolving', 'completed'].includes(turn.status)) {
        throw new AppError('STATE_CONFLICT', '机械结果尚未完成可叙事的回合生命周期。');
      }
      const repository = new AdjudicationRepository(tx);
      const outcomeRow = await repository.findOutcomeByExecution(tx, runId);
      if (!outcomeRow) throw new AppError('STATE_CONFLICT', '机械结果尚未提交或已被恢复操作 supersede。');
      assertOutcomeMatches(run, outcomeRow, campaignId, turnId, runId);

      let latest = await repository.findLatestNarrationAttempt(tx, runId);
      if (latest) assertAttemptMatches(latest, outcomeRow, campaignId, turnId, runId);
      if (latest?.status === 'running') {
        if (!isNarrationAttemptExpired(latest.created_at)) return { kind: 'running' };
        const now = new Date().toISOString();
        const reclaimed = await repository.updateNarrationAttempt(
          tx,
          latest.id,
          'failed',
          null,
          JSON.stringify({
            code: NARRATION_ATTEMPT_EXPIRED_CODE,
            message: '叙事尝试超过恢复租约，已允许重试。',
            timestamp: now,
          }),
          now,
        );
        if (!reclaimed) {
          latest = await repository.findLatestNarrationAttempt(tx, runId);
          if (latest) assertAttemptMatches(latest, outcomeRow, campaignId, turnId, runId);
          if (latest?.status === 'running') return { kind: 'running' };
          if (latest?.status === 'succeeded') {
            return {
              kind: 'succeeded',
              attempt: latest,
              output: parseNarrationOutput(latest.result_json),
            };
          }
        }
      }
      if (latest?.status === 'succeeded') {
        return {
          kind: 'succeeded',
          attempt: latest,
          output: parseNarrationOutput(latest.result_json),
        };
      }

      let request: NarrationRequest;
      try {
        request = await this.buildRequest(tx, outcomeRow);
      } catch (error) {
        const retryable = this.asRetryable(error);
        const now = new Date().toISOString();
        const attempt = await repository.nextNarrationAttempt(tx, runId);
        const row = await this.insertAttempt(
          tx,
          repository,
          campaignId,
          turnId,
          runId,
          outcomeRow,
          attempt,
          'failed',
          JSON.stringify({ stage: 'narration_request' }),
          JSON.stringify({ code: retryable.code, message: retryable.message, timestamp: now }),
          now,
        );
        return { kind: 'failed', attempt: row, error: retryable };
      }

      const attempt = await repository.nextNarrationAttempt(tx, runId);
      const now = new Date().toISOString();
      const row = await this.insertAttempt(
        tx,
        repository,
        campaignId,
        turnId,
        runId,
        outcomeRow,
        attempt,
        'running',
        JSON.stringify(request),
        null,
        now,
      );
      return { kind: 'started', attempt: row, request };
    });
  }

  private async insertAttempt(
    tx: QueryExecutor,
    repository: AdjudicationRepository,
    campaignId: string,
    turnId: string,
    runId: string,
    outcomeRow: MechanicalOutcomeRow,
    attempt: number,
    status: NarrationAttemptRow['status'],
    requestJson: string,
    errorJson: string | null,
    now: string,
  ): Promise<NarrationAttemptRow> {
    const row: NarrationAttemptRow = {
      id: nanoid(24),
      campaign_id: campaignId,
      turn_id: turnId,
      execution_id: runId,
      outcome_id: outcomeRow.id,
      idempotency_key: `narration:${runId}:${attempt}`,
      state_revision: outcomeRow.applied_state_revision,
      attempt,
      status,
      request_json: requestJson,
      result_json: null,
      error_json: errorJson,
      created_at: now,
      completed_at: status === 'running' ? null : now,
    };
    await repository.insertNarrationAttempt(tx, {
      id: row.id,
      campaignId,
      turnId,
      executionId: runId,
      outcomeId: outcomeRow.id,
      idempotencyKey: row.idempotency_key,
      stateRevision: row.state_revision,
      attempt,
      status,
      requestJson,
      resultJson: null,
      errorJson,
      createdAt: now,
      completedAt: row.completed_at,
    });
    return row;
  }

  private async buildRequest(
    tx: QueryExecutor,
    outcomeRow: MechanicalOutcomeRow,
  ): Promise<NarrationRequest> {
    const outcome = mechanicalResolvedOutcomeSchema.parse(JSON.parse(outcomeRow.outcome_json));
    const actions = await new TurnRepository(tx).listActionsByTurn(outcomeRow.turn_id);
    const actionById = new Map(actions.map((action) => [action.id, action]));
    const projection = await this.projectObservable(tx, outcomeRow.campaign_id, outcome);
    const actionSummaries = outcome.intents.map((intent) => {
      const action = actionById.get(intent.actionId);
      if (!action || action.player_id !== intent.actorId) {
        throw new AppError('INTERNAL_ERROR', '机械结果缺少与叙事行动对应的玩家行动。');
      }
      return {
        actionId: action.id,
        actorId: action.player_id,
        observableIntent: {
          actionType: intent.actionType,
          ...(intent.actionRef ? { actionRef: intent.actionRef } : {}),
          targetIds: intent.targetIds.filter((targetId) => projection.visibleEntityIds.has(targetId)),
        },
      };
    });
    return narrationRequestSchema.parse({
      outcomeId: outcomeRow.id,
      executionId: outcomeRow.execution_id,
      campaignId: outcomeRow.campaign_id,
      turnId: outcomeRow.turn_id,
      stateRevision: outcomeRow.applied_state_revision,
      audience: 'player_public',
      observableEntities: projection.observableEntities,
      actionSummaries,
      observableOutcome: {
        effects: projection.effects,
        rolls: projection.rolls,
      },
    });
  }

  private async projectObservable(
    tx: QueryExecutor,
    campaignId: string,
    outcome: Pick<MechanicalResolvedOutcome, 'intents' | 'rollPlans' | 'rollRecords' | 'effects'>,
  ): Promise<{
    observableEntities: Array<{ id: string; kind: 'actor' | 'combatant'; displayName: string }>;
    visibleEntityIds: Set<string>;
    effects: MechanicalResolvedOutcome['effects'];
    rolls: Array<{
      kind: MechanicalResolvedOutcome['rollPlans'][number]['rollKind'];
      actionId: string;
      actorId: string;
      targetIds: string[];
      selectedDice: number[];
      total: number;
      result: MechanicalResolvedOutcome['rollRecords'][number]['result'];
    }>;
  }> {
    const actorIds = [...new Set(outcome.intents.map((intent) => intent.actorId))];
    const actorIdSet = new Set(actorIds);
    const candidateCombatantIds = [...new Set([
      ...outcome.intents.flatMap((intent) => intent.targetIds),
      ...outcome.rollPlans.flatMap((plan) => plan.targetIds),
      ...outcome.effects.map((effect) => effect.targetId),
    ].filter((id) => !actorIdSet.has(id)))];

    const characters = await new CharacterRepository(tx).listByCampaign(campaignId);
    const observableEntities: Array<{ id: string; kind: 'actor' | 'combatant'; displayName: string }> = [];
    const visibleEntityIds = new Set(actorIds);
    for (const actorId of actorIds) {
      const character = characters.find((row) => row.player_id === actorId && row.status !== 'archived')
        ?? characters.find((row) => row.player_id === actorId);
      observableEntities.push({ id: actorId, kind: 'actor', displayName: character?.name ?? actorId });
    }

    if (candidateCombatantIds.length > 0) {
      const placeholders = candidateCombatantIds.map(() => '?').join(',');
      const combatants = await tx.query<{ id: string; name: string }>(
        `SELECT id, name FROM platform_combatants
         WHERE campaign_id = ? AND superseded_at IS NULL AND visibility = 'public'
           AND id IN (${placeholders}) ORDER BY id`,
        [campaignId, ...candidateCombatantIds],
      );
      for (const combatant of combatants) {
        visibleEntityIds.add(combatant.id);
        observableEntities.push({ id: combatant.id, kind: 'combatant', displayName: combatant.name });
      }
    }

    const actionIds = new Set(outcome.intents.map((intent) => intent.actionId));
    const effects = outcome.effects
      .filter((effect) => visibleEntityIds.has(effect.targetId))
      .map((effect) => ({
        ...(effect.sourceActionId && actionIds.has(effect.sourceActionId) ? { sourceActionId: effect.sourceActionId } : {}),
        kind: effect.kind,
        targetId: effect.targetId,
        delta: effect.delta,
        reason: effect.reason,
      }));

    const intentsById = new Map(outcome.intents.map((intent) => [intent.intentId, intent]));
    const rolls = outcome.rollRecords.map((record) => {
      const plan = outcome.rollPlans.find((candidate) => candidate.id === record.rollPlanId);
      const intent = intentsById.get(record.actionIntentId);
      if (!plan || !intent) throw new AppError('INTERNAL_ERROR', '机械结果缺少对应的 RollPlan 或 Intent。');
      return {
        kind: plan.rollKind,
        actionId: intent.actionId,
        actorId: intent.actorId,
        targetIds: plan.targetIds.filter((targetId) => visibleEntityIds.has(targetId)),
        selectedDice: record.selectedDice,
        total: record.total,
        result: record.result,
      };
    });

    return { observableEntities, visibleEntityIds, effects, rolls };
  }

  private async finalize(
    campaignId: string,
    turnId: string,
    runId: string,
    attemptId: string,
    output: NarrationOutput,
  ): Promise<void> {
    await this.executor.transaction(async (tx) => {
      await tx.execute('UPDATE campaigns SET updated_at = updated_at WHERE id = ?', [campaignId]);
      const runs = new AiRunRepository(tx);
      const run = await runs.findById(runId);
      if (!run || run.campaign_id !== campaignId || run.turn_id !== turnId
        || run.status !== 'running' || run.run_kind !== 'mechanical_resolution') {
        throw new AppError('STATE_CONFLICT', '机械 run 不在叙事提交状态。');
      }
      const turn = await new TurnRepository(tx).findTurnById(turnId);
      if (!turn || turn.campaign_id !== campaignId || !['resolving', 'completed'].includes(turn.status)) {
        throw new AppError('STATE_CONFLICT', '叙事提交时回合生命周期不匹配。');
      }
      const repository = new AdjudicationRepository(tx);
      const outcomeRow = await repository.findOutcomeByExecution(tx, runId);
      if (!outcomeRow) throw new AppError('STATE_CONFLICT', '机械结果已丢失或已被恢复操作 supersede。');
      assertOutcomeMatches(run, outcomeRow, campaignId, turnId, runId);
      const attempt = await repository.findNarrationAttemptById(tx, attemptId);
      if (!attempt) throw new AppError('STATE_CONFLICT', '叙事尝试已被恢复操作 supersede。');
      assertAttemptMatches(attempt, outcomeRow, campaignId, turnId, runId);
      const now = new Date().toISOString();
      const attemptUpdated = await repository.updateNarrationAttempt(
        tx, attemptId, 'succeeded', JSON.stringify(output), null, now,
      );
      if (!attemptUpdated) {
        const latest = await repository.findLatestNarrationAttempt(tx, runId);
        if (latest?.status !== 'succeeded') {
          throw new AppError('STATE_CONFLICT', '叙事尝试已被并发更新。');
        }
      } else {
        const entriesRepo = new TurnEntryRepository(tx);
        let index = 0;
        await entriesRepo.insertEntry(tx, {
          id: nanoid(24), ai_run_id: runId, turn_id: turnId, campaign_id: campaignId,
          entry_kind: 'narrative', entry_index: index++, visibility: 'public', target_player_id: null,
          payload_json: JSON.stringify({ text: output.publicNarrative }), created_at: now,
        });
        for (const update of output.privateUpdates) {
          await entriesRepo.insertEntry(tx, {
            id: nanoid(24), ai_run_id: runId, turn_id: turnId, campaign_id: campaignId,
            entry_kind: 'private_update', entry_index: index++, visibility: 'player_private',
            target_player_id: update.playerId, payload_json: JSON.stringify({ text: update.content }), created_at: now,
          });
        }
      }
      const outcome = JSON.parse(outcomeRow.outcome_json) as MechanicalResolvedOutcome;
      if (!(await runs.markSucceeded(
        tx,
        runId,
        JSON.stringify({ stage: 'narrative_decision', outcome, narration: output }),
        JSON.stringify({ stage: 'narration', outcomeId: outcomeRow.id, attemptId, privateUpdateCount: output.privateUpdates.length }),
        now,
        outcomeRow.applied_state_revision,
      ))) {
        throw new AppError('STATE_CONFLICT', '叙事完成时 AI run 已被并发更新。');
      }
      await this.outbox.publishIn(tx, { type: 'owner.debug', campaignId, runId, kind: 'result' });
    });
  }

  private async recordFailure(attemptId: string, error: NarrativePresentationRetryableError): Promise<void> {
    try {
      await this.executor.transaction(async (tx) => {
        await new AdjudicationRepository(tx).updateNarrationAttempt(
          tx,
          attemptId,
          'failed',
          null,
          JSON.stringify({ code: error.code, message: error.message, timestamp: new Date().toISOString() }),
          new Date().toISOString(),
        );
      });
    } catch {
      // The mechanics checkpoint remains retryable even if diagnostics are
      // temporarily unavailable. No authoritative state is changed here.
    }
  }

  private asRetryable(error: unknown): NarrativePresentationRetryableError {
    if (error instanceof NarrativePresentationRetryableError) return error;
    if (error instanceof AppError) {
      const code = error.code === 'AI_PROVIDER_FAILED' || error.code === 'AI_OUTPUT_INVALID'
        || error.code === 'STALE_STATE_REVISION' || error.code === 'INTERNAL_ERROR'
        ? error.code
        : 'INTERNAL_ERROR';
      return new NarrativePresentationRetryableError(code, error.message);
    }
    return new NarrativePresentationRetryableError('AI_PROVIDER_FAILED', 'Narration Provider 调用失败。');
  }
}

function isNarrationAttemptExpired(createdAt: string, now = Date.now()): boolean {
  const created = Date.parse(createdAt);
  return !Number.isFinite(created) || created <= now - NARRATIVE_PRESENTATION_ATTEMPT_LEASE_MS;
}

function assertOutcomeMatches(
  run: AiRunRow,
  outcome: { id: string; campaign_id: string; turn_id: string; execution_id: string; applied_state_revision: number },
  campaignId: string,
  turnId: string,
  runId: string,
): void {
  if (outcome.campaign_id !== campaignId || outcome.turn_id !== turnId || outcome.execution_id !== runId
    || run.applied_state_revision !== outcome.applied_state_revision) {
    throw new AppError('STATE_CONFLICT', '机械结果与 AI run 身份或 StateRevision 不匹配。');
  }
}

function assertAttemptMatches(
  attempt: NarrationAttemptRow,
  outcome: { id: string; campaign_id: string; turn_id: string; execution_id: string; applied_state_revision: number },
  campaignId: string,
  turnId: string,
  runId: string,
): void {
  if (attempt.campaign_id !== campaignId || attempt.turn_id !== turnId || attempt.execution_id !== runId
    || attempt.outcome_id !== outcome.id || attempt.state_revision !== outcome.applied_state_revision) {
    throw new AppError('STATE_CONFLICT', '叙事尝试与机械结果身份或 StateRevision 不匹配。');
  }
}

function parseNarrationOutput(resultJson: string | null): NarrationOutput {
  if (!resultJson) throw new AppError('INTERNAL_ERROR', '已成功的叙事尝试缺少结果。');
  try {
    const parsed = JSON.parse(resultJson) as unknown;
    return narrationOutputSchema.parse(parsed);
  } catch {
    throw new AppError('INTERNAL_ERROR', '已成功的叙事尝试结果不可读取。');
  }
}
