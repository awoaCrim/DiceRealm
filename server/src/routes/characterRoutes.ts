import { Router } from 'express';
import type { Request, Response } from 'express';
import { characterDraftInputSchema, characterReviewActionSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { CharacterService } from '../modules/characters/CharacterService.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';

/**
 * 角色路由：挂在 /api/campaigns/:campaignId/characters。
 * 必须以 Router({ mergeParams: true }) 创建，才能在子路由中读取父级 :campaignId。
 * 每个 handler 先 getCampaignContext 取得 campaign 级认证上下文（含 role），
 * 权限判断在 service 内完成；owner 不调用 submit 路径。
 */
export function createCharacterRouter(executor: QueryExecutor, characters: CharacterService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.json({ projection: await characters.projectForCampaign(getCampaignContext(req)) });
  }));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = characterDraftInputSchema.parse(req.body);
    res.status(201).json({ character: await characters.createDraft(ctx, input) });
  }));

  router.put('/:characterId', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = characterDraftInputSchema.parse(req.body);
    res.json({ character: await characters.updateDraft(ctx, stringParam(req, 'characterId'), input) });
  }));

  router.post('/:characterId/submit', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    if (ctx.role !== 'player') {
      throw new AppError('FORBIDDEN', '只有玩家可以提交角色审核。');
    }
    res.json({ character: await characters.submitForReview(ctx, stringParam(req, 'characterId')) });
  }));

  router.post('/:characterId/review', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const action = characterReviewActionSchema.parse(req.body?.action);
    const id = stringParam(req, 'characterId');
    if (action === 'approve') {
      res.json({ character: await characters.approve(ctx, id) });
      return;
    }
    res.json({ character: await characters.reject(ctx, id) });
  }));

  return router;
}

function stringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) {
    // 坏 resourceId 表示资源不存在，用 NOT_FOUND（而非 CAMPAIGN_NOT_FOUND）。
    throw new AppError('NOT_FOUND', '角色不存在。');
  }
  return value;
}
