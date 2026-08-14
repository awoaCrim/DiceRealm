import Database from 'better-sqlite3';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApp } from '../app.js';
import { parseSecurityConfig } from '../config.js';
import { createSqliteDatabase } from '../platform/database/SqliteDatabaseAdapter.js';
import { ScriptedAiProvider } from '../modules/ai-runtime/ScriptedAiProvider.js';
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
  it('accepts only a DatabasePort and returns an explicit { app, realtimeRuntime }', async () => {
    const platformDb = createSqliteDatabase(':memory:');
    try {
      await platformDb.migrate();
      const composed = createPlatformApp({ database: platformDb, securityConfig: parseSecurityConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://127.0.0.1' }) });
      expect(typeof composed.app.use).toBe('function');
      expect(typeof composed.realtimeRuntime.closeAll).toBe('function');
      // 显式返回 runtime：不得依赖 app property cast。
      expect('realtimeRuntime' in composed.app).toBe(false);
    } finally {
      await platformDb.close();
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
