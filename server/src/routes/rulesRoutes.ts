import { jsonBodyBudget } from '../platform/http/jsonBodyBudget.js';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { ruleSourceRegistrationInputSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';
import { RulesService } from '../modules/rules/RulesService.js';
import { requireOwner } from '../modules/campaigns/CampaignAccess.js';

/** Owner-only metadata registry mounted at /api/campaigns/:campaignId/rules. */
export function createRulesRouter(executor: QueryExecutor, rules: RulesService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));

  router.get('/sources', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    requireOwner(ctx);
    res.json({ sources: await rules.listForOwner(ctx) });
  }));

  router.post('/sources', requireRouteOwner, jsonBodyBudget('rules'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    requireOwner(ctx);
    const parsed = ruleSourceRegistrationInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('INVALID_RULE_SOURCE', '规则来源必须包含来源、版本、许可证、署名与有效的 SHA-256 哈希。');
    }
    res.status(201).json({ source: await rules.register(ctx, parsed.data) });
  }));
  return router;
}

function requireRouteOwner(req: Request, _res: Response, next: import('express').NextFunction): void {
  try { requireOwner(getCampaignContext(req)); next(); }
  catch (error) { next(error); }
}

