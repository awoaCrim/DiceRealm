# DND AI-DM 平台重构：阶段二 A（Phase 2A）详细计划（世界事实、事务性 outbox、回合与行动）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本文是 `2026-08-02-dnd-ai-dm-rearchitecture-revised.md`（权威总路线图）中 **Phase 2A** 的唯一可执行详细计划，覆盖 5 个小任务：共享 HTTP harness、世界事实（`004_world_state.sql`）、事件契约与事务性 outbox（`005_events_outbox.sql`）、回合与行动（`006_turns_actions.sql`）、HTTP 垂直验收。Phase 2B（存档 + AI runtime，`007`–`008`）在 2A 完成并通过复审后编写。

## 状态：⏭ 待执行

**Goal:** 在 Phase 1（`62c40df`–`6e11c7a`）已建成 campaign-scoped 权限、`VisibilityPolicy`、角色后端与 HTTP 垂直基线上，产出（1）共享 HTTP test harness（纯 refactor，前后测试绿），（2）世界事实数据面（owner 写、player 只读投影、knownBy 不泄漏），（3）事件契约与事务性 outbox（每战役 sequence 并发安全、回滚不留残迹、事件受众可投影），（4）回合与行动生命周期（最后一名提交自动锁定、`turn.action_submitted`/`turn.locked` 与业务写同事务），（5）owner + playerA + playerB 三 actor 的 HTTP 垂直验收，锁定 world/outbox/turn 三条链路的正确性与隐私隔离。

**Architecture:** 所有新平台表统一 `platform_` 前缀，迁移编号连续（`004` → `005` → `006`）。领域服务只消费 `resolveCampaignContext` 生成的 `CampaignAuthContext`（不硬编码 ctx/campaignId）；多写操作一律 `DatabasePort.transaction`，事务内的所有 repository 用传入的 `tx` 重新构造，绝不持有外层 executor 绕开事务。outbox 是事务性事件存储：`TurnService` 只依赖 `EventPublisherPort` 端口，具体 `OutboxRepository` 由 app 装配注入；`publishIn(tx, event)` 用传入 tx 完成计数器分配 + 事件插入，与业务写同事务提交/回滚。事件受众（`public`/`owner_only`/`player_private`）与 `canReadEvent` 投影函数定义在 contracts，Phase 3 的 SSE live/replay 复用同一投影。HTTP 垂直用 `app.listen(0)` + `fetch` + 独立 cookie jar（经共享 harness）。

**Tech Stack:** Node.js 22.12.0、TypeScript、Express、SQLite（`better-sqlite3` 12.10.0 固定）、PostgreSQL（`pg`）、Zod、Vitest。不写真实 `server/dnd.sqlite`，一律内存 SQLite；Postgres 契约由既有 `POSTGRES_TEST_URL` 门控套件覆盖（本阶段新增 SQL 保持可移植）。

---

## 执行前约束

- 不 `git stash pop` 归档 stash；不修改 `server/dnd.sqlite` 等运行数据；不使用 `git add .`，每次只暂存任务列出的具体路径。
- 所有外部 CLI 使用 `rtk` 前缀。
- 每个任务一个只含该任务文件的 commit，trailer 精确为 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 本阶段不建立任何前端文件；不建立 archive/AI runtime/SSE/combat；不新增错误码（只用既有码：`FORBIDDEN`/`CAMPAIGN_NOT_FOUND`/`STATE_CONFLICT`/`VALIDATION_ERROR`/`NOT_FOUND`/`TURN_LOCKED`/`TURN_NOT_ACTIVE`/`CHARACTER_NOT_APPROVED`）。
- 事件与业务写同事务；多写操作在 tx 内必须使用传入的 `tx`，repository 不得持有外部 executor 后在 tx 中绕开。
- outbox 每战役 sequence 用「原子 upsert 计数器 + `RETURNING`」在写事务内取得，**绝不用“读取后 MAX+1”**；`published_at` 必须可空（新事件未发布），**禁止 `NOT NULL DEFAULT`**；`UNIQUE(campaign_id, sequence)` 仅作不变量兜底。
- 回合序号允许 `MAX(number)+1`，但**只在 tx 内对 campaign 行做 no-op 更新获得行锁后**执行（SQLite 靠既有 transaction queue 串行，Postgres 靠行锁）。
- `ai.preview.*` 与 `ai.preview.failed` 对 player 可见（失败事件客户端丢弃预览并显示可恢复错误）；owner-only debug 走独立 `owner.debug` 事件，绝不在玩家流中出现。
- 不硬编码 ctx/campaignId；所有领域服务只消费 `CampaignAuthContext`。
- 所有路由挂在 `/api/campaigns/:campaignId/*`，`Router({ mergeParams: true })` + campaign middleware，且在平台 `errorMiddleware` 之前注册；不改现有 `/api/campaigns` 根 middleware。
- 玩家 DTO 不得泄露完整 `knownBy` 列表（只返回 `[]` 或自己的 playerId）、他人 action 正文、owner_only 内容与任何 `*_json`/内部字段。

## 本阶段 Files 总览（先读后写）

- Create: `server/src/tests/httpTestHarness.ts`
- Modify: `server/src/tests/authCampaignRoutes.test.ts`
- Modify: `server/src/tests/vertical-characters-http.test.ts`
- Create: `packages/contracts/src/world.ts`
- Create: `packages/contracts/src/world.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `server/src/platform/database/migrations/004_world_state.sql`
- Create: `server/src/modules/world/WorldFactRepository.ts`
- Create: `server/src/modules/world/WorldFactService.ts`
- Create: `server/src/modules/world/world.test.ts`
- Create: `server/src/routes/worldRoutes.ts`
- Modify: `server/src/app.ts`（Task 2 挂 world 路由）
- Modify: `packages/contracts/src/events.ts`
- Create: `packages/contracts/src/events.test.ts`
- Create: `server/src/platform/database/migrations/005_events_outbox.sql`
- Create: `server/src/platform/events/EventPublisherPort.ts`
- Create: `server/src/platform/events/OutboxRepository.ts`
- Create: `server/src/platform/events/outbox.test.ts`
- Create: `server/src/platform/database/migrations/006_turns_actions.sql`
- Modify: `packages/contracts/src/turn.ts`
- Modify: `server/src/modules/characters/CharacterRepository.ts`（只读新增）
- Create: `server/src/modules/turns/TurnRepository.ts`
- Create: `server/src/modules/turns/TurnService.ts`
- Create: `server/src/modules/turns/turn.test.ts`
- Create: `server/src/routes/turnRoutes.ts`
- Modify: `server/src/app.ts`（Task 4 追加 turn 路由）
- Create: `server/src/tests/vertical-world-outbox-turns-http.test.ts`

## 任务依赖图

```
Task 1（共享 HTTP harness）──────────┐
Task 2（world facts + 004）──────────┼──→ Task 5（HTTP 垂直验收）
Task 3（events + outbox + 005）──→ Task 4（turns + 006）──┘
Task 4 依赖 Task 3 的 EventPublisherPort/OutboxRepository
Task 1/2/3 相互独立（迁移编号决定任务执行顺序 004→005→006）
Task 5 是独立验收测试，依赖 Task 1-4 的已实现整合，在 Task 4 之后创建并运行（不要求先红）
```

---

## Task 1：抽取共享 HTTP test harness（纯 refactor）

**依赖：** Phase 1 的 `server/src/tests/authCampaignRoutes.test.ts` 与 `server/src/tests/vertical-characters-http.test.ts` 内联的 `startPlatformServer`/`registerAndLogin`/`jsonHeaders`；`createApp`/`createMemoryDb`/`migrate`/`createSqliteDatabase`。无本阶段前置任务。

**目标：** 把两个既有测试重复的服务器启动与登录助手收敛为一个共享 harness。**纯 refactor：不要求先红**；抽取后两个测试文件的断言行为（状态码、响应体、隐私隔离、DTO 洁净断言）逐字不变。harness 额外返回 `platformDb` 供验收测试直查 outbox/world 数据，并在 `close()` 里先关 server 再关 platformDb。

### Files

- Create: `server/src/tests/httpTestHarness.ts`
- Modify: `server/src/tests/authCampaignRoutes.test.ts`
- Modify: `server/src/tests/vertical-characters-http.test.ts`

### Step 1：创建共享 harness 并重构两个测试文件

本任务是纯 refactor，不走「先红」：先创建 harness，再把两个测试文件内联助手删掉并改用 harness，然后运行确认前后全绿。

`server/src/tests/httpTestHarness.ts`（注意：`registerAndLogin` 是 `authCampaignRoutes` 版本（cookie map + `sessionId`）与 `vertical-characters-http` 版本（cookie 字符串 + `userId`）的严格超集，两个文件的既有断言都保留）：

```ts
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import {
  createSqliteDatabase,
  type SqliteDatabaseAdapter,
} from '../platform/database/SqliteDatabaseAdapter.js';

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
export async function startPlatformServer(): Promise<StartedPlatform> {
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
    platformDb,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // platformDb.close() 关闭它复用的 raw 连接（reuseRaw），只关一次，避免 double-close 资源泄漏。
      await platformDb.close();
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
```

`server/src/tests/authCampaignRoutes.test.ts` 的机械重构（断言体逐字不动）：

- 删除内联的 `startPlatformServer`/`registerAndLogin`/`parseSetCookie`/`baseUrlOf`，删除现在不再使用的 `createApp`/`createSqliteDatabase`/`createMemoryDb`/`migrate`/`AddressInfo` 导入。
- 新增导入：`import { startPlatformServer, registerAndLogin, jsonHeaders } from './httpTestHarness.js';`
- `const { cookies, sessionId } = await registerAndLogin(...)` → `const { cookieHeader, sessionId } = await registerAndLogin(...)`；文件内所有 `X.cookies.dnd_session` → `X.cookieHeader`（如 `ownerCookie = \`dnd_session=${owner.cookies.dnd_session}\`` → `ownerCookie = owner.cookieHeader`）。
- `baseUrlOf(server)` → `server.baseUrl`。
- 其余断言（401/403/404 状态码、`error.code`、`not.toContain('invite')` 等）逐字不变；`server.close()` 调用不变（harness 的 close 现在同时关 server 与 platformDb）。

`server/src/tests/vertical-characters-http.test.ts` 的机械重构（断言体逐字不动）：

- 删除内联的 `startPlatformServer`/`registerAndLogin`/`jsonHeaders`/`StartedApp`/`Actor` 接口与相关导入。
- 新增导入：`import { startPlatformServer, registerAndLogin, jsonHeaders } from './httpTestHarness.js';`
- `registerAndLogin` 返回值从 `{ cookies: string; userId }` 改为 `{ cookieHeader: string; userId }`：`jsonHeaders(playerA.cookies)` → `jsonHeaders(playerA.cookieHeader)`，`headers: { cookie: owner.cookies }` → `headers: { cookie: owner.cookieHeader }`。
- 其余断言（投影隔离、DTO 洁净、`password_hash` 不泄漏、`playerApprove` 403 等）逐字不变。

### Step 2：运行确认通过（refactor 不要求先红）

```bash
rtk npm test -- --run server/src/tests/authCampaignRoutes.test.ts server/src/tests/vertical-characters-http.test.ts
```

预期：**两个文件直接通过**，与 refactor 前行为一致——这是 refactor 的验收标准。若失败，通常是导入路径错误或某处 `cookies` 遗漏替换，逐项修复（不许改断言）。

### Step 3：无新生产文件（错误形态检查清单）

本任务没有新生产文件。若验收失败，逐项检查：

- harness 的 `close()` 未关 `platformDb`（或 double-close `raw`）。
- `registerAndLogin` 丢失任一既有断言（`password_hash` 或 `set-cookie`），导致某个测试漏检。
- 某处仍引用 `cookies.dnd_session`（TS 编译错误即暴露）。
- `jsonHeaders` 未用 `cookieHeader`（Cookie 头缺失 → 401）。

### Step 4：全量相关测试

```bash
rtk npm test -- --run server/src/tests/authCampaignRoutes.test.ts server/src/tests/vertical-characters-http.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：两个 refactored 测试全绿；typecheck/build 通过。Task 5 的验收测试文件在本任务时还不存在，`--run` 只对已存在文件生效，无需在此引用。

### Step 5：提交

```bash
rtk git add server/src/tests/httpTestHarness.ts server/src/tests/authCampaignRoutes.test.ts server/src/tests/vertical-characters-http.test.ts
rtk git commit -m "test: extract shared HTTP test harness for platform verticals" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2：世界事实（contract + `004_world_state.sql` + service + route）

**依赖：** Phase 1 的 `CampaignAuthContext`/`resolveCampaignContext`/`requireOwner`/`requireCampaignMember`/`canRead`（`VisibilityPolicy`）；`DatabasePort.transaction`；contracts 既有 `visibilitySchema`。Task 1 的 harness 供本任务的 HTTP 相关验证（world 模块测试本身不依赖 harness）。

**目标：** owner 写世界事实、player 只读经投影后的 facts；`player_private` 的 `knownBy` 必须是该 campaign 的 player 成员且非空；`public`/`owner_only` 落库 `knownBy=[]`；player DTO 绝不泄露完整 `knownBy`（只返回 `[]` 或自己的 playerId）。

### Files

- Create: `packages/contracts/src/world.ts`
- Create: `packages/contracts/src/world.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `server/src/platform/database/migrations/004_world_state.sql`
- Create: `server/src/modules/world/WorldFactRepository.ts`
- Create: `server/src/modules/world/WorldFactService.ts`
- Create: `server/src/modules/world/world.test.ts`
- Create: `server/src/routes/worldRoutes.ts`
- Modify: `server/src/app.ts`（挂 `/api/campaigns/:campaignId/world`）

### Step 1：写失败测试

`packages/contracts/src/world.ts`（contract schema 保持宽松，非空/成员校验在 service 层）：

```ts
import { z } from 'zod';
import { visibilitySchema } from './turn.js';

/** 世界事实 contract：owner 写入，player 只读经 VisibilityPolicy 投影。 */

export const worldFactKindSchema = z.enum([
  'location', 'npc', 'item', 'lore', 'faction', 'quest', 'custom',
]);

export type WorldFactKind = z.infer<typeof worldFactKindSchema>;

/** owner 创建/更新世界事实的输入。knownBy 语义：public/owner_only 必须为空（service 强制落库 []）；
 *  player_private 必须给出非空的目标 playerId 列表，每个都必须是该 campaign 的 player 成员。 */
export const worldFactInputSchema = z.object({
  title: z.string().trim().min(1),
  kind: worldFactKindSchema,
  content: z.string().min(1),
  visibility: visibilitySchema,
  knownBy: z.array(z.string().min(1)).default([]),
});

export type WorldFactInput = z.infer<typeof worldFactInputSchema>;

/** 事实 DTO。knownBy 已按观看者投影：owner 可见完整列表；player 只见 []（public）或 [自己的 playerId]。 */
export const worldFactSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  title: z.string().min(1),
  kind: worldFactKindSchema,
  content: z.string(),
  visibility: visibilitySchema,
  knownBy: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WorldFact = z.infer<typeof worldFactSchema>;

export const worldFactProjectionSchema = z.object({
  facts: z.array(worldFactSchema),
});

export type WorldFactProjection = z.infer<typeof worldFactProjectionSchema>;
```

在 `packages/contracts/src/index.ts` 追加 `export * from './world.js';`。

`packages/contracts/src/world.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { worldFactInputSchema, worldFactProjectionSchema } from './index';

describe('world fact contracts', () => {
  it('parses a player_private input with knownBy', () => {
    const input = worldFactInputSchema.parse({
      title: '密室钥匙', kind: 'item', content: '藏在地毯下。',
      visibility: 'player_private', knownBy: ['player-a'],
    });
    expect(input.knownBy).toEqual(['player-a']);
  });

  it('defaults knownBy to an empty list', () => {
    const input = worldFactInputSchema.parse({
      title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public',
    });
    expect(input.knownBy).toEqual([]);
  });

  it('rejects an unknown kind', () => {
    expect(() => worldFactInputSchema.parse({
      title: 'x', kind: 'bogus', content: 'y', visibility: 'public',
    })).toThrow();
  });

  it('projects facts without internal json fields', () => {
    const projection = worldFactProjectionSchema.parse({
      facts: [{
        id: 'f1', campaignId: 'c1', title: 't', kind: 'lore', content: 'c',
        visibility: 'public', knownBy: [], createdAt: 'now', updatedAt: 'now',
      }],
    });
    expect(projection.facts[0].knownBy).toEqual([]);
    expect(JSON.stringify(projection)).not.toContain('_json');
  });
});
```

`server/src/modules/world/world.test.ts`（先写失败测试，Step 3 再实现 service/repo）：

```ts
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { resolveCampaignContext, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { WorldFactService } from './WorldFactService.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const playerA = await identity.register({ login: 'a@example.test', password: 'correct-password' });
  const playerB = await identity.register({ login: 'b@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  await campaigns.join({ userId: playerA.userId }, created.campaign.id, created.inviteCode);
  await campaigns.join({ userId: playerB.userId }, created.campaign.id, created.inviteCode);
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const playerACtx = await resolveCampaignContext(db, { userId: playerA.userId }, created.campaign.id);
  const playerBCtx = await resolveCampaignContext(db, { userId: playerB.userId }, created.campaign.id);
  return { db, ownerCtx, playerACtx, playerBCtx };
}

describe('world facts', () => {
  it('owner creates public/player_private/owner_only facts with normalized knownBy', async () => {
    const { db, ownerCtx, playerACtx } = await makeFixture();
    const service = new WorldFactService(db);
    const pub = await service.create(ownerCtx, { title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public' });
    expect(pub.knownBy).toEqual([]);
    const priv = await service.create(ownerCtx, {
      title: '密室钥匙', kind: 'item', content: '藏在地毯下。',
      visibility: 'player_private', knownBy: [playerACtx.playerId as string],
    });
    expect(priv.knownBy).toEqual([playerACtx.playerId]);
    const only = await service.create(ownerCtx, {
      title: '隐秘布局', kind: 'lore', content: '只有你知道。', visibility: 'owner_only',
    });
    expect(only.knownBy).toEqual([]);
    await db.close();
  });

  it('rejects player_private with empty or non-member knownBy', async () => {
    const { db, ownerCtx, playerACtx } = await makeFixture();
    const service = new WorldFactService(db);
    await expect(service.create(ownerCtx, {
      title: 'x', kind: 'lore', content: 'y', visibility: 'player_private', knownBy: [],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.create(ownerCtx, {
      title: 'x', kind: 'lore', content: 'y', visibility: 'player_private', knownBy: ['ghost'],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(playerACtx.playerId).toBeTruthy();
    await db.close();
  });

  it('rejects player writes', async () => {
    const { db, playerACtx } = await makeFixture();
    const service = new WorldFactService(db);
    await expect(service.create(playerACtx, {
      title: 'x', kind: 'lore', content: 'y', visibility: 'public',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.close();
  });

  it('projects isolated facts per player without leaking knownBy or owner_only content', async () => {
    const { db, ownerCtx, playerACtx, playerBCtx } = await makeFixture();
    const service = new WorldFactService(db);
    const aId = playerACtx.playerId as string;
    const bId = playerBCtx.playerId as string;
    await service.create(ownerCtx, { title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public' });
    await service.create(ownerCtx, { title: 'A 的密信', kind: 'item', content: '给 A。', visibility: 'player_private', knownBy: [aId] });
    await service.create(ownerCtx, { title: 'B 的密信', kind: 'item', content: '给 B。', visibility: 'player_private', knownBy: [bId] });
    await service.create(ownerCtx, { title: '隐秘布局', kind: 'lore', content: '只有你知道。', visibility: 'owner_only' });

    const a = await service.projectForCampaign(playerACtx);
    expect(a.facts.map((f) => f.title).sort()).toEqual(['A 的密信', '酒馆']);
    expect(a.facts.find((f) => f.title === 'A 的密信')?.knownBy).toEqual([aId]);
    expect(a.facts.every((f) => f.knownBy.length <= 1)).toBe(true);

    const b = await service.projectForCampaign(playerBCtx);
    expect(b.facts.map((f) => f.title).sort()).toEqual(['B 的密信', '酒馆']);

    const owner = await service.projectForCampaign(ownerCtx);
    expect(owner.facts).toHaveLength(4);
    expect(owner.facts.find((f) => f.title === 'A 的密信')?.knownBy).toEqual([aId]);
    await db.close();
  });

  it('owner updates and deletes a fact', async () => {
    const { db, ownerCtx, playerACtx } = await makeFixture();
    const service = new WorldFactService(db);
    const created = await service.create(ownerCtx, { title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public' });
    // 确保 update 的 updated_at 与 create 的 updated_at 落在不同毫秒，updatedAt 变化的断言确定成立。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await service.update(ownerCtx, created.id, { title: '酒馆·扩建', kind: 'location', content: '更热闹。', visibility: 'public' });
    expect(updated.title).toBe('酒馆·扩建');
    // update 保留原 created_at，仅 updated_at 前进（不得伪造创建时间）。
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect((await service.projectForCampaign(playerACtx)).facts.map((f) => f.title)).toContain('酒馆·扩建');
    await service.delete(ownerCtx, created.id);
    expect(await service.projectForCampaign(ownerCtx)).toEqual({ facts: [] });
    await db.close();
  });
});
```

### Step 2：运行确认失败

```bash
rtk npm test -- --run server/src/modules/world/world.test.ts packages/contracts/src/world.test.ts
```

预期：失败——`packages/contracts/src/world.ts`、`WorldFactService`/`WorldFactRepository` 尚不存在（import 失败）；`004_world_state.sql` 未创建。失败集中在缺失模块与缺失迁移，不涉及既有行为。

### Step 3：实现

`server/src/platform/database/migrations/004_world_state.sql`（可移植：TEXT 主外键、`DEFAULT CURRENT_TIMESTAMP`、无 SQLite-only 函数）：

```sql
-- 004_world_state.sql
-- World facts: the persistent world model for a campaign.
-- Only the owner writes facts; players read only the visibility-projected subset.
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS).
-- Portable across SQLite and PostgreSQL:
--   - TEXT primary/foreign keys
--   - DEFAULT CURRENT_TIMESTAMP
--   - no SQLite-only functions or syntax

CREATE TABLE IF NOT EXISTS platform_world_facts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('location','npc','item','lore','faction','quest','custom')),
  content TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','player_private','owner_only')),
  known_by_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS platform_world_facts_campaign_idx
  ON platform_world_facts(campaign_id, visibility);
```

`server/src/modules/world/WorldFactRepository.ts`（每个方法接收 `QueryExecutor`，可注入 tx）：

```ts
import type { WorldFactKind, Visibility } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface WorldFactRow {
  id: string;
  campaign_id: string;
  title: string;
  kind: WorldFactKind;
  content: string;
  visibility: Visibility;
  known_by_json: string;
  created_at: string;
  updated_at: string;
}

export class WorldFactRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async insert(row: WorldFactRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_world_facts
        (id, campaign_id, title, kind, content, visibility, known_by_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.title, row.kind, row.content, row.visibility,
       row.known_by_json, row.created_at, row.updated_at],
    );
  }

  async listByCampaign(campaignId: string): Promise<WorldFactRow[]> {
    return this.executor.query<WorldFactRow>(
      'SELECT * FROM platform_world_facts WHERE campaign_id = ? ORDER BY created_at ASC',
      [campaignId],
    );
  }

  async findById(id: string): Promise<WorldFactRow | null> {
    const rows = await this.executor.query<WorldFactRow>(
      'SELECT * FROM platform_world_facts WHERE id = ?',
      [id],
    );
    return rows[0] ?? null;
  }

  /** 条件更新：仅当行存在且属于该 campaign 时更新；未命中返回 false → NOT_FOUND。 */
  async updateContent(
    factId: string,
    campaignId: string,
    patch: Pick<WorldFactRow, 'title' | 'kind' | 'content' | 'visibility' | 'known_by_json' | 'updated_at'>,
  ): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_world_facts
         SET title = ?, kind = ?, content = ?, visibility = ?, known_by_json = ?, updated_at = ?
       WHERE id = ? AND campaign_id = ?`,
      [patch.title, patch.kind, patch.content, patch.visibility, patch.known_by_json,
       patch.updated_at, factId, campaignId],
    );
    return result.changes === 1;
  }

  /** 条件删除：仅当行存在且属于该 campaign 时删除；未命中返回 false → NOT_FOUND。 */
  async delete(factId: string, campaignId: string): Promise<boolean> {
    const result = await this.executor.execute(
      'DELETE FROM platform_world_facts WHERE id = ? AND campaign_id = ?',
      [factId, campaignId],
    );
    return result.changes === 1;
  }

  /** 该 campaign 的 player 角色成员 id 列表（用于校验 player_private 的 knownBy）。 */
  async listPlayerMemberIds(campaignId: string): Promise<string[]> {
    const rows = await this.executor.query<{ user_id: string }>(
      "SELECT user_id FROM campaign_members WHERE campaign_id = ? AND role = 'player' ORDER BY user_id",
      [campaignId],
    );
    return rows.map((row) => row.user_id);
  }
}
```

`server/src/modules/world/WorldFactService.ts`（**并发/隐私核心**：写入走事务；`knownBy` 校验在事务内；投影时 player 只见可读 facts 且 knownBy 收敛为 `[]`/自己的 playerId）：

```ts
import { nanoid } from 'nanoid';
import type { WorldFact, WorldFactInput, WorldFactProjection } from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { canRead } from '../visibility/VisibilityPolicy.js';
import { WorldFactRepository, type WorldFactRow } from './WorldFactRepository.js';

export class WorldFactService {
  private readonly repository: WorldFactRepository;

  constructor(private readonly executor: DatabasePort) {
    this.repository = new WorldFactRepository(executor);
  }

  async create(ctx: CampaignAuthContext, input: WorldFactInput): Promise<WorldFact> {
    requireOwner(ctx);
    return this.executor.transaction(async (tx) => {
      const repo = new WorldFactRepository(tx);
      const knownBy = await this.validateKnownBy(tx, ctx.campaignId, input);
      const now = new Date().toISOString();
      const row: WorldFactRow = {
        id: nanoid(24),
        campaign_id: ctx.campaignId,
        title: input.title,
        kind: input.kind,
        content: input.content,
        visibility: input.visibility,
        known_by_json: JSON.stringify(knownBy),
        created_at: now,
        updated_at: now,
      };
      await repo.insert(row);
      return mapFact(row);
    });
  }

  async update(ctx: CampaignAuthContext, factId: string, input: WorldFactInput): Promise<WorldFact> {
    requireOwner(ctx);
    return this.executor.transaction(async (tx) => {
      const repo = new WorldFactRepository(tx);
      // 在同一事务内读取现有行：保留原 created_at，仅 updated_at = now，不得伪造创建时间。
      const existing = await repo.findById(factId);
      if (!existing || existing.campaign_id !== ctx.campaignId) {
        throw new AppError('NOT_FOUND', '世界事实不存在。');
      }
      const knownBy = await this.validateKnownBy(tx, ctx.campaignId, input);
      const now = new Date().toISOString();
      const ok = await repo.updateContent(factId, ctx.campaignId, {
        title: input.title, kind: input.kind, content: input.content,
        visibility: input.visibility, known_by_json: JSON.stringify(knownBy), updated_at: now,
      });
      if (!ok) {
        throw new AppError('NOT_FOUND', '世界事实不存在。');
      }
      return mapFact({
        ...existing,
        title: input.title,
        kind: input.kind,
        content: input.content,
        visibility: input.visibility,
        known_by_json: JSON.stringify(knownBy),
        updated_at: now,
      });
    });
  }

  async delete(ctx: CampaignAuthContext, factId: string): Promise<void> {
    requireOwner(ctx);
    const ok = await this.repository.delete(factId, ctx.campaignId);
    if (!ok) {
      throw new AppError('NOT_FOUND', '世界事实不存在。');
    }
  }

  async projectForCampaign(ctx: CampaignAuthContext): Promise<WorldFactProjection> {
    const rows = await this.repository.listByCampaign(ctx.campaignId);
    const facts: WorldFact[] = [];
    for (const row of rows) {
      const knownBy = JSON.parse(row.known_by_json) as string[];
      if (ctx.role === 'owner') {
        facts.push(mapFact(row));
        continue;
      }
      if (!canRead({ role: 'player', playerId: ctx.playerId }, row.visibility, knownBy)) {
        continue;
      }
      // player DTO 不泄露完整 knownBy：public → []；player_private 可见 → [自己的 playerId]。
      facts.push({ ...mapFact(row), knownBy: row.visibility === 'player_private' ? [ctx.playerId as string] : [] });
    }
    return { facts };
  }

  /** public/owner_only 一律落库 knownBy=[]；player_private 必须非空且每个都是该 campaign 的 player 成员。 */
  private async validateKnownBy(
    tx: QueryExecutor,
    campaignId: string,
    input: WorldFactInput,
  ): Promise<string[]> {
    if (input.visibility !== 'player_private') {
      return [];
    }
    if (input.knownBy.length === 0) {
      throw new AppError('VALIDATION_ERROR', '玩家私密事实必须指定至少一个可见玩家。');
    }
    const playerIds = await new WorldFactRepository(tx).listPlayerMemberIds(campaignId);
    for (const playerId of input.knownBy) {
      if (!playerIds.includes(playerId)) {
        throw new AppError('VALIDATION_ERROR', '目标玩家不是该战役的玩家成员。');
      }
    }
    return [...new Set(input.knownBy)];
  }
}

function mapFact(row: WorldFactRow): WorldFact {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    title: row.title,
    kind: row.kind,
    content: row.content,
    visibility: row.visibility,
    knownBy: JSON.parse(row.known_by_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

`server/src/routes/worldRoutes.ts`（必须 `Router({ mergeParams: true })` + campaign middleware）：

```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { worldFactInputSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { WorldFactService } from '../modules/world/WorldFactService.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';

export function createWorldRouter(executor: QueryExecutor, facts: WorldFactService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.json({ projection: await facts.projectForCampaign(getCampaignContext(req)) });
  }));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = worldFactInputSchema.parse(req.body);
    res.status(201).json({ fact: await facts.create(ctx, input) });
  }));

  router.put('/:factId', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = worldFactInputSchema.parse(req.body);
    res.json({ fact: await facts.update(ctx, stringParam(req, 'factId'), input) });
  }));

  router.delete('/:factId', asyncHandler(async (req: Request, res: Response) => {
    await facts.delete(getCampaignContext(req), stringParam(req, 'factId'));
    res.status(204).end();
  }));

  return router;
}

function stringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) {
    throw new AppError('NOT_FOUND', '世界事实不存在。');
  }
  return value;
}
```

`server/src/app.ts` 挂载（在平台块内、`errorMiddleware` 之前；不改 `/api/campaigns` 根 router）：

```ts
import { WorldFactService } from './modules/world/WorldFactService.js';
import { createWorldRouter } from './routes/worldRoutes.js';
// ...
if (options.platformDb) {
  const identity = new IdentityService(options.platformDb);
  const campaigns = new CampaignService(options.platformDb);
  const characters = new CharacterService(options.platformDb);
  const worldFacts = new WorldFactService(options.platformDb);
  app.use(createSessionMiddleware(identity));
  app.use('/api/auth', createAuthRouter(identity));
  app.use('/api/campaigns', createCampaignRouter(campaigns));
  app.use('/api/campaigns/:campaignId/characters', createCharacterRouter(options.platformDb, characters));
  app.use('/api/campaigns/:campaignId/world', createWorldRouter(options.platformDb, worldFacts));
  app.use(errorMiddleware);
}
```

### Step 4：运行确认通过

```bash
rtk npm test -- --run server/src/modules/world/world.test.ts packages/contracts/src/world.test.ts packages/contracts/src/contracts.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：world 模块与 contract 测试全绿；`platform_world_facts` 经 `004_world_state.sql` 创建；build 把 `004_world_state.sql` 复制进 `dist`；既有 contracts 测试不回退。

### Step 5：提交

```bash
rtk git add packages/contracts/src/world.ts packages/contracts/src/world.test.ts packages/contracts/src/index.ts server/src/platform/database/migrations/004_world_state.sql server/src/modules/world server/src/routes/worldRoutes.ts server/src/app.ts
rtk git commit -m "feat: add campaign world facts with visibility projection" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3：事件契约 + 事务性 outbox（`005_events_outbox.sql`）

**依赖：** Phase 1 的 `DatabasePort.transaction`/`QueryExecutor`、`SqliteDatabaseAdapter` 事务串行队列；contracts 既有 `events.ts`。Task 2 提供迁移编号 004（本任务 005，二者独立）。

**目标：** 事件契约收敛（每个 variant 带 `campaignId`、`interaction.requested` 补 `targetPlayerId`、新增 `owner.debug`）与事务性 outbox：每战役 sequence 并发安全（原子 upsert + `RETURNING`）、回滚不留 counter/事件、`published_at` 可空。`EventPublisherPort` 端口 + `OutboxRepository` 具体实现依赖方向正确（service 依赖 port；app 注入 concrete；`publishIn` 接收 tx）。受众投影函数供 Phase 3 SSE 复用。

### Files

- Modify: `packages/contracts/src/events.ts`
- Create: `packages/contracts/src/events.test.ts`
- Create: `server/src/platform/database/migrations/005_events_outbox.sql`
- Create: `server/src/platform/events/EventPublisherPort.ts`
- Create: `server/src/platform/events/OutboxRepository.ts`
- Create: `server/src/platform/events/outbox.test.ts`

### Step 1：写失败测试

`packages/contracts/src/events.ts` 整体替换为（既有 `campaignEventSchema` 测试 `{ type: 'database.row_dump' }` 仍然抛错，不受影响）：

```ts
import { z } from 'zod';

/** 领域事件：SSE 推送的是领域事件而非原始数据库行。每个 variant 都带 campaignId（outbox 按 campaign 分片）。 */

export const campaignEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('player.joined'), campaignId: z.string().min(1), playerId: z.string().min(1) }),
  z.object({ type: z.literal('turn.action_submitted'), campaignId: z.string().min(1), turnId: z.string().min(1), playerId: z.string().min(1) }),
  z.object({ type: z.literal('turn.locked'), campaignId: z.string().min(1), turnId: z.string().min(1) }),
  z.object({ type: z.literal('ai.preview.started'), campaignId: z.string().min(1), runId: z.string().min(1) }),
  z.object({ type: z.literal('ai.preview.delta'), campaignId: z.string().min(1), runId: z.string().min(1), text: z.string() }),
  z.object({ type: z.literal('ai.preview.failed'), campaignId: z.string().min(1), runId: z.string().min(1), code: z.string() }),
  z.object({ type: z.literal('turn.resolved'), campaignId: z.string().min(1), turnId: z.string().min(1), archiveId: z.string().min(1) }),
  z.object({ type: z.literal('combat.updated'), campaignId: z.string().min(1), encounterId: z.string().min(1) }),
  z.object({ type: z.literal('interaction.requested'), campaignId: z.string().min(1), requestId: z.string().min(1), targetPlayerId: z.string().min(1) }),
  // owner-only debug（AI 上下文、输入输出原始记录等）；Phase 2A 定义但不 emit，Phase 3 由 AI 结算写入。
  z.object({ type: z.literal('owner.debug'), campaignId: z.string().min(1), runId: z.string().min(1), kind: z.string().min(1) }),
]);

export type CampaignEvent = z.infer<typeof campaignEventSchema>;

export const campaignEventTypeSchema = z.enum([
  'player.joined',
  'turn.action_submitted',
  'turn.locked',
  'ai.preview.started',
  'ai.preview.delta',
  'ai.preview.failed',
  'turn.resolved',
  'combat.updated',
  'interaction.requested',
  'owner.debug',
]);

export type CampaignEventType = z.infer<typeof campaignEventTypeSchema>;

/** 事件可见性受众：public/owner_only 无目标玩家（targetPlayerId 必为 null）；player_private 必填目标玩家。 */
export const campaignEventAudienceSchema = z.discriminatedUnion('visibility', [
  z.object({ visibility: z.literal('public'), targetPlayerId: z.null() }),
  z.object({ visibility: z.literal('owner_only'), targetPlayerId: z.null() }),
  z.object({ visibility: z.literal('player_private'), targetPlayerId: z.string().min(1) }),
]);

export type CampaignEventAudience = z.infer<typeof campaignEventAudienceSchema>;

/** 每个事件的默认受众：owner.debug → owner_only；interaction.requested → 目标玩家；其余 → public。
 *  ai.preview.* 与 ai.preview.failed 对 player 可见（失败时客户端丢弃预览并显示可恢复错误）。 */
export function eventDefaultAudience(event: CampaignEvent): CampaignEventAudience {
  switch (event.type) {
    case 'owner.debug':
      return { visibility: 'owner_only', targetPlayerId: null };
    case 'interaction.requested':
      return { visibility: 'player_private', targetPlayerId: event.targetPlayerId };
    default:
      return { visibility: 'public', targetPlayerId: null };
  }
}

/** 事件观看者：owner 全量；player 只见 public + 自己的 player_private。 */
export interface EventViewer {
  role: 'owner' | 'player';
  playerId: string | null;
}

/** 唯一事件投影规则：Phase 3 的 SSE live 与 replay 复用同一函数，保证重连前后一致。 */
export function canReadEvent(viewer: EventViewer, event: CampaignEvent): boolean {
  if (viewer.role === 'owner') {
    return true;
  }
  const audience = eventDefaultAudience(event);
  if (audience.visibility === 'public') {
    return true;
  }
  if (audience.visibility === 'player_private') {
    return viewer.playerId != null && audience.targetPlayerId === viewer.playerId;
  }
  return false;
}
```

`packages/contracts/src/events.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { campaignEventSchema, canReadEvent, eventDefaultAudience } from './index';

describe('campaign event contracts', () => {
  it('accepts every variant with campaignId', () => {
    expect(campaignEventSchema.parse({ type: 'player.joined', campaignId: 'c', playerId: 'p' }))
      .toHaveProperty('campaignId', 'c');
    expect(campaignEventSchema.parse({ type: 'turn.action_submitted', campaignId: 'c', turnId: 't', playerId: 'p' })).toBeTruthy();
    expect(campaignEventSchema.parse({ type: 'turn.locked', campaignId: 'c', turnId: 't' })).toBeTruthy();
    expect(campaignEventSchema.parse({ type: 'ai.preview.failed', campaignId: 'c', runId: 'r', code: 'AI_PROVIDER_FAILED' })).toBeTruthy();
    expect(campaignEventSchema.parse({ type: 'interaction.requested', campaignId: 'c', requestId: 'q', targetPlayerId: 'p2' })).toBeTruthy();
    expect(campaignEventSchema.parse({ type: 'owner.debug', campaignId: 'c', runId: 'r', kind: 'ctx' })).toBeTruthy();
  });

  it('rejects an event without campaignId', () => {
    expect(() => campaignEventSchema.parse({ type: 'turn.locked', turnId: 't' })).toThrow();
  });

  it('rejects interaction.requested without targetPlayerId', () => {
    expect(() => campaignEventSchema.parse({ type: 'interaction.requested', campaignId: 'c', requestId: 'q' })).toThrow();
  });

  it('computes the default audience per event type', () => {
    expect(eventDefaultAudience({ type: 'turn.locked', campaignId: 'c', turnId: 't' }))
      .toEqual({ visibility: 'public', targetPlayerId: null });
    expect(eventDefaultAudience({ type: 'owner.debug', campaignId: 'c', runId: 'r', kind: 'k' }))
      .toEqual({ visibility: 'owner_only', targetPlayerId: null });
    expect(eventDefaultAudience({ type: 'interaction.requested', campaignId: 'c', requestId: 'q', targetPlayerId: 'p2' }))
      .toEqual({ visibility: 'player_private', targetPlayerId: 'p2' });
  });

  it('projects events per viewer', () => {
    const owner = { role: 'owner' as const, playerId: null };
    const p1 = { role: 'player' as const, playerId: 'p1' };
    const p2 = { role: 'player' as const, playerId: 'p2' };
    const submitted = { type: 'turn.action_submitted' as const, campaignId: 'c', turnId: 't', playerId: 'p1' };
    expect(canReadEvent(owner, submitted)).toBe(true);
    expect(canReadEvent(p1, submitted)).toBe(true);
    expect(canReadEvent(p2, submitted)).toBe(true);
    const debug = { type: 'owner.debug' as const, campaignId: 'c', runId: 'r', kind: 'k' };
    expect(canReadEvent(owner, debug)).toBe(true);
    expect(canReadEvent(p1, debug)).toBe(false);
    const interaction = { type: 'interaction.requested' as const, campaignId: 'c', requestId: 'q', targetPlayerId: 'p2' };
    expect(canReadEvent(p1, interaction)).toBe(false);
    expect(canReadEvent(p2, interaction)).toBe(true);
    expect(canReadEvent(owner, interaction)).toBe(true);
  });
});
```

`server/src/platform/events/outbox.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { CampaignEvent } from '@dnd/contracts';
import { createSqliteDatabase, type SqliteDatabaseAdapter } from '../database/SqliteDatabaseAdapter.js';
import { OutboxRepository } from './OutboxRepository.js';

const locked = (campaignId: string, turnId = 't1'): CampaignEvent =>
  ({ type: 'turn.locked', campaignId, turnId });
const submitted = (campaignId: string, playerId: string): CampaignEvent =>
  ({ type: 'turn.action_submitted', campaignId, turnId: 't1', playerId });

/**
 * 内存库没有 campaign：platform_outbox_sequences.campaign_id 有 FK REFERENCES campaigns(id)，
 * 发布前必须先插入唯一 owner user 与 campaign（created_at/updated_at 等必填列）。
 * 保留 FK 作为不变量，不删除。
 */
async function seedCampaign(db: SqliteDatabaseAdapter, campaignId: string): Promise<void> {
  const ownerId = `owner-${campaignId}`;
  const now = new Date().toISOString();
  await db.execute(
    'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
    [ownerId, `${ownerId}@example.test`, 'hash'],
  );
  await db.execute(
    'INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [campaignId, ownerId, `campaign-${campaignId}`, 'setup', 'dnd5e', now, now],
  );
}

describe('outbox', () => {
  it('assigns independent per-campaign sequences', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    await seedCampaign(db, 'c2');
    const repo = new OutboxRepository(db);
    await db.transaction((tx) => repo.publishIn(tx, locked('c1')));
    await db.transaction((tx) => repo.publishIn(tx, locked('c1', 't2')));
    await db.transaction((tx) => repo.publishIn(tx, locked('c2')));
    expect((await repo.listByCampaign('c1')).map((row) => row.sequence)).toEqual([1, 2]);
    expect((await repo.listByCampaign('c2')).map((row) => row.sequence)).toEqual([1]);
    await db.close();
  });

  it('rolls back counter and event together with the business transaction', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const repo = new OutboxRepository(db);
    await expect(db.transaction(async (tx) => {
      await repo.publishIn(tx, submitted('c1', 'p1'));
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await repo.listByCampaign('c1')).toEqual([]);
    const counters = await db.query<{ campaign_id: string }>(
      'SELECT campaign_id FROM platform_outbox_sequences',
    );
    expect(counters).toEqual([]);
    // 回滚无残留：下一次发布 sequence 仍从 1 开始。
    const seq = await db.transaction((tx) => repo.publishIn(tx, locked('c1')));
    expect(seq).toBe(1);
    await db.close();
  });

  it('assigns strictly increasing sequences under concurrent publishes', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const repo = new OutboxRepository(db);
    await Promise.all([
      db.transaction((tx) => repo.publishIn(tx, submitted('c1', 'p1'))),
      db.transaction((tx) => repo.publishIn(tx, submitted('c1', 'p2'))),
    ]);
    const rows = await db.query<{ sequence: number }>(
      'SELECT sequence FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence',
      ['c1'],
    );
    expect(rows.map((row) => row.sequence)).toEqual([1, 2]);
    await db.close();
  });

  it('rejects an event missing campaignId', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const repo = new OutboxRepository(db);
    const bad = { type: 'turn.locked', turnId: 't1' } as unknown as CampaignEvent;
    await expect(db.transaction((tx) => repo.publishIn(tx, bad))).rejects.toThrow();
    await db.close();
  });

  it('round-trips the payload and leaves published_at null', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const repo = new OutboxRepository(db);
    const event = submitted('c1', 'p1');
    await db.transaction((tx) => repo.publishIn(tx, event));
    const rows = await repo.listByCampaign('c1');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload_json)).toEqual(event);
    expect(rows[0].event_type).toBe('turn.action_submitted');
    expect(rows[0].visibility).toBe('public');
    expect(rows[0].target_player_id).toBeNull();
    expect(rows[0].published_at).toBeNull();
    await db.close();
  });

  it('writes owner.debug with owner_only visibility and no target', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const repo = new OutboxRepository(db);
    await db.transaction((tx) => repo.publishIn(tx, { type: 'owner.debug', campaignId: 'c1', runId: 'r1', kind: 'ctx' }));
    const rows = await repo.listByCampaign('c1');
    expect(rows[0].visibility).toBe('owner_only');
    expect(rows[0].target_player_id).toBeNull();
    await db.close();
  });
});
```

### Step 2：运行确认失败

```bash
rtk npm test -- --run packages/contracts/src/events.test.ts packages/contracts/src/contracts.test.ts server/src/platform/events/outbox.test.ts
```

预期：失败——`events.ts` 尚未补 `campaignId`/受众/`owner.debug`，`events.test.ts` 断言不满足；`OutboxRepository`/`EventPublisherPort` 不存在；`005_events_outbox.sql` 未创建。既有 `contracts.test.ts` 的 `database.row_dump` 用例仍通过（本阶段对 events 的既有测试无破坏样例，新增用例集中在 `events.test.ts`）。

### Step 3：实现

`server/src/platform/database/migrations/005_events_outbox.sql`（`published_at` 可空、`UNIQUE(campaign_id, sequence)` 仅作不变量）：

```sql
-- 005_events_outbox.sql
-- Transactional event outbox + per-campaign sequence counter.
-- New events are unpublished (published_at IS NULL). The sequence is allocated
-- by an atomic upsert of platform_outbox_sequences INSIDE the business
-- transaction; UNIQUE(campaign_id, sequence) is only an invariant, never the
-- allocation mechanism. Safe to re-run; portable across SQLite and PostgreSQL.

CREATE TABLE IF NOT EXISTS platform_outbox_sequences (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  last_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_outbox_events (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','owner_only','player_private')),
  target_player_id TEXT,
  payload_json TEXT NOT NULL,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (campaign_id, sequence)
);

CREATE INDEX IF NOT EXISTS platform_outbox_events_campaign_seq_idx
  ON platform_outbox_events(campaign_id, sequence);
```

`server/src/platform/events/EventPublisherPort.ts`：

```ts
import type { CampaignEvent } from '@dnd/contracts';
import type { QueryExecutor } from '../database/DatabasePort.js';

/** 领域事件发布端口：在业务事务内写入 outbox（同 tx 原子提交/回滚）。service 只依赖本端口，不 new concrete。 */
export interface EventPublisherPort {
  publishIn(tx: QueryExecutor, event: CampaignEvent): Promise<number>;
}
```

`server/src/platform/events/OutboxRepository.ts`（`publishIn` 的计数器与插入都用传入 tx；list 用基础 executor）：

```ts
import { nanoid } from 'nanoid';
import { campaignEventSchema, eventDefaultAudience, type CampaignEvent } from '@dnd/contracts';
import type { QueryExecutor } from '../database/DatabasePort.js';
import type { EventPublisherPort } from './EventPublisherPort.js';

export interface OutboxEventRow {
  id: string;
  campaign_id: string;
  sequence: number;
  event_type: string;
  visibility: 'public' | 'owner_only' | 'player_private';
  target_player_id: string | null;
  payload_json: string;
  published_at: string | null;
  created_at: string;
}

/**
 * Outbox 具体实现：publishIn 使用传入的 tx（业务事务内）完成 schema 校验、
 * 计数器分配 + 事件插入，与业务写同事务提交/回滚；绝不持有外部 executor 后在 tx 中绕开。
 */
export class OutboxRepository implements EventPublisherPort {
  constructor(private readonly executor: QueryExecutor) {}

  async publishIn(tx: QueryExecutor, event: CampaignEvent): Promise<number> {
    const parsed = campaignEventSchema.parse(event); // 校验每个 variant 的 campaignId 等
    const audience = eventDefaultAudience(parsed);
    const sequence = await nextSequence(tx, parsed.campaignId);
    await tx.execute(
      `INSERT INTO platform_outbox_events
        (id, campaign_id, sequence, event_type, visibility, target_player_id, payload_json, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [nanoid(24), parsed.campaignId, sequence, parsed.type, audience.visibility,
       audience.targetPlayerId, JSON.stringify(parsed), null, new Date().toISOString()],
    );
    return sequence;
  }

  async listByCampaign(campaignId: string): Promise<OutboxEventRow[]> {
    return this.executor.query<OutboxEventRow>(
      'SELECT * FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence ASC',
      [campaignId],
    );
  }

  async listUnpublished(campaignId: string): Promise<OutboxEventRow[]> {
    return this.executor.query<OutboxEventRow>(
      'SELECT * FROM platform_outbox_events WHERE campaign_id = ? AND published_at IS NULL ORDER BY sequence ASC',
      [campaignId],
    );
  }
}

/**
 * 每战役 sequence 原子分配：upsert 计数器 + RETURNING（SQLite >=3.35 与 Postgres 通用）。
 * 绝不用“读取后 MAX+1”；UNIQUE(campaign_id, sequence) 仅作不变量兜底。
 * 在事务内调用：counter 与事件同事务，回滚时两者都不留。
 */
export async function nextSequence(tx: QueryExecutor, campaignId: string): Promise<number> {
  const rows = await tx.query<{ last_seq: number }>(
    `INSERT INTO platform_outbox_sequences (campaign_id, last_seq)
     VALUES (?, 1)
     ON CONFLICT (campaign_id) DO UPDATE SET last_seq = platform_outbox_sequences.last_seq + 1
     RETURNING last_seq`,
    [campaignId],
  );
  return Number(rows[0].last_seq);
}
```

### Step 4：运行确认通过

```bash
rtk npm test -- --run packages/contracts/src/events.test.ts packages/contracts/src/contracts.test.ts server/src/platform/events/outbox.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：事件契约与 outbox 测试全绿；回滚用例确认 counter 与事件同滚（`SELECT campaign_id FROM platform_outbox_sequences` 为空）；build 把 `005_events_outbox.sql` 复制进 `dist`；既有 `contracts.test.ts` 不回退。

### Step 5：提交

```bash
rtk git add packages/contracts/src/events.ts packages/contracts/src/events.test.ts server/src/platform/database/migrations/005_events_outbox.sql server/src/platform/events
rtk git commit -m "feat: add campaign event contract and transactional outbox" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4：回合与行动（`006_turns_actions.sql` + service + route）

**依赖：** Task 3 的 `EventPublisherPort`/`OutboxRepository`（`TurnService` 依赖 port，app 注入 concrete）；Phase 1 的 `CharacterRepository`（本任务只读新增）与 `CampaignAuthContext`/`requireOwner`。Task 2 已占用迁移 004，本任务 006。

**目标：** `startTurn`（owner、campaign 行锁、无未终结回合、distinct approved、无批准 → `CHARACTER_NOT_APPROVED`、`MAX(number)+1` 仅在锁内安全）与 `submitAction`/`edit`（player only、turn 行锁、状态区分 `NOT_FOUND`/`TURN_LOCKED`/`TURN_NOT_ACTIVE`、approved + 必须 requirements、upsert 自己的 action、首次提交才发 `turn.action_submitted`、最后一名提交才发 `turn.locked`，两事件与业务写同 tx）。player 视角只见自己的 action，owner 视角见全部 action；事件与 list 不含正文。

> 进行中/未终结回合定义：`waiting_for_actions | locked | resolving | needs_owner_attention`。只有 `completed` 才允许开启下一回合。锁定后回合只能经 AI 结算或 owner 处理前进（产品规格 2026-08-01 rearchitecture 设计），因此 `locked` 同样阻挡新回合，避免重叠的进行中回合。

### Files

- Create: `server/src/platform/database/migrations/006_turns_actions.sql`
- Modify: `packages/contracts/src/turn.ts`
- Modify: `server/src/modules/characters/CharacterRepository.ts`（只读新增两个方法）
- Create: `server/src/modules/turns/TurnRepository.ts`
- Create: `server/src/modules/turns/TurnService.ts`
- Create: `server/src/modules/turns/turn.test.ts`
- Create: `server/src/routes/turnRoutes.ts`
- Modify: `server/src/app.ts`（追加 turn 路由）

### Step 1：写失败测试

在 `packages/contracts/src/turn.ts` 追加（复用既有 `turnStatusSchema`/`visibilitySchema`，不冲突）：

```ts
export const turnActionInputSchema = z.object({
  body: z.string().trim().min(1),
});
export type TurnActionInput = z.infer<typeof turnActionInputSchema>;

export const turnSummarySchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  number: z.number().int(),
  status: turnStatusSchema,
  lockedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TurnSummary = z.infer<typeof turnSummarySchema>;

export const turnActionSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  campaignId: z.string().min(1),
  playerId: z.string().min(1),
  body: z.string(),
  submittedAt: z.string(),
  updatedAt: z.string(),
});
export type TurnAction = z.infer<typeof turnActionSchema>;

export const turnProgressSchema = z.object({
  requiredPlayerIds: z.array(z.string().min(1)),
  submittedPlayerIds: z.array(z.string().min(1)),
  locked: z.boolean(),
});
export type TurnProgress = z.infer<typeof turnProgressSchema>;

/** 回合列表项：不含任何 action 正文。 */
export const turnListEntrySchema = z.object({
  turn: turnSummarySchema,
  progress: turnProgressSchema,
});
export type TurnListEntry = z.infer<typeof turnListEntrySchema>;

/** 玩家视角：只能看到自己的 action 正文。 */
export const turnPlayerViewSchema = z.object({
  turn: turnSummarySchema,
  myAction: turnActionSchema.nullable(),
  progress: turnProgressSchema,
});
export type TurnPlayerView = z.infer<typeof turnPlayerViewSchema>;

/** owner 视角：看到全部 action 正文。 */
export const turnOwnerViewSchema = z.object({
  turn: turnSummarySchema,
  actions: z.array(turnActionSchema),
  progress: turnProgressSchema,
});
export type TurnOwnerView = z.infer<typeof turnOwnerViewSchema>;
```

`server/src/modules/turns/turn.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { TurnService } from './TurnService.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const characters = new CharacterService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const a = await identity.register({ login: 'a@example.test', password: 'correct-password' });
  const b = await identity.register({ login: 'b@example.test', password: 'correct-password' });
  const c = await identity.register({ login: 'c@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  for (const user of [a, b, c]) {
    await campaigns.join({ userId: user.userId }, created.campaign.id, created.inviteCode);
  }
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
  const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
  const cCtx = await resolveCampaignContext(db, { userId: c.userId }, created.campaign.id);
  const approve = async (ctx: CampaignAuthContext, name: string) => {
    const draft = await characters.createDraft(ctx, { name, sheet: { ac: 14 } });
    await characters.submitForReview(ctx, draft.id);
    await characters.approve(ownerCtx, draft.id);
  };
  await approve(aCtx, '薇拉');
  await approve(bCtx, '卡恩');
  const service = new TurnService(db, new OutboxRepository(db));
  return { db, service, ownerCtx, aCtx, bCtx, cCtx };
}

describe('turns', () => {
  it('starts a turn requiring only the approved players', async () => {
    const { db, service, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    expect(turn.status).toBe('waiting_for_actions');
    expect(turn.number).toBe(1);
    const ownerView = await service.getView(ownerCtx, turn.id);
    if (!('actions' in ownerView)) throw new Error('expected owner view');
    expect(ownerView.progress.requiredPlayerIds.sort())
      .toEqual([aCtx.playerId as string, bCtx.playerId as string].sort());
    await db.close();
  });

  it('rejects a second start while a turn is active', async () => {
    const { db, service, ownerCtx } = await makeFixture();
    await service.startTurn(ownerCtx);
    await expect(service.startTurn(ownerCtx)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('rejects starting a new turn while a locked turn is unresolved', async () => {
    const { db, service, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    await service.submitAction(aCtx, turn.id, { body: 'A 行动' });
    await service.submitAction(bCtx, turn.id, { body: 'B 行动' });
    // locked 也是进行中：只能经 AI 结算或 owner 处理前进，不能开新回合。
    await expect(service.startTurn(ownerCtx)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('rejects starting a new turn while a turn is resolving or needs owner attention', async () => {
    const { db, service, ownerCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'resolving' WHERE id = ?", [turn.id]);
    await expect(service.startTurn(ownerCtx)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.execute("UPDATE platform_turns SET status = 'needs_owner_attention' WHERE id = ?", [turn.id]);
    await expect(service.startTurn(ownerCtx)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('allows starting the next turn after the previous one is completed', async () => {
    const { db, service, ownerCtx } = await makeFixture();
    const first = await service.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [
      new Date().toISOString(), first.id,
    ]);
    const next = await service.startTurn(ownerCtx);
    expect(next.number).toBe(2);
    expect(next.status).toBe('waiting_for_actions');
    await db.close();
  });

  it('serializes concurrent startTurn so exactly one wins and the other gets STATE_CONFLICT', async () => {
    const { db, service, ownerCtx } = await makeFixture();
    const results = await Promise.allSettled([
      service.startTurn(ownerCtx),
      service.startTurn(ownerCtx),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { code?: string }).code).toBe('STATE_CONFLICT');
    const rows = await db.query<{ number: number; status: string }>(
      'SELECT number, status FROM platform_turns ORDER BY number',
    );
    expect(rows.map((r) => r.number)).toEqual([1]);
    expect(rows[0].status).toBe('waiting_for_actions');
    await db.close();
  });

  it('rejects startTurn without any approved character', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const identity = new IdentityService(db);
    const campaigns = new CampaignService(db);
    const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
    const created = await campaigns.create(owner.userId, { name: '空房', ruleset: 'dnd5e' });
    const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
    const service = new TurnService(db, new OutboxRepository(db));
    await expect(service.startTurn(ownerCtx)).rejects.toMatchObject({ code: 'CHARACTER_NOT_APPROVED' });
    await db.close();
  });

  it('locks after the last submit and emits 2 action_submitted + 1 locked once (edit adds no event)', async () => {
    const { db, service, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    const aView = await service.submitAction(aCtx, turn.id, { body: '我搜索房间。' });
    expect(aView.progress.submittedPlayerIds).toEqual([aCtx.playerId]);
    // A 锁前编辑：不重复发 progress 事件。
    await service.submitAction(aCtx, turn.id, { body: '我仔细搜索房间。' });
    const bView = await service.submitAction(bCtx, turn.id, { body: '我警戒门口。' });
    expect(bView.turn.status).toBe('locked');
    const rows = await db.query<{ sequence: number; event_type: string; payload_json: string }>(
      'SELECT sequence, event_type, payload_json FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence',
      [turn.campaignId],
    );
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.event_type)).toEqual([
      'turn.action_submitted', 'turn.action_submitted', 'turn.locked',
    ]);
    for (const row of rows) {
      expect(row.payload_json).not.toContain('搜索房间');
      expect(row.payload_json).not.toContain('警戒门口');
    }
    await db.close();
  });

  it('rejects editing after the turn is locked', async () => {
    const { db, service, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    await service.submitAction(aCtx, turn.id, { body: 'A 行动' });
    await service.submitAction(bCtx, turn.id, { body: 'B 行动' });
    await expect(service.submitAction(aCtx, turn.id, { body: '锁后修改' }))
      .rejects.toMatchObject({ code: 'TURN_LOCKED' });
    await db.close();
  });

  it('rejects an unapproved player and an owner submit', async () => {
    const { db, service, ownerCtx, cCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    await expect(service.submitAction(cCtx, turn.id, { body: '尝试' }))
      .rejects.toMatchObject({ code: 'CHARACTER_NOT_APPROVED' });
    await expect(service.submitAction(ownerCtx, turn.id, { body: 'owner 尝试' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.close();
  });

  it('assigns concurrent submits distinct sequences and locks exactly once', async () => {
    const { db, service, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    await Promise.all([
      service.submitAction(aCtx, turn.id, { body: 'A 并发' }),
      service.submitAction(bCtx, turn.id, { body: 'B 并发' }),
    ]);
    const rows = await db.query<{ sequence: number; event_type: string }>(
      'SELECT sequence, event_type FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence',
      [turn.campaignId],
    );
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(rows.filter((r) => r.event_type === 'turn.locked')).toHaveLength(1);
    await db.close();
  });

  it('keeps player action bodies private in player view and visible to owner', async () => {
    const { db, service, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    await service.submitAction(aCtx, turn.id, { body: 'A 的私密行动' });
    const bView = await service.getView(bCtx, turn.id);
    if (!('myAction' in bView)) throw new Error('expected player view');
    expect(bView.myAction).toBeNull();
    expect(JSON.stringify(bView)).not.toContain('A 的私密行动');
    const ownerView = await service.getView(ownerCtx, turn.id);
    if (!('actions' in ownerView)) throw new Error('expected owner view');
    expect(ownerView.actions.map((action) => action.body)).toContain('A 的私密行动');
    await db.close();
  });

  it('lists turns without action bodies', async () => {
    const { db, service, ownerCtx, aCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    await service.submitAction(aCtx, turn.id, { body: 'A 行动' });
    const list = await service.listForCampaign(ownerCtx);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('A 行动');
    expect(list[0].progress.requiredPlayerIds).toHaveLength(2);
    await db.close();
  });
});
```

### Step 2：运行确认失败

```bash
rtk npm test -- --run server/src/modules/turns/turn.test.ts
```

预期：失败——`TurnService`/`TurnRepository` 不存在；`006_turns_actions.sql` 未创建；`CharacterRepository` 缺 `listApprovedPlayerIds`。

### Step 3：实现

`server/src/platform/database/migrations/006_turns_actions.sql`（规范化 requirements、FK/unique/portable；turn 含 `locked_at`/`completed_at`）：

```sql
-- 006_turns_actions.sql
-- Turn lifecycle and player actions.
-- platform_turn_requirements normalises which players must act per turn and
-- whether each has submitted; platform_actions upserts per (turn, player).
-- Safe to re-run; portable across SQLite and PostgreSQL.

CREATE TABLE IF NOT EXISTS platform_turns (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting_for_actions','locked','resolving','needs_owner_attention','completed')),
  locked_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (campaign_id, number)
);

CREATE INDEX IF NOT EXISTS platform_turns_campaign_idx
  ON platform_turns(campaign_id, number);

CREATE TABLE IF NOT EXISTS platform_actions (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  player_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (turn_id, player_id)
);

CREATE INDEX IF NOT EXISTS platform_actions_turn_idx
  ON platform_actions(turn_id, player_id);

CREATE TABLE IF NOT EXISTS platform_turn_requirements (
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  player_id TEXT NOT NULL REFERENCES users(id),
  submitted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (turn_id, player_id)
);

CREATE INDEX IF NOT EXISTS platform_turn_requirements_turn_idx
  ON platform_turn_requirements(turn_id, submitted);
```

`server/src/modules/characters/CharacterRepository.ts` 只读新增（追加在 `listByCampaign` 之后；不改既有方法）：

```ts
  /** 只读：该 campaign 已批准角色数量。 */
  async countApproved(campaignId: string): Promise<number> {
    const rows = await this.executor.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_characters WHERE campaign_id = ? AND status = ?',
      [campaignId, 'approved'],
    );
    return Number(rows[0].count);
  }

  /** 只读：该 campaign 已批准角色的 DISTINCT player_id（决定回合必需玩家）。 */
  async listApprovedPlayerIds(campaignId: string): Promise<string[]> {
    const rows = await this.executor.query<{ player_id: string }>(
      'SELECT DISTINCT player_id FROM platform_characters WHERE campaign_id = ? AND status = ? ORDER BY player_id',
      [campaignId, 'approved'],
    );
    return rows.map((row) => row.player_id);
  }
```

`server/src/modules/turns/TurnRepository.ts`（方法签名 + SQL；所有方法接收 `QueryExecutor`，可注入 tx）：

```ts
import type { TurnStatus } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface TurnRow {
  id: string;
  campaign_id: string;
  number: number;
  status: TurnStatus;
  locked_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActionRow {
  id: string;
  turn_id: string;
  campaign_id: string;
  player_id: string;
  body: string;
  submitted_at: string;
  updated_at: string;
}

export interface RequirementRow {
  turn_id: string;
  campaign_id: string;
  player_id: string;
  submitted: number;
}

export class TurnRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async insertTurn(row: TurnRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_turns
        (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.number, row.status, row.locked_at, row.completed_at,
       row.created_at, row.updated_at],
    );
  }

  async findTurnById(id: string): Promise<TurnRow | null> {
    const rows = await this.executor.query<TurnRow>('SELECT * FROM platform_turns WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  /**
   * 查找战役内未终结（进行中）的回合：waiting_for_actions / locked / resolving /
   * needs_owner_attention 都算进行中，只有 completed 才允许开启下一回合。
   * 锁定后回合只能经 AI 结算或 owner 处理前进（产品规格 2026-08-01 rearchitecture
   * 设计：锁定后“所有行动不可修改；回合只能通过 AI 结算或拥有者处理流程前进”），
   * 因此 locked 也阻挡新回合，避免出现重叠的进行中回合。
   */
  async findUnfinishedTurn(campaignId: string): Promise<TurnRow | null> {
    const rows = await this.executor.query<TurnRow>(
      "SELECT * FROM platform_turns WHERE campaign_id = ? AND status IN ('waiting_for_actions','locked','resolving','needs_owner_attention') ORDER BY number ASC LIMIT 1",
      [campaignId],
    );
    return rows[0] ?? null;
  }

  async listByCampaign(campaignId: string): Promise<TurnRow[]> {
    return this.executor.query<TurnRow>(
      'SELECT * FROM platform_turns WHERE campaign_id = ? ORDER BY number ASC',
      [campaignId],
    );
  }

  async maxTurnNumber(campaignId: string): Promise<number> {
    const rows = await this.executor.query<{ max: number | null }>(
      'SELECT MAX(number) AS max FROM platform_turns WHERE campaign_id = ?',
      [campaignId],
    );
    return Number(rows[0].max ?? 0);
  }

  /** 条件 no-op 更新：获得 turn 行锁（Postgres 行锁；SQLite 写事务串行），未命中表示不存在。 */
  async lockTurnRow(turnId: string, campaignId: string): Promise<boolean> {
    const result = await this.executor.execute(
      'UPDATE platform_turns SET updated_at = updated_at WHERE id = ? AND campaign_id = ?',
      [turnId, campaignId],
    );
    return result.changes === 1;
  }

  /** 状态迁移：仅当仍为 waiting_for_actions 时锁定；返回是否命中（防止重复发 locked 事件）。 */
  async lockTurn(turnId: string, lockedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      "UPDATE platform_turns SET status = 'locked', locked_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting_for_actions'",
      [lockedAt, lockedAt, turnId],
    );
    return result.changes === 1;
  }

  async insertRequirement(turnId: string, campaignId: string, playerId: string): Promise<void> {
    await this.executor.execute(
      'INSERT INTO platform_turn_requirements (turn_id, campaign_id, player_id, submitted) VALUES (?, ?, ?, 0)',
      [turnId, campaignId, playerId],
    );
  }

  async listRequirements(turnId: string): Promise<RequirementRow[]> {
    return this.executor.query<RequirementRow>(
      'SELECT * FROM platform_turn_requirements WHERE turn_id = ? ORDER BY player_id',
      [turnId],
    );
  }

  async isRequired(turnId: string, playerId: string): Promise<boolean> {
    const rows = await this.executor.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_turn_requirements WHERE turn_id = ? AND player_id = ?',
      [turnId, playerId],
    );
    return Number(rows[0].count) > 0;
  }

  async markRequirementSubmitted(turnId: string, playerId: string): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_turn_requirements SET submitted = 1 WHERE turn_id = ? AND player_id = ?',
      [turnId, playerId],
    );
  }

  async countSubmitted(turnId: string): Promise<number> {
    const rows = await this.executor.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_turn_requirements WHERE turn_id = ? AND submitted = 1',
      [turnId],
    );
    return Number(rows[0].count);
  }

  async countTotal(turnId: string): Promise<number> {
    const rows = await this.executor.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_turn_requirements WHERE turn_id = ?',
      [turnId],
    );
    return Number(rows[0].count);
  }

  async insertAction(row: ActionRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_actions
        (id, turn_id, campaign_id, player_id, body, submitted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.turn_id, row.campaign_id, row.player_id, row.body, row.submitted_at, row.updated_at],
    );
  }

  async updateActionBody(actionId: string, body: string, updatedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      'UPDATE platform_actions SET body = ?, updated_at = ? WHERE id = ?',
      [body, updatedAt, actionId],
    );
    return result.changes === 1;
  }

  async findActionByTurnPlayer(turnId: string, playerId: string): Promise<ActionRow | null> {
    const rows = await this.executor.query<ActionRow>(
      'SELECT * FROM platform_actions WHERE turn_id = ? AND player_id = ?',
      [turnId, playerId],
    );
    return rows[0] ?? null;
  }

  async listActionsByTurn(turnId: string): Promise<ActionRow[]> {
    return this.executor.query<ActionRow>(
      'SELECT * FROM platform_actions WHERE turn_id = ? ORDER BY submitted_at ASC',
      [turnId],
    );
  }
}
```

`server/src/modules/turns/TurnService.ts`（**事务正确性核心**：`startTurn` 与 `submitAction` 的完整算法见下；`TurnService` 依赖 `EventPublisherPort` 端口，不 new concrete）：

```ts
import { nanoid } from 'nanoid';
import type {
  TurnAction, TurnActionInput, TurnListEntry, TurnOwnerView, TurnPlayerView, TurnProgress, TurnSummary,
} from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';
import { TurnRepository, type ActionRow, type TurnRow } from './TurnRepository.js';

export class TurnService {
  private readonly repository: TurnRepository;

  constructor(
    private readonly executor: DatabasePort,
    private readonly outbox: EventPublisherPort,
  ) {
    this.repository = new TurnRepository(executor);
  }

  /** owner 开始新回合：campaign 行锁 → 无未终结回合 → distinct approved → MAX+1（锁内安全）→ insert turn+requirements。 */
  async startTurn(ctx: CampaignAuthContext): Promise<TurnSummary> {
    requireOwner(ctx);
    return this.executor.transaction(async (tx) => {
      // 1) campaign 行锁：no-op 写（Postgres 行锁；SQLite 写事务串行）。
      await tx.execute('UPDATE campaigns SET updated_at = updated_at WHERE id = ?', [ctx.campaignId]);
      const repo = new TurnRepository(tx);
      // 2) 无未终结（进行中）回合：locked/resolving/needs_owner_attention 同样阻挡新回合，
      //    只有 completed 才允许下一回合。
      const active = await repo.findUnfinishedTurn(ctx.campaignId);
      if (active) {
        throw new AppError('STATE_CONFLICT', '已有进行中的回合。');
      }
      // 3) distinct approved players；无批准 → CHARACTER_NOT_APPROVED。
      const characters = new CharacterRepository(tx);
      const playerIds = await characters.listApprovedPlayerIds(ctx.campaignId);
      if (playerIds.length === 0) {
        throw new AppError('CHARACTER_NOT_APPROVED', '没有已批准的角色，无法开始回合。');
      }
      // 4) MAX(number)+1：campaign 行已被本事务锁住，并发安全。
      const number = (await repo.maxTurnNumber(ctx.campaignId)) + 1;
      const now = new Date().toISOString();
      const turnId = nanoid(24);
      await repo.insertTurn({
        id: turnId, campaign_id: ctx.campaignId, number, status: 'waiting_for_actions',
        locked_at: null, completed_at: null, created_at: now, updated_at: now,
      });
      for (const playerId of playerIds) {
        await repo.insertRequirement(turnId, ctx.campaignId, playerId);
      }
      return mapSummary((await repo.findTurnById(turnId)) as TurnRow);
    });
  }

  /** 玩家提交/编辑自己的行动。首次提交才发 progress 事件；最后一名提交才锁定并发 locked 事件；两事件与业务写同 tx。 */
  async submitAction(
    ctx: CampaignAuthContext,
    turnId: string,
    input: TurnActionInput,
  ): Promise<TurnPlayerView> {
    if (ctx.role !== 'player' || !ctx.playerId) {
      throw new AppError('FORBIDDEN', '只有玩家可以提交行动。');
    }
    return this.executor.transaction(async (tx) => {
      const repo = new TurnRepository(tx);
      // 1) 条件 no-op 更新 turn 行获得锁；未命中 → NOT_FOUND。
      const lockedRow = await repo.lockTurnRow(turnId, ctx.campaignId);
      if (!lockedRow) {
        throw new AppError('NOT_FOUND', '回合不存在。');
      }
      // 2) 读状态：区分 NOT_FOUND / TURN_LOCKED / TURN_NOT_ACTIVE。
      const turn = await repo.findTurnById(turnId);
      if (!turn) {
        throw new AppError('NOT_FOUND', '回合不存在。');
      }
      if (turn.status !== 'waiting_for_actions') {
        if (turn.status === 'locked') {
          throw new AppError('TURN_LOCKED', '回合已锁定，无法修改行动。');
        }
        throw new AppError('TURN_NOT_ACTIVE', '当前回合状态不允许提交行动。');
      }
      // 3) 必须是已批准角色。
      const characters = new CharacterRepository(tx);
      const approvedIds = await characters.listApprovedPlayerIds(ctx.campaignId);
      if (!approvedIds.includes(ctx.playerId)) {
        throw new AppError('CHARACTER_NOT_APPROVED', '你的角色尚未通过审核。');
      }
      // 4) 必须是本回合必需玩家。
      if (!(await repo.isRequired(turnId, ctx.playerId))) {
        throw new AppError('FORBIDDEN', '你不是该回合的必需玩家。');
      }
      // 5) upsert 自己的 action（UNIQUE(turn_id, player_id)）。
      const existing = await repo.findActionByTurnPlayer(turnId, ctx.playerId);
      const now = new Date().toISOString();
      let firstSubmit = false;
      if (existing) {
        await repo.updateActionBody(existing.id, input.body, now);
      } else {
        await repo.insertAction({
          id: nanoid(24), turn_id: turnId, campaign_id: ctx.campaignId, player_id: ctx.playerId,
          body: input.body, submitted_at: now, updated_at: now,
        });
        await repo.markRequirementSubmitted(turnId, ctx.playerId);
        firstSubmit = true;
      }
      // 6) 首次提交才发 progress 事件（锁前编辑不发，避免重复）。
      if (firstSubmit) {
        await this.outbox.publishIn(tx, {
          type: 'turn.action_submitted', campaignId: ctx.campaignId, turnId, playerId: ctx.playerId,
        });
      }
      // 7) 最后一名提交 → 锁定 + locked 事件（条件锁定防重复）。
      const submitted = await repo.countSubmitted(turnId);
      const total = await repo.countTotal(turnId);
      if (total > 0 && submitted >= total) {
        const didLock = await repo.lockTurn(turnId, now);
        if (didLock) {
          await this.outbox.publishIn(tx, {
            type: 'turn.locked', campaignId: ctx.campaignId, turnId,
          });
        }
      }
      // 8) service 返回在 commit 后（transaction 提交后才 resolve）。
      return this.playerView(tx, turnId, ctx.playerId);
    });
  }

  /** 回合列表：只有 summary + progress，不含任何 action 正文。 */
  async listForCampaign(ctx: CampaignAuthContext): Promise<TurnListEntry[]> {
    const rows = await this.repository.listByCampaign(ctx.campaignId);
    const entries: TurnListEntry[] = [];
    for (const row of rows) {
      entries.push({ turn: mapSummary(row), progress: await this.progressOf(this.executor, row.id) });
    }
    return entries;
  }

  /** owner 视角见全部 actions；player 视角只见自己的 myAction。 */
  async getView(ctx: CampaignAuthContext, turnId: string): Promise<TurnPlayerView | TurnOwnerView> {
    const turn = await this.repository.findTurnById(turnId);
    if (!turn || turn.campaign_id !== ctx.campaignId) {
      throw new AppError('NOT_FOUND', '回合不存在。');
    }
    if (ctx.role === 'owner') {
      return {
        turn: mapSummary(turn),
        actions: (await this.repository.listActionsByTurn(turnId)).map(mapAction),
        progress: await this.progressOf(this.executor, turnId),
      };
    }
    const myAction = await this.repository.findActionByTurnPlayer(turnId, ctx.playerId ?? '');
    return {
      turn: mapSummary(turn),
      myAction: myAction ? mapAction(myAction) : null,
      progress: await this.progressOf(this.executor, turnId),
    };
  }

  private async playerView(tx: QueryExecutor, turnId: string, playerId: string): Promise<TurnPlayerView> {
    const repo = new TurnRepository(tx);
    const turn = await repo.findTurnById(turnId);
    if (!turn) throw new AppError('NOT_FOUND', '回合不存在。');
    const myAction = await repo.findActionByTurnPlayer(turnId, playerId);
    return {
      turn: mapSummary(turn),
      myAction: myAction ? mapAction(myAction) : null,
      progress: await this.progressOf(tx, turnId),
    };
  }

  private async progressOf(executor: QueryExecutor, turnId: string): Promise<TurnProgress> {
    const repo = new TurnRepository(executor);
    const requirements = await repo.listRequirements(turnId);
    const turn = await repo.findTurnById(turnId);
    return {
      requiredPlayerIds: requirements.map((r) => r.player_id),
      submittedPlayerIds: requirements.filter((r) => r.submitted === 1).map((r) => r.player_id),
      locked: turn?.status === 'locked',
    };
  }
}

function mapSummary(row: TurnRow): TurnSummary {
  return {
    id: row.id, campaignId: row.campaign_id, number: row.number, status: row.status,
    lockedAt: row.locked_at, completedAt: row.completed_at, createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAction(row: ActionRow): TurnAction {
  return {
    id: row.id, turnId: row.turn_id, campaignId: row.campaign_id, playerId: row.player_id,
    body: row.body, submittedAt: row.submitted_at, updatedAt: row.updated_at,
  };
}
```

`server/src/routes/turnRoutes.ts`（`mergeParams` + campaign middleware；`POST /:turnId/actions` 只玩家）：

```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { turnActionInputSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { TurnService } from '../modules/turns/TurnService.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';

export function createTurnRouter(executor: QueryExecutor, turns: TurnService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.json({ turns: await turns.listForCampaign(getCampaignContext(req)) });
  }));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ turn: await turns.startTurn(getCampaignContext(req)) });
  }));

  router.get('/:turnId', asyncHandler(async (req: Request, res: Response) => {
    res.json({ view: await turns.getView(getCampaignContext(req), stringParam(req, 'turnId')) });
  }));

  router.post('/:turnId/actions', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = turnActionInputSchema.parse(req.body);
    res.json({ view: await turns.submitAction(ctx, stringParam(req, 'turnId'), input) });
  }));

  return router;
}

function stringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) {
    throw new AppError('NOT_FOUND', '回合不存在。');
  }
  return value;
}
```

`server/src/app.ts` 挂载（追加在 world 路由之后、`errorMiddleware` 之前；注入 concrete `OutboxRepository`）：

```ts
import { TurnService } from './modules/turns/TurnService.js';
import { OutboxRepository } from './platform/events/OutboxRepository.js';
import { createTurnRouter } from './routes/turnRoutes.js';
// ...
if (options.platformDb) {
  // ... 既有 identity/campaigns/characters/worldFacts ...
  const turns = new TurnService(options.platformDb, new OutboxRepository(options.platformDb));
  app.use('/api/campaigns/:campaignId/world', createWorldRouter(options.platformDb, worldFacts));
  app.use('/api/campaigns/:campaignId/turns', createTurnRouter(options.platformDb, turns));
  app.use(errorMiddleware);
}
```

### Step 4：运行确认通过

```bash
rtk npm test -- --run server/src/modules/turns/turn.test.ts server/src/modules/characters/character.test.ts server/src/platform/events/outbox.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：回合测试全绿——A 提交 + A 编辑 + B 提交 → outbox `[1,2,3]` / `[action_submitted, action_submitted, locked]`；并发 A/B 只发一次 `turn.locked`；锁后 409 `TURN_LOCKED`；玩家/owner 视图隐私成立；list 无 action 正文；既有角色/outbox 测试不回退；`006_turns_actions.sql` 被复制进 `dist`。

### Step 5：提交

```bash
rtk git add server/src/platform/database/migrations/006_turns_actions.sql packages/contracts/src/turn.ts server/src/modules/characters/CharacterRepository.ts server/src/modules/turns server/src/routes/turnRoutes.ts server/src/app.ts
rtk git commit -m "feat: add turn and action lifecycle with atomic outbox events" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5：HTTP 垂直验收（world + outbox + turns）

**依赖：** Task 1（共享 harness）、Task 2（world 路由）、Task 3（outbox）、Task 4（turn 路由）。Phase 1 的角色 HTTP 垂直流程（owner/player/playerB 三 cookie jar）已建，本任务在其上扩展。

**目标：** 用共享 harness 的内存 SQLite + owner/playerA/playerB 三 actor 跑通完整流程：创建战役 → 加入 → 创建/提交/审核角色 → owner 建四类 world fact → A/B 投影隔离且 knownBy 不泄漏 → owner 开始回合（要求 A/B）→ A 提交/编辑 → B 提交 → 回合锁定 → A 锁后 409 `TURN_LOCKED` → outbox 直查 sequence/types/payload/published_at。本任务是独立验收测试，不要求先红。

### Files

- Create: `server/src/tests/vertical-world-outbox-turns-http.test.ts`

### Step 1：写验收测试

`server/src/tests/vertical-world-outbox-turns-http.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { jsonHeaders, registerAndLogin, startPlatformServer } from './httpTestHarness.js';

interface Actor {
  userId: string;
  cookieHeader: string;
}

async function createCharacter(
  charsBase: string,
  actor: Actor,
  name: string,
  ac: number,
): Promise<string> {
  const createRes = await fetch(`${charsBase}`, {
    method: 'POST',
    headers: jsonHeaders(actor.cookieHeader),
    body: JSON.stringify({ name, sheet: { ac } }),
  });
  expect(createRes.status).toBe(201);
  const body = (await createRes.json()) as { character: { id: string } };
  const submitRes = await fetch(`${charsBase}/${body.character.id}/submit`, {
    method: 'POST',
    headers: jsonHeaders(actor.cookieHeader),
  });
  expect(submitRes.status).toBe(200);
  return body.character.id;
}

describe('HTTP world + outbox + turns vertical flow', () => {
  it('projects world facts per player, locks the turn after the last submit, and emits ordered outbox events without bodies', async () => {
    const server = await startPlatformServer();
    try {
      const { baseUrl, platformDb } = server;
      const owner = await registerAndLogin(baseUrl, 'owner@example.test');
      const playerA = await registerAndLogin(baseUrl, 'a@example.test');
      const playerB = await registerAndLogin(baseUrl, 'b@example.test');

      const createRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'POST', headers: jsonHeaders(owner.cookieHeader),
        body: JSON.stringify({ name: '失落矿坑', ruleset: 'dnd5e' }),
      });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };

      for (const actor of [playerA, playerB]) {
        const joinRes = await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}/join`, {
          method: 'POST', headers: jsonHeaders(actor.cookieHeader),
          body: JSON.stringify({ inviteCode: createBody.inviteCode }),
        });
        expect(joinRes.status).toBe(201);
      }

      const charsBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/characters`;
      const aCharId = await createCharacter(charsBase, playerA, '薇拉', 14);
      const bCharId = await createCharacter(charsBase, playerB, '卡恩', 16);
      for (const charId of [aCharId, bCharId]) {
        const review = await fetch(`${charsBase}/${charId}/review`, {
          method: 'POST', headers: jsonHeaders(owner.cookieHeader),
          body: JSON.stringify({ action: 'approve' }),
        });
        expect(review.status).toBe(200);
      }

      // --- world facts：owner 建 public / A-private / B-private / owner-only ---
      const worldBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/world`;
      const createFact = async (body: Record<string, unknown>) => {
        const res = await fetch(`${worldBase}`, {
          method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify(body),
        });
        expect(res.status).toBe(201);
        return (await res.json()) as { fact: { id: string } };
      };
      await createFact({ title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public' });
      await createFact({ title: 'A 的密信', kind: 'item', content: '给 A。', visibility: 'player_private', knownBy: [playerA.userId] });
      await createFact({ title: 'B 的密信', kind: 'item', content: '给 B。', visibility: 'player_private', knownBy: [playerB.userId] });
      await createFact({ title: '隐秘布局', kind: 'lore', content: '只有你知道。', visibility: 'owner_only' });

      const aWorld = (await (await fetch(`${worldBase}`, { headers: { cookie: playerA.cookieHeader } })).json()) as {
        projection: { facts: Array<{ title: string; knownBy: string[] }> };
      };
      expect(aWorld.projection.facts.map((f) => f.title).sort()).toEqual(['A 的密信', '酒馆']);
      expect(aWorld.projection.facts.every((f) => f.knownBy.length <= 1)).toBe(true);
      expect(JSON.stringify(aWorld)).not.toContain(playerB.userId);

      const bWorld = (await (await fetch(`${worldBase}`, { headers: { cookie: playerB.cookieHeader } })).json()) as {
        projection: { facts: Array<{ title: string }> };
      };
      expect(bWorld.projection.facts.map((f) => f.title).sort()).toEqual(['B 的密信', '酒馆']);

      const ownerWorld = (await (await fetch(`${worldBase}`, { headers: { cookie: owner.cookieHeader } })).json()) as {
        projection: { facts: Array<{ title: string; knownBy: string[] }> };
      };
      expect(ownerWorld.projection.facts).toHaveLength(4);
      expect(JSON.stringify(ownerWorld.projection.facts)).toContain(playerA.userId);

      // --- turns ---
      const turnsBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/turns`;
      const startRes = await fetch(`${turnsBase}`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader) });
      expect(startRes.status).toBe(201);
      const startBody = (await startRes.json()) as { turn: { id: string; number: number } };
      const turnId = startBody.turn.id;
      expect(startBody.turn.number).toBe(1);

      const submit = async (actor: Actor, body: string) => {
        const res = await fetch(`${turnsBase}/${turnId}/actions`, {
          method: 'POST', headers: jsonHeaders(actor.cookieHeader), body: JSON.stringify({ body }),
        });
        return res;
      };

      const aSubmit = await submit(playerA, '我搜索房间。');
      expect(aSubmit.status).toBe(200);
      const aView = (await aSubmit.json()) as {
        view: { turn: { status: string }; progress: { submittedPlayerIds: string[] } };
      };
      expect(aView.view.turn.status).toBe('waiting_for_actions');
      expect(aView.view.progress.submittedPlayerIds).toEqual([playerA.userId]);

      // A 锁前编辑：不重复发 progress 事件。
      const aEdit = await submit(playerA, '我仔细搜索房间。');
      expect(aEdit.status).toBe(200);

      const bSubmit = await submit(playerB, '我警戒门口。');
      expect(bSubmit.status).toBe(200);
      const bView = (await bSubmit.json()) as { view: { turn: { status: string } } };
      expect(bView.view.turn.status).toBe('locked');

      // A 锁后提交 → 409 TURN_LOCKED。
      const aLocked = await submit(playerA, '锁后想改');
      expect(aLocked.status).toBe(409);
      const lockedBody = (await aLocked.json()) as { error: { code: string } };
      expect(lockedBody.error.code).toBe('TURN_LOCKED');

      // outbox 直查：sequence [1,2,3]、types、payload 无正文、published_at null。
      const outboxRows = await platformDb.query<{
        sequence: number; event_type: string; payload_json: string; published_at: string | null;
      }>(
        'SELECT sequence, event_type, payload_json, published_at FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence',
        [createBody.campaign.id],
      );
      expect(outboxRows.map((r) => r.sequence)).toEqual([1, 2, 3]);
      expect(outboxRows.map((r) => r.event_type)).toEqual([
        'turn.action_submitted', 'turn.action_submitted', 'turn.locked',
      ]);
      for (const row of outboxRows) {
        expect(row.payload_json).not.toContain('搜索房间');
        expect(row.payload_json).not.toContain('警戒门口');
        expect(row.published_at).toBeNull();
      }

      // B 看不到 A 正文；owner 看全。
      const bTurnView = (await (await fetch(`${turnsBase}/${turnId}`, { headers: { cookie: playerB.cookieHeader } })).json()) as {
        view: { myAction: { body: string } | null };
      };
      expect(JSON.stringify(bTurnView)).not.toContain('搜索房间');
      expect(bTurnView.view.myAction?.body).toBe('我警戒门口。');
      const ownerTurnView = (await (await fetch(`${turnsBase}/${turnId}`, { headers: { cookie: owner.cookieHeader } })).json()) as {
        view: { actions: Array<{ body: string; playerId: string }> };
      };
      expect(ownerTurnView.view.actions.map((a) => a.body).sort()).toEqual(['我仔细搜索房间。', '我警戒门口。']);

      // turn list 无 action 正文。
      const turnList = (await (await fetch(`${turnsBase}`, { headers: { cookie: owner.cookieHeader } })).json()) as { turns: unknown[] };
      expect(JSON.stringify(turnList)).not.toContain('搜索房间');
      expect(JSON.stringify(turnList)).not.toContain('警戒门口');

      // DTO 无 *_json / 内部字段。
      expect(JSON.stringify(ownerWorld)).not.toContain('_json');
      expect(JSON.stringify(ownerTurnView)).not.toContain('_json');
    } finally {
      await server.close();
    }
  });
});
```

### Step 2：运行确认通过

```bash
rtk npm test -- --run server/src/tests/vertical-world-outbox-turns-http.test.ts
```

预期：**直接通过**——Task 2-4 已把 world/turn 路由挂到 `createApp`，outbox 由 `TurnService` 同事务写入；本验收测试验证该整合（world 投影隔离、knownBy 不泄漏、回合锁定、outbox 顺序/内容/未发布、隐私与 DTO 洁净）。若此步失败，按 Step 3 错误形态清单定位 Task 2-4 缺陷并修复，不是改测试绕过。

### Step 3：无新生产文件（错误形态检查清单）

本任务没有新生产文件。若验收失败，逐项检查：

- world 投影把 `owner_only` 内容或完整 `knownBy` 泄露给玩家（`knownBy.length <= 1` 与 `not.toContain(playerB.userId)` 断言暴露）。
- 玩家调用 `POST /turns` 或 `POST /world` 成功（应 `FORBIDDEN`）。
- A 编辑重复发 `turn.action_submitted`（outbox 变成 4 行）。
- 无 `campaign` 行锁 / turn 行锁时并发提交出现 sequence 冲突或重复 `turn.locked`。
- `published_at` 非 null（新事件未发布）；`payload_json` 含行动正文。
- B 的 turn 视图含 A 的 action 正文；owner 视图缺失某 action。
- turn list 或 DTO 含 `*_json`/`player_id` 等内部字段。
- 路由未用 `mergeParams` 或挂在 `errorMiddleware` 之后。

### Step 4：全量相关测试

```bash
rtk npm test -- --run server/src/tests/vertical-world-outbox-turns-http.test.ts server/src/tests/vertical-characters-http.test.ts server/src/tests/authCampaignRoutes.test.ts server/src/modules/turns/turn.test.ts server/src/modules/world/world.test.ts server/src/platform/events/outbox.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：垂直验收、共享 harness 重构后的两个既有 HTTP 测试、world/turn/outbox 模块测试全绿；typecheck/build 通过；`004/005/006` 三份迁移均被复制进 `dist`。全程使用内存 SQLite，不触碰真实 `server/dnd.sqlite`。

### Step 5：提交

```bash
rtk git add server/src/tests/vertical-world-outbox-turns-http.test.ts
rtk git commit -m "test: verify world/outbox/turn HTTP vertical flow with three actors" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 本阶段验收门检查清单（全部完成后勾选）

- [ ] 共享 HTTP harness 抽取完成：`startPlatformServer` 返回 `platformDb`；`close()` 先关 server 再关 platformDb；既有 `authCampaignRoutes`/`vertical-characters-http` 断言行为不变、全绿
- [ ] `004_world_state.sql` 创建；world contract + service + route 测试通过；owner 写、player 只读投影、knownBy 收敛 `[]`/自己、owner_only 不外泄、非成员 knownBy 拒绝；update 保留原 `created_at`（仅 `updated_at` 前进）
- [ ] `005_events_outbox.sql` 创建；`campaignEventSchema` 每 variant 带 `campaignId`；`owner.debug` 已定义未 emit；`eventDefaultAudience`/`canReadEvent` 就绪；outbox 并发安全、回滚无残留、`published_at` 可空
- [ ] `006_turns_actions.sql` 创建；最后一名提交自动锁定；锁定后 `TURN_LOCKED`；未批准 `CHARACTER_NOT_APPROVED`；A 编辑不重复发事件；并发 A/B 只发一次 `turn.locked`；`sequence=[1,2,3]`
- [ ] HTTP 垂直验收（owner + playerA + playerB）通过；world 投影隔离、outbox 顺序/内容/未发布、turn 视图隐私、DTO 无 `*_json`/内部字段
- [ ] `rtk npm test`、`rtk npm run typecheck`、`rtk npm run build` 全绿；Phase 2A 两级 review（计划 review + 实现 review）通过后编写 Phase 2B 详细计划

## 已知错误形态（本阶段不得出现）

- 事件 variant 缺 `campaignId` 仍被 schema 接受；`interaction.requested` 缺 `targetPlayerId`。
- outbox 用“读取后 MAX+1”分配 sequence；`published_at NOT NULL DEFAULT`；回滚后残留 counter 或事件。
- A 锁前编辑重复发 `turn.action_submitted`；锁定事件重复（无条件 `lockTurn`）。
- 玩家投影泄露完整 `knownBy`、`owner_only` 内容、他人 action 正文；turn list 或 DTO 含 `*_json`/内部字段。
- 硬编码 ctx/campaignId（服务不消费 `resolveCampaignContext` 生成的 `CampaignAuthContext`）。
- outbox 测试在无 campaign 的库上直接 publish（`platform_outbox_sequences.campaign_id` FK 失败）；须先 `seedCampaign`。
- world `update` 伪造 `created_at`（未读现有行、把 `created_at: now` 塞进返回 DTO）；须同 tx 读旧行保留原 `created_at`。
- 多写在 tx 内使用外层 executor（repository 持有外部 executor 绕开 tx）。
- 路由未用 `Router({ mergeParams: true })`、未挂 campaign middleware、或挂在 `errorMiddleware` 之后；改动现有 `/api/campaigns` 根 middleware。
- 玩家能调用 owner-only 路由（`POST /turns`、`POST/PUT/DELETE /world`）。
- 真实 `server/dnd.sqlite` 被写入（一律内存 SQLite）。
- 新增错误码（本阶段只使用既有码）。

## 规格覆盖对照（本阶段）

| 设计成功标准 | 覆盖任务 |
| --- | --- |
| 向不同玩家发布不同可见内容（世界事实投影） | Task 2（`VisibilityPolicy` 复用 + knownBy 收敛） |
| 多名玩家提交本轮行动 | Task 4（`submitAction`） |
| 最后一名玩家提交后自动锁定 | Task 4（`countSubmitted === countTotal` + `turn.locked`） |
| 应用角色、世界和战斗状态（角色/世界） | Task 2（world facts） |
| 事务性 outbox 与事件受众 | Task 3（`005_events_outbox.sql` + `canReadEvent`，Phase 3 SSE 复用） |

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
