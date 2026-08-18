import { nanoid } from 'nanoid';
import type {
  ApprovedCharacter,
  CharacterDerivedValues,
  CharacterDraft,
  CharacterDraftInput,
  CharacterProjection,
  CharacterRejected,
  CharacterReview,
  CharacterStatus,
} from '@dnd/contracts';
import type { DatabasePort } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { CharacterRepository, type CharacterAuditRow, type CharacterRow } from './CharacterRepository.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';
import { ActorService } from '../actors/ActorService.js';

/**
 * 派生值计算：从 sheet 计算关键派生值并带来源列表。
 * 当前只持久化 AC，其余派生名后续阶段扩展；返回值类型与 CharacterDerivedValues 兼容。
 */
export function computeDerived(sheet: Record<string, unknown>): CharacterDerivedValues {
  const ac = typeof sheet.ac === 'number' ? sheet.ac : 10;
  return { ac: { value: ac, sources: ['base'] } };
}

/**
 * CharacterService：角色创建/更新/提交审核/owner 审核/投影与审计。
 * 并发安全核心：每个“读 + 状态检查 + 条件更新 + 审计”都发生在同一个
 * DatabasePort.transaction 内（repository 用 tx 重新构造，不持有外部 executor 后绕开）；
 * 条件更新未命中抛 STATE_CONFLICT，杜绝 approve/reject 并发双写；
 * 派生值实际写入 derived_json；每次状态/内容变更写 audit。
 */
export class CharacterService {
  private readonly repository: CharacterRepository;
  private readonly mutations: CampaignMutationCoordinator;
  private readonly actors: ActorService;

  constructor(private readonly executor: DatabasePort, mutations?: CampaignMutationCoordinator, actors?: ActorService) {
    this.repository = new CharacterRepository(executor);
    this.mutations = mutations ?? new CampaignMutationCoordinator(executor);
    this.actors = actors ?? new ActorService(executor, this.mutations);
  }

  async createDraft(ctx: CampaignAuthContext, input: CharacterDraftInput): Promise<CharacterDraft> {
    if (ctx.role !== 'player') {
      throw new AppError('FORBIDDEN', '只有玩家可以创建角色。');
    }
    if (!ctx.playerId) {
      throw new AppError('FORBIDDEN', '只有玩家可以创建角色。');
    }
    const now = new Date().toISOString();
    const row: CharacterRow = {
      id: nanoid(24),
      campaign_id: ctx.campaignId,
      player_id: ctx.playerId,
      name: input.name,
      status: 'draft',
      sheet_json: JSON.stringify(input.sheet),
      derived_json: '{}',
      submitted_at: null,
      approved_at: null,
      created_at: now,
      updated_at: now,
    };
    // insert + audit + revision 同一事务。
    await this.executor.transaction(async (tx) => {
      const repo = new CharacterRepository(tx);
      const execution = await this.mutations.mutateIn(tx, {
        campaignId: ctx.campaignId,
        mutationId: `character-create:${row.id}`,
        causeType: 'character_create',
        causeId: row.id,
      }, async () => {
        await repo.insert(row);
        await repo.insertAudit(this.auditRow(ctx, row, 'create', null));
        return true;
      });
      if (!execution.result) throw new AppError('INTERNAL_ERROR', '角色创建结果读取失败。');
    });
    return mapDraft(row);
  }

  async updateDraft(ctx: CampaignAuthContext, characterId: string, input: CharacterDraftInput): Promise<CharacterDraft> {
    const updated = await this.ownTransition(
      ctx,
      characterId,
      ['draft', 'rejected'],
      (row) => {
        const now = new Date().toISOString();
        return {
          ...row,
          name: input.name,
          sheet_json: JSON.stringify(input.sheet),
          status: 'draft',
          derived_json: '{}',
          submitted_at: null,
          approved_at: null,
          updated_at: now,
        };
      },
      'update',
    );
    return mapDraft(updated);
  }

  async submitForReview(ctx: CampaignAuthContext, characterId: string): Promise<CharacterReview> {
    // 幂等：已是自己的 pending_review 直接返回当前值（纯读，无写）。
    const existing = await this.repository.findById(characterId);
    if (
      existing &&
      existing.campaign_id === ctx.campaignId &&
      existing.player_id === ctx.playerId &&
      existing.status === 'pending_review'
    ) {
      return mapReview(existing);
    }
    const updated = await this.ownTransition(
      ctx,
      characterId,
      ['draft', 'rejected'],
      (row) => {
        const now = new Date().toISOString();
        return { ...row, status: 'pending_review', submitted_at: now, updated_at: now };
      },
      'submit',
    );
    return mapReview(updated);
  }

  async approve(ctx: CampaignAuthContext, characterId: string): Promise<ApprovedCharacter> {
    const updated = await this.campaignTransition(
      ctx,
      characterId,
      ['pending_review'],
      (row) => {
        const sheet = JSON.parse(row.sheet_json) as Record<string, unknown>;
        const derived = computeDerived(sheet);
        const now = new Date().toISOString();
        return {
          ...row,
          status: 'approved',
          derived_json: JSON.stringify(derived),
          approved_at: now,
          updated_at: now,
        };
      },
      'approve',
      async (tx, approved, stateRevision) => {
        await this.actors.ensureCharacterActorIn(tx, approved, stateRevision);
      },
    );
    return mapApproved(updated, JSON.parse(updated.derived_json) as CharacterDerivedValues);
  }

  async reject(ctx: CampaignAuthContext, characterId: string): Promise<CharacterRejected> {
    const updated = await this.campaignTransition(
      ctx,
      characterId,
      ['pending_review'],
      (row) => {
        const now = new Date().toISOString();
        return { ...row, status: 'rejected', submitted_at: null, updated_at: now };
      },
      'reject',
    );
    return mapRejected(updated);
  }

  async projectForCampaign(ctx: CampaignAuthContext): Promise<CharacterProjection> {
    const rows = await this.repository.listByCampaign(ctx.campaignId);
    const mine = rows.filter((row) => row.player_id === ctx.playerId);
    const reviews = ctx.role === 'owner' ? rows.filter((row) => row.status === 'pending_review') : [];
    const approvedSummaries = rows
      .filter((row) => row.status === 'approved')
      .map((row) => ({ id: row.id, name: row.name, playerId: row.player_id }));
    return {
      myDrafts: mine.filter((row) => row.status === 'draft').map(mapDraft),
      myPending: mine.filter((row) => row.status === 'pending_review').map(mapReview),
      myRejected: mine.filter((row) => row.status === 'rejected').map(mapRejected),
      myApproved: mine
        .filter((row) => row.status === 'approved')
        .map((row) => mapApproved(row, JSON.parse(row.derived_json) as CharacterDerivedValues)),
      reviews: reviews.map(mapReview),
      approvedSummaries,
    };
  }

  /** 玩家本人操作的原子变更：读 + 状态检查 + 条件更新 + 审计在同一事务内。 */
  private async ownTransition(
    ctx: CampaignAuthContext,
    characterId: string,
    expectedStatuses: CharacterStatus[],
    buildUpdated: (row: CharacterRow) => CharacterRow,
    action: string,
  ): Promise<CharacterRow> {
    return this.executor.transaction(async (tx) => {
      const repo = new CharacterRepository(tx);
      const row = await repo.findById(characterId);
      if (!row || row.campaign_id !== ctx.campaignId || row.player_id !== ctx.playerId) {
        // 跨 campaign / 跨 player 统一 NOT_FOUND，不泄露存在性。
        throw new AppError('NOT_FOUND', '角色不存在。');
      }
      if (!expectedStatuses.includes(row.status)) {
        throw new AppError('STATE_CONFLICT', '当前角色状态不允许该操作。');
      }
      const execution = await this.mutations.mutateIn(tx, {
        campaignId: ctx.campaignId,
        mutationId: `character-${action}:${nanoid(24)}`,
        causeType: `character_${action}`,
        causeId: characterId,
      }, async () => this.commitTransition(repo, ctx, row, buildUpdated, action));
      if (!execution.result) throw new AppError('INTERNAL_ERROR', '角色变更结果读取失败。');
      return execution.result;
    });
  }

  /** owner 操作的原子变更：读 + 状态检查 + 条件更新 + 审计在同一事务内。 */
  private async campaignTransition(
    ctx: CampaignAuthContext,
    characterId: string,
    expectedStatuses: CharacterStatus[],
    buildUpdated: (row: CharacterRow) => CharacterRow,
    action: string,
    afterTransition?: (tx: import('../../platform/database/DatabasePort.js').QueryExecutor, row: CharacterRow, stateRevision: number) => Promise<void>,
  ): Promise<CharacterRow> {
    requireOwner(ctx);
    return this.executor.transaction(async (tx) => {
      const repo = new CharacterRepository(tx);
      const row = await repo.findById(characterId);
      if (!row || row.campaign_id !== ctx.campaignId) {
        throw new AppError('NOT_FOUND', '角色不存在。');
      }
      if (!expectedStatuses.includes(row.status)) {
        throw new AppError('STATE_CONFLICT', '当前角色状态不允许该操作。');
      }
      const execution = await this.mutations.mutateIn(tx, {
        campaignId: ctx.campaignId,
        mutationId: `character-${action}:${nanoid(24)}`,
        causeType: `character_${action}`,
        causeId: characterId,
      }, async ({ stateRevision }) => {
        const updated = await this.commitTransition(repo, ctx, row, buildUpdated, action);
        if (afterTransition) await afterTransition(tx, updated, stateRevision);
        return updated;
      });
      if (!execution.result) throw new AppError('INTERNAL_ERROR', '角色变更结果读取失败。');
      return execution.result;
    });
  }

  private async commitTransition(
    repo: CharacterRepository,
    ctx: CampaignAuthContext,
    row: CharacterRow,
    buildUpdated: (row: CharacterRow) => CharacterRow,
    action: string,
  ): Promise<CharacterRow> {
    const updated = buildUpdated(row);
    const ok = await repo.updateContent(updated, row.status);
    if (!ok) {
      // 并发路径：另一请求已改变状态，条件更新未命中。
      throw new AppError('STATE_CONFLICT', '该角色状态已变化，请刷新后重试。');
    }
    await repo.insertAudit(this.auditRow(ctx, updated, action, row));
    return updated;
  }

  private auditRow(
    ctx: CampaignAuthContext,
    after: CharacterRow,
    action: string,
    before: CharacterRow | null,
  ): CharacterAuditRow {
    return {
      id: nanoid(24),
      character_id: after.id,
      campaign_id: after.campaign_id,
      actor_user_id: ctx.userId,
      action,
      before_json: before ? JSON.stringify(before) : null,
      after_json: JSON.stringify(after),
      created_at: new Date().toISOString(),
    };
  }
}

function mapDraft(row: CharacterRow): CharacterDraft {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    playerId: row.player_id,
    name: row.name,
    status: 'draft',
    sheet: JSON.parse(row.sheet_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReview(row: CharacterRow): CharacterReview {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    playerId: row.player_id,
    name: row.name,
    status: 'pending_review',
    sheet: JSON.parse(row.sheet_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at ?? row.updated_at,
  };
}

function mapRejected(row: CharacterRow): CharacterRejected {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    playerId: row.player_id,
    name: row.name,
    status: 'rejected',
    sheet: JSON.parse(row.sheet_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApproved(row: CharacterRow, derived: CharacterDerivedValues): ApprovedCharacter {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    playerId: row.player_id,
    name: row.name,
    status: 'approved',
    sheet: JSON.parse(row.sheet_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at ?? row.updated_at,
    derived,
  };
}
