import type { Request, RequestHandler, Response } from 'express';
import type { QueryExecutor } from '../database/DatabasePort.js';
import { resolveCampaignContext, type CampaignAuthContext } from '../../modules/campaigns/CampaignAccess.js';
import { AppError } from './AppError.js';
import { getAuthContext, type AuthenticatedRequest } from './sessionMiddleware.js';

/**
 * 只用于 feature routers（挂在 /api/campaigns/:campaignId/*）。
 * 不全局挂载到现有 /api/campaigns router，不阻塞 list/create/join。
 */
export function requireCampaignMember(executor: QueryExecutor): RequestHandler {
  return async (req, _res, next) => {
    try {
      const ctx = getAuthContext(req);
      const campaignId = readCampaignIdParam(req);
      (req as AuthenticatedRequest).campaignContext = await resolveCampaignContext(executor, ctx, campaignId);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function getCampaignContext(req: Request): CampaignAuthContext {
  const context = (req as AuthenticatedRequest).campaignContext;
  if (!context) {
    throw new AppError('AUTH_REQUIRED', '请先登录。');
  }
  return context;
}

function readCampaignIdParam(req: Request): string {
  const value = req.params.campaignId;
  if (typeof value !== 'string' || !value) {
    throw new AppError('CAMPAIGN_NOT_FOUND', '战役不存在。');
  }
  return value;
}
