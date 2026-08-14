import { jsonBodyBudget } from '../platform/http/jsonBodyBudget.js';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { aiProviderConfigInputSchema, resolveTurnInputSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { AppError } from '../platform/http/AppError.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AiResolutionService } from '../modules/ai-runtime/AiResolutionService.js';
import { AiRunRepository, type AiRunRow } from '../modules/ai-runtime/AiRunRepository.js';
import { TurnEntryRepository, projectEntries, type TurnEntryRow } from '../modules/ai-runtime/TurnEntryRepository.js';
import { TurnRepository } from '../modules/turns/TurnRepository.js';
import { requireOwner } from '../modules/campaigns/CampaignAccess.js';
import type { AiProviderConfigService } from '../modules/ai-runtime/AiProviderConfigService.js';

/**
 * AI 路由：挂在 /api/campaigns/:campaignId/ai。
 * 必须以 Router({ mergeParams: true }) 创建，才能在子路由中读取父级 :campaignId。
 * resolve（POST /turns/:turnId/runs）的 owner 权限由 AiResolutionService 在事务内 enforce；
 * 只读端点（runs 列表 / run 详情）由路由层 requireOwner + campaign 归属校验共同保证。
 */
export function createAiRouter(executor: QueryExecutor, ai: AiResolutionService, providerConfig: AiProviderConfigService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));

  router.get('/provider-status', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    res.json({ provider: await providerConfig.getForOwner(ctx) });
  }));

  router.put('/provider-config', requireRouteOwner, jsonBodyBudget('aiProvider'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    requireOwner(ctx);
    const input = aiProviderConfigInputSchema.parse(req.body);
    res.json({ provider: await providerConfig.save(ctx, input) });
  }));

  router.post('/provider-config/test', requireRouteOwner, jsonBodyBudget('aiProvider'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    requireOwner(ctx);
    const input = aiProviderConfigInputSchema.parse(req.body);
    await providerConfig.test(ctx, input);
    res.json({ ok: true });
  }));

  router.get('/runs', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    requireOwner(ctx);
    const runs = await new AiRunRepository(executor).listByCampaign(ctx.campaignId);
    res.json({ runs: runs.map(toView) });
  }));

  router.post('/turns/:turnId/runs', requireRouteOwner, jsonBodyBudget('ai'), asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = resolveTurnInputSchema.parse(req.body);
    // 新 run → 201；同 key 幂等 replay（既有 run）→ 200。service 返回 { created, run }。
    const result = await ai.resolveTurn(ctx, stringParam(req, 'turnId'), input);
    res.status(result.created ? 201 : 200).json({ run: result.run });
  }));

  router.get('/turns/:turnId/runs', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    requireOwner(ctx);
    const turnId = stringParam(req, 'turnId');
    await requireTurnInCampaign(executor, ctx.campaignId, turnId); // 跨 campaign 已知 turnId → NOT_FOUND
    const runs = await new AiRunRepository(executor).listByTurn(turnId);
    res.json({ runs: runs.map(toView) });
  }));

  router.get('/runs/:runId', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    requireOwner(ctx);
    const run = await new AiRunRepository(executor).findById(stringParam(req, 'runId'));
    if (!run || run.campaign_id !== ctx.campaignId) throw new AppError('NOT_FOUND', 'AI run 不存在。');
    // owner-only 详情：附加 context/result/rawDebug（普通 player 不可读）。
    res.json({ run: { ...toView(run), context: JSON.parse(run.context_json), result: run.result_json ? JSON.parse(run.result_json) : null, rawDebug: run.raw_debug_json ? JSON.parse(run.raw_debug_json) : null } });
  }));

  router.get('/turns/:turnId/entries', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const turnId = stringParam(req, 'turnId');
    await requireTurnInCampaign(executor, ctx.campaignId, turnId); // 跨 campaign 已知 turnId → NOT_FOUND
    const rows = await new TurnEntryRepository(executor).listByTurn(turnId);
    const projected = projectEntries({ role: ctx.role, playerId: ctx.playerId }, rows);
    res.json({ entries: projected.map(toEntry) });
  }));

  return router;
}

function requireRouteOwner(req: Request, _res: Response, next: NextFunction): void {
  try { requireOwner(getCampaignContext(req)); next(); }
  catch (error) { next(error); }
}


async function requireTurnInCampaign(executor: QueryExecutor, campaignId: string, turnId: string): Promise<void> {
  const turn = await new TurnRepository(executor).findTurnById(turnId);
  if (!turn || turn.campaign_id !== campaignId) {
    throw new AppError('NOT_FOUND', '回合不存在。');
  }
}

function toView(row: AiRunRow) {
  return {
    id: row.id, campaignId: row.campaign_id, campaignSequence: row.campaign_sequence,
    turnId: row.turn_id, attempt: row.attempt, idempotencyKey: row.idempotency_key,
    provider: row.provider, model: row.model, status: row.status, errorCode: row.error_code,
    startedAt: row.started_at, completedAt: row.completed_at, superseded: row.superseded_at !== null,
  };
}

function toEntry(row: TurnEntryRow) {
  return {
    id: row.id, aiRunId: row.ai_run_id, turnId: row.turn_id, campaignId: row.campaign_id,
    entryKind: row.entry_kind, entryIndex: row.entry_index, visibility: row.visibility,
    targetPlayerId: row.target_player_id, payload: JSON.parse(row.payload_json), createdAt: row.created_at,
  };
}

function stringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new AppError('NOT_FOUND', '资源不存在。');
  return value;
}
