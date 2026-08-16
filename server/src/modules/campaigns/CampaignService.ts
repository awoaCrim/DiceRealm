import { nanoid } from 'nanoid';
import type {
  AuthContext,
  Campaign,
  CampaignMember,
  CampaignSettingsPatch,
  CampaignSummary,
  CampaignView,
  CreateCampaignInput,
  CreateCampaignResult,
} from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import {
  CampaignRepository,
  mapCampaign,
  mapCampaignMember,
  type CampaignMemberRow,
  type CampaignRow,
  type CampaignSummaryRow,
} from './CampaignRepository.js';
import { generateInviteCode, hashInviteCode, verifyInviteCode } from './inviteCodes.js';
import { CampaignMutationCoordinator } from './CampaignMutationCoordinator.js';

/**
 * CampaignService：创建、加入、查询与更新战役。
 * 每个方法先校验认证上下文（ctx 中存在 userId），再校验成员关系；
 * owner-only 操作额外校验 role === 'owner'。
 */
export class CampaignService {
  private readonly repository: CampaignRepository;
  private readonly mutations: CampaignMutationCoordinator;

  constructor(private readonly executor: DatabasePort, mutations?: CampaignMutationCoordinator) {
    this.repository = new CampaignRepository(executor);
    this.mutations = mutations ?? new CampaignMutationCoordinator(executor);
  }

  async create(ownerId: string, input: CreateCampaignInput): Promise<CreateCampaignResult> {
    if (!ownerId) {
      throw new AppError('AUTH_REQUIRED', '请先登录。');
    }
    const name = normalizeName(input.name);
    const ruleset = normalizeRuleset(input.ruleset);
    const id = nanoid(24);
    const now = new Date().toISOString();
    const inviteCode = generateInviteCode();
    const inviteCodeHash = hashInviteCode(inviteCode);
    await this.executor.transaction(async (tx) => {
      const repository = new CampaignRepository(tx);
      await repository.insert(id, ownerId, name, ruleset, 'setup', now, inviteCodeHash);
      await repository.insertMember(id, ownerId, 'owner', now);
      // Migration 015 creates heads for existing campaigns; new campaigns must
      // initialize their independent head in the same transaction as creation.
      await tx.execute(
        'INSERT INTO platform_campaign_state_heads (campaign_id, revision, updated_at) VALUES (?, 0, ?) ',
        [id, now],
      );
    });
    const row: CampaignRow = {
      id,
      owner_id: ownerId,
      name,
      status: 'setup',
      ruleset,
      created_at: now,
      updated_at: now,
      invite_code_hash: inviteCodeHash,
    };
    return { campaign: mapCampaign(row), inviteCode };
  }

  async listOwnedOrJoined(userId: string): Promise<CampaignSummary[]> {
    if (!userId) {
      throw new AppError('AUTH_REQUIRED', '请先登录。');
    }
    const rows = await this.repository.listForUser(userId);
    return rows.map(mapSummaryRow);
  }

  async getForMember(ctx: AuthContext, campaignId: string): Promise<CampaignView> {
    const userId = requireUserId(ctx);
    const campaign = await requireCampaign(this.repository, campaignId);
    const members = await this.repository.listMembers(campaignId);
    const member = members.find((entry) => entry.user_id === userId);
    if (!member) {
      // 对非成员隐藏战役存在性。
      throw new AppError('CAMPAIGN_NOT_FOUND', '战役不存在。');
    }
    return {
      campaign: mapCampaign(campaign),
      members: members.map(mapCampaignMember),
    };
  }

  async join(ctx: AuthContext, campaignId: string, inviteCode: string): Promise<CampaignMember> {
    const userId = requireUserId(ctx);
    return this.executor.transaction(async (tx) => {
      const repository = new CampaignRepository(tx);
      const campaign = await requireCampaign(repository, campaignId);
      const member = await repository.findMember(campaignId, userId);
      if (member) {
        // 已加入（owner 或 player）不可重复加入，统一使用同一错误。
        throw new AppError('STATE_CONFLICT', '你已经是该战役的成员。');
      }
      if (!verifyInviteCode(inviteCode, campaign.invite_code_hash)) {
        // 错误邀请码与不存在的战役使用同一错误，避免泄露战役/邀请码信息。
        throw new AppError('CAMPAIGN_NOT_FOUND', '战役不存在或邀请码无效。');
      }
      const now = new Date().toISOString();
      const execution = await this.mutations.mutateIn(tx, {
        campaignId,
        mutationId: `campaign-join:${nanoid(24)}`,
        causeType: 'campaign_member_join',
        causeId: userId,
      }, async () => {
        await repository.insertMember(campaignId, userId, 'player', now);
        const row: CampaignMemberRow = {
          campaign_id: campaignId,
          user_id: userId,
          role: 'player',
          joined_at: now,
        };
        return mapCampaignMember(row);
      });
      if (!execution.result) throw new AppError('INTERNAL_ERROR', '战役成员创建结果读取失败。');
      return execution.result;
    });
  }

  async updateSettings(ctx: AuthContext, campaignId: string, input: CampaignSettingsPatch): Promise<Campaign> {
    const userId = requireUserId(ctx);
    const campaign = await requireCampaign(this.repository, campaignId);
    const member = await this.repository.findMember(campaignId, userId);
    if (!member) {
      throw new AppError('CAMPAIGN_NOT_FOUND', '战役不存在。');
    }
    if (member.role !== 'owner') {
      throw new AppError('FORBIDDEN', '你没有权限执行此操作。');
    }
    const name = normalizeName(input.name);
    const now = new Date().toISOString();
    await this.repository.updateSettings(campaignId, name, now);
    return mapCampaign({
      ...campaign,
      name,
      updated_at: now,
    });
  }
}

export async function requireCampaign(repository: CampaignRepository, campaignId: string): Promise<CampaignRow> {
  const campaign = await repository.findById(campaignId);
  if (!campaign) {
    throw new AppError('CAMPAIGN_NOT_FOUND', '战役不存在。');
  }
  return campaign;
}

function requireUserId(ctx: AuthContext): string {
  if (!ctx || !ctx.userId) {
    throw new AppError('AUTH_REQUIRED', '请先登录。');
  }
  return ctx.userId;
}

function normalizeName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) {
    throw new AppError('VALIDATION_ERROR', '战役名称不能为空。');
  }
  if (value.length > 200) {
    throw new AppError('VALIDATION_ERROR', '战役名称过长。');
  }
  return value;
}

function normalizeRuleset(ruleset: unknown): string {
  const value = typeof ruleset === 'string' ? ruleset.trim() : '';
  if (!value) {
    throw new AppError('VALIDATION_ERROR', '规则集不能为空。');
  }
  return value;
}

function mapSummaryRow(row: CampaignSummaryRow): CampaignSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    ruleset: row.ruleset,
    updatedAt: row.updated_at,
    role: row.role,
  };
}
