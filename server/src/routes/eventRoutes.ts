import { Router } from 'express';
import type { Request, Response } from 'express';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';
import { getSessionBinding } from '../platform/http/sessionMiddleware.js';
import type { SessionAuthorityBinding } from '../modules/identity/SessionAuthority.js';
import type { EventStreamRuntime } from '../platform/realtime/EventStreamService.js';

export interface EventRouteOptions {
  /** 测试注入短轮询间隔（生产默认 250ms 由 service 决定）。 */
  pollIntervalMs?: number;
  /** 测试注入短 heartbeat（生产默认 15s）。 */
  heartbeatIntervalMs?: number;
}

/**
 * SSE 路由：GET /api/campaigns/:campaignId/events?after=<sequence>。
 * 经 campaign 权限校验（requireCampaignMember），同一 outbox 数据源 + projectEvent 投影。
 * 断线重放（after/Last-Event-ID）与 live tail 共用 EventStreamService 单例 runtime；
 * 路由不得按请求 new service。
 */
export function createEventRouter(executor: QueryExecutor, runtime: EventStreamRuntime, options: EventRouteOptions = {}): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs;

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const after = parseCursor(req);
    const ctx = getCampaignContext(req);
    const session = getSessionBinding(req);
    const viewer = { role: ctx.role, playerId: ctx.playerId };
    const authorityBinding: SessionAuthorityBinding = {
      internalSessionId: session.internalSessionId,
      userId: session.userId,
      authRevision: session.authRevision,
      revokeEpoch: session.revokeEpoch,
      campaignId: ctx.campaignId,
      viewer,
    };
    let subscription: { close(): void } | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let headersStarted = false;
    let invalidated = false;
    let cleanedUp = false;
    const closeDelivery = (): void => {
      invalidated = true;
      subscription?.close();
    };
    const destroyResponse = (): void => {
      invalidated = true;
      subscription?.close();
      // Before SSE headers this is only a tombstone: the route still owns the 401 response.
      if (!headersStarted) return;
      if (!res.writableEnded) res.end();
      res.destroy();
    };
    // Provisional registration closes the final-check/notifier gap. A revoke while the check awaits
    // tombstones this request; no asynchronous boundary exists between the final test and flushHeaders.
    const unregisterClient = runtime.registerClient({
      campaignId: ctx.campaignId,
      viewer,
      authorityBinding,
      close: closeDelivery,
      destroy: destroyResponse,
    });
    const cleanup = (): void => {
      invalidated = true;
      if (cleanedUp) return;
      cleanedUp = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      subscription?.close();
      unregisterClient();
    };
    req.once('close', cleanup);

    try {
      const current = await runtime.service.isCurrent(authorityBinding);
      if (!current || invalidated) {
        cleanup();
        throw new AppError('AUTH_REQUIRED', '请先登录。');
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      headersStarted = true;
      res.flushHeaders();

      heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          const ok = res.write(': ping\n\n');
          if (ok === false) {
            subscription?.close();
            res.destroy();
          }
        }
      }, heartbeatIntervalMs);

      subscription = runtime.service.subscribe({
        campaignId: ctx.campaignId,
        viewer,
        authorityBinding,
        after,
        pollIntervalMs,
        onFrame: (frame) => {
          const payload = `id: ${frame.id}\nevent: campaign\ndata: ${JSON.stringify(frame.data)}\n\n`;
          const ok = res.write(payload);
          if (ok === false) {
            subscription?.close();
            res.destroy();
          }
          return ok;
        },
        onProjectionError: () => {
          // 脱敏诊断：只记录 sequence 级信息，不把原始 payload/parse 错误发给客户端。
          if (typeof req.app.locals?.logProjectionError === 'function') {
            req.app.locals.logProjectionError();
          }
        },
        onError: () => {
          if (!res.writableEnded) res.destroy();
        },
      });
      if (invalidated) destroyResponse();
    } catch (error) {
      cleanup();
      throw error;
    }
  }));

  return router;
}

/** 解析游标：`?after` 优先于 Last-Event-ID；非安全非负整数 → 400。 */
function parseCursor(req: Request): number {
  const queryValue = req.query.after;
  const headerValue = req.headers['last-event-id'];
  const raw = queryValue !== undefined
    ? (typeof queryValue === 'string' ? queryValue : undefined)
    : (typeof headerValue === 'string' ? headerValue : undefined);
  if (raw === undefined) {
    return 0;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('VALIDATION_ERROR', '游标必须是安全非负整数。');
  }
  return value;
}
