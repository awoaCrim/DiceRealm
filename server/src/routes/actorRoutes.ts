import { Router } from 'express';
import type { Request, Response } from 'express';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { ActorService } from '../modules/actors/ActorService.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';

/** Minimum Actor read projection needed by multi-Actor clients. */
export function createActorRouter(executor: QueryExecutor, actors: ActorService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const projected = ctx.role === 'owner'
      ? await actors.list(ctx)
      : await actors.listControlled(ctx);
    res.json({ actors: projected });
  }));
  return router;
}
