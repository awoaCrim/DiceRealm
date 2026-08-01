import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { createSqliteDatabase } from '../platform/database/SqliteDatabaseAdapter.js';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';

interface StartedApp {
  baseUrl: string;
  close: () => Promise<void>;
}

/** 启动一个带平台路由的完整 HTTP 服务器（真实 SQLite 内存库）。 */
async function startPlatformServer(): Promise<StartedApp> {
  const raw = createMemoryDb();
  migrate(raw);
  const platformDb = createSqliteDatabase(undefined, { reuseRaw: raw });
  await platformDb.migrate();
  const app = createApp(raw, { platformDb });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface AuthResult {
  user: { userId: string; login: string };
  sessionId: string;
  cookies: Record<string, string>;
}

async function registerAndLogin(baseUrl: string, login: string, password = 'correct-password'): Promise<AuthResult> {
  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });
  expect(registerRes.status).toBe(201);
  const registerBody = (await registerRes.json()) as { user: { userId: string; login: string } };

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });
  expect(loginRes.status).toBe(200);
  const loginBody = (await loginRes.json()) as { session: { sessionId: string } };
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('dnd_session=');

  return {
    user: registerBody.user,
    sessionId: loginBody.session.sessionId,
    cookies: parseSetCookie(setCookie),
  };
}

function parseSetCookie(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(',')) {
    const match = part.match(/^([^=]+)=([^;]*)/);
    if (match) {
      cookies[match[1].trim()] = match[2].trim();
    }
  }
  return cookies;
}

describe('auth routes over HTTP', () => {
  it('registers, logs in, reads me, and logs out', async () => {
    const server = await startPlatformServer();
    try {
      const { cookies, sessionId } = await registerAndLogin(server.baseUrl, 'alice@example.test');

      const meRes = await fetch(`${server.baseUrl}/api/auth/me`, {
        headers: { cookie: `dnd_session=${cookies.dnd_session}` },
      });
      expect(meRes.status).toBe(200);
      const meBody = (await meRes.json()) as { user: { login: string } };
      expect(meBody.user.login).toBe('alice@example.test');

      const logoutRes = await fetch(`${server.baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: `dnd_session=${cookies.dnd_session}` },
      });
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.headers.get('set-cookie')).toContain('dnd_session=');

      // 注销后 session 失效。
      const after = await fetch(`${server.baseUrl}/api/auth/me`, {
        headers: { cookie: `dnd_session=${sessionId}` },
      });
      expect(after.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('rejects login with a wrong password as AUTH_REQUIRED', async () => {
    const server = await startPlatformServer();
    try {
      await registerAndLogin(baseUrlOf(server), 'bob@example.test', 'correct-password');
      const res = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: 'bob@example.test', password: 'wrong-password' }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('AUTH_REQUIRED');
      expect(typeof body.error.message).toBe('string');
    } finally {
      await server.close();
    }
  });

  it('rejects /me without a session as AUTH_REQUIRED with the contract error body', async () => {
    const server = await startPlatformServer();
    try {
      const res = await fetch(`${server.baseUrl}/api/auth/me`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('AUTH_REQUIRED');
      expect(typeof body.error.message).toBe('string');
    } finally {
      await server.close();
    }
  });

  it('rejects a short password at register with VALIDATION_ERROR (400)', async () => {
    const server = await startPlatformServer();
    try {
      const res = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: 'shortpw@example.test', password: 'short' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('密码长度');
    } finally {
      await server.close();
    }
  });

  it('never exposes the raw error message for unknown internal errors', async () => {
    const server = await startPlatformServer();
    try {
      // 畸形 JSON 由 body-parser 抛出 SyntaxError（status=400），错误中间件收敛为契约错误。
      const res = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad json',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toBe('请求参数无效');
      expect(JSON.stringify(body)).not.toContain('SyntaxError');
      expect(JSON.stringify(body)).not.toContain('bad json');
    } finally {
      await server.close();
    }
  });

  it('supports Bearer-token authenticated /api/auth/me', async () => {
    const server = await startPlatformServer();
    try {
      const { sessionId } = await registerAndLogin(baseUrlOf(server), 'carol@example.test');
      const res = await fetch(`${server.baseUrl}/api/auth/me`, {
        headers: { authorization: `Bearer ${sessionId}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { login: string } };
      expect(body.user.login).toBe('carol@example.test');
    } finally {
      await server.close();
    }
  });
});

describe('campaign routes over HTTP', () => {
  it('creates, lists, joins, and enforces owner-only settings', async () => {
    const server = await startPlatformServer();
    try {
      const { baseUrl } = server;
      const owner = await registerAndLogin(baseUrl, 'owner@example.test');
      const player = await registerAndLogin(baseUrl, 'player@example.test');
      const newcomer = await registerAndLogin(baseUrl, 'newcomer@example.test');

      const ownerCookie = `dnd_session=${owner.cookies.dnd_session}`;
      const playerCookie = `dnd_session=${player.cookies.dnd_session}`;

      const createRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ownerCookie },
        body: JSON.stringify({ name: '矿坑', ruleset: 'dnd5e' }),
      });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { campaign: { id: string; name: string; ownerId: string }; inviteCode: string };
      expect(createBody.campaign.name).toBe('矿坑');
      expect(createBody.inviteCode).toBeTruthy();

      // 未登录不能访问。
      const unauthList = await fetch(`${baseUrl}/api/campaigns`);
      expect(unauthList.status).toBe(401);

      const listRes = await fetch(`${baseUrl}/api/campaigns`, { headers: { cookie: ownerCookie } });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { campaigns: Array<{ id: string; role: string }> };
      expect(listBody.campaigns).toHaveLength(1);
      expect(listBody.campaigns[0].role).toBe('owner');

      // player 用创建响应返回的 raw invite code 加入。
      const inviteCode = createBody.inviteCode;
      const joinRes = await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: playerCookie },
        body: JSON.stringify({ inviteCode }),
      });
      expect(joinRes.status).toBe(201);
      const joinBody = (await joinRes.json()) as { member: { role: string } };
      expect(joinBody.member.role).toBe('player');

      // player 越权更新设置 → FORBIDDEN。
      const forbiddenRes = await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: playerCookie },
        body: JSON.stringify({ name: 'nope' }),
      });
      expect(forbiddenRes.status).toBe(403);
      const forbiddenBody = (await forbiddenRes.json()) as { error: { code: string; message: string } };
      expect(forbiddenBody.error).toMatchObject({ code: 'FORBIDDEN', message: '你没有权限执行此操作。' });

      // owner 更新设置成功。
      const settingsRes = await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: ownerCookie },
        body: JSON.stringify({ name: '矿坑·新名' }),
      });
      expect(settingsRes.status).toBe(200);
      const settingsBody = (await settingsRes.json()) as { campaign: { name: string } };
      expect(settingsBody.campaign.name).toBe('矿坑·新名');

      // 错误邀请码 → CAMPAIGN_NOT_FOUND（用一个尚未加入的新用户）。
      const badInvite = await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `dnd_session=${newcomer.cookies.dnd_session}` },
        body: JSON.stringify({ inviteCode: 'wrong' }),
      });
      expect(badInvite.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('does not leak the invite code inside the campaign view', async () => {
    const server = await startPlatformServer();
    try {
      const owner = await registerAndLogin(baseUrlOf(server), 'owner2@example.test');
      const ownerCookie = `dnd_session=${owner.cookies.dnd_session}`;
      const createRes = await fetch(`${server.baseUrl}/api/campaigns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ownerCookie },
        body: JSON.stringify({ name: '秘密战役', ruleset: 'dnd5e' }),
      });
      const createBody = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };
      expect(createBody.inviteCode).toBeTruthy();
      const viewRes = await fetch(`${server.baseUrl}/api/campaigns/${createBody.campaign.id}`, {
        headers: { cookie: ownerCookie },
      });
      expect(viewRes.status).toBe(200);
      const viewText = await viewRes.text();
      expect(viewText).not.toContain('invite');
      expect(viewText).not.toContain('inviteCode');
      expect(viewText).not.toContain(createBody.inviteCode);
    } finally {
      await server.close();
    }
  });

  it('returns a safe JSON 404 for unmatched /api paths (no HTML)', async () => {
    const server = await startPlatformServer();
    try {
      const res = await fetch(`${server.baseUrl}/api/auth/does-not-exist`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') ?? '').toContain('application/json');
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error).toMatchObject({ code: 'NOT_FOUND', message: '接口不存在。' });
      const text = await (await fetch(`${server.baseUrl}/api/nonexistent-route`)).text();
      expect(text.toLowerCase()).not.toContain('<html');
    } finally {
      await server.close();
    }
  });
});

function baseUrlOf(server: StartedApp): string {
  return server.baseUrl;
}
