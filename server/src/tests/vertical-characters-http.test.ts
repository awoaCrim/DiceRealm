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

/**
 * 启动一个带平台路由的完整 HTTP 服务器（真实 SQLite 内存库）。
 * 测试全程使用内存 SQLite，不触碰真实 server/dnd.sqlite。
 */
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
    close: async () => {
      // 先关闭 server（停止接受/处理请求），再关闭 platformDb；
      // platformDb.close() 会关闭它复用的 raw 连接（reuseRaw），只关一次，避免 double-close。
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await platformDb.close();
    },
  };
}

interface Actor {
  /** 独立 cookie jar：完整 Cookie 头字符串。 */
  cookies: string;
  userId: string;
}

/** 注册（201）并登录（200），解析 HttpOnly dnd_session cookie，返回独立 cookie jar。 */
async function registerAndLogin(baseUrl: string, login: string, password = 'correct-password'): Promise<Actor> {
  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });
  expect(registerRes.status).toBe(201);
  const registerText = await registerRes.text();
  // 注册响应 DTO 不得包含密码哈希。
  expect(registerText).not.toContain('password_hash');
  expect(registerText).not.toContain('passwordHash');
  const registerBody = JSON.parse(registerText) as { user: { userId: string } };

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });
  expect(loginRes.status).toBe(200);
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  const match = /dnd_session=([^;]*)/.exec(setCookie);
  expect(match).toBeTruthy();
  return { cookies: `dnd_session=${match![1]}`, userId: registerBody.user.userId };
}

function jsonHeaders(cookies: string) {
  return { 'content-type': 'application/json', cookie: cookies };
}

describe('HTTP character vertical flow', () => {
  it('runs register → login → owner create → player join → player create/update/submit → owner approve → player sees approved', async () => {
    const server = await startPlatformServer();
    try {
      const { baseUrl } = server;
      const owner = await registerAndLogin(baseUrl, 'owner@example.test');
      const playerA = await registerAndLogin(baseUrl, 'player@example.test');
      const playerB = await registerAndLogin(baseUrl, 'playerb@example.test');

      // owner 创建战役，拿到 campaign.id + 一次性 raw invite code。
      const createRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'POST',
        headers: jsonHeaders(owner.cookies),
        body: JSON.stringify({ name: '失落矿坑', ruleset: 'dnd5e' }),
      });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };
      expect(createBody.campaign.id).toBeTruthy();
      expect(createBody.inviteCode).toBeTruthy();

      // playerA / playerB 用 raw invite code 加入。
      for (const actor of [playerA, playerB]) {
        const joinRes = await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}/join`, {
          method: 'POST',
          headers: jsonHeaders(actor.cookies),
          body: JSON.stringify({ inviteCode: createBody.inviteCode }),
        });
        expect(joinRes.status).toBe(201);
      }

      const charsBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/characters`;

      // playerA 创建/更新/提交角色。
      const createChar = await fetch(`${charsBase}`, {
        method: 'POST',
        headers: jsonHeaders(playerA.cookies),
        body: JSON.stringify({ name: '薇拉', sheet: { ac: 14 } }),
      });
      expect(createChar.status).toBe(201);
      const charBody = (await createChar.json()) as { character: { id: string } };
      const charId = charBody.character.id;

      const updateChar = await fetch(`${charsBase}/${charId}`, {
        method: 'PUT',
        headers: jsonHeaders(playerA.cookies),
        body: JSON.stringify({ name: '薇拉', sheet: { ac: 15 } }),
      });
      expect(updateChar.status).toBe(200);

      const submitRes = await fetch(`${charsBase}/${charId}/submit`, {
        method: 'POST',
        headers: jsonHeaders(playerA.cookies),
      });
      expect(submitRes.status).toBe(200);

      // owner 看到待审队列并 approve。
      const ownerList = await fetch(`${charsBase}`, { headers: { cookie: owner.cookies } });
      expect(ownerList.status).toBe(200);
      const ownerProjection = (await ownerList.json()) as { projection: { reviews: Array<{ id: string }> } };
      expect(ownerProjection.projection.reviews).toHaveLength(1);
      expect(ownerProjection.projection.reviews[0].id).toBe(charId);

      const approveRes = await fetch(`${charsBase}/${charId}/review`, {
        method: 'POST',
        headers: jsonHeaders(owner.cookies),
        body: JSON.stringify({ action: 'approve' }),
      });
      expect(approveRes.status).toBe(200);
      const approved = (await approveRes.json()) as { character: { status: string; derived: Record<string, unknown> } };
      expect(approved.character.status).toBe('approved');
      expect(approved.character.derived).toHaveProperty('ac');

      // playerA 本人能看到自己的已批准完整角色（含 derived），myPending 清空。
      const aOwnView = (await (await fetch(`${charsBase}`, { headers: { cookie: playerA.cookies } })).json()) as {
        projection: { myApproved: Array<{ id: string }>; myPending: unknown[] };
      };
      expect(aOwnView.projection.myApproved.map((c) => c.id)).toContain(charId);
      expect(aOwnView.projection.myPending).toEqual([]);

      // playerB 看不到他人 draft/pending/rejected；但能看到已批准角色的安全 summary。
      const bList = await fetch(`${charsBase}`, { headers: { cookie: playerB.cookies } });
      expect(bList.status).toBe(200);
      const bProjection = (await bList.json()) as {
        projection: {
          myDrafts: unknown[];
          myPending: unknown[];
          myRejected: unknown[];
          myApproved: unknown[];
          reviews: unknown[];
          approvedSummaries: Array<{ name: string }>;
        };
      };
      expect(bProjection.projection.myDrafts).toEqual([]);
      expect(bProjection.projection.myPending).toEqual([]);
      expect(bProjection.projection.myRejected).toEqual([]);
      expect(bProjection.projection.myApproved).toEqual([]);
      expect(bProjection.projection.reviews).toEqual([]);
      expect(bProjection.projection.approvedSummaries.map((s) => s.name)).toContain('薇拉');

      // player 不能 approve：403 FORBIDDEN，且断言契约错误体 code。
      const playerApprove = await fetch(`${charsBase}/${charId}/review`, {
        method: 'POST',
        headers: jsonHeaders(playerA.cookies),
        body: JSON.stringify({ action: 'approve' }),
      });
      expect(playerApprove.status).toBe(403);
      const playerApproveBody = (await playerApprove.json()) as { error: { code: string } };
      expect(playerApproveBody.error.code).toBe('FORBIDDEN');

      // playerB 创建 private draft“卡恩”ac16。
      const bDraft = await fetch(`${charsBase}`, {
        method: 'POST',
        headers: jsonHeaders(playerB.cookies),
        body: JSON.stringify({ name: '卡恩', sheet: { ac: 16 } }),
      });
      expect(bDraft.status).toBe(201);

      // playerA 整个 projection JSON 不得包含“卡恩”或该 sheet 内容，myDrafts 为空。
      const aListText = await (await fetch(`${charsBase}`, { headers: { cookie: playerA.cookies } })).text();
      expect(aListText).not.toContain('卡恩');
      expect(aListText).not.toContain('"ac":16');
      const aProjection = JSON.parse(aListText) as { projection: { myDrafts: unknown[] } };
      expect(aProjection.projection.myDrafts).toEqual([]);

      // owner 不能 submit：路由层前置 role 校验 → FORBIDDEN，并断言契约错误体 code。
      const ownerSubmit = await fetch(`${charsBase}/${charId}/submit`, {
        method: 'POST',
        headers: jsonHeaders(owner.cookies),
      });
      expect(ownerSubmit.status).toBe(403);
      const ownerSubmitBody = (await ownerSubmit.json()) as { error: { code: string } };
      expect(ownerSubmitBody.error.code).toBe('FORBIDDEN');

      // /api/auth/me 响应不含 password_hash。
      const meText = await (await fetch(`${baseUrl}/api/auth/me`, {
        headers: { cookie: owner.cookies },
      })).text();
      expect(meText).not.toContain('password_hash');
      expect(meText).not.toContain('passwordHash');

      // DTO 洁净：campaign 视图无 raw invite code / invite_code_hash。
      const viewText = await (await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}`, {
        headers: { cookie: owner.cookies },
      })).text();
      expect(viewText).not.toContain('inviteCode');
      expect(viewText).not.toContain('invite_code_hash');
      expect(viewText).not.toContain(createBody.inviteCode);

      // 角色 DTO 不含 DB 内部字段。
      const approvedText = JSON.stringify(approved.character);
      expect(approvedText).not.toContain('sheet_json');
      expect(approvedText).not.toContain('derived_json');
      expect(approvedText).not.toContain('character_id');
      expect(approvedText).not.toContain('actor_user_id');
      expect(approvedText).not.toContain('before_json');
      expect(approvedText).not.toContain('after_json');
    } finally {
      // 失败路径也保证 server 与 platformDb 资源被正确关闭，不泄露 handle。
      await server.close();
    }
  });
});
