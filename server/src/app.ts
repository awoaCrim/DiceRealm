import express from 'express';
import type { SecurityConfig } from './config.js';
import { RequestSecurityPolicy } from './platform/http/RequestSecurityPolicy.js';
import { securityHeaders } from './platform/http/securityHeaders.js';
import type { EventViewer } from '@dnd/contracts';
import type { DatabasePort } from './platform/database/DatabasePort.js';
import { errorMiddleware } from './platform/http/errorMiddleware.js';
import { createSessionMiddleware } from './platform/http/sessionMiddleware.js';
import { IdentityService, type IdentityServiceOptions } from './modules/identity/IdentityService.js';
import { CampaignService } from './modules/campaigns/CampaignService.js';
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
import { createEventRouter } from './routes/eventRoutes.js';
import { createCombatRouter } from './routes/combatRoutes.js';
import {
  EventStreamService,
  TransactionalOutboxTailReader,
  type EventAuthorityChecker,
  type EventStreamRuntime,
} from './platform/realtime/EventStreamService.js';
import { SessionAuthority, type SessionAuthorityBinding } from './modules/identity/SessionAuthority.js';
import { CombatService } from './modules/combat/CombatService.js';
import { CombatAiAdapter } from './modules/combat/CombatAiAdapter.js';
import { CombatRepository } from './modules/combat/CombatRepository.js';
import { AiProviderConfigService } from './modules/ai-runtime/AiProviderConfigService.js';
import { CampaignScopedAiProvider } from './modules/ai-runtime/CampaignScopedAiProvider.js';
import type { CredentialCipher } from './modules/ai-runtime/CredentialCipher.js';
import { NarrativeWorkCoordinator } from './modules/narrative-runtime/NarrativeWorkCoordinator.js';
import { NarrativeWorkRuntime } from './modules/narrative-runtime/NarrativeWorkRuntime.js';

/**
 * 平台唯一组合根。`database` 必填且只能是 `DatabasePort`；
 * 生产不再接受 raw better-sqlite3 或双 seam。
 */
export interface CreatePlatformAppOptions {
  database: DatabasePort;
  /** Production falls back to UnavailableAiProvider when no provider is configured. */
  aiProvider?: AiProviderPort;
  /** Local cipher used for campaign-scoped saved provider credentials. */
  credentialCipher?: CredentialCipher;
  /** Validated origin/TLS/proxy policy. */
  securityConfig: SecurityConfig;
}

/** Deterministic controls exposed only through createTestPlatformApp. */
export interface PlatformAppTestOptions {
  identityOptions?: IdentityServiceOptions;
  providerFetch?: typeof fetch;
  configuredAiProviderFactory?: (config: import('./config.js').AiProviderEnvConfig, fetchImpl?: typeof fetch) => AiProviderPort;
  realtimeAuthorityChecker?: EventAuthorityChecker;
  realtimePollIntervalMs?: number;
  realtimeHeartbeatIntervalMs?: number;
  narrativeWorkPollIntervalMs?: number;
}

export interface PlatformApp {
  app: express.Express;
  realtimeRuntime: EventStreamRuntime;
  narrativeWorkRuntime: NarrativeWorkRuntime;
}

export function createPlatformApp(options: CreatePlatformAppOptions): PlatformApp {
  return composePlatformApp(options, {});
}

/** Test-only constructor; production startup imports createPlatformApp only. */
export function createTestPlatformApp(
  options: CreatePlatformAppOptions,
  testOptions: PlatformAppTestOptions = {},
): PlatformApp {
  return composePlatformApp(options, testOptions);
}

function composePlatformApp(
  options: CreatePlatformAppOptions,
  testOptions: PlatformAppTestOptions,
): PlatformApp {
  const { database } = options;
  const app = express();
  if (!options.securityConfig) throw new Error('security configuration is required');
  const securityPolicy = new RequestSecurityPolicy(options.securityConfig);
  app.set('trust proxy', securityPolicy.trustProxyPredicate());
  app.use((req, res, next) => {
    if (req.path === '/api/auth' || req.path.startsWith('/api/auth/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(securityHeaders());
  app.use(securityPolicy.middleware());

  // Realtime is composed before identity so commit-only session notifications can close matching clients.
  const sessionAuthority = new SessionAuthority(database);
  const realtimeService = new EventStreamService(
    new TransactionalOutboxTailReader(database),
    {},
    testOptions.realtimeAuthorityChecker ?? sessionAuthority,
  );
  const realtimeClients = new Set<{
    campaignId: string;
    viewer: EventViewer;
    authorityBinding?: SessionAuthorityBinding;
    close(): void;
    destroy(): void;
  }>();
  const closeClients = (matches: (client: {
    campaignId: string;
    viewer: EventViewer;
    authorityBinding?: SessionAuthorityBinding;
  }) => boolean): number => {
    const matched = [...realtimeClients].filter(matches);
    // Linearization order: remove every match first, then drop all delivery state, then destroy all responses.
    for (const client of matched) realtimeClients.delete(client);
    for (const client of matched) {
      try { client.close(); }
      catch { /* isolate one broken client so all matching delivery state is still dropped */ }
    }
    for (const client of matched) {
      try { client.destroy(); }
      catch { /* isolate one broken socket so remaining matching responses are still closed */ }
    }
    return matched.length;
  };
  const realtimeRuntime: EventStreamRuntime = {
    service: realtimeService,
    closeAll: () => {
      closeClients(() => true);
      realtimeService.closeAll();
    },
    registerClient: (client) => {
      realtimeClients.add(client);
      return () => { realtimeClients.delete(client); };
    },
    closeViewer: (campaignId, viewer) => closeClients((client) => (
      client.campaignId === campaignId
      && client.viewer.role === viewer.role
      && client.viewer.playerId === viewer.playerId
    )),
    revokeSession: (internalSessionId) => closeClients((client) => client.authorityBinding?.internalSessionId === internalSessionId),
    revokeUser: (userId) => closeClients((client) => client.authorityBinding?.userId === userId),
    closeAllForMaintenance: () => closeClients(() => true),
  };

  const identity = new IdentityService(database, {
    ...testOptions.identityOptions,
    revocationNotifier: testOptions.identityOptions?.revocationNotifier ?? realtimeRuntime,
  });
  const campaigns = new CampaignService(database);
  const characters = new CharacterService(database);
  const worldFacts = new WorldFactService(database);
  // TurnService 依赖 EventPublisherPort 端口；composition root 注入 concrete OutboxRepository（与业务同 tx 写 outbox）。
  const turns = new TurnService(database, new OutboxRepository(database));
  app.use(createSessionMiddleware(identity));
  app.use('/api/auth', createAuthRouter(identity));
  app.use('/api/campaigns', createCampaignRouter(database, campaigns));
  // 角色路由挂在 campaign-scoped 前缀下，与现有 /api/campaigns list/create/join 互不影响。
  app.use('/api/campaigns/:campaignId/characters', createCharacterRouter(database, characters));
  // 世界事实路由同样挂在 campaign-scoped 前缀下。
  app.use('/api/campaigns/:campaignId/world', createWorldRouter(database, worldFacts));
  // 回合路由挂在 campaign-scoped 前缀下；owner/player 权限由 service 在事务内 enforce。
  app.use('/api/campaigns/:campaignId/turns', createTurnRouter(database, turns));
  // 存档路由同样挂在 campaign-scoped 前缀下；owner-only 权限由 service 在事务内 enforce。
  const archives = new ArchiveService(database, new OutboxRepository(database));
  app.use('/api/campaigns/:campaignId/archives', createArchiveRouter(database, archives));
  // 结构化战斗：HTTP 写命令 owner-only；players 只读投影；AI 经 CombatAiAdapter 同端口。
  const combat = new CombatService(database, new OutboxRepository(database));
  app.use('/api/campaigns/:campaignId/combat', createCombatRouter(database, combat));
  // Shared runtime: requests bind the authoritative session tuple before headers are flushed.
  app.use('/api/campaigns/:campaignId/events', createEventRouter(database, realtimeRuntime, {
    pollIntervalMs: testOptions.realtimePollIntervalMs,
    heartbeatIntervalMs: testOptions.realtimeHeartbeatIntervalMs,
  }));
  // AI 路由同样挂在 campaign-scoped 前缀下：WebUI 配置按战役加密保存并由动态 facade
  // 每次 run 解析，保存后无需重启立即生效；未保存时安全回退到 env/injected Provider。
  const fallbackAiProvider = options.aiProvider ?? new UnavailableAiProvider();
  const aiProviderConfig = new AiProviderConfigService(database, {
    fallbackProvider: fallbackAiProvider,
    credentialCipher: options.credentialCipher,
    fetchImpl: testOptions.providerFetch,
    providerFactory: testOptions.configuredAiProviderFactory,
  });
  const aiProvider = new CampaignScopedAiProvider(aiProviderConfig);
  const ai = new AiResolutionService(
    database, aiProvider, new OutboxRepository(database), archives,
    new AiContextBuilder(database),
    new TurnResolutionValidator(database),
    // Combat state changes use the same whitelisted command port and formal apply transaction.
    new StateChangeMaterializer(database, new CombatAiAdapter(combat, new CombatRepository(database))),
  );
  app.use('/api/campaigns/:campaignId/ai', createAiRouter(database, ai, aiProviderConfig));
  // The outbox worker is composed with the same campaign-scoped Provider facade
  // and resolver instance as HTTP, but startup owns its lifecycle.
  const narrativeWorkRuntime = new NarrativeWorkRuntime(
    database,
    new NarrativeWorkCoordinator(database, new OutboxRepository(database)),
    ai,
    testOptions.narrativeWorkPollIntervalMs,
  );

  // 统一错误中间件：注册在所有平台路由之后、404 之前，处理一切已挂载 route 的错误。
  app.use(errorMiddleware);

  // 兜底 404：未匹配的 API 路径（含已删除的 legacy /api/admin、/api/player、/events）返回
  // 安全 JSON（而非 Express 默认 HTML），不向客户端泄漏任何路由/框架信息。
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } });
  });

  return { app, realtimeRuntime, narrativeWorkRuntime };
}
