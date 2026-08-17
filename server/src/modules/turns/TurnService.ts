import { nanoid } from 'nanoid';
import type {
  TurnAction, TurnActionInput, TurnListEntry, TurnOwnerView, TurnPlayerView, TurnProgress, TurnSummary,
} from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';
import { TurnRepository, type ActionRow, type TurnRow } from './TurnRepository.js';
import { NarrativeRoundRepository } from '../narrative-runtime/NarrativeRoundRepository.js';
import { NarrativeRoundService } from '../narrative-runtime/NarrativeRoundService.js';

/**
 * TurnService：owner 开始回合、玩家提交/编辑行动、锁定与隐私投影。
 * 事务正确性核心：startTurn 与 submitAction 的读 + 状态检查 + 条件更新 + outbox
 * 事件全部在同一个 DatabasePort.transaction 内（repository 用 tx 重新构造，绝不
 * 持有外部 executor 后绕开）；outbox 事件与业务写同事务原子提交/回滚。
 * 依赖 EventPublisherPort 端口，不 new concrete 实现。
 */
export class TurnService {
  private readonly repository: TurnRepository;
  private readonly mutations: CampaignMutationCoordinator;
  private readonly narrative: NarrativeRoundService;

  constructor(
    private readonly executor: DatabasePort,
    private readonly outbox: EventPublisherPort,
    mutations?: CampaignMutationCoordinator,
    narrative?: NarrativeRoundService,
  ) {
    this.repository = new TurnRepository(executor);
    this.mutations = mutations ?? new CampaignMutationCoordinator(executor);
    this.narrative = narrative ?? new NarrativeRoundService(executor, outbox, this.mutations);
  }

  /** owner 开始新回合：campaign 行锁 → 无未终结回合 → distinct approved → MAX+1（锁内安全）→ insert turn+requirements。 */
  async startTurn(ctx: CampaignAuthContext): Promise<TurnSummary> {
    requireOwner(ctx);
    const mutationId = `turn-start:${nanoid(24)}`;
    return this.executor.transaction(async (tx) => {
      const execution = await this.mutations.mutateIn(tx, {
        campaignId: ctx.campaignId,
        mutationId,
        causeType: 'turn_start',
      }, async () => {
      // 1) no-op 写触碰 campaign 行；SQLite 写事务队列保证启动新回合串行执行。
      await tx.execute('UPDATE campaigns SET updated_at = updated_at WHERE id = ?', [ctx.campaignId]);
      const repo = new TurnRepository(tx);
      // 2) 无未终结（进行中）回合：locked/resolving/needs_owner_attention 同样阻挡新回合，
      //    只有 completed 才允许下一回合。
      const active = await repo.findUnfinishedTurn(ctx.campaignId);
      if (active) {
        throw new AppError('STATE_CONFLICT', '已有进行中的回合。');
      }
      // 3) distinct approved players；无批准 → CHARACTER_NOT_APPROVED。
      const characters = new CharacterRepository(tx);
      const playerIds = await characters.listApprovedPlayerIds(ctx.campaignId);
      if (playerIds.length === 0) {
        throw new AppError('CHARACTER_NOT_APPROVED', '没有已批准的角色，无法开始回合。');
      }
      // 4) MAX(number)+1：campaign 行已被本事务锁住，并发安全。
      const number = (await repo.maxTurnNumber(ctx.campaignId)) + 1;
      const now = new Date().toISOString();
      const turnId = nanoid(24);
      await repo.insertTurn({
        id: turnId, campaign_id: ctx.campaignId, number, status: 'waiting_for_actions',
        locked_at: null, completed_at: null, created_at: now, updated_at: now,
      });
      for (const playerId of playerIds) {
        await repo.insertRequirement(turnId, ctx.campaignId, playerId);
      }
      await this.narrative.ensureForTurnIn(tx, ctx.campaignId, turnId);
      return mapSummary((await repo.findTurnById(turnId)) as TurnRow);
      });
      if (!execution.result) throw new AppError('INTERNAL_ERROR', '回合创建结果读取失败。');
      return execution.result;
    });
  }

  /** 玩家提交/编辑自己的行动。首次提交才发 progress 事件；最后一名提交才锁定并发 locked 事件；两事件与业务写同 tx。 */
  async submitAction(
    ctx: CampaignAuthContext,
    turnId: string,
    input: TurnActionInput,
  ): Promise<TurnPlayerView> {
    if (ctx.role !== 'player' || !ctx.playerId) {
      throw new AppError('FORBIDDEN', '只有玩家可以提交行动。');
    }
    const playerId = ctx.playerId;
    const mutationId = `turn-action:${nanoid(24)}`;
    return this.executor.transaction(async (tx) => {
      const execution = await this.mutations.mutateIn(tx, {
        campaignId: ctx.campaignId,
        mutationId,
        causeType: 'turn_action_submit',
        causeId: turnId,
      }, async ({ stateRevision }) => {
      const repo = new TurnRepository(tx);
      // 1) 条件 no-op 更新 turn 行获得锁；未命中 → NOT_FOUND。
      const lockedRow = await repo.lockTurnRow(turnId, ctx.campaignId);
      if (!lockedRow) {
        throw new AppError('NOT_FOUND', '回合不存在。');
      }
      // 2) 读状态：区分 NOT_FOUND / TURN_LOCKED / TURN_NOT_ACTIVE。
      const turn = await repo.findTurnById(turnId);
      if (!turn) {
        throw new AppError('NOT_FOUND', '回合不存在。');
      }
      // NarrativeRound owns the live lifecycle. Turn status is only the
      // compatibility mirror used for legacy DTOs and old repositories.
      const round = await this.narrative.ensureForTurnIn(tx, ctx.campaignId, turnId);
      if (!['collecting', 'processing', 'needs_owner_attention'].includes(round.status)) {
        if (round.status === 'ready') {
          throw new AppError('TURN_LOCKED', '回合已锁定，无法修改行动。');
        }
        throw new AppError('TURN_NOT_ACTIVE', '当前回合状态不允许提交行动。');
      }
      // 3) 必须是已批准角色。
      const characters = new CharacterRepository(tx);
      const approvedIds = await characters.listApprovedPlayerIds(ctx.campaignId);
      if (!approvedIds.includes(playerId)) {
        throw new AppError('CHARACTER_NOT_APPROVED', '你的角色尚未通过审核。');
      }
      // 4) 必须是本回合必需玩家。
      if (!(await repo.isRequired(turnId, playerId))) {
        throw new AppError('FORBIDDEN', '你不是该回合的必需玩家。');
      }
      const narrativeRepository = new NarrativeRoundRepository(tx);
      const decision = await narrativeRepository.findDecisionByActor(round.id, playerId);
      if (!decision) throw new AppError('FORBIDDEN', '你不是该叙事回合的参与者。');
      if (!['waiting', 'submitted'].includes(decision.status)) {
        throw new AppError('TURN_LOCKED', '该行动已经被 worker claim，无法修改。');
      }
      // 5) upsert 自己的 action（UNIQUE(turn_id, player_id)）。
      const existing = await repo.findActionByTurnPlayer(turnId, playerId);
      const now = new Date().toISOString();
      let firstSubmit = false;
      let actionId: string;
      if (existing) {
        await repo.updateActionBody(existing.id, input.body, now);
        actionId = existing.id;
      } else {
        actionId = nanoid(24);
        await repo.insertAction({
          id: actionId, turn_id: turnId, campaign_id: ctx.campaignId, player_id: playerId,
          body: input.body, submitted_at: now, updated_at: now,
        });
        await repo.markRequirementSubmitted(turnId, playerId);
        firstSubmit = true;
      }
      const submittedDecision = await this.narrative.linkSubmittedActionIn(tx, ctx.campaignId, turnId, playerId, actionId, now);
      // 6) 首次提交才发 progress 事件（锁前编辑不发，避免重复）。
      if (firstSubmit) {
        await this.outbox.publishIn(tx, {
          type: 'turn.action_submitted', campaignId: ctx.campaignId, turnId, playerId: playerId,
        });
      }
      if (firstSubmit) {
        await this.outbox.publishIn(tx, {
          type: 'narrative.round.work_available', campaignId: ctx.campaignId,
          roundId: round.id, decisionId: submittedDecision.id,
        });
      }
      // 7) All-submitted remains a compatibility mirror only. A worker may
      // already be processing the earliest decision while later players submit;
      // submission never waits for this condition before waking work.
      const submitted = await repo.countSubmitted(turnId);
      const total = await repo.countTotal(turnId);
      if (round.status === 'collecting' && total > 0 && submitted >= total) {
        const didReady = await this.narrative.markReadyIn(tx, round.id, now, stateRevision);
        if (didReady) {
          // A worker may already have mirrored the live Decision claim as
          // Turn=resolving. In that race the Round can still become ready
          // after the last action arrives; retain resolving and do not emit a
          // duplicate locked event.
          const didLock = await repo.lockTurn(turnId, now);
          if (didLock) {
            await this.outbox.publishIn(tx, {
              type: 'turn.locked', campaignId: ctx.campaignId, turnId,
            });
          } else {
            const currentTurn = await repo.findTurnById(turnId);
            if (!currentTurn || !['locked', 'resolving'].includes(currentTurn.status)) {
              throw new AppError('STATE_CONFLICT', '兼容回合状态无法锁定。');
            }
          }
        }
      }
      // 8) service 返回在 commit 后（transaction 提交后才 resolve）。
      return this.playerView(tx, turnId, playerId);
      });
      if (!execution.result) throw new AppError('INTERNAL_ERROR', '行动提交结果读取失败。');
      return execution.result;
    });
  }

  /** 回合列表：只有 summary + progress，不含任何 action 正文。 */
  async listForCampaign(ctx: CampaignAuthContext): Promise<TurnListEntry[]> {
    const rows = await this.repository.listByCampaign(ctx.campaignId);
    const entries: TurnListEntry[] = [];
    for (const row of rows) {
      entries.push({ turn: mapSummary(row), progress: await this.progressOf(this.executor, row.id) });
    }
    return entries;
  }

  /** owner 视角见全部 actions；player 视角只见自己的 myAction。 */
  async getView(ctx: CampaignAuthContext, turnId: string): Promise<TurnPlayerView | TurnOwnerView> {
    const turn = await this.repository.findTurnById(turnId);
    if (!turn || turn.campaign_id !== ctx.campaignId) {
      throw new AppError('NOT_FOUND', '回合不存在。');
    }
    if (ctx.role === 'owner') {
      return {
        turn: mapSummary(turn),
        actions: (await this.repository.listActionsByTurn(turnId)).map(mapAction),
        progress: await this.progressOf(this.executor, turnId),
      };
    }
    const myAction = await this.repository.findActionByTurnPlayer(turnId, ctx.playerId ?? '');
    return {
      turn: mapSummary(turn),
      myAction: myAction ? mapAction(myAction) : null,
      progress: await this.progressOf(this.executor, turnId),
    };
  }

  private async playerView(tx: QueryExecutor, turnId: string, playerId: string): Promise<TurnPlayerView> {
    const repo = new TurnRepository(tx);
    const turn = await repo.findTurnById(turnId);
    if (!turn) throw new AppError('NOT_FOUND', '回合不存在。');
    const myAction = await repo.findActionByTurnPlayer(turnId, playerId);
    return {
      turn: mapSummary(turn),
      myAction: myAction ? mapAction(myAction) : null,
      progress: await this.progressOf(tx, turnId),
    };
  }

  private async progressOf(executor: QueryExecutor, turnId: string): Promise<TurnProgress> {
    const repo = new TurnRepository(executor);
    const requirements = await repo.listRequirements(turnId);
    const turn = await repo.findTurnById(turnId);
    return {
      requiredPlayerIds: requirements.map((r) => r.player_id),
      submittedPlayerIds: requirements.filter((r) => r.submitted === 1).map((r) => r.player_id),
      locked: turn?.status === 'locked',
    };
  }
}

function mapSummary(row: TurnRow): TurnSummary {
  return {
    id: row.id, campaignId: row.campaign_id, number: row.number, status: row.status,
    lockedAt: row.locked_at, completedAt: row.completed_at, createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAction(row: ActionRow): TurnAction {
  return {
    id: row.id, turnId: row.turn_id, campaignId: row.campaign_id, playerId: row.player_id,
    body: row.body, submittedAt: row.submitted_at, updatedAt: row.updated_at,
  };
}
