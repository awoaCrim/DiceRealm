import { expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import {
  createSqliteDatabase,
  type SqliteDatabaseAdapter,
} from '../platform/database/SqliteDatabaseAdapter.js';
import type { AiProviderPort } from '../modules/ai-runtime/AiProviderPort.js';

export interface StartedPlatform {
  baseUrl: string;
  /** 供验收测试直查数据库（如 outbox/world 行）。close() 会先关 server 再关 platformDb。 */
  platformDb: SqliteDatabaseAdapter;
  close: () => Promise<void>;
}

export interface TestActor {
  userId: string;
  sessionId: string;
  /** 可直接放入请求 header 的 Cookie 值，如 `dnd_session=abc`。 */
  cookieHeader: string;
}

/** 启动一个带平台路由的完整 HTTP 服务器（真实 SQLite 内存库）。 */
export async function startPlatformServer(options: { aiProvider?: AiProviderPort } = {}): Promise<StartedPlatform> {
  const raw = createMemoryDb();
  migrate(raw);
  const platformDb = createSqliteDatabase(undefined, { reuseRaw: raw });
  await platformDb.migrate();
  const app = createApp(raw, { platformDb, aiProvider: options.aiProvider });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    platformDb,
    close: async () => {
      // 先关闭 server（停止接受/处理请求），再关闭 platformDb；
      // platformDb.close() 会关闭它复用的 raw 连接（reuseRaw），只关一次，避免 double-close。
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } finally {
        await platformDb.close();
      }
    },
  };
}

/** 注册并登录，返回 userId/sessionId/cookieHeader。断言合并自两个既有测试（两者都应继续通过）。 */
export async function registerAndLogin(
  baseUrl: string,
  login: string,
  password = 'correct-password',
): Promise<TestActor> {
  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });
  expect(registerRes.status).toBe(201);
  const registerText = await registerRes.text();
  // 注册响应 DTO 不得包含密码哈希（vertical 既有断言）。
  expect(registerText).not.toContain('password_hash');
  expect(registerText).not.toContain('passwordHash');
  const registerBody = JSON.parse(registerText) as { user: { userId: string } };

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });
  expect(loginRes.status).toBe(200);
  const loginBody = (await loginRes.json()) as { session: { sessionId: string } };
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  // authCampaignRoutes 既有断言。
  expect(setCookie).toContain('dnd_session=');
  const match = /dnd_session=([^;]*)/.exec(setCookie);
  expect(match).toBeTruthy();
  return {
    userId: registerBody.user.userId,
    sessionId: loginBody.session.sessionId,
    cookieHeader: `dnd_session=${match![1]}`,
  };
}

export function jsonHeaders(cookieHeader: string) {
  return { 'content-type': 'application/json', cookie: cookieHeader };
}
