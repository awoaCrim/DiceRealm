import { jsonBodyBudget } from '../platform/http/jsonBodyBudget.js';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { combatCommandSchema, startEncounterInputSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { CombatService } from '../modules/combat/CombatService.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';

/**
 * 结构化战斗路由：挂在 /api/campaigns/:campaignId/combat。
 * HTTP 写命令 owner-only（CombatService 内 requireOwner enforce）；
 * 玩家只读投影（get/list）。AI 通过 CombatAiAdapter 使用同一命令端口，不经 HTTP。
 */
export function createCombatRouter(executor: QueryExecutor, combat: CombatService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));

  router.post('/', requireRouteOwner, jsonBodyBudget('combat'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = startEncounterInputSchema.parse(req.body);
    res.status(201).json({ encounter: await combat.start(ctx, input) });
  }));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.json({ encounters: await combat.list(getCampaignContext(req)) });
  }));

  router.get('/:encounterId', asyncHandler(async (req: Request, res: Response) => {
    res.json({ encounter: await combat.get(getCampaignContext(req), stringParam(req, 'encounterId')) });
  }));

  router.post('/:encounterId/commands', requireRouteOwner, jsonBodyBudget('combat'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const command = combatCommandSchema.parse(req.body);
    if (command.kind === 'start_encounter') {
      throw new AppError('VALIDATION_ERROR', 'start_encounter 只能通过 POST /combat 创建。');
    }
    res.json({ encounter: await combat.execute(ctx, stringParam(req, 'encounterId'), command) });
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
  if (typeof value !== 'string' || !value) throw new AppError('NOT_FOUND', '遭遇不存在。');
  return value;
}
