import { jsonBodyBudget } from '../platform/http/jsonBodyBudget.js';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { turnActionInputSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { TurnService } from '../modules/turns/TurnService.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';

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
  router.post('/:turnId/actions', requireRoutePlayer, jsonBodyBudget('turn'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = turnActionInputSchema.parse(req.body);
    res.json({ view: await turns.submitAction(ctx, stringParam(req, 'turnId'), input) });
  }));
  return router;
}
function requireRoutePlayer(req: Request, _res: Response, next: import('express').NextFunction): void {
  try {
    if (getCampaignContext(req).role !== 'player') throw new AppError('FORBIDDEN', '只有玩家可以执行此操作。');
    next();
  } catch (error) { next(error); }
}
function stringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new AppError('NOT_FOUND', '回合不存在。');
  return value;
}
