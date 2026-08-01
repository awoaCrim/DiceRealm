import type { Campaign, CampaignMember, CampaignStatus, Role } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface CampaignRow {
  id: string;
  owner_id: string;
  name: string;
  status: CampaignStatus;
  ruleset: string;
  created_at: string;
  updated_at: string;
  /** 邀请码 SHA-256 摘要；旧战役可能为 null（尚未发放邀请码）。 */
  invite_code_hash: string | null;
}

export interface CampaignMemberRow {
  campaign_id: string;
  user_id: string;
  role: Role;
  joined_at: string;
}

export interface CampaignSummaryRow {
  id: string;
  name: string;
  status: CampaignStatus;
  ruleset: string;
  updated_at: string;
  role: Role;
}

export function mapCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    status: row.status,
    ruleset: row.ruleset,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapCampaignMember(row: CampaignMemberRow): CampaignMember {
  return {
    campaignId: row.campaign_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: row.joined_at,
  };
}

/**
 * CampaignRepository：通过 QueryExecutor 端口访问平台战役表。
 * 不包含权限策略与业务规则（这些属于 CampaignService）。
 */
export class CampaignRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async findById(id: string): Promise<CampaignRow | null> {
    const rows = await this.executor.query<CampaignRow>(
      'SELECT id, owner_id, name, status, ruleset, created_at, updated_at, invite_code_hash FROM campaigns WHERE id = ?',
      [id],
    );
    return rows[0] ?? null;
  }

  async insert(
    id: string,
    ownerId: string,
    name: string,
    ruleset: string,
    status: CampaignStatus,
    now: string,
    inviteCodeHash: string,
  ): Promise<void> {
    await this.executor.execute(
      'INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at, invite_code_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, ownerId, name, status, ruleset, now, now, inviteCodeHash],
    );
  }

  async updateSettings(id: string, name: string, now: string): Promise<void> {
    await this.executor.execute('UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ?', [name, now, id]);
  }

  async listMembers(campaignId: string): Promise<CampaignMemberRow[]> {
    return this.executor.query<CampaignMemberRow>(
      'SELECT campaign_id, user_id, role, joined_at FROM campaign_members WHERE campaign_id = ? ORDER BY joined_at ASC',
      [campaignId],
    );
  }

  async findMember(campaignId: string, userId: string): Promise<CampaignMemberRow | null> {
    const rows = await this.executor.query<CampaignMemberRow>(
      'SELECT campaign_id, user_id, role, joined_at FROM campaign_members WHERE campaign_id = ? AND user_id = ?',
      [campaignId, userId],
    );
    return rows[0] ?? null;
  }

  async insertMember(campaignId: string, userId: string, role: Role, joinedAt: string): Promise<void> {
    await this.executor.execute(
      'INSERT INTO campaign_members (campaign_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [campaignId, userId, role, joinedAt],
    );
  }

  /** 列出一个用户拥有或加入的所有战役及其成员角色。 */
  async listForUser(userId: string): Promise<CampaignSummaryRow[]> {
    return this.executor.query<CampaignSummaryRow>(
      `SELECT c.id, c.name, c.status, c.ruleset, c.updated_at, m.role AS role
         FROM campaign_members m
         JOIN campaigns c ON c.id = m.campaign_id
        WHERE m.user_id = ?
        ORDER BY c.updated_at DESC`,
      [userId],
    );
  }
}
