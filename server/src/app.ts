import cors from 'cors';
import express from 'express';
import { ZodError } from 'zod';
import type { AppDatabase } from './db/connection.js';
import type { SqliteDatabaseAdapter } from './platform/database/SqliteDatabaseAdapter.js';
import { errorMiddleware } from './platform/http/errorMiddleware.js';
import { createSessionMiddleware } from './platform/http/sessionMiddleware.js';
import { IdentityService } from './modules/identity/IdentityService.js';
import { CampaignService } from './modules/campaigns/CampaignService.js';
import { createAdminRouter } from './routes/adminRoutes.js';
import { createPlayerRouter } from './routes/playerRoutes.js';
import { createSseRouter } from './routes/sseRoutes.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { createCampaignRouter } from './routes/campaignRoutes.js';

export interface CreateAppOptions {
  /** 可选：平台数据库适配器。提供时挂载身份/战役路由与会话中间件。 */
  platformDb?: SqliteDatabaseAdapter;
}

export function createApp(db: AppDatabase, options: CreateAppOptions = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  if (options.platformDb) {
    const identity = new IdentityService(options.platformDb);
    const campaigns = new CampaignService(options.platformDb);
    app.use(createSessionMiddleware(identity));
    app.use('/api/auth', createAuthRouter(identity));
    app.use('/api/campaigns', createCampaignRouter(campaigns));
    // 平台路由的错误统一由新错误中间件处理；必须先于旧错误中间件注册，
    // 否则会被下面 legacy 的错误兜底吞掉并泄漏原始 message。
    app.use(errorMiddleware);
  }

  app.use('/api/admin', createAdminRouter(db));
  app.use('/api/player', createPlayerRouter(db));
  app.use('/events', createSseRouter(db));
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Invalid request body', issues: err.issues });
      return;
    }
    if (typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
      const message = err instanceof Error ? err.message : 'Invalid request body';
      res.status(err.status).json({ error: message || 'Invalid request body' });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message || 'Internal server error' });
  });

  // 兜底 404：未匹配的 API 路径返回安全 JSON（而非 Express 默认 HTML），
  // 不向客户端泄漏任何路由/框架信息。
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } });
  });

  return app;
}
