import { nanoid } from 'nanoid';
import type { WorldFact, WorldFactInput, WorldFactProjection } from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { canRead } from '../visibility/VisibilityPolicy.js';
import { WorldFactRepository, type WorldFactRow } from './WorldFactRepository.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';

/**
 * WorldFactService：owner 写世界事实、player 只读经 VisibilityPolicy 投影。
 * 并发/隐私核心：写入走事务；knownBy 成员校验在事务内（与写同 tx）；
 * 投影时 player 只见可读 facts 且 knownBy 收敛为 []/自己的 playerId，绝不泄漏完整列表。
 */
export class WorldFactService {
  private readonly repository: WorldFactRepository;
  private readonly mutations: CampaignMutationCoordinator;

  constructor(private readonly executor: DatabasePort, mutations?: CampaignMutationCoordinator) {
    this.repository = new WorldFactRepository(executor);
    this.mutations = mutations ?? new CampaignMutationCoordinator(executor);
  }

  async create(ctx: CampaignAuthContext, input: WorldFactInput): Promise<WorldFact> {
    requireOwner(ctx);
    return this.executor.transaction(async (tx) => {
      const repo = new WorldFactRepository(tx);
      const knownBy = await this.validateKnownBy(tx, ctx.campaignId, input);
      const now = new Date().toISOString();
      const row: WorldFactRow = {
        id: nanoid(24),
        campaign_id: ctx.campaignId,
        title: input.title,
        kind: input.kind,
        content: input.content,
        visibility: input.visibility,
        known_by_json: JSON.stringify(knownBy),
        created_at: now,
        updated_at: now,
      };
      const execution = await this.mutations.mutateIn(tx, {
        campaignId: ctx.campaignId,
        mutationId: `world-fact-create:${row.id}`,
        causeType: 'world_fact_create',
        causeId: row.id,
      }, async () => {
        await repo.insert(row);
        return mapFact(row);
      });
      if (!execution.result) throw new AppError('INTERNAL_ERROR', '世界事实创建结果读取失败。');
      return execution.result;
    });
  }

  async update(ctx: CampaignAuthContext, factId: string, input: WorldFactInput): Promise<WorldFact> {
    requireOwner(ctx);
    return this.executor.transaction(async (tx) => {
      const repo = new WorldFactRepository(tx);
      // 在同一事务内读取现有行：保留原 created_at，仅 updated_at = now，不得伪造创建时间。
      const existing = await repo.findById(factId);
      if (!existing || existing.campaign_id !== ctx.campaignId) {
        throw new AppError('NOT_FOUND', '世界事实不存在。');
      }
      const knownBy = await this.validateKnownBy(tx, ctx.campaignId, input);
      const now = new Date().toISOString();
      const execution = await this.mutations.mutateIn(tx, {
        campaignId: ctx.campaignId,
        mutationId: `world-fact-update:${nanoid(24)}`,
        causeType: 'world_fact_update',
        causeId: factId,
      }, async () => {
        const ok = await repo.updateContent(factId, ctx.campaignId, {
          title: input.title, kind: input.kind, content: input.content,
          visibility: input.visibility, known_by_json: JSON.stringify(knownBy), updated_at: now,
        });
        if (!ok) {
          throw new AppError('NOT_FOUND', '世界事实不存在。');
        }
        return mapFact({
          ...existing,
          title: input.title,
          kind: input.kind,
          content: input.content,
          visibility: input.visibility,
          known_by_json: JSON.stringify(knownBy),
          updated_at: now,
        });
      });
      if (!execution.result) throw new AppError('INTERNAL_ERROR', '世界事实更新结果读取失败。');
      return execution.result;
    });
  }

  async delete(ctx: CampaignAuthContext, factId: string): Promise<void> {
    requireOwner(ctx);
    await this.executor.transaction(async (tx) => {
      const repo = new WorldFactRepository(tx);
      const execution = await this.mutations.mutateIn(tx, {
        campaignId: ctx.campaignId,
        mutationId: `world-fact-delete:${nanoid(24)}`,
        causeType: 'world_fact_delete',
        causeId: factId,
      }, async () => {
        const ok = await repo.delete(factId, ctx.campaignId);
        if (!ok) {
          throw new AppError('NOT_FOUND', '世界事实不存在。');
        }
        return true;
      });
      if (!execution.result) throw new AppError('INTERNAL_ERROR', '世界事实删除结果读取失败。');
    });
  }

  async projectForCampaign(ctx: CampaignAuthContext): Promise<WorldFactProjection> {
    const rows = await this.repository.listByCampaign(ctx.campaignId);
    const facts: WorldFact[] = [];
    for (const row of rows) {
      const knownBy = JSON.parse(row.known_by_json) as string[];
      if (ctx.role === 'owner') {
        facts.push(mapFact(row));
        continue;
      }
      if (!canRead({ role: 'player', playerId: ctx.playerId }, row.visibility, knownBy)) {
        continue;
      }
      // player DTO 不泄露完整 knownBy：public → []；player_private 可见 → [自己的 playerId]。
      facts.push({ ...mapFact(row), knownBy: row.visibility === 'player_private' ? [ctx.playerId as string] : [] });
    }
    return { facts };
  }

  /** public/owner_only 一律落库 knownBy=[]；player_private 必须非空且每个都是该 campaign 的 player 成员。 */
  private async validateKnownBy(
    tx: QueryExecutor,
    campaignId: string,
    input: WorldFactInput,
  ): Promise<string[]> {
    const knownBy = input.knownBy ?? [];
    if (input.visibility !== 'player_private') {
      return [];
    }
    if (knownBy.length === 0) {
      throw new AppError('VALIDATION_ERROR', '玩家私密事实必须指定至少一个可见玩家。');
    }
    const playerIds = await new WorldFactRepository(tx).listPlayerMemberIds(campaignId);
    for (const playerId of knownBy) {
      if (!playerIds.includes(playerId)) {
        throw new AppError('VALIDATION_ERROR', '目标玩家不是该战役的玩家成员。');
      }
    }
    return [...new Set(knownBy)];
  }
}

function mapFact(row: WorldFactRow): WorldFact {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    title: row.title,
    kind: row.kind,
    content: row.content,
    visibility: row.visibility,
    knownBy: JSON.parse(row.known_by_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
