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
import { createCharacterRouter } from './routes/characterRoutes.js';
import { CharacterService } from './modules/characters/CharacterService.js';
import { WorldFactService } from './modules/world/WorldFactService.js';
import { createWorldRouter } from './routes/worldRoutes.js';
import { TurnService } from './modules/turns/TurnService.js';
import { OutboxRepository } from './platform/events/OutboxRepository.js';
import { createTurnRouter } from './routes/turnRoutes.js';
import { ArchiveService } from './modules/archives/ArchiveService.js';
import { createArchiveRouter } from './routes/archiveRoutes.js';
import { AiResolutionService } from './modules/ai-runtime/AiResolutionService.js';
import { AiContextBuilder } from './modules/ai-runtime/AiContextBuilder.js';
import { TurnResolutionValidator } from './modules/ai-runtime/TurnResolutionValidator.js';
import { StateChangeMaterializer } from './modules/ai-runtime/StateChangeMaterializer.js';
import { UnavailableAiProvider } from './modules/ai-runtime/UnavailableAiProvider.js';
import type { AiProviderPort } from './modules/ai-runtime/AiProviderPort.js';
import { createAiRouter } from './routes/aiRoutes.js';

export interface CreateAppOptions {
  /** 可选：平台数据库适配器。提供时挂载身份/战役路由与会话中间件。 */
  platformDb?: SqliteDatabaseAdapter;
  /** AI Provider：生产默认 UnavailableAiProvider（resolve 安全失败 AI_PROVIDER_FAILED）；测试注入 ScriptedAiProvider。绝不默认 Mock。 */
  aiProvider?: AiProviderPort;
}

export function createApp(db: AppDatabase, options: CreateAppOptions = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  if (options.platformDb) {
    const identity = new IdentityService(options.platformDb);
    const campaigns = new CampaignService(options.platformDb);
    const characters = new CharacterService(options.platformDb);
    const worldFacts = new WorldFactService(options.platformDb);
    // TurnService 依赖 EventPublisherPort 端口；composition root 注入 concrete OutboxRepository（与业务同 tx 写 outbox）。
    const turns = new TurnService(options.platformDb, new OutboxRepository(options.platformDb));
    app.use(createSessionMiddleware(identity));
    app.use('/api/auth', createAuthRouter(identity));
    app.use('/api/campaigns', createCampaignRouter(campaigns));
    // 角色路由挂在 campaign-scoped 前缀下，与现有 /api/campaigns list/create/join 互不影响。
    app.use('/api/campaigns/:campaignId/characters', createCharacterRouter(options.platformDb, characters));
    // 世界事实路由同样挂在 campaign-scoped 前缀下。
    app.use('/api/campaigns/:campaignId/world', createWorldRouter(options.platformDb, worldFacts));
    // 回合路由挂在 campaign-scoped 前缀下；owner/player 权限由 service 在事务内 enforce。
    app.use('/api/campaigns/:campaignId/turns', createTurnRouter(options.platformDb, turns));
    // 存档路由同样挂在 campaign-scoped 前缀下；owner-only 权限由 service 在事务内 enforce。
    const archives = new ArchiveService(options.platformDb, new OutboxRepository(options.platformDb));
    app.use('/api/campaigns/:campaignId/archives', createArchiveRouter(options.platformDb, archives));
    // AI 路由同样挂在 campaign-scoped 前缀下：resolve 权限由 AiResolutionService 在事务内 enforce；
    // 只读端点由路由层 requireOwner + campaign 归属校验保证。生产默认 UnavailableAiProvider（安全失败）。
    const aiProvider = options.aiProvider ?? new UnavailableAiProvider();
    const ai = new AiResolutionService(
      options.platformDb, aiProvider, new OutboxRepository(options.platformDb), archives,
      new AiContextBuilder(options.platformDb),
      new TurnResolutionValidator(options.platformDb),
      new StateChangeMaterializer(options.platformDb),
    );
    app.use('/api/campaigns/:campaignId/ai', createAiRouter(options.platformDb, ai));
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
