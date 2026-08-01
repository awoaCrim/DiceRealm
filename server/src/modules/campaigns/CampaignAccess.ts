import type { AuthContext, Role } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';

/**
 * 已解析的战役级认证上下文：所有领域服务以它为唯一 ctx。
 * 独立结构，不 extends AuthContext（其 role/playerId/campaignId 可选），
 * 以避免类型上允许缺失必需字段。
 */
export interface CampaignAuthContext {
  userId: string;
  campaignId: string;
  role: Role;
  /** player 角色时即该用户在战役内的成员 user_id；owner 为 null。 */
  playerId: string | null;
}

/** 从会话 ctx 解析该用户在指定战役内的角色；非成员按 CAMPAIGN_NOT_FOUND 隐藏存在性。 */
export async function resolveCampaignContext(
  executor: QueryExecutor,
  ctx: AuthContext,
  campaignId: string,
): Promise<CampaignAuthContext> {
  if (!ctx?.userId) {
    throw new AppError('AUTH_REQUIRED', '请先登录。');
  }
  const rows = await executor.query<{ role: Role }>(
    'SELECT role FROM campaign_members WHERE campaign_id = ? AND user_id = ?',
    [campaignId, ctx.userId],
  );
  const member = rows[0];
  if (!member) {
    throw new AppError('CAMPAIGN_NOT_FOUND', '战役不存在。');
  }
  return {
    userId: ctx.userId,
    campaignId,
    role: member.role,
    playerId: member.role === 'player' ? ctx.userId : null,
  };
}

export function requireOwner(ctx: CampaignAuthContext): void {
  if (ctx.role !== 'owner') {
    throw new AppError('FORBIDDEN', '你没有权限执行此操作。');
  }
}
