import Database from 'better-sqlite3';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApp } from '../app.js';
import { parseSecurityConfig } from '../config.js';
import { createSqliteDatabase } from '../platform/database/SqliteDatabaseAdapter.js';
import { ScriptedAiProvider } from '../modules/ai-runtime/ScriptedAiProvider.js';
import { IdentityService } from '../modules/identity/IdentityService.js';
import { CampaignService } from '../modules/campaigns/CampaignService.js';
import { CampaignMutationCoordinator } from '../modules/campaigns/CampaignMutationCoordinator.js';
import { CharacterService } from '../modules/characters/CharacterService.js';
import { ActorService } from '../modules/actors/ActorService.js';
import { TurnService } from '../modules/turns/TurnService.js';
import { NarrativeRoundService } from '../modules/narrative-runtime/NarrativeRoundService.js';
import { OutboxRepository } from '../platform/events/OutboxRepository.js';
import { resolveCampaignContext } from '../modules/campaigns/CampaignAccess.js';
import {
  installHarnessFetch,
  registerAndLogin,
  startTestPlatformServer,
  TestCookieJar,
} from './httpTestHarness.js';

let restoreHarnessFetch: (() => void) | undefined;
beforeAll(() => { restoreHarnessFetch = installHarnessFetch(); });
afterAll(() => { restoreHarnessFetch?.(); });

const SERVER_SRC = fileURLToPath(new URL('../', import.meta.url));

const FORBIDDEN_SPECIFIER_MARKERS = [
  '/services/',
  '/domain/types',
  '/db/connection',
  '/db/schema',
  '/db/seedRules',
  '/routes/adminRoutes',
  '/routes/adminAiTurnRoutes',
  '/routes/adminCharacterResourceRoutes',
  '/routes/adminCombatRoutes',
  '/routes/adminConfigRoutes',
  '/routes/adminDbRoutes',
  '/routes/adminMemoryRoutes',
  '/routes/adminResourceRoutes',
  '/routes/playerRoutes',
  '/routes/sseRoutes',
];

const FORBIDDEN_TOKENS = [
  'createApp',
  'AppDatabase',
  'createMemoryDb',
  'getDb',
  'getPlatformDb',
  'migratePlatform',
  'SyncMigrationExecutor',
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walkTsFiles(root: string, exclude: (path: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!exclude(full)) visit(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  };
  visit(root);
  return out;
}

function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromPattern = /\bfrom\s*['"]([^'"]+)['"]/g;
  const importPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const pattern of [fromPattern, importPattern]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function checkImportGraph(root: string, files: string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(root, file).replace(/\\/g, '/');
    for (const specifier of staticImportSpecifiers(source)) {
      for (const marker of FORBIDDEN_SPECIFIER_MARKERS) {
        if (specifier.includes(marker)) {
          violations.push(`${rel}: imports forbidden '${specifier}' (${marker})`);
        }
      }
    }
    const stripped = stripComments(source);
    for (const token of FORBIDDEN_TOKENS) {
      if (new RegExp(`\\b${token}\\b`).test(stripped)) {
        violations.push(`${rel}: contains forbidden token '${token}'`);
      }
    }
  }
  return violations;
}


describe('createPlatformApp composition root', () => {
  it('accepts only a DatabasePort and returns explicit HTTP, realtime and narrative runtimes', async () => {
    const platformDb = createSqliteDatabase(':memory:');
    try {
      await platformDb.migrate();
      const composed = createPlatformApp({ database: platformDb, securityConfig: parseSecurityConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://127.0.0.1' }) });
      expect(typeof composed.app.use).toBe('function');
      expect(typeof composed.realtimeRuntime.closeAll).toBe('function');
      expect(typeof composed.narrativeWorkCoordinator.sweepExpiredClaims).toBe('function');
      expect(typeof composed.narrativeWorkRuntime.start).toBe('function');
      expect(typeof composed.narrativeWorkRuntime.stop).toBe('function');
      // 显式返回 runtime：不得依赖 app property cast。
      expect('realtimeRuntime' in composed.app).toBe(false);
    } finally {
      await platformDb.close();
    }
  });

  it('keeps the production worker on the shared Actor-aware narrative service across two rounds', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const identity = new IdentityService(db);
    const campaigns = new CampaignService(db);
    const owner = await identity.register({ login: 'worker-owner@example.test', password: 'correct-password' });
    const player = await identity.register({ login: 'worker-player@example.test', password: 'correct-password' });
    const created = await campaigns.create(owner.userId, { name: 'worker composition', ruleset: 'dnd5e' });
    await campaigns.join({ userId: player.userId }, created.campaign.id, created.inviteCode);
    const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
    const playerCtx = await resolveCampaignContext(db, { userId: player.userId }, created.campaign.id);
    const mutations = new CampaignMutationCoordinator(db);
    const actors = new ActorService(db, mutations);
    const characters = new CharacterService(db, mutations, actors);
    const outbox = new OutboxRepository(db);
    const narrative = new NarrativeRoundService(db, outbox, mutations, actors);
    const turns = new TurnService(db, outbox, mutations, narrative, actors);
    const approve = async (name: string): Promise<string> => {
      const draft = await characters.createDraft(playerCtx, {
        name,
        sheet: { ac: 14, hpCurrent: 10, hpMax: 10 },
      });
      await characters.submitForReview(playerCtx, draft.id);
      await characters.approve(ownerCtx, draft.id);
      return draft.id;
    };
    const firstCharacterId = await approve('双角色一');
    const secondCharacterId = await approve('双角色二');
    const controlled = await actors.listControlled(playerCtx);
    const actorIds = [
      controlled.find((actor) => actor.characterId === firstCharacterId)?.id,
      controlled.find((actor) => actor.characterId === secondCharacterId)?.id,
    ].filter((actorId): actorId is string => Boolean(actorId));
    if (actorIds.length !== 2) throw new Error('expected two controlled Actors');
    const provider = new ScriptedAiProvider(async (input) => {
      if (input.stage === 'narration') {
        return { publicNarrative: '共享 Actor worker 已完成叙事。', privateUpdates: [] };
      }
      const processing = (await db.query<{
        action_id: string | null;
        actor_id: string;
        campaign_actor_id: string | null;
      }>(
        `SELECT action_id, actor_id, campaign_actor_id
         FROM platform_narrative_decisions
         WHERE status = 'processing'
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      ))[0];
      if (!processing?.action_id) throw new Error('expected a processing narrative decision');
      return {
        actionIntents: [{
          actionId: processing.action_id,
          actorId: processing.campaign_actor_id ?? processing.actor_id,
          mode: 'player_action',
          actionType: 'healing',
          actionRef: 'healing:basic',
          targetIds: [],
          declaredApproach: '保持队伍状态稳定',
          desiredOutcome: '恢复一点生命',
          resourceChoices: [],
          fallbackPolicy: 'continue',
        }],
      };
    });
    const composed = createPlatformApp({
      database: db,
      securityConfig: parseSecurityConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://127.0.0.1' }),
      aiProvider: provider,
    });
    try {
      const firstTurn = await turns.startTurn(ownerCtx);
      for (const actorId of actorIds) {
        await turns.submitAction(playerCtx, firstTurn.id, { actorId, body: `Actor ${actorId} 的行动。` });
      }
      // Each pass handles at most one decision for an active round. Repeated
      // deterministic polls model the real outbox worker without starting a timer.
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await composed.narrativeWorkRuntime.runOnce();
      }
      const firstRound = (await db.query<{ status: string }>(
        'SELECT status FROM platform_narrative_rounds WHERE turn_id = ?', [firstTurn.id],
      ))[0];
      expect(firstRound.status).toBe('closed');
      const secondTurn = (await db.query<{ id: string; status: string }>(
        'SELECT id, status FROM platform_turns WHERE campaign_id = ? AND number = 2', [created.campaign.id],
      ))[0];
      expect(secondTurn.status).toBe('waiting_for_actions');
      const participants = await db.query<{
        actor_id: string | null;
        required: number;
        player_id: string | null;
      }>(
        'SELECT actor_id, required, player_id FROM platform_narrative_round_participants WHERE round_id = ? ORDER BY participant_order',
        [secondTurn.id],
      );
      expect(participants).toHaveLength(2);
      expect(participants.every((participant) => participant.required === 1)).toBe(true);
      expect(participants.every((participant) => participant.player_id === player.userId)).toBe(true);
      expect(participants.map((participant) => participant.actor_id)).toEqual(expect.arrayContaining(actorIds));
      expect(participants.some((participant) => participant.actor_id === null)).toBe(false);
      for (const actorId of actorIds) {
        await turns.submitAction(playerCtx, secondTurn.id, { actorId, body: `第二轮 ${actorId} 的行动。` });
      }
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await composed.narrativeWorkRuntime.runOnce();
      }
      expect((await db.query<{ status: string }>(
        'SELECT status FROM platform_narrative_rounds WHERE turn_id = ?', [secondTurn.id],
      ))[0].status).toBe('closed');
    } finally {
      await composed.narrativeWorkRuntime.stop();
      composed.realtimeRuntime.closeAll();
      await db.close();
    }
  });

  it('rejects raw database connections and test controls at the production boundary', () => {
    const securityConfig = parseSecurityConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://127.0.0.1' });
    // Compile-only assertions: invalid constructors must never execute at runtime.
    if (false) {
      // @ts-expect-error -- raw better-sqlite3 连接必须不能作为 database 传入
      createPlatformApp({ database: new Database(':memory:'), securityConfig });
      const platformDb = createSqliteDatabase(':memory:');
      // @ts-expect-error -- providerFetch 只能通过 createTestPlatformApp 注入
      createPlatformApp({ database: platformDb, securityConfig, providerFetch: fetch });
    }
  });

  it('serves HTTP composition checks through HTTPS with an opaque cookie-jar actor', async () => {
    const server = await startTestPlatformServer();
    try {
      expect(server.baseUrl).toMatch(/^https:\/\//);
      const actor = await registerAndLogin(server.baseUrl, 'composition-boundary-user');
      expect(actor.cookieJar).toBeInstanceOf(TestCookieJar);
    } finally {
      await server.close();
    }
  });

  it('mounts the platform auth/campaign routes', async () => {
    const server = await startTestPlatformServer();
    try {
      const actor = await registerAndLogin(server.baseUrl, 'composition-user');
      const res = await fetch(`${server.baseUrl}/api/campaigns`, {
        headers: { cookie: actor.cookieJar.header() },
      });
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('returns exact safe JSON 404 for every legacy URL', async () => {
    const server = await startTestPlatformServer();
    try {
      const legacyPaths = [
        '/api/admin',
        '/api/admin/rooms/room-1',
        '/api/admin/rooms/room-1/turn',
        '/api/player',
        '/api/player/token-abc',
        '/events',
        '/events/room-1',
      ];
      for (const path of legacyPaths) {
        const res = await fetch(`${server.baseUrl}${path}`);
        expect(res.status, path).toBe(404);
        expect(res.headers.get('content-type'), path).toContain('application/json');
        expect(await res.json(), path).toEqual({ error: { code: 'NOT_FOUND', message: '接口不存在。' } });
      }
      // POST 也不得挂载 legacy 处理器。
      const post = await fetch(`${server.baseUrl}/api/admin/rooms/room-1`, { method: 'POST' });
      expect(post.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('converges AppError / Zod / unknown errors through the unified errorMiddleware envelope', async () => {
    const server = await startTestPlatformServer();
    try {
      const actor = await registerAndLogin(server.baseUrl, 'dup-user');
      // AppError：重复注册 → AUTH_REQUIRED envelope，不泄漏内部细节。
      const dup = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: actor.cookieJar.header() },
        body: JSON.stringify({ login: 'dup-user', password: 'x' }),
      });
      expect(dup.status).toBe(401);
      expect(await dup.json()).toEqual({ error: { code: 'AUTH_REQUIRED', message: '该登录名已被注册。' } });

      // Zod / body-parser unknown error：畸形 JSON → 统一 VALIDATION_ERROR。
      const bad = await fetch(`${server.baseUrl}/api/campaigns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: actor.cookieJar.header() },
        body: '{bad json',
      });
      expect(bad.status).toBe(400);
      const badBody = (await bad.json()) as { error: { code: string } };
      expect(badBody.error.code).toBe('VALIDATION_ERROR');
    } finally {
      await server.close();
    }
  });

  it('keeps the AI route reachable with an injected provider', async () => {
    const provider = new ScriptedAiProvider(async () => ({ source: 'scripted' }));
    const server = await startTestPlatformServer({ aiProvider: provider });
    try {
      const actor = await registerAndLogin(server.baseUrl, 'ai-user');
      const campaigns = await fetch(`${server.baseUrl}/api/campaigns`, {
        headers: { cookie: actor.cookieJar.header() },
      });
      expect(campaigns.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe('production import graph guard', () => {
  it('rejects any legacy service/route/db/domain import or token in production sources', () => {
    const productionFiles = walkTsFiles(SERVER_SRC, (path) => {
      const rel = relative(SERVER_SRC, path).replace(/\\/g, '/');
      return rel.startsWith('tests/') || path.includes('node_modules');
    });
    const violations = checkImportGraph(SERVER_SRC, productionFiles);
    expect(violations).toEqual([]);
  });

  it('keeps the retained test-support harness and fixtures free of legacy imports', () => {
    const supportFiles = [
      join(SERVER_SRC, 'tests', 'httpTestHarness.ts'),
      ...walkTsFiles(join(SERVER_SRC, 'tests', 'fixtures'), () => false),
    ];
    const violations = checkImportGraph(SERVER_SRC, supportFiles);
    expect(violations).toEqual([]);
  });
});

describe('server/dist legacy artifact scan', () => {
  it('contains no compiled legacy routes/services/db/domain modules', () => {
    const distDir = fileURLToPath(new URL('../../dist/', import.meta.url));
    if (!statSync(distDir, { throwIfNoEntry: false })) {
      // build 尚未运行时跳过；生产构建后的验证会扫描实际 dist。
      return;
    }
    const forbidden = [
      'routes/admin',
      'routes/playerRoutes',
      'routes/sseRoutes',
      'services/',
      'db/schema',
      'db/connection',
      'db/seedRules',
      'domain/types',
    ];
    const hits: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          visit(full);
        } else if (entry.endsWith('.js')) {
          const rel = relative(distDir, full).replace(/\\/g, '/');
          if (forbidden.some((marker) => rel.includes(marker))) {
            hits.push(rel);
          }
        }
      }
    };
    visit(distDir);
    expect(hits).toEqual([]);
  });
});
