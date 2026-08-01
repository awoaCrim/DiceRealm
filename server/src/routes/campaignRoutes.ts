import { Router } from 'express';
import type { Request, Response } from 'express';
import { createCampaignInputSchema, campaignSettingsPatchSchema } from '@dnd/contracts';
import type { CampaignService } from '../modules/campaigns/CampaignService.js';
import { AppError } from '../platform/http/AppError.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { getAuthContext, requireAuth } from '../platform/http/sessionMiddleware.js';

/**
 * 战役路由：列出、创建、查看、加入与更新设置。
 * 路由只解析请求、调用 service、返回 DTO；权限与校验在 service 内完成。
 */
export function createCampaignRouter(campaigns: CampaignService): Router {
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
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = getAuthContext(req);
      const input = createCampaignInputSchema.parse(req.body);
      const result = await campaigns.create(ctx.userId, input);
      // 创建响应向 owner 返回一次性 raw invite code（不落库）；后续列表/详情不再返回。
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
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = getAuthContext(req);
      const inviteCode = parseInviteCode(req);
      const member = await campaigns.join(ctx, stringParam(req, 'campaignId'), inviteCode);
      res.status(201).json({ member });
    }),
  );

  router.patch(
    '/:campaignId/settings',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = getAuthContext(req);
      const input = campaignSettingsPatchSchema.parse(req.body);
      const campaign = await campaigns.updateSettings(ctx, stringParam(req, 'campaignId'), input);
      res.json({ campaign });
    }),
  );

  return router;
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
