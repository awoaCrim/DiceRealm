import { nanoid } from 'nanoid';
import type { AiPrompt, AiRunView, ResolveTurnInput, ResolvedOutcome } from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';
import { TurnRepository } from '../turns/TurnRepository.js';
import { ArchiveService } from '../archives/ArchiveService.js';
import { AiRunRepository, type AiRunRow } from './AiRunRepository.js';
import { TurnEntryRepository } from './TurnEntryRepository.js';
import { AiContextBuilder } from './AiContextBuilder.js';
import { AiOutputValidationError, TurnResolutionValidator } from './TurnResolutionValidator.js';
import { StateChangeMaterializer } from './StateChangeMaterializer.js';
import type { AiProviderPort } from './AiProviderPort.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';

export class AiResolutionService {
  constructor(
    private readonly executor: DatabasePort,
    private readonly provider: AiProviderPort,
    private readonly outbox: EventPublisherPort,
    private readonly archives: ArchiveService,
    private readonly context: AiContextBuilder,
    private readonly validator: TurnResolutionValidator,
    private readonly materializer: StateChangeMaterializer,
    private readonly mutations: CampaignMutationCoordinator = new CampaignMutationCoordinator(executor),
  ) {}

  get publicConfig(): AiProviderPort['publicConfig'] {
    return this.provider.publicConfig;
  }

  get name(): string {
    return this.provider.name;
  }

  get model(): string {
    return this.provider.model;
  }

  async resolveTurn(ctx: CampaignAuthContext, turnId: string, input: ResolveTurnInput): Promise<{ created: boolean; run: AiRunView }> {
    requireOwner(ctx);
    const { idempotencyKey } = input;
    // 动态 facade 在 claim 前解析并固定本次 run 的 provider；因此 run 身份、stream 调用和
    // 幂等 replay 使用同一实例，保存后的新配置只影响后续新 run，不会撕裂进行中的结算。
    const runProvider = this.provider.resolveForCampaign
      ? await this.provider.resolveForCampaign(ctx.campaignId)
      : this.provider;
    // 1) claim tx：campaign/turn 行锁 + 幂等查重 + attempt + context 快照 + run=running + turn=resolving + preview.started。
    //    claim 结果是 discriminated union：replay 不带 prompt（不触碰 provider），claimed 带 prompt 供 provider 消费。
    const claim = await this.claim(ctx.campaignId, turnId, idempotencyKey, runProvider);
    if (claim.kind === 'replay') {
      // 幂等 replay：不调用 provider、不写 entries/archive/events，直接返回既有 run。
      return { created: false, run: this.toView(claim.run) };
    }
    const runId = claim.run.id;
    let finalOutput: unknown;
    try {
      // 2) provider 在 tx 外运行；每个 delta 独立短 tx publish。仅 claimed 分支持有 prompt。
      finalOutput = await runProvider.stream(claim.prompt, {
        onDelta: async (delta) => {
          try {
            // delta 短 tx/publish 失败（DB 中断、outbox 写失败等）不是 provider 输出问题：
            // 包装为受控 INTERNAL_ERROR（安全文案，不携带底层 DB 信息），由下方 catch 保留。
            await this.executor.transaction((tx) =>
              this.outbox.publishIn(tx, { type: 'ai.preview.delta', campaignId: ctx.campaignId, runId, text: delta.text }),
            );
          } catch {
            // 丢弃原始 DB 错误对象（绝不持久化/上 HTTP），只抛受控 INTERNAL_ERROR。
            throw new AppError('INTERNAL_ERROR', 'AI 预览流式写入内部错误。');
          }
        },
      });
    } catch (error) {
      // 3a) provider 阶段 catch 分类：
      //     - 受控 AppError（delta publish 失败包装的 INTERNAL_ERROR 等）原样保留其 code，
      //       绝不当 AI_PROVIDER_FAILED 误报（provider 本身可能成功、是本地 DB 写入失败）。
      //     - 其余 provider throw（网络/输出异常）→ AI_PROVIDER_FAILED（HTTP 502）。provider 抛出的
      //       原始 Error 绝不落库/上 HTTP；fail() 只写固定脱敏文案。
      if (error instanceof AppError) {
        await this.fail(ctx.campaignId, turnId, runId, error.code, error);
        throw error;
      }
      const appError = new AppError('AI_PROVIDER_FAILED', 'AI Provider 调用失败。');
      await this.fail(ctx.campaignId, turnId, runId, appError.code, error);
      throw appError;
    }
    try {
      // 3b) parse + 校验 + formal apply。actorUserId=ctx.userId（真实 owner，供 character audit 与自动存档 created_by FK）。
      //     schema/规则/可见性校验失败 → 原 AppError（AI_OUTPUT_INVALID / STATE_CONFLICT）；
      //     formal apply 内部任一失败整体 rollback（run 仍 running、turn 仍 resolving），随后进入 catch。
      const resolution = await this.validateAndParse(ctx.campaignId, finalOutput);
      await this.applyFormal(ctx.campaignId, turnId, runId, resolution, ctx.userId);
    } catch (error) {
      // 4) 校验/formal-apply 阶段：受控 AppError 保持原码（AI_OUTPUT_INVALID / STATE_CONFLICT）；
      //    未知 DB/formal-apply 错误（非 AppError）→ INTERNAL_ERROR（tx 已整体回滚，fail tx 再置
      //    needs_owner_attention），绝不当 AI_PROVIDER_FAILED 误报。
      if (error instanceof AppError) {
        await this.fail(ctx.campaignId, turnId, runId, error.code, error);
        throw error;
      }
      const internal = new AppError('INTERNAL_ERROR', 'AI 结算内部错误。');
      await this.fail(ctx.campaignId, turnId, runId, internal.code, error);
      throw internal;
    }
    // 5) post-commit reload 在 try/catch 之外：仅服务端成功返回。加载失败/丢失同样不应
    //    把已 succeeded 的 run 再标记 failed 或补发 ai.preview.failed——reload 查询自身抛错时
    //    会向上传播为服务端内部错误；`completed` 为 null 时 toView 显式抛 INTERNAL_ERROR 而非
    //    静默用空行返回（不 catch，绝不误报 provider 失败）。
    const completed = await new AiRunRepository(this.executor).findById(runId);
    if (!completed) {
      throw new AppError('INTERNAL_ERROR', 'AI 结算结果读取失败。');
    }
    return { created: true, run: this.toView(completed) };
  }

  /** claim：返回既有 run（replay）或新 run（claimed）。幂等优先：同 key 同 turn 的既有 run 直接返回
   *  （含 succeeded/completed 之后的 replay），不要求 turn 仍 locked/needs_owner_attention；只有创建新 run 时才校验回合状态。
   *  返回值是 discriminated union：`{ kind:'replay'; run }` 不含 prompt（resolveTurn 分支后不触碰 provider）；
   *  `{ kind:'claimed'; run; prompt }` 持有 context 快照供 provider 消费。 */
  private async claim(campaignId: string, turnId: string, idempotencyKey: string, runProvider: AiProviderPort): Promise<{ kind: 'replay'; run: AiRunRow } | { kind: 'claimed'; run: AiRunRow; prompt: AiPrompt }> {
    return this.executor.transaction(async (tx) => {
      await tx.execute('UPDATE campaigns SET updated_at = updated_at WHERE id = ?', [campaignId]);
      const runs = new AiRunRepository(tx);
      const turns = new TurnRepository(tx);
      // 1) 归属确认：lockTurnRow 过滤 superseded 且返回未命中=不存在；只用于归属校验，不改状态。
      if (!(await turns.lockTurnRow(turnId, campaignId))) {
        throw new AppError('NOT_FOUND', '回合不存在。');
      }
      const turn = await turns.findTurnById(turnId);
      if (!turn) throw new AppError('NOT_FOUND', '回合不存在。');
      // 2) 幂等优先：同 key 已有 run → 直接返回（成功 replay 时 turn 已 completed，也先查幂等）。
      const existing = await runs.findByIdempotencyKey(tx, campaignId, idempotencyKey);
      if (existing) {
        if (existing.turn_id !== turnId) {
          throw new AppError('VALIDATION_ERROR', 'idempotencyKey 已用于其它回合。');
        }
        // 幂等 replay 不调用 provider、不写 entries/archive/events，直接返回既有 run（kind='replay'）。
        return { kind: 'replay', run: existing };
      }
      // 3) 只有创建新 run 时才校验回合状态：waiting 未锁定 → TURN_NOT_ACTIVE；
      //    completed 是终态（已结算），新 key 不得绕过 idempotency → STATE_CONFLICT；
      //    其余非许可状态（如 resolving 并发中）同样 STATE_CONFLICT。
      if (turn.status !== 'locked' && turn.status !== 'needs_owner_attention') {
        if (turn.status === 'waiting_for_actions') {
          throw new AppError('TURN_NOT_ACTIVE', '当前回合不允许结算。');
        }
        throw new AppError('STATE_CONFLICT', '当前回合状态不允许结算。');
      }
      // Claim is itself an authoritative mutation: locked -> resolving advances
      // the independent state head exactly once. The context is built after that
      // transition and records the post-claim revision.
      const runId = nanoid(24);
      const claimMutation = await this.mutations.mutateIn(tx, {
        campaignId,
        mutationId: `ai-claim:${runId}`,
        causeType: 'ai_claim',
        causeId: turnId,
      }, async ({ stateRevision }) => {
        const attempt = (await runs.maxAttempt(tx, turnId)) + 1;
        const campaignSequence = await runs.nextCampaignSequence(tx, campaignId);
        const now = new Date().toISOString();
        if (!(await turns.markResolving(turnId, now))) {
          throw new AppError('STATE_CONFLICT', '回合已不在结算许可状态。');
        }
        const pkg = await this.context.buildForTurn(campaignId, turnId, tx, { actionId: turnId });
        await runs.insertRun(tx, {
          id: runId, campaign_id: campaignId, campaign_sequence: campaignSequence, turn_id: turnId,
          attempt, idempotency_key: idempotencyKey, provider: runProvider.name, model: runProvider.model,
          status: 'running', context_json: JSON.stringify({ prompt: pkg.prompt, context: pkg.context, stateRevision }), result_json: null,
          error_code: null, error_json: null, raw_debug_json: null, started_at: now, completed_at: null,
          expected_state_revision: stateRevision, applied_state_revision: null,
        });
        await this.outbox.publishIn(tx, { type: 'ai.preview.started', campaignId, runId });
        const created = (await runs.findById(runId)) as AiRunRow;
        return { run: created, prompt: pkg.prompt };
      });
      if (!claimMutation.result) throw new AppError('INTERNAL_ERROR', 'AI claim 结果读取失败。');
      return { kind: 'claimed', run: claimMutation.result.run, prompt: claimMutation.result.prompt };
    });
  }

  private async validateAndParse(campaignId: string, output: unknown): Promise<ResolvedOutcome> {
    // schema parse + 规则/可见性校验统一在 validator 内；任一失败 → AI_OUTPUT_INVALID。
    return this.validator.validate(campaignId, output);
  }

  /** formal apply tx：白名单 state changes → entries/requests → run succeeded → turn completed → 正式事件 → 自动存档 → 下一回合。 */
  private async applyFormal(campaignId: string, turnId: string, runId: string, resolution: ResolvedOutcome, actorUserId: string): Promise<void> {
    await this.executor.transaction(async (tx) => {
      await tx.execute('UPDATE campaigns SET updated_at = updated_at WHERE id = ?', [campaignId]);
      const turns = new TurnRepository(tx);
      const runs = new AiRunRepository(tx);
      // 1) 锁定/校验 run+turn。
      const run = await runs.findById(runId);
      if (!run || run.status !== 'running') throw new AppError('STATE_CONFLICT', 'AI run 不在可应用状态。');
      const turn = await turns.findTurnById(turnId);
      if (!turn || turn.status !== 'resolving') throw new AppError('STATE_CONFLICT', '回合不在结算中。');
      // Legacy runs have no fixed input revision and are audit/display only.
      if (run.expected_state_revision === null || run.expected_state_revision === undefined) {
        throw new AppError('STATE_CONFLICT', '旧版 AI 结算不能正式应用。');
      }
      await this.mutations.mutateIn(tx, {
        campaignId,
        expectedRevision: run.expected_state_revision,
        mutationId: `ai-formal:${runId}`,
        causeType: 'ai_formal_apply',
        causeId: runId,
      }, async ({ stateRevision }) => {
      // 2) 白名单 state changes + AI 创建式世界事实/遭遇（combat 能力门禁；actorUserId 供 character audit FK）。
      await this.materializer.applyAll(tx, campaignId, resolution.stateChanges, actorUserId, {
        worldFactCreations: resolution.worldFactCreations,
        encounterStarts: resolution.encounterStarts,
      });
      // 3) 写 entries 与 interaction requests。
      const now = new Date().toISOString();
      const entriesRepo = new TurnEntryRepository(tx);
      let index = 0;
      await entriesRepo.insertEntry(tx, {
        id: nanoid(24), ai_run_id: runId, turn_id: turnId, campaign_id: campaignId,
        entry_kind: 'narrative', entry_index: index++, visibility: 'public',
        target_player_id: null, payload_json: JSON.stringify({ text: resolution.publicNarrative }), created_at: now,
      });
      for (const update of resolution.privateUpdates) {
        await entriesRepo.insertEntry(tx, {
          id: nanoid(24), ai_run_id: runId, turn_id: turnId, campaign_id: campaignId,
          entry_kind: 'private_update', entry_index: index++, visibility: 'player_private',
          target_player_id: update.playerId, payload_json: JSON.stringify({ text: update.content }), created_at: now,
        });
      }
      const interactionIds: Array<{ requestId: string; targetPlayerId: string }> = [];
      for (const interaction of resolution.interactionRequests) {
        // DB 主键用内部 nanoid，provider 的 id 存 provider_id 列：跨 run/跨 campaign 复用 'i1'
        // 不会撞全局主键；interaction.requested 事件 requestId 与 InteractionRequestView.id 都是内部 id。
        const requestId = nanoid(24);
        await entriesRepo.insertInteractionRequest(tx, {
          id: requestId, provider_id: interaction.id, campaign_id: campaignId, turn_id: turnId, ai_run_id: runId,
          target_player_id: interaction.targetPlayerId, prompt: interaction.prompt, created_at: now,
        });
        interactionIds.push({ requestId, targetPlayerId: interaction.targetPlayerId });
      }
      // 4) run succeeded/result/debug（2B 只存 raw_debug_json，不 emit owner.debug）。
      const rawDebug = JSON.stringify({ resolution });
      if (!(await runs.markSucceeded(tx, runId, JSON.stringify(resolution), rawDebug, now, stateRevision))) {
        throw new AppError('STATE_CONFLICT', 'AI run 已被并发更新。');
      }
      // 4b) owner.debug（Phase 3）：成功 formal apply 后、turn completed 前，同一事务发布
      //     仅携带 { runId, kind: 'result' } 的 owner-only 事件；敏感正文继续由 owner-only
      //     AI run detail 查询提供，不塞入事件。
      await this.outbox.publishIn(tx, { type: 'owner.debug', campaignId, runId, kind: 'result' });
      // 5) turn completed。
      if (!(await turns.markCompleted(turnId, now))) {
        throw new AppError('STATE_CONFLICT', '回合已在结算中被并发修改。');
      }
      // 6) 预生成 automatic archiveId（与 createAutomatic 插入的正式存档 id 一致）。
      const automaticArchiveId = nanoid(24);
      // 7) publish turn.resolved + 所有 interaction.requested（同 tx 内获得正式事件最高 sequence）。
      await this.outbox.publishIn(tx, { type: 'turn.resolved', campaignId, turnId, archiveId: automaticArchiveId });
      for (const { requestId, targetPlayerId } of interactionIds) {
        await this.outbox.publishIn(tx, { type: 'interaction.requested', campaignId, requestId, targetPlayerId });
      }
      // 8) snapshot 的 outbox watermark 自动包含这些正式事件：captureSnapshot 的 maxOutboxSequence
      //    在事务内读取，此时 turn.resolved/interaction.requested 已插入，max sequence 覆盖它们。
      // 9) insert automatic archive（同 tx；kind=automatic、label=null、id=automaticArchiveId；actorUserId 为真实 owner，created_by FK 满足）。
      await this.archives.createAutomatic(tx, campaignId, turnId, actorUserId, automaticArchiveId);
      // 10) create 下一 waiting turn + requirements（同 tx；绝不嵌套 TurnService.transaction）。
      await this.createNextTurn(tx, campaignId);
      // 11) The enclosing coordinator/transaction commits head, ledger and all
      //    formal writes atomically. Archive/outbox retain their own sequences.
      // 注：自动存档的 turnNumber watermark 在 createAutomatic 内由 maxActiveTurnNumber 读取——
      //    此时 next turn 尚未插入，因此快照 turnNumber 是 resolved turn 的 number（正确）。
      });
    });
  }

  private async createNextTurn(tx: QueryExecutor, campaignId: string): Promise<void> {
    const turns = new TurnRepository(tx);
    const characters = new CharacterRepository(tx);
    const playerIds = await characters.listApprovedPlayerIds(campaignId);
    const number = (await turns.maxTurnNumber(campaignId)) + 1; // 含 superseded，不复用
    const now = new Date().toISOString();
    const turnId = nanoid(24);
    await turns.insertTurn({
      id: turnId, campaign_id: campaignId, number, status: 'waiting_for_actions',
      locked_at: null, completed_at: null, created_at: now, updated_at: now,
    });
    for (const playerId of playerIds) {
      await turns.insertRequirement(turnId, campaignId, playerId);
    }
  }

  /** fail tx：run failed + turn=needs_owner_attention + preview.failed；无正式写。
   *  error_json/raw_debug 一律使用严格白名单结构：AppError（受控消息）保留 name/message/code；
   *  原始 provider Error / 未知 DB / formal-apply 错误只写固定脱敏文案，绝不持久化原始
   *  Error.message/stack（防止 URL/API key/Bearer token/堆栈位置泄漏），测试断言原始 secret
   *  与 raw 文本不落库。fail() 的条件更新保证失败路径不产生半截正式写。 */
  private async fail(campaignId: string, turnId: string, runId: string, code: string, error: unknown): Promise<void> {
    await this.executor.transaction(async (tx) => {
      const runs = new AiRunRepository(tx);
      const existing = await runs.findById(runId);
      if (!existing || existing.status !== 'running') return;
      const now = new Date().toISOString();
      // 持久化结构是严格白名单：AppError（我们自己的受控消息）原样保留 name/message；
      // 非 AppError（provider/网络/未知 DB/formal-apply）只写固定脱敏文案，绝不持久化原始
      // Error.message/stack，防止 URL/API key/Bearer token/堆栈位置泄漏。测试断言原始
      // secret 与 raw 前缀都不落库。
      // 脱敏文案按 code 区分（与阶段分类一致）：AI_PROVIDER_FAILED → 固定 provider 文案
      // （AiProviderError 只是脱敏占位）；其它（INTERNAL_ERROR 等）→ 固定内部文案，
      // 绝不在落库层误报 provider 失败。
      const isControlled = error instanceof AppError;
      const isProviderFailure = code === 'AI_PROVIDER_FAILED';
      const sanitized = {
        code,
        name: isControlled ? error.name : (isProviderFailure ? 'AiProviderError' : 'AiResolutionInternalError'),
        message: isControlled
          ? error.message
          : isProviderFailure
            ? 'AI Provider 调用失败，详情已脱敏。'
            : 'AI 结算内部错误，详情已脱敏。',
        timestamp: now,
      };
      const errorJson = JSON.stringify(sanitized);
      // AI 输出 schema/domain 校验错误只把有界的 path/code 投影写入 Owner-only rawDebug；
      // error_json 与 HTTP 仍保持通用受控文案。绝不保存 issue message、rejected value 或 Provider 原始输出。
      const rawDebugJson = error instanceof AiOutputValidationError
        ? JSON.stringify({ ...sanitized, diagnostic: error.diagnostic })
        : errorJson;
      const execution = await this.mutations.mutateIn(tx, {
        campaignId,
        mutationId: `ai-fail:${runId}`,
        causeType: 'ai_failure',
        causeId: runId,
      }, async () => {
        if (!(await runs.markFailed(tx, runId, code, errorJson, rawDebugJson, now))) {
          throw new AppError('STATE_CONFLICT', 'AI run 已被并发更新。');
        }
        // 条件更新（仅当 turn 仍 resolving）：若并发已把 turn 改成其它状态，失败路径不写半截正式状态。
        await tx.execute(
          "UPDATE platform_turns SET status = 'needs_owner_attention', updated_at = ? WHERE id = ? AND status = 'resolving'",
          [now, turnId],
        );
        await this.outbox.publishIn(tx, { type: 'ai.preview.failed', campaignId, runId, code });
        return true;
      });
      if (!execution.result) throw new AppError('INTERNAL_ERROR', 'AI 失败结果读取失败。');
    });
  }
  private toView(row: AiRunRow): AiRunView {
    return {
      id: row.id, campaignId: row.campaign_id, campaignSequence: row.campaign_sequence,
      turnId: row.turn_id, attempt: row.attempt, idempotencyKey: row.idempotency_key,
      provider: row.provider, model: row.model, status: row.status,
      errorCode: row.error_code, startedAt: row.started_at, completedAt: row.completed_at,
      superseded: row.superseded_at !== null,
    };
  }
}
