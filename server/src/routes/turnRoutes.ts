import { Router } from 'express';
import type { Request, Response } from 'express';
import { turnActionInputSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { TurnService } from '../modules/turns/TurnService.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';

/**
 * 回合路由：挂在 /api/campaigns/:campaignId/turns。
 * 必须以 Router({ mergeParams: true }) 创建，才能在子路由中读取父级 :campaignId。
 * owner 开始回合（POST /），player 提交行动（POST /:turnId/actions）；权限判断在 service 内完成。
 */
export function createTurnRouter(executor: QueryExecutor, turns: TurnService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.json({ turns: await turns.listForCampaign(getCampaignContext(req)) });
  }));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ turn: await turns.startTurn(getCampaignContext(req)) });
  }));

  router.get('/:turnId', asyncHandler(async (req: Request, res: Response) => {
    res.json({ view: await turns.getView(getCampaignContext(req), stringParam(req, 'turnId')) });
  }));

  router.post('/:turnId/actions', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = turnActionInputSchema.parse(req.body);
    res.json({ view: await turns.submitAction(ctx, stringParam(req, 'turnId'), input) });
  }));

  return router;
}

function stringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) {
    // 坏 resourceId 表示资源不存在，用 NOT_FOUND（而非 CAMPAIGN_NOT_FOUND）。
    throw new AppError('NOT_FOUND', '回合不存在。');
  }
  return value;
}
