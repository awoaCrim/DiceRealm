import { jsonBodyBudget } from '../platform/http/jsonBodyBudget.js';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { manualArchiveInputSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { ArchiveService } from '../modules/archives/ArchiveService.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';

/**
 * 存档路由：挂在 /api/campaigns/:campaignId/archives。
 * 必须以 Router({ mergeParams: true }) 创建，才能在子路由中读取父级 :campaignId。
 * 三个端点都是 owner-only（service 内 enforce requireOwner）：
 * GET / 列表、POST / 手动存档、POST /:archiveId/restore 恢复。
 */
export function createArchiveRouter(executor: QueryExecutor, archives: ArchiveService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    // 存档列表 owner-only：service 内 enforce（listForCampaign 调 requireOwner），player 不可见。
    res.json({ archives: await archives.listForCampaign(getCampaignContext(req)) });
  }));

  router.post('/', requireRouteOwner, jsonBodyBudget('archive'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = manualArchiveInputSchema.parse(req.body);
    res.status(201).json({ archive: await archives.createManual(ctx, input.label) });
  }));

  router.post('/:archiveId/restore', requireRouteOwner, asyncHandler(async (req: Request, res: Response) => {
    res.json({ result: await archives.restore(getCampaignContext(req), stringParam(req, 'archiveId')) });
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
  if (typeof value !== 'string' || !value) throw new AppError('NOT_FOUND', '存档不存在。');
  return value;
}
