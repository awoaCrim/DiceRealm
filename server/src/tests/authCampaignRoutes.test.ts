import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { installHarnessFetch, jsonHeaders, registerAndLogin, startTestPlatformServer } from './httpTestHarness.js';

let restoreHarnessFetch: (() => void) | undefined;
beforeAll(() => { restoreHarnessFetch = installHarnessFetch(); });
afterAll(() => { restoreHarnessFetch?.(); });

async function setMaintenanceState(
  database: { execute(sql: string, params?: unknown[]): Promise<{ changes: number }> },
  state: 'active' | 'draining' | 'quiescent',
): Promise<void> {
  const now = new Date().toISOString();
  await database.execute(
    `INSERT INTO platform_instance
       (singleton_id, database_id, enrollment_state, credential_key_fingerprint, enrollment_key_origin,
        maintenance_state, maintenance_epoch, platform_rules_revision, session_security_state,
        session_security_cutover_at, created_at, updated_at)
     VALUES (1, 'http-test-db', 'ready', ?, 'preexisting', ?, 1, 0, 'ready', ?, ?, ?)`,
    [`sha256:${'0'.repeat(64)}`, state, now, now, now],
  );
}

describe('auth routes over HTTP', () => {
  it('uses exact secure cookie-only auth and never exposes raw session material', async () => {
    const server = await startTestPlatformServer();
    try {
      const register = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: 'cookie-contract@example.test', password: 'correct-password' }),
      });
      expect(register.status).toBe(201);
      const login = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: 'cookie-contract@example.test', password: 'correct-password' }),
      });
      const bodyText = await login.text();
      expect(bodyText).toMatch(/^\{"session":\{"expiresAt":"[^"]+"\}\}$/);
      expect(bodyText).not.toContain('sessionId');
      const cookies = login.headers.getSetCookie();
      expect(cookies).toHaveLength(2);
      expect(cookies[0]).toMatch(/^__Host-dnd_session=[A-Za-z0-9_-]{43}; Max-Age=604800; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$/);
      expect(cookies[1]).toMatch(/^__Host-dnd_csrf=[A-Za-z0-9_-]{43}; Max-Age=604800; Path=\/; Expires=[^;]+; Secure; SameSite=Lax$/);
      expect(cookies.join(';')).not.toContain('Domain=');
      expect(bodyText).not.toContain('__Host-dnd_session=');

      const bearerToken = /__Host-dnd_session=([^;]+)/.exec(cookies[0])![1];
      const bearer = await fetch(`${server.baseUrl}/api/auth/me`, {
        headers: { authorization: `Bearer ${bearerToken}` },
      });
      expect(bearer.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('quiescent /me with an existing CSRF cookie performs zero session or audit writes', async () => {
    const server = await startTestPlatformServer();
    try {
      const actor = await registerAndLogin(server.baseUrl, 'quiescent-existing-csrf@example.test');
      await setMaintenanceState(server.platformDb, 'quiescent');
      const beforeSession = await server.platformDb.query('SELECT * FROM sessions');
      const beforeAudit = await server.platformDb.query('SELECT * FROM platform_security_audit_events');

      const response = await fetch(`${server.baseUrl}/api/auth/me`, { headers: { cookie: actor.cookieJar.header() } });

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await server.platformDb.query('SELECT * FROM sessions')).toEqual(beforeSession);
      expect(await server.platformDb.query('SELECT * FROM platform_security_audit_events')).toEqual(beforeAudit);
    } finally {
      await server.close();
    }
  });

  it('quiescent /me with missing CSRF changes only csrf_digest', async () => {
    const server = await startTestPlatformServer();
    try {
      const actor = await registerAndLogin(server.baseUrl, 'quiescent-missing-csrf@example.test');
      actor.cookieJar.delete('__Host-dnd_csrf');
      await setMaintenanceState(server.platformDb, 'quiescent');
      const before = (await server.platformDb.query<{
        id: string; csrf_digest: string; last_seen_at: string; idle_expires_at: string;
        revoked_at: string | null; revoke_epoch: number;
      }>('SELECT id, csrf_digest, last_seen_at, idle_expires_at, revoked_at, revoke_epoch FROM sessions'))[0];
      const beforeAudit = await server.platformDb.query('SELECT * FROM platform_security_audit_events');

      const response = await fetch(`${server.baseUrl}/api/auth/me`, { headers: { cookie: actor.cookieJar.header() } });
      actor.cookieJar.absorb(response);
      const next = (await server.platformDb.query<{
        id: string; csrf_digest: string; last_seen_at: string; idle_expires_at: string;
        revoked_at: string | null; revoke_epoch: number;
      }>('SELECT id, csrf_digest, last_seen_at, idle_expires_at, revoked_at, revoke_epoch FROM sessions'))[0];

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(actor.cookieJar.peek('__Host-dnd_csrf')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(next.csrf_digest).not.toBe(before.csrf_digest);
      expect({ ...next, csrf_digest: before.csrf_digest }).toEqual(before);
      expect(await server.platformDb.query('SELECT * FROM platform_security_audit_events')).toEqual(beforeAudit);
    } finally {
      await server.close();
    }
  });

  it('recovers a missing CSRF cookie on /me with conditional digest rotation', async () => {
    const server = await startTestPlatformServer();
    try {
      const actor = await registerAndLogin(server.baseUrl, 'csrf-recovery@example.test');
      const oldCsrf = actor.cookieJar.peek('__Host-dnd_csrf');
      actor.cookieJar.delete('__Host-dnd_csrf');
      const first = await fetch(`${server.baseUrl}/api/auth/me`, { headers: { cookie: actor.cookieJar.header() } });
      expect(first.status).toBe(200);
      expect(first.headers.get('cache-control')).toBe('no-store');
      const cachedBeforeRotation = `${actor.cookieJar.header()}; __Host-dnd_csrf=${oldCsrf}`;
      actor.cookieJar.absorb(first);
      const nextCsrf = actor.cookieJar.peek('__Host-dnd_csrf');
      expect(nextCsrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(nextCsrf).not.toBe(oldCsrf);
      const rows = await server.platformDb.query<{ csrf_digest: string }>('SELECT csrf_digest FROM sessions');
      expect(rows[0].csrf_digest).toBe(createHash('sha256').update(nextCsrf).digest('hex'));
      expect(rows[0].csrf_digest).not.toBe(createHash('sha256').update(oldCsrf).digest('hex'));

      const oldLogout = await fetch(`${server.baseUrl}/api/auth/logout`, {
        method: 'POST', headers: { cookie: cachedBeforeRotation, 'x-csrf-token': oldCsrf },
      });
      expect(oldLogout.status).toBe(403);
      const newLogout = await fetch(`${server.baseUrl}/api/auth/logout`, {
        method: 'POST', headers: { cookie: actor.cookieJar.header(), 'x-csrf-token': nextCsrf },
      });
      expect(newLogout.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('logout-all invalidates both devices, clears exact cookies, and advances revisions and epochs', async () => {
    const server = await startTestPlatformServer();
    try {
      const first = await registerAndLogin(server.baseUrl, 'logout-all@example.test');
      const login = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: 'logout-all@example.test', password: 'correct-password' }),
      });
      const secondJar = new (await import('./httpTestHarness.js')).TestCookieJar();
      secondJar.absorb(login);

      const response = await fetch(`${server.baseUrl}/api/auth/logout-all`, {
        method: 'POST',
        headers: { cookie: first.cookieJar.header(), 'x-csrf-token': first.cookieJar.peek('__Host-dnd_csrf') },
      });
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([
        expect.stringMatching(/^__Host-dnd_session=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax$/),
        expect.stringMatching(/^__Host-dnd_csrf=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax$/),
      ]);
      expect(response.headers.getSetCookie().join(';')).not.toContain('Domain=');
      await expect(fetch(`${server.baseUrl}/api/auth/me`, { headers: { cookie: first.cookieJar.header() } }).then((res) => res.status)).resolves.toBe(401);
      await expect(fetch(`${server.baseUrl}/api/auth/me`, { headers: { cookie: secondJar.header() } }).then((res) => res.status)).resolves.toBe(401);
      expect((await server.platformDb.query<{ auth_revision: number }>('SELECT auth_revision FROM users WHERE id = ?', [first.userId]))[0].auth_revision).toBe(1);
      expect(await server.platformDb.query<{ revoke_epoch: number; revoked: number }>(
        'SELECT revoke_epoch, revoked_at IS NOT NULL AS revoked FROM sessions ORDER BY id',
      )).toEqual([{ revoke_epoch: 1, revoked: 1 }, { revoke_epoch: 1, revoked: 1 }]);
    } finally {
      await server.close();
    }
  });

  it('pins exact clear-cookie deletion attributes for current logout', async () => {
    const server = await startTestPlatformServer();
    try {
      const actor = await registerAndLogin(server.baseUrl, 'clear-cookie@example.test');
      const response = await fetch(`${server.baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: actor.cookieJar.header(), 'x-csrf-token': actor.cookieJar.peek('__Host-dnd_csrf') },
      });
      expect(response.headers.getSetCookie()).toEqual([
        '__Host-dnd_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
        '__Host-dnd_csrf=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax',
      ]);
      expect(response.headers.getSetCookie().join(';')).not.toContain('Max-Age=604800');
      expect(response.headers.getSetCookie().join(';')).not.toContain('Domain=');
    } finally {
      await server.close();
    }
  });

  it('registers, logs in, reads me, and logs out', async () => {
    const server = await startTestPlatformServer();
    try {
      const { cookieJar } = await registerAndLogin(server.baseUrl, 'alice@example.test');

      const meRes = await fetch(`${server.baseUrl}/api/auth/me`, {
        headers: { cookie: cookieJar.header() },
      });
      expect(meRes.status).toBe(200);
      const meBody = (await meRes.json()) as { user: { login: string } };
      expect(meBody.user.login).toBe('alice@example.test');

      const logoutRes = await fetch(`${server.baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: cookieJar.header(), 'x-csrf-token': cookieJar.peek('__Host-dnd_csrf') },
      });
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.headers.getSetCookie()).toEqual(expect.arrayContaining([
        expect.stringContaining('__Host-dnd_session='),
        expect.stringContaining('__Host-dnd_csrf='),
      ]));

      // 注销后 session 失效。
      const after = await fetch(`${server.baseUrl}/api/auth/me`, {
        headers: { cookie: `__Host-dnd_session=${cookieJar.peek('__Host-dnd_session')}` },
      });
      expect(after.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('rejects login with a wrong password as AUTH_REQUIRED', async () => {
    const server = await startTestPlatformServer();
    try {
      await registerAndLogin(server.baseUrl, 'bob@example.test', 'correct-password');
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
    const server = await startTestPlatformServer();
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
    const server = await startTestPlatformServer();
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
    const server = await startTestPlatformServer();
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

  it('rejects Bearer-token authenticated /api/auth/me', async () => {
    const server = await startTestPlatformServer();
    try {
      const actor = await registerAndLogin(server.baseUrl, 'carol@example.test');
      const raw = actor.cookieJar.peek('__Host-dnd_session');
      const res = await fetch(`${server.baseUrl}/api/auth/me`, {
        headers: { authorization: `Bearer ${raw}` },
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe('campaign routes over HTTP', () => {
  it('creates, lists, joins, and enforces owner-only settings', async () => {
    const server = await startTestPlatformServer();
    try {
      const { baseUrl } = server;
      const owner = await registerAndLogin(baseUrl, 'owner@example.test');
      const player = await registerAndLogin(baseUrl, 'player@example.test');
      const newcomer = await registerAndLogin(baseUrl, 'newcomer@example.test');

      const ownerCookie = owner.cookieJar.header();
      const playerCookie = player.cookieJar.header();

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
        headers: { 'content-type': 'application/json', cookie: newcomer.cookieJar.header() },
        body: JSON.stringify({ inviteCode: 'wrong' }),
      });
      expect(badInvite.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('does not leak the invite code inside the campaign view', async () => {
    const server = await startTestPlatformServer();
    try {
      const owner = await registerAndLogin(server.baseUrl, 'owner2@example.test');
      const ownerCookie = owner.cookieJar.header();
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
    const server = await startTestPlatformServer();
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
