import { jsonBodyBudget } from '../platform/http/jsonBodyBudget.js';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { createCampaignInputSchema, campaignSettingsPatchSchema } from '@dnd/contracts';
import type { CampaignService } from '../modules/campaigns/CampaignService.js';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { AppError } from '../platform/http/AppError.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { getAuthContext, requireAuth } from '../platform/http/sessionMiddleware.js';
import { resolveCampaignContext } from '../modules/campaigns/CampaignAccess.js';

/**
 * 战役路由：列出、创建、查看、加入与更新设置。
 * 路由只解析请求、调用 service、返回 DTO；权限与校验在 service 内完成。
 */
export function createCampaignRouter(executor: QueryExecutor, campaigns: CampaignService): Router {
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = getAuthContext(req);
      const summaryList = await campaigns.listOwnedOrJoined(ctx.userId);
      res.json({ campaigns: summaryList });
    }),
  );

  router.post(
    '/',
    jsonBodyBudget('campaigns'),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = getAuthContext(req);
      const input = createCampaignInputSchema.parse(req.body);
      const result = await campaigns.create(ctx.userId, input);
      res.status(201).json({ campaign: result.campaign, inviteCode: result.inviteCode });
    }),
  );

  router.get(
    '/:campaignId',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = getAuthContext(req);
      const view = await campaigns.getForMember(ctx, stringParam(req, 'campaignId'));
      res.json(view);
    }),
  );

  router.post(
    '/:campaignId/join',
    jsonBodyBudget('campaigns'),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = getAuthContext(req);
      const inviteCode = parseInviteCode(req);
      const member = await campaigns.join(ctx, stringParam(req, 'campaignId'), inviteCode);
      res.status(201).json({ member });
    }),
  );

  router.patch(
    '/:campaignId/settings',
    requireRouteOwner(executor),
    jsonBodyBudget('campaigns'),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = getAuthContext(req);
      const input = campaignSettingsPatchSchema.parse(req.body);
      const campaign = await campaigns.updateSettings(ctx, stringParam(req, 'campaignId'), input);
      res.json({ campaign });
    }),
  );

  return router;
}

function requireRouteOwner(executor: QueryExecutor): import('express').RequestHandler {
  return async (req, _res, next) => {
    try {
      const ctx = await resolveCampaignContext(executor, getAuthContext(req), stringParam(req, 'campaignId'));
      if (ctx.role !== 'owner') throw new AppError('FORBIDDEN', '你没有权限执行此操作。');
      next();
    } catch (error) { next(error); }
  };
}

function stringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) {
    throw new AppError('CAMPAIGN_NOT_FOUND', '战役不存在。');
  }
  return value;
}

function parseInviteCode(req: Request): string {
  const candidate =
    req.body?.inviteCode ??
    req.body?.invite_code ??
    req.query?.inviteCode ??
    req.query?.invite_code ??
    '';
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new AppError('CAMPAIGN_NOT_FOUND', '战役不存在或邀请码无效。');
  }
  return candidate.trim();
}
