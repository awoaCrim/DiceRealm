import { nanoid } from 'nanoid';
import type {
  ActionIntentProposal,
  AiRunView,
  ResolvedOutcome,
} from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';
import { TurnRepository } from '../turns/TurnRepository.js';
import { AiContextBuilder } from '../ai-runtime/AiContextBuilder.js';
import { AiRunRepository, type AiRunRow } from '../ai-runtime/AiRunRepository.js';
import { AiOutputValidationError, TurnResolutionValidator } from '../ai-runtime/TurnResolutionValidator.js';
import type { AiProviderPort } from '../ai-runtime/AiProviderPort.js';
import { MechanicalResolutionService } from '../adjudication/MechanicalResolutionService.js';
import { NarrativeRoundRepository } from './NarrativeRoundRepository.js';
import { NarrativeRoundService } from './NarrativeRoundService.js';

interface ClaimedDecisionRun {
  kind: 'replay' | 'claimed';
  run: AiRunRow;
  prompt?: import('@dnd/contracts').AiPrompt;
}

/**
 * Decision-scoped semantic resolution. This is the new causal path; the
 * legacy AiResolutionService whole-turn path remains available for replay and
 * compatibility until callers migrate to this service.
 */
export class NarrativeDecisionResolutionService {
  constructor(
    private readonly executor: DatabasePort,
    private readonly provider: AiProviderPort,
    private readonly outbox: EventPublisherPort,
    private readonly context: AiContextBuilder = new AiContextBuilder(executor),
    private readonly validator: TurnResolutionValidator = new TurnResolutionValidator(executor),
    private readonly mutations: CampaignMutationCoordinator = new CampaignMutationCoordinator(executor),
    private readonly narrative: NarrativeRoundService = new NarrativeRoundService(executor, outbox, mutations),
    private readonly mechanical: MechanicalResolutionService = new MechanicalResolutionService(executor, outbox),
  ) {}

  async resolveDecision(
    ctx: CampaignAuthContext,
    roundId: string,
    decisionId: string,
    input: { idempotencyKey: string },
  ): Promise<{ created: boolean; run: AiRunView }> {
    requireOwner(ctx);
    const runProvider = this.provider.resolveForCampaign
      ? await this.provider.resolveForCampaign(ctx.campaignId)
      : this.provider;
    const claim = await this.claim(ctx.campaignId, roundId, decisionId, input.idempotencyKey, runProvider);
    if (claim.kind === 'replay') return { created: false, run: this.toView(claim.run) };
    const runId = claim.run.id;
    try {
      const raw = await runProvider.stream(claim.prompt!, {
        onDelta: async (delta) => {
          await this.executor.transaction((tx) => this.outbox.publishIn(tx, {
            type: 'ai.preview.delta', campaignId: ctx.campaignId, runId, text: delta.text,
          }));
        },
      });
      const outcome = await this.validator.validate(ctx.campaignId, raw);
      const proposal = this.singleProposal(outcome, decisionId, roundId);
      await this.apply(ctx.campaignId, ctx.userId, roundId, decisionId, runId, proposal);
    } catch (error) {
      await this.fail(ctx.campaignId, roundId, decisionId, runId, error);
      if (error instanceof AppError) throw error;
      throw new AppError('AI_PROVIDER_FAILED', 'AI Provider 调用失败。');
    }
    const completed = await new AiRunRepository(this.executor).findById(runId);
    if (!completed) throw new AppError('INTERNAL_ERROR', '叙事决策结果读取失败。');
    return { created: true, run: this.toView(completed) };
  }

  private async claim(
    campaignId: string,
    roundId: string,
    decisionId: string,
    idempotencyKey: string,
    provider: AiProviderPort,
  ): Promise<ClaimedDecisionRun> {
    return this.executor.transaction(async (tx) => {
      await tx.execute('UPDATE campaigns SET updated_at = updated_at WHERE id = ?', [campaignId]);
      const runs = new AiRunRepository(tx);
      const roundRepository = new NarrativeRoundRepository(tx);
      const decision = await roundRepository.findDecisionById(decisionId);
      if (!decision || decision.campaign_id !== campaignId || decision.round_id !== roundId) {
        throw new AppError('NOT_FOUND', '叙事决策不存在。');
      }
      const turn = await new TurnRepository(tx).findTurnById(decision.turn_id);
      if (!turn || turn.campaign_id !== campaignId) throw new AppError('NOT_FOUND', '回合不存在。');
      const existing = await runs.findByIdempotencyKey(tx, campaignId, idempotencyKey);
      if (existing) {
        if (existing.turn_id !== decision.turn_id) throw new AppError('VALIDATION_ERROR', 'idempotencyKey 已用于其它回合。');
        return { kind: 'replay' as const, run: existing };
      }
      if (turn.status !== 'locked' && turn.status !== 'resolving' && turn.status !== 'needs_owner_attention') {
        throw new AppError('TURN_NOT_ACTIVE', '当前回合不允许处理该叙事决策。');
      }
      if (!decision.action_id) throw new AppError('STATE_CONFLICT', '叙事决策尚未提交行动。');
      const runId = nanoid(24);
      const mutation = await this.mutations.mutateIn(tx, {
        campaignId,
        mutationId: `narrative-ai-claim:${runId}`,
        causeType: 'narrative_decision_claim',
        causeId: decisionId,
      }, async ({ stateRevision }) => {
        const now = new Date().toISOString();
        const packageValue = await this.context.buildForTurn(campaignId, decision.turn_id, tx, {
          audience: 'actor_private',
          actorId: decision.actor_id,
          actionId: decision.action_id ?? undefined,
          roundId,
          decisionId,
          stage: 'decision_interpretation',
        });
        await this.narrative.claimDecisionIn(tx, {
          campaignId, roundId, decisionId, executionId: runId, stateRevision,
        }, now);
        await tx.execute(
          "UPDATE platform_turns SET status = 'resolving', updated_at = ? WHERE id = ? AND status IN ('locked','needs_owner_attention')",
          [now, decision.turn_id],
        );
        const attempt = (await runs.maxAttempt(tx, decision.turn_id)) + 1;
        const campaignSequence = await runs.nextCampaignSequence(tx, campaignId);
        await runs.insertRun(tx, {
          id: runId,
          campaign_id: campaignId,
          campaign_sequence: campaignSequence,
          turn_id: decision.turn_id,
          attempt,
          idempotency_key: idempotencyKey,
          provider: provider.name,
          model: provider.model,
          status: 'running',
          context_json: JSON.stringify({ prompt: packageValue.prompt, context: packageValue.context, stateRevision, roundId, decisionId }),
          result_json: null,
          error_code: null,
          error_json: null,
          raw_debug_json: null,
          started_at: now,
          completed_at: null,
          expected_state_revision: stateRevision,
          applied_state_revision: null,
          run_kind: 'intent_interpretation',
          parent_run_id: null,
        });
        await this.outbox.publishIn(tx, { type: 'ai.preview.started', campaignId, runId });
        const created = await runs.findById(runId);
        if (!created) throw new AppError('INTERNAL_ERROR', '叙事决策 AI run 创建失败。');
        return { run: created, prompt: packageValue.prompt };
      });
      if (!mutation.result) {
        const replay = await runs.findById(runId);
        if (!replay) throw new AppError('INTERNAL_ERROR', '叙事决策 claim replay 读取失败。');
        return { kind: 'replay' as const, run: replay };
      }
      return { kind: 'claimed' as const, run: mutation.result.run, prompt: mutation.result.prompt };
    });
  }

  private singleProposal(outcome: ResolvedOutcome, decisionId: string, roundId: string): ActionIntentProposal {
    if (outcome.actionIntents.length !== 1) {
      throw new AppError('AI_OUTPUT_INVALID', '单个叙事决策必须对应唯一的 semantic Intent。');
    }
    const proposal = outcome.actionIntents[0];
    if (!proposal.actionId || !proposal.actorId) {
      throw new AppError('AI_OUTPUT_INVALID', '叙事决策 Intent 缺少 actor/action。');
    }
    // roundId/decisionId are checked against the persisted decision in apply;
    // retaining the arguments here makes the contract explicit at the boundary.
    void decisionId;
    void roundId;
    return proposal;
  }

  private async apply(
    campaignId: string,
    actorUserId: string,
    roundId: string,
    decisionId: string,
    runId: string,
    proposal: ActionIntentProposal,
  ): Promise<void> {
    await this.executor.transaction(async (tx) => {
      const runs = new AiRunRepository(tx);
      const roundRepository = new NarrativeRoundRepository(tx);
      const run = await runs.findById(runId);
      const decision = await roundRepository.findDecisionById(decisionId);
      if (!run || run.status !== 'running' || !decision || decision.round_id !== roundId || decision.campaign_id !== campaignId) {
        throw new AppError('STATE_CONFLICT', '叙事决策 AI run 不在可应用状态。');
      }
      if (!run.expected_state_revision && run.expected_state_revision !== 0) {
        throw new AppError('STATE_CONFLICT', '叙事决策缺少输入状态版本。');
      }
      if (decision.action_id !== proposal.actionId || decision.actor_id !== proposal.actorId) {
        throw new AppError('AI_OUTPUT_INVALID', '叙事决策 Intent 与玩家行动不匹配。');
      }
      await this.mutations.mutateIn(tx, {
        campaignId,
        expectedRevision: run.expected_state_revision,
        mutationId: `narrative-ai-apply:${runId}`,
        causeType: 'narrative_decision_apply',
        causeId: runId,
      }, async ({ stateRevision }) => {
        const mechanical = await this.mechanical.resolveDecisionIn(tx, {
          campaignId,
          turnId: decision.turn_id,
          executionId: runId,
          mutationId: `narrative-ai-apply:${runId}`,
          basedOnStateRevision: run.expected_state_revision as number,
          appliedStateRevision: stateRevision,
          actorUserId,
          proposal,
        });
        const outcomeId = mechanical.outcomeId;
        const sourceRefs = [`round:${roundId}`, `decision:${decisionId}`, `execution:${runId}`, `outcome:${outcomeId}`, `state-revision:${campaignId}:${stateRevision}`];
        for (const effect of mechanical.effects) {
          await this.narrative.recordWorkingFactIn(tx, {
            campaignId,
            roundId,
            decisionId,
            actionId: decision.action_id,
            factKind: effect.kind,
            payload: { targetId: effect.targetId, delta: effect.delta, reason: effect.reason },
            visibility: 'public',
            authority: 'server_mechanical',
            validationStatus: 'authoritative',
            sourceKind: 'mechanical_resolved_outcome',
            provenance: {
              roundId, decisionId, actionId: decision.action_id, executionId: runId,
              outcomeId, eventId: null, basedOnStateRevision: run.expected_state_revision as number,
              appliedStateRevision: stateRevision, sourceRefs,
            },
          });
        }
        if (mechanical.effects.length === 0) {
          await this.narrative.recordWorkingFactIn(tx, {
            campaignId,
            roundId,
            decisionId,
            actionId: decision.action_id,
            factKind: 'decision.resolved',
            payload: { actionType: proposal.actionType, actionRef: proposal.actionRef ?? null, targetIds: proposal.targetIds },
            visibility: 'public',
            authority: 'runtime_state',
            validationStatus: 'authoritative',
            sourceKind: 'narrative_decision',
            provenance: {
              roundId, decisionId, actionId: decision.action_id, executionId: runId,
              outcomeId, eventId: null, basedOnStateRevision: run.expected_state_revision as number,
              appliedStateRevision: stateRevision, sourceRefs,
            },
          });
        }
        await this.narrative.markDecisionResolvedIn(tx, {
          campaignId, roundId, decisionId, outcomeId, stateRevision,
        });
        const resultJson = JSON.stringify({ stage: 'narrative_decision', outcome: mechanical.outcome });
        const rawDebugJson = JSON.stringify({ stage: 'narrative_decision', outcomeId, decisionId, roundId });
        if (!(await runs.markSucceeded(tx, runId, resultJson, rawDebugJson, new Date().toISOString(), stateRevision))) {
          throw new AppError('STATE_CONFLICT', '叙事决策 AI run 已被并发更新。');
        }
        await this.outbox.publishIn(tx, { type: 'owner.debug', campaignId, runId, kind: 'result' });
      });
    });
  }

  private async fail(campaignId: string, roundId: string, decisionId: string, runId: string, error: unknown): Promise<void> {
    await this.executor.transaction(async (tx) => {
      const runs = new AiRunRepository(tx);
      const run = await runs.findById(runId);
      if (!run || run.status !== 'running') return;
      const code = error instanceof AppError ? error.code : 'AI_PROVIDER_FAILED';
      const now = new Date().toISOString();
      const diagnostic = error instanceof AiOutputValidationError ? { diagnostic: error.diagnostic } : undefined;
      const errorJson = JSON.stringify({
        code,
        name: error instanceof AppError ? error.name : 'NarrativeDecisionError',
        message: error instanceof AppError ? error.message : '叙事决策 AI 调用失败，详情已脱敏。',
        timestamp: now,
      });
      const rawDebugJson = JSON.stringify({ code, roundId, decisionId, ...diagnostic });
      await this.mutations.mutateIn(tx, {
        campaignId,
        mutationId: `narrative-ai-fail:${runId}`,
        causeType: 'narrative_decision_failure',
        causeId: runId,
      }, async ({ stateRevision }) => {
        if (!(await runs.markFailed(tx, runId, code, errorJson, rawDebugJson, now))) {
          throw new AppError('STATE_CONFLICT', '叙事决策 AI run 已被并发更新。');
        }
        const repository = new NarrativeRoundRepository(tx);
        if (!(await repository.markNeedsOwnerAttention(decisionId, code, now))) {
          throw new AppError('STATE_CONFLICT', '叙事决策无法进入 Owner attention。');
        }
        const decision = await repository.findDecisionById(decisionId);
        if (decision) {
          await repository.updateParticipantStatus(roundId, decision.actor_id, 'needs_owner_attention', now);
        }
        await repository.updateStatus(roundId, ['processing', 'ready'], 'needs_owner_attention', now, null);
        const round = await repository.findById(roundId);
        if (round) {
          await repository.updateCursor(roundId, round.decision_cursor, stateRevision, now);
        }
        await tx.execute(
          "UPDATE platform_turns SET status = 'needs_owner_attention', updated_at = ? WHERE id = ? AND status = 'resolving'",
          [now, run.turn_id],
        );
        await this.outbox.publishIn(tx, { type: 'ai.preview.failed', campaignId, runId, code });
      });
    });
  }

  private toView(row: AiRunRow): AiRunView {
    return {
      id: row.id,
      campaignId: row.campaign_id,
      campaignSequence: row.campaign_sequence,
      turnId: row.turn_id,
      attempt: row.attempt,
      idempotencyKey: row.idempotency_key,
      provider: row.provider,
      model: row.model,
      status: row.status,
      errorCode: row.error_code,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      superseded: row.superseded_at !== null,
    };
  }
}
