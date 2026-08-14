import { jsonBodyBudget } from '../platform/http/jsonBodyBudget.js';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { worldFactInputSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { WorldFactService } from '../modules/world/WorldFactService.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';

/**
 * 世界事实路由：挂在 /api/campaigns/:campaignId/world。
 * 必须以 Router({ mergeParams: true }) 创建，才能在子路由中读取父级 :campaignId。
 * owner 写（POST/PUT/DELETE），player 只读投影（GET）；权限判断在 service 内完成。
 */
export function createWorldRouter(executor: QueryExecutor, facts: WorldFactService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.json({ projection: await facts.projectForCampaign(getCampaignContext(req)) });
  }));

  router.post('/', requireRouteOwner, jsonBodyBudget('world'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = worldFactInputSchema.parse(req.body);
    res.status(201).json({ fact: await facts.create(ctx, input) });
  }));

  router.put('/:factId', requireRouteOwner, jsonBodyBudget('world'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = worldFactInputSchema.parse(req.body);
    res.json({ fact: await facts.update(ctx, stringParam(req, 'factId'), input) });
  }));

  router.delete('/:factId', requireRouteOwner, asyncHandler(async (req: Request, res: Response) => {
    await facts.delete(getCampaignContext(req), stringParam(req, 'factId'));
    res.status(204).end();
  }));

  return router;
}

function requireRouteOwner(req: Request, _res: Response, next: import('express').NextFunction): void {
  try {
    const ctx = getCampaignContext(req);
    if (ctx.role !== 'owner') throw new AppError('FORBIDDEN', '你没有权限执行此操作。');
    next();
  } catch (error) { next(error); }
}
function stringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new AppError('NOT_FOUND', '世界事实不存在。');
  return value;
}
