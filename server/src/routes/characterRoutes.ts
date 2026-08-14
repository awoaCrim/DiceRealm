import { jsonBodyBudget } from '../platform/http/jsonBodyBudget.js';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { characterDraftInputSchema, characterReviewActionSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { CharacterService } from '../modules/characters/CharacterService.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';

export function createCharacterRouter(executor: QueryExecutor, characters: CharacterService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.json({ projection: await characters.projectForCampaign(getCampaignContext(req)) });
  }));
  router.post('/', requireRoutePlayer, jsonBodyBudget('characters'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = characterDraftInputSchema.parse(req.body);
    res.status(201).json({ character: await characters.createDraft(ctx, input) });
  }));
  router.put('/:characterId', requireRoutePlayer, jsonBodyBudget('characters'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = characterDraftInputSchema.parse(req.body);
    res.json({ character: await characters.updateDraft(ctx, stringParam(req, 'characterId'), input) });
  }));
  router.post('/:characterId/submit', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    if (ctx.role !== 'player') throw new AppError('FORBIDDEN', '只有玩家可以提交角色审核。');
    res.json({ character: await characters.submitForReview(ctx, stringParam(req, 'characterId')) });
  }));
  router.post('/:characterId/review', requireRouteOwner, jsonBodyBudget('characters'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const action = characterReviewActionSchema.parse(req.body?.action);
    const id = stringParam(req, 'characterId');
    if (action === 'approve') res.json({ character: await characters.approve(ctx, id) });
    else res.json({ character: await characters.reject(ctx, id) });
  }));
  return router;
}

function requireRoutePlayer(req: Request, _res: Response, next: import('express').NextFunction): void {
  try {
    if (getCampaignContext(req).role !== 'player') throw new AppError('FORBIDDEN', '只有玩家可以执行此操作。');
    next();
  } catch (error) { next(error); }
}
function requireRouteOwner(req: Request, _res: Response, next: import('express').NextFunction): void {
  try {
    if (getCampaignContext(req).role !== 'owner') throw new AppError('FORBIDDEN', '你没有权限执行此操作。');
    next();
  } catch (error) { next(error); }
}
function stringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new AppError('NOT_FOUND', '角色不存在。');
  return value;
}
