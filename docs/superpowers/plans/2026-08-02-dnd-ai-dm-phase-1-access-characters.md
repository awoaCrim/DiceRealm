# DND AI-DM 平台重构：阶段一详细计划（基线硬化、战役访问控制、角色后端与 HTTP 垂直验收）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本文是 `2026-08-02-dnd-ai-dm-rearchitecture-revised.md`（权威总路线图）中 **Phase 1** 的唯一可执行详细计划，覆盖该阶段全部 4 个小任务。后续阶段详细计划只有在各自前一阶段通过验收与两级 review 后才编写。

**Goal:** 在 Task 1-3 已完成基线上，产出（1）可复现的 Node/Postgres 测试基线，（2）campaign-scoped 访问控制与统一可见性策略，（3）角色创建/审核后端与 `003_characters.sql` 迁移，（4）一条真实的 HTTP 垂直验收流程（owner + player + playerB），为后续 world/turn/AI/前端阶段奠定权限与投影基础。

**Architecture:** 通过 `DatabasePort`/`QueryExecutor` 端口访问平台表；新增 `CampaignAuthContext` 作为唯一战役级认证上下文（不 `extends` 可选字段的 `AuthContext`），由 `resolveCampaignContext` 从会话 ctx 解析，经 `campaignMiddleware` 注入请求；`VisibilityPolicy` 是唯一可见性规则（owner 全量、player 只见 public + 自己 knownBy 的 player_private、owner_only 永不越权）。角色服务/仓储全部接收 `QueryExecutor`，多写操作走 `DatabasePort.transaction`。HTTP 垂直用 `app.listen(0)` + `fetch` + 独立 cookie jar 验证权限与投影。

**Tech Stack:** Node.js 22.12.0（`.nvmrc` + `engines.node >=22.12.0 <23`）、TypeScript、Express、SQLite（`better-sqlite3` 12.10.0 固定）、PostgreSQL（`pg`，`POSTGRES_TEST_URL` 门控）、Zod、Vitest。

---

## 执行前约束

- 不 `git stash pop` 归档 stash；不修改 `server/dnd.sqlite` 等运行数据；不使用 `git add .`。
- 所有外部 CLI 使用 `rtk` 前缀。
- 每个任务一个只含该任务文件的 commit，trailer 精确为 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 本阶段不建立任何前端文件；不建立 world/turn/outbox/archive/AI/SSE/combat；不新增错误码。
- 本文不含任何占位符与未经实现验证的伪代码；除本文外，所有阶段边界与硬约束见总路线图 `2026-08-02-dnd-ai-dm-rearchitecture-revised.md`。

## 本阶段 Files 总览（先读后写）

- Create: `.nvmrc`
- Modify: `package.json`（根：engines）
- Modify: `server/package.json`（better-sqlite3 固定 12.10.0）
- Modify: `package-lock.json`（`rtk npm install` 同步）
- Create: `server/src/platform/database/databaseContractSuite.ts`
- Create: `server/src/platform/database/node-engine.test.ts`
- Create: `server/src/platform/database/postgres-contract.test.ts`
- Modify: `server/src/platform/database/database.test.ts`
- Create: `server/src/modules/campaigns/CampaignAccess.ts`
- Create: `server/src/modules/campaigns/campaign-access.test.ts`
- Create: `server/src/modules/visibility/VisibilityPolicy.ts`
- Create: `server/src/modules/visibility/ProjectionService.ts`
- Create: `server/src/modules/visibility/visibility.test.ts`
- Create: `server/src/platform/http/campaignMiddleware.ts`
- Modify: `server/src/platform/http/sessionMiddleware.ts`（扩展 `AuthenticatedRequest`）
- Create: `server/src/platform/database/migrations/003_characters.sql`
- Create: `server/src/modules/characters/CharacterRepository.ts`
- Create: `server/src/modules/characters/CharacterService.ts`
- Create: `server/src/modules/characters/character.test.ts`
- Modify: `packages/contracts/src/character.ts`
- Create: `server/src/routes/characterRoutes.ts`
- Modify: `server/src/app.ts`
- Create: `server/src/tests/vertical-characters-http.test.ts`

## 任务依赖图

```
Task 1（可复现基线）──┐
                      ├─→ Task 2（campaign access + visibility）──→ Task 3（角色后端）──→ Task 4（HTTP 垂直验收）
Task 1 又为 Task 3 提供可复现测试基线
Task 2 为 Task 3 提供 CampaignAuthContext/requireOwner/getCampaignContext
Task 3 产出角色服务/路由/迁移
Task 4 是独立验收测试，依赖 Task 2/3 的已实现整合，在 Task 3 之后创建并运行（不要求先红）
```

---

## Task 1：可复现基线（Node 引擎约束 + better-sqlite3 固定 + DatabasePort 契约套件）

**依赖：** Task 1-3 已完成的 `DatabasePort`、`SqliteDatabaseAdapter`、`PostgresDatabaseAdapter`、`MigrationRunner`（均已实测）。无本阶段前置任务。

**目标：** 让任何开发者在本机可复现同样基线：Node 版本固定、原生模块 ABI 稳定、SQLite/Postgres 共用同一组数据库契约测试。

### Files

- Create: `.nvmrc`
- Modify: `package.json`（根）
- Modify: `server/package.json`
- Modify: `package-lock.json`
- Create: `server/src/platform/database/databaseContractSuite.ts`
- Create: `server/src/platform/database/node-engine.test.ts`
- Create: `server/src/platform/database/postgres-contract.test.ts`
- Modify: `server/src/platform/database/database.test.ts`

### Step 1：写失败测试

本任务先写“配置一致性”失败测试，再在 Step 3 才创建 `.nvmrc` 与修改根 `package.json`，保证 Step 2 的失败原因清晰（`.nvmrc`/`engines` 尚不存在），符合 TDD。

创建 `server/src/platform/database/databaseContractSuite.ts`（与驱动无关的契约测试，SQLite/Postgres 共用；`node:crypto` 顶层 ESM 导入从第一步就保持，不在后续步骤改 import 方式）：

```ts
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabasePort } from './DatabasePort.js';

export interface DatabaseFactory {
  label: string;
  create(): Promise<DatabasePort>;
}

/**
 * 同一组契约测试在 SQLite 与 PostgreSQL 上都必须通过。
 * 测试资源一律使用 randomUUID() 生成唯一 id/login，并在 try/finally 中 close，
 * 避免在共享 Postgres 测试库上重复运行撞唯一约束或泄漏连接。
 */
export function defineDatabaseContractSuite(factory: DatabaseFactory): void {
  describe(`${factory.label} database port contract`, () => {
    it('rolls back a failed transaction', async () => {
      const db = await factory.create();
      try {
        await db.migrate();
        const id = randomUUID();
        await expect(db.transaction(async (tx) => {
          await tx.execute(
            'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
            [id, `rollback-${id}`, 'hash'],
          );
          throw new Error('abort');
        })).rejects.toThrow('abort');
        const rows = await db.query<{ count: number }>(
          'SELECT COUNT(*) AS count FROM users WHERE id = ?',
          [id],
        );
        expect(Number(rows[0].count)).toBe(0);
      } finally {
        await db.close();
      }
    });

    it('commits a transaction when the callback succeeds', async () => {
      const db = await factory.create();
      try {
        await db.migrate();
        const id = randomUUID();
        await db.transaction(async (tx) => {
          await tx.execute(
            'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
            [id, `commit-${id}`, 'hash'],
          );
        });
        const rows = await db.query<{ count: number }>(
          'SELECT COUNT(*) AS count FROM users WHERE id = ?',
          [id],
        );
        expect(Number(rows[0].count)).toBe(1);
      } finally {
        await db.close();
      }
    });

    it('supports parameterised query and execute with correct changes', async () => {
      const db = await factory.create();
      try {
        await db.migrate();
        const id = randomUUID();
        const login = `param-${id}`;
        const insert = await db.execute(
          'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
          [id, login, 'hash'],
        );
        expect(insert.changes).toBe(1);
        const rows = await db.query<{ id: string; login: string }>(
          'SELECT id, login FROM users WHERE login = ?',
          [login],
        );
        expect(rows).toEqual([{ id, login }]);
      } finally {
        await db.close();
      }
    });

    it('runs migrations only once', async () => {
      const db = await factory.create();
      try {
        await db.migrate();
        await db.migrate();
        const versionRows = await db.query<{ version: string }>('SELECT version FROM platform_migrations');
        const versions = versionRows.map((row) => row.version);
        expect(versions).toEqual([...new Set(versions)]);
      } finally {
        await db.close();
      }
    });
  });
}

/**
 * 读取仓库根 package.json 的 engines.node 与 .nvmrc，断言两者都存在且一致。
 * 任一缺失都会抛出明确错误，作为 Step 2 的失败原因。
 */
export function readNodePins(repoRoot: string): { engines: string; nvmrc: string } {
  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { engines?: { node?: string } };
  if (!root.engines?.node) {
    throw new Error('package.json 缺少 engines.node 约束');
  }
  let nvmrc = '';
  try {
    nvmrc = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim();
  } catch {
    throw new Error('.nvmrc 缺失：请先固定 Node 版本');
  }
  if (!nvmrc) {
    throw new Error('.nvmrc 为空：请写入已验证的 Node 版本');
  }
  return { engines: root.engines.node, nvmrc };
}
```

创建 `server/src/platform/database/node-engine.test.ts`（独立配置一致性测试；只读 `.nvmrc`/engines 并断言两者一致，不比对当前进程 Node 版本）：

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readNodePins } from './databaseContractSuite.js';

describe('node engine constraint', () => {
  // server/src/platform/database → server/src/platform → server/src → server → 仓库根（上溯四级）
  const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
  it('declares engines.node matching .nvmrc', () => {
    const { engines, nvmrc } = readNodePins(repoRoot);
    expect(engines).toContain(nvmrc);
    expect(engines).toMatch(/^>=\d+\.\d+\.\d+ </);
  });
});
```

创建 `server/src/platform/database/postgres-contract.test.ts`（`POSTGRES_TEST_URL` 门控；未配置时 `describe.skipIf` 跳过；**不做“环境变量必须为空”断言**）：

```ts
import { describe } from 'vitest';
import pg from 'pg';
import { PostgresDatabaseAdapter } from './PostgresDatabaseAdapter.js';
import { defineDatabaseContractSuite } from './databaseContractSuite.js';

// POSTGRES_TEST_URL 必须指向一个可丢弃的测试库：契约套件会真实建表/插入/清理。
const url = process.env.POSTGRES_TEST_URL;

describe.skipIf(!url)('postgres database port contract', () => {
  defineDatabaseContractSuite({
    label: 'postgres',
    create: async () =>
      new PostgresDatabaseAdapter(new pg.Pool({ connectionString: url, max: 1 })),
  });
});
```

说明：契约测试 `SELECT COUNT(*) AS count FROM users` 的 `count` 在 SQLite 是 `number`、在 Postgres 是 `string`，套件一律用 `Number(rows[0].count)` 归一化；测试资源用 `randomUUID()` 唯一化并在 `try/finally` 中 `close()`，重复运行不会撞唯一约束。此时 `.nvmrc` 与根 `package.json` 的 `engines` 尚不存在，`database.test.ts` 尚未改造。

### Step 2：运行确认失败

```bash
rtk npm test -- --run server/src/platform/database/node-engine.test.ts server/src/platform/database/postgres-contract.test.ts server/src/platform/database/database.test.ts
```

预期：`node-engine.test.ts` **明确失败**——根 `package.json` 尚缺 `engines.node`（`readNodePins` 抛“package.json 缺少 engines.node 约束”），且 `.nvmrc` 尚不存在（未创建）。`postgres-contract.test.ts` 在无 `POSTGRES_TEST_URL` 时被 `describe.skipIf` 跳过；`database.test.ts` 既有用例仍全绿（本步只新增文件，不改既有测试）。失败原因集中在配置一致性测试，不涉及数据库行为。

### Step 3：实现

创建 `.nvmrc`：

```text
22.12.0
```

在根 `package.json` 增加 `engines`：

```json
{
  "engines": {
    "node": ">=22.12.0 <23"
  }
}
```

把 `server/src/platform/database/database.test.ts` 中既有的事务回滚/提交/参数化/迁移幂等四个用例收敛为调用契约套件，并保留既有的 `postgres placeholder rewrite`、`migration SQL portability`、`migration runner failure modes`、`legacy schema initialisation` 专项用例：

```ts
import { defineDatabaseContractSuite } from './databaseContractSuite.js';
import { createSqliteDatabase } from './SqliteDatabaseAdapter.js';

defineDatabaseContractSuite({
  label: 'sqlite',
  create: async () => createSqliteDatabase(':memory:'),
});
```

同时把 `legacy schema initialisation` 中对平台迁移数量的固定断言（当前为 `count === 2`）改为版本断言，避免 Task 3 加入 `003_characters.sql` 后测试失效：

```ts
const platformVersions = await adapter.query<{ version: string }>(
  'SELECT version FROM platform_migrations ORDER BY version',
);
expect(platformVersions.map((row) => row.version)).toEqual(
  expect.arrayContaining(['001', '002']),
);
expect(new Set(platformVersions.map((row) => row.version)).size).toBe(platformVersions.length);
```

该测试只验证基础迁移存在且版本不重复，不把总迁移数量锁死；后续增加 `003`–`010` 时仍保持有效。

在 `server/package.json` 把 `better-sqlite3` 从 `latest` 改为 lockfile 中已解析的具体版本（从 `package-lock.json` 的 `packages['node_modules/better-sqlite3'].version` 读取，实测为 `12.10.0`）：

```json
{
  "dependencies": {
    "better-sqlite3": "12.10.0"
  }
}
```

运行 `rtk npm install` 同步 `package-lock.json`。

### Step 4：运行确认通过

```bash
rtk npm test -- --run server/src/platform/database/node-engine.test.ts server/src/platform/database/postgres-contract.test.ts server/src/platform/database/database.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：SQLite 契约套件与既有专项用例全绿；`node-engine.test.ts` 通过（`.nvmrc` = `22.12.0` 且被 `engines >=22.12.0 <23` 包含，不依赖当前进程 Node 版本，如 24.x 也能通过）；无 `POSTGRES_TEST_URL` 时 postgres 套件跳过；server build 通过。执行测试前建议 `rtk nvm use 22.12.0`，保证原生模块 ABI 与既定版本一致。

### Step 5：提交

```bash
rtk git add .nvmrc package.json package-lock.json server/package.json server/src/platform/database/databaseContractSuite.ts server/src/platform/database/node-engine.test.ts server/src/platform/database/postgres-contract.test.ts server/src/platform/database/database.test.ts
rtk git commit -m "chore: pin node engine and gate postgres contract tests" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2：Campaign-scoped 访问控制与精简可见性策略

**依赖：** Task 1-3 的 `AuthContext`、`campaign_members` 表；Task 1 的可复现测试基线。

**目标：** 定义战役级认证上下文与唯一可见性规则，供所有后续领域模块与路由复用。`campaignMiddleware` 只服务于未来 feature routers，不阻塞现有 `/api/campaigns` list/create/join。

### Files

- Create: `server/src/modules/campaigns/CampaignAccess.ts`
- Create: `server/src/modules/campaigns/campaign-access.test.ts`
- Create: `server/src/modules/visibility/VisibilityPolicy.ts`
- Create: `server/src/modules/visibility/ProjectionService.ts`
- Create: `server/src/modules/visibility/visibility.test.ts`
- Create: `server/src/platform/http/campaignMiddleware.ts`
- Modify: `server/src/platform/http/sessionMiddleware.ts`

### Step 1：写失败测试

`server/src/modules/campaigns/campaign-access.test.ts`（含一个测试内 probe Express router：`Router({ mergeParams: true })` + `requireCampaignMember`，用真实 HTTP 请求证明父级 `:campaignId` 可解析、非成员被拒；probe router 只存在于测试，不挂到生产 `/api/campaigns` 根 router）：

```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Router } from 'express';
import { describe, expect, it } from 'vitest';
import type { AuthContext } from '@dnd/contracts';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { requireCampaignMember, getCampaignContext } from '../../platform/http/campaignMiddleware.js';
import { errorMiddleware } from '../../platform/http/errorMiddleware.js';
import { IdentityService } from '../identity/IdentityService.js';
import { CampaignService } from './CampaignService.js';
import { requireOwner, resolveCampaignContext } from './CampaignAccess.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const player = await identity.register({ login: 'player@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  await campaigns.join({ userId: player.userId }, created.campaign.id, created.inviteCode);
  return { db, created, owner, player };
}

describe('campaign access context', () => {
  it('resolves owner and player roles with the expected playerId', async () => {
    const { db, created, owner, player } = await makeFixture();
    const ownerCtx: AuthContext = { userId: owner.userId };
    const playerCtx: AuthContext = { userId: player.userId };
    const ownerView = await resolveCampaignContext(db, ownerCtx, created.campaign.id);
    expect(ownerView).toMatchObject({ campaignId: created.campaign.id, role: 'owner', playerId: null });
    const playerView = await resolveCampaignContext(db, playerCtx, created.campaign.id);
    expect(playerView).toMatchObject({ campaignId: created.campaign.id, role: 'player', playerId: player.userId });
    await db.close();
  });

  it('hides a campaign from a non-member', async () => {
    const { db, created } = await makeFixture();
    await expect(resolveCampaignContext(db, { userId: 'ghost' }, created.campaign.id))
      .rejects.toMatchObject({ code: 'CAMPAIGN_NOT_FOUND' });
    await db.close();
  });

  it('requireOwner rejects a player', async () => {
    const { db, created, player } = await makeFixture();
    const playerView = await resolveCampaignContext(db, { userId: player.userId }, created.campaign.id);
    expect(() => requireOwner(playerView)).toThrow(/你没有权限执行此操作/);
    await db.close();
  });
});

describe('campaign middleware probe router', () => {
  it('resolves the parent :campaignId param and rejects non-members over HTTP', async () => {
    const { db, created, player } = await makeFixture();
    // 会话中间件最小桩：直接写 authContext（真实流程由 sessionMiddleware 填充）。
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { authContext?: AuthContext }).authContext = { userId: player.userId };
      next();
    });
    // 测试内 probe router：mergeParams 必须为 true，否则子路由读不到父级 :campaignId。
    const probe = Router({ mergeParams: true });
    probe.use(requireCampaignMember(db));
    probe.get('/', (req, res) => {
      const ctx = getCampaignContext(req);
      res.json({ campaignId: ctx.campaignId, role: ctx.role });
    });
    app.use('/api/campaigns/:campaignId/characters', probe);
    app.use(errorMiddleware);

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    try {
      const memberRes = await fetch(`http://127.0.0.1:${address.port}/api/campaigns/${created.campaign.id}/characters`);
      expect(memberRes.status).toBe(200);
      const memberBody = (await memberRes.json()) as { campaignId: string; role: string };
      expect(memberBody).toEqual({ campaignId: created.campaign.id, role: 'player' });

      // 非成员（session 仍为 player，但 campaign 不存在/未加入）→ CAMPAIGN_NOT_FOUND 隐藏存在性。
      const ghostRes = await fetch(`http://127.0.0.1:${address.port}/api/campaigns/ghost-campaign/characters`);
      expect(ghostRes.status).toBe(404);
      const ghostBody = (await ghostRes.json()) as { error: { code: string } };
      expect(ghostBody.error.code).toBe('CAMPAIGN_NOT_FOUND');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  });
});
```

`server/src/modules/visibility/visibility.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ProjectionService } from './ProjectionService.js';

describe('visibility policy', () => {
  const service = new ProjectionService();

  it('does not expose another player private fact', () => {
    const full = {
      facts: [
        { id: 'f-public', visibility: 'public', knownBy: [] },
        { id: 'f-private', visibility: 'player_private', knownBy: ['player-a'] },
        { id: 'f-owner', visibility: 'owner_only', knownBy: [] },
      ],
    };
    expect(service.projectFacts({ role: 'player', playerId: 'player-b' }, full).map((f) => f.id))
      .toEqual(['f-public']);
    expect(service.projectFacts({ role: 'player', playerId: 'player-a' }, full).map((f) => f.id))
      .toEqual(['f-public', 'f-private']);
    expect(service.projectFacts({ role: 'owner', playerId: null }, full).map((f) => f.id))
      .toEqual(['f-public', 'f-private', 'f-owner']);
  });

  it('never bypasses owner_only via knownBy', () => {
    expect(service.projectFacts(
      { role: 'player', playerId: 'player-a' },
      { facts: [{ id: 'leak', visibility: 'owner_only', knownBy: ['player-a'] }] },
    )).toEqual([]);
  });
});
```

### Step 2：运行确认失败

```bash
rtk npm test -- --run server/src/modules/campaigns/campaign-access.test.ts server/src/modules/visibility/visibility.test.ts
```

预期：失败，原因是 `CampaignAccess.ts`、`ProjectionService.ts` 不存在（`VisibilityPolicy.ts` 尚不存在）。

### Step 3：实现

`server/src/modules/campaigns/CampaignAccess.ts`：

```ts
import type { AuthContext, Role } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';

/**
 * 已解析的战役级认证上下文：所有领域服务以它为唯一 ctx。
 * 独立结构，不 extends AuthContext（其 role/playerId/campaignId 可选），
 * 以避免类型上允许缺失必需字段。
 */
export interface CampaignAuthContext {
  userId: string;
  campaignId: string;
  role: Role;
  /** player 角色时即该用户在战役内的成员 user_id；owner 为 null。 */
  playerId: string | null;
}

/** 从会话 ctx 解析该用户在指定战役内的角色；非成员按 CAMPAIGN_NOT_FOUND 隐藏存在性。 */
export async function resolveCampaignContext(
  executor: QueryExecutor,
  ctx: AuthContext,
  campaignId: string,
): Promise<CampaignAuthContext> {
  if (!ctx?.userId) {
    throw new AppError('AUTH_REQUIRED', '请先登录。');
  }
  const rows = await executor.query<{ role: Role }>(
    'SELECT role FROM campaign_members WHERE campaign_id = ? AND user_id = ?',
    [campaignId, ctx.userId],
  );
  const member = rows[0];
  if (!member) {
    throw new AppError('CAMPAIGN_NOT_FOUND', '战役不存在。');
  }
  return {
    userId: ctx.userId,
    campaignId,
    role: member.role,
    playerId: member.role === 'player' ? ctx.userId : null,
  };
}

export function requireOwner(ctx: CampaignAuthContext): void {
  if (ctx.role !== 'owner') {
    throw new AppError('FORBIDDEN', '你没有权限执行此操作。');
  }
}
```

`server/src/modules/visibility/VisibilityPolicy.ts`：

```ts
import type { Visibility } from '@dnd/contracts';

export interface VisibilitySubject {
  role: 'owner' | 'player';
  playerId: string | null;
}

/** 唯一可见性规则：owner 全量；player 只见 public + 自己 knownBy 的 player_private；owner_only 永不外泄。 */
export function canRead(
  subject: VisibilitySubject,
  visibility: Visibility,
  knownBy: string[],
): boolean {
  if (subject.role === 'owner') {
    return true;
  }
  if (visibility === 'public') {
    return true;
  }
  if (visibility === 'player_private') {
    return subject.playerId != null && knownBy.includes(subject.playerId);
  }
  return false;
}
```

`server/src/modules/visibility/ProjectionService.ts`：

```ts
import type { Visibility } from '@dnd/contracts';
import { canRead, type VisibilitySubject } from './VisibilityPolicy.js';

export interface VisibleResource {
  id: string;
  visibility: Visibility;
  knownBy: string[];
}

export interface ProjectableState {
  facts: VisibleResource[];
}

export class ProjectionService {
  projectFacts(subject: VisibilitySubject, state: ProjectableState): VisibleResource[] {
    return state.facts.filter((fact) => canRead(subject, fact.visibility, fact.knownBy));
  }
}
```

修改 `server/src/platform/http/sessionMiddleware.ts`：在既有 `AuthContext` 导入旁新增 `CampaignAuthContext` type import，并给 `AuthenticatedRequest` 增加可选 `campaignContext` 字段（供路由中间件写入 campaign ctx；不改变既有字段语义）：

```ts
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthContext } from '@dnd/contracts';
import type { CampaignAuthContext } from '../../modules/campaigns/CampaignAccess.js';
import { AppError } from './AppError.js';
// ... 其余导入与函数不变

export interface AuthenticatedRequest extends Request {
  authContext?: AuthContext;
  sessionUser?: { userId: string; login: string };
  campaignContext?: CampaignAuthContext;
}
```

`server/src/platform/http/campaignMiddleware.ts`（相对导入路径：到 `DatabasePort` 为 `../database/DatabasePort.js`，到 `CampaignAccess` 为 `../../modules/campaigns/CampaignAccess.js`）：

```ts
import type { Request, RequestHandler, Response } from 'express';
import type { QueryExecutor } from '../database/DatabasePort.js';
import { resolveCampaignContext, type CampaignAuthContext } from '../../modules/campaigns/CampaignAccess.js';
import { AppError } from './AppError.js';
import { getAuthContext, type AuthenticatedRequest } from './sessionMiddleware.js';

/**
 * 只用于 feature routers（挂在 /api/campaigns/:campaignId/*）。
 * 不全局挂载到现有 /api/campaigns router，不阻塞 list/create/join。
 */
export function requireCampaignMember(executor: QueryExecutor): RequestHandler {
  return async (req, _res, next) => {
    try {
      const ctx = getAuthContext(req);
      const campaignId = readCampaignIdParam(req);
      (req as AuthenticatedRequest).campaignContext = await resolveCampaignContext(executor, ctx, campaignId);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function getCampaignContext(req: Request): CampaignAuthContext {
  const context = (req as AuthenticatedRequest).campaignContext;
  if (!context) {
    throw new AppError('AUTH_REQUIRED', '请先登录。');
  }
  return context;
}

function readCampaignIdParam(req: Request): string {
  const value = req.params.campaignId;
  if (typeof value !== 'string' || !value) {
    throw new AppError('CAMPAIGN_NOT_FOUND', '战役不存在。');
  }
  return value;
}
```

注意：feature router 必须以 `Router({ mergeParams: true })` 创建，才能在子路由中读取父级 `:campaignId` 参数（Task 2 的 probe router 测试与 Task 3 路由均已体现；生产 `/api/campaigns` 根 router 不挂载本中间件）。

### Step 4：运行确认通过

```bash
rtk npm test -- --run server/src/modules/campaigns/campaign-access.test.ts server/src/modules/visibility/visibility.test.ts server/src/modules/campaigns/campaign.test.ts server/src/modules/identity/identity.test.ts
rtk npm run typecheck --workspace server
```

预期：新增与既有战役/身份测试全绿（含 campaign middleware probe router 测试：父级 `:campaignId` 可解析、非成员 404 `CAMPAIGN_NOT_FOUND`）；typecheck 通过；现有 `/api/campaigns` 路由未受任何影响（未挂载 campaignMiddleware）。

### Step 5：提交

```bash
rtk git add server/src/modules/campaigns/CampaignAccess.ts server/src/modules/campaigns/campaign-access.test.ts server/src/modules/visibility server/src/platform/http/campaignMiddleware.ts server/src/platform/http/sessionMiddleware.ts
rtk git commit -m "feat: add campaign-scoped access and visibility policy" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3：角色后端（服务 + 仓储 + 迁移 + 路由）

**依赖：** Task 2（`CampaignAuthContext`、`requireOwner`、`getCampaignContext`、`requireCampaignMember`）；Task 1（可复现测试基线）。

**目标：** 建立角色创建/更新/提交审核/owner 审核/派生值落库/审计，以及 `platform_characters` + `platform_character_audits` 迁移。所有多写操作走 `DatabasePort.transaction`，所有操作校验 `campaign_id`。

### Files

- Create: `server/src/platform/database/migrations/003_characters.sql`
- Create: `server/src/modules/characters/CharacterRepository.ts`
- Create: `server/src/modules/characters/CharacterService.ts`
- Create: `server/src/modules/characters/character.test.ts`
- Modify: `packages/contracts/src/character.ts`
- Create: `server/src/routes/characterRoutes.ts`
- Modify: `server/src/app.ts`

### Step 1：写失败测试

在 `packages/contracts/src/character.ts` 追加输入/审核命令/投影 schema（不得与既有 `characterBaseSchema`/`characterDraftSchema`/`characterReviewSchema`/`approvedCharacterSchema` 字段冲突）：

```ts
export const characterDraftInputSchema = z.object({
  name: z.string().min(1),
  sheet: z.record(z.string(), z.unknown()).default({}),
});

export type CharacterDraftInput = z.infer<typeof characterDraftInputSchema>;

export const characterReviewActionSchema = z.enum(['approve', 'reject']);

export type CharacterReviewAction = z.infer<typeof characterReviewActionSchema>;

/** 拥有者退回后的角色：可再次编辑并重新提交。 */
export const characterRejectedSchema = characterBaseSchema.extend({
  status: z.literal('rejected'),
  sheet: z.record(z.string(), z.unknown()).default({}),
});

export type CharacterRejected = z.infer<typeof characterRejectedSchema>;

/** 玩家可见的其它已批准角色安全摘要（不含他人 sheet/derived 内部结构）。 */
export const approvedCharacterSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  playerId: z.string().min(1),
});

export type ApprovedCharacterSummary = z.infer<typeof approvedCharacterSummarySchema>;

/** 角色投影：我的草稿/我的待审/我的已退回/我的已批准（完整角色）+ owner 待审队列 + party 已批准安全摘要。 */
export const characterProjectionSchema = z.object({
  myDrafts: z.array(characterDraftSchema),
  myPending: z.array(characterReviewSchema),
  myRejected: z.array(characterRejectedSchema),
  myApproved: z.array(approvedCharacterSchema),
  reviews: z.array(characterReviewSchema),
  approvedSummaries: z.array(approvedCharacterSummarySchema),
});

export type CharacterProjection = z.infer<typeof characterProjectionSchema>;
```

`server/src/modules/characters/character.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { AuthContext } from '@dnd/contracts';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import type { SqliteDatabaseAdapter } from '../../platform/database/SqliteDatabaseAdapter.js';
import { resolveCampaignContext, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { IdentityService } from '../identity/IdentityService.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from './CharacterService.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const player = await identity.register({ login: 'player@example.test', password: 'correct-password' });
  const playerB = await identity.register({ login: 'playerb@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  await campaigns.join({ userId: player.userId }, created.campaign.id, created.inviteCode);
  await campaigns.join({ userId: playerB.userId }, created.campaign.id, created.inviteCode);
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const playerCtx = await resolveCampaignContext(db, { userId: player.userId }, created.campaign.id);
  const playerBCtx = await resolveCampaignContext(db, { userId: playerB.userId }, created.campaign.id);
  return { db, created, ownerCtx, playerCtx, playerBCtx };
}

describe('characters', () => {
  it('creates a player draft, updates it, then submits for review', async () => {
    const { db, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    expect(draft.status).toBe('draft');
    const updated = await service.updateDraft(playerCtx, draft.id, { name: '薇拉', sheet: { ac: 15 } });
    expect(updated.sheet.ac).toBe(15);
    const review = await service.submitForReview(playerCtx, draft.id);
    expect(review.status).toBe('pending_review');
    await db.close();
  });

  it('allows only the owner to approve a pending character', async () => {
    const { db, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    await expect(service.approve(playerCtx, draft.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.close();
  });

  it('approves a character with auditable derived AC persisted to derived_json', async () => {
    const { db, ownerCtx, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    const approved = await service.approve(ownerCtx, draft.id);
    expect(approved.status).toBe('approved');
    expect(approved.derived.ac).toEqual({ value: 14, sources: ['base'] });
    const row = await db.query<{ derived_json: string }>(
      'SELECT derived_json FROM platform_characters WHERE id = ?',
      [draft.id],
    );
    expect(JSON.parse(row[0].derived_json)).toEqual({ ac: { value: 14, sources: ['base'] } });
    await db.close();
  });

  it('prevents a player from editing another player character', async () => {
    const { db, playerCtx, playerBCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await expect(service.submitForReview(playerBCtx, draft.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await db.close();
  });

  it('persists an audit row on every status/content change', async () => {
    const { db, ownerCtx, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    await service.approve(ownerCtx, draft.id);
    const rows = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_character_audits WHERE character_id = ?',
      [draft.id],
    );
    expect(Number(rows[0].count)).toBeGreaterThanOrEqual(3);
    await db.close();
  });

  it('rejects a second approve after the status changed (conditional update)', async () => {
    const { db, ownerCtx, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    await service.approve(ownerCtx, draft.id);
    // 并发场景的串行等价：第二次 approve 条件更新不命中 → STATE_CONFLICT，不会双写。
    await expect(service.approve(ownerCtx, draft.id)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('shows own pending and approved characters to the owning player', async () => {
    const { db, ownerCtx, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    const pendingView = await service.projectForCampaign(playerCtx);
    expect(pendingView.myPending).toHaveLength(1);
    await service.approve(ownerCtx, draft.id);
    const approvedView = await service.projectForCampaign(playerCtx);
    expect(approvedView.myApproved).toHaveLength(1);
    expect(approvedView.myApproved[0].derived).toHaveProperty('ac');
    await db.close();
  });

  it('projects approved summaries visible to another player, hiding private drafts', async () => {
    const { db, ownerCtx, playerCtx, playerBCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    await service.approve(ownerCtx, draft.id);
    const viewForB = await service.projectForCampaign(playerBCtx);
    expect(viewForB.approvedSummaries).toHaveLength(1);
    expect(viewForB.approvedSummaries[0]).toMatchObject({ name: '薇拉' });
    expect(viewForB.myDrafts).toEqual([]);
    expect(viewForB.myPending).toEqual([]);
    expect(viewForB.myRejected).toEqual([]);
    expect(viewForB.myApproved).toEqual([]);
    await db.close();
  });
});
```

### Step 2：运行确认失败

```bash
rtk npm test -- --run server/src/modules/characters/character.test.ts
```

预期：失败，原因是 `CharacterService`/`CharacterRepository` 不存在；`createDraft`/`updateDraft`/`submitForReview`/`approve`/`projectForCampaign` 未定义。

### Step 3：实现

`003_characters.sql`（可移植：TEXT 主外键、`DEFAULT CURRENT_TIMESTAMP`，无 SQLite-only 函数；`platform_character_audits` 保存 actor/action/before/after，满足派生值与审核可审计）：

```sql
-- 003_characters.sql
CREATE TABLE IF NOT EXISTS platform_characters (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  player_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','pending_review','approved','rejected','archived')),
  sheet_json TEXT NOT NULL DEFAULT '{}',
  derived_json TEXT NOT NULL DEFAULT '{}',
  submitted_at TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS platform_characters_campaign_idx
  ON platform_characters(campaign_id, status);

CREATE TABLE IF NOT EXISTS platform_character_audits (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES platform_characters(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS platform_character_audits_character_idx
  ON platform_character_audits(character_id);
```

`server/src/modules/characters/CharacterRepository.ts`（所有方法接收 `QueryExecutor`，可注入 tx）：

```ts
import type { CharacterStatus } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface CharacterRow {
  id: string;
  campaign_id: string;
  player_id: string;
  name: string;
  status: CharacterStatus;
  sheet_json: string;
  derived_json: string;
  submitted_at: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CharacterAuditRow {
  id: string;
  character_id: string;
  campaign_id: string;
  actor_user_id: string;
  action: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

export class CharacterRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async findById(id: string): Promise<CharacterRow | null> {
    const rows = await this.executor.query<CharacterRow>(
      'SELECT * FROM platform_characters WHERE id = ?',
      [id],
    );
    return rows[0] ?? null;
  }

  async listByCampaign(campaignId: string): Promise<CharacterRow[]> {
    return this.executor.query<CharacterRow>(
      'SELECT * FROM platform_characters WHERE campaign_id = ? ORDER BY created_at ASC',
      [campaignId],
    );
  }

  async insert(row: CharacterRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_characters
        (id, campaign_id, player_id, name, status, sheet_json, derived_json,
         submitted_at, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.player_id, row.name, row.status, row.sheet_json,
       row.derived_json, row.submitted_at, row.approved_at, row.created_at, row.updated_at],
    );
  }

  /**
   * 条件更新：仅当行存在、属于该 campaign 且当前 status 等于 expectedStatus 时更新，
   * 返回是否命中（changes === 1）。服务用返回值判定并发冲突：未命中 → STATE_CONFLICT。
   * 这样 read + 状态检查 + 条件更新 + audit 可在同一事务内完成，杜绝并发双写。
   */
  async updateContent(row: CharacterRow, expectedStatus: CharacterStatus): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE platform_characters
         SET name = ?, sheet_json = ?, status = ?, derived_json = ?, submitted_at = ?, approved_at = ?, updated_at = ?
       WHERE id = ? AND campaign_id = ? AND status = ?`,
      [row.name, row.sheet_json, row.status, row.derived_json, row.submitted_at,
       row.approved_at, row.updated_at, row.id, row.campaign_id, expectedStatus],
    );
    return result.changes === 1;
  }

  async insertAudit(row: CharacterAuditRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_character_audits
        (id, character_id, campaign_id, actor_user_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.character_id, row.campaign_id, row.actor_user_id, row.action,
       row.before_json, row.after_json, row.created_at],
    );
  }
}
```

`server/src/modules/characters/CharacterService.ts`（**并发安全核心**：每个“读 + 状态检查 + 条件更新 + 审计”都发生在同一个 `DatabasePort.transaction` 内，repository 不持有外部 executor 后在 tx 中绕开；`updateContent` 按 `expectedStatus` 条件更新，未命中抛 `STATE_CONFLICT`，杜绝 approve/reject 并发双写；派生值实际写 `derived_json`；每次状态/内容变更写 audit）：

```ts
import { nanoid } from 'nanoid';
import type {
  ApprovedCharacter,
  CharacterDraft,
  CharacterDraftInput,
  CharacterProjection,
  CharacterRejected,
  CharacterReview,
  CharacterStatus,
} from '@dnd/contracts';
import type { DatabasePort } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import type { CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { requireOwner } from '../campaigns/CampaignAccess.js';
import { CharacterRepository, type CharacterAuditRow, type CharacterRow } from './CharacterRepository.js';

/** 派生值计算：AC 等关键派生名统一从 sheet 计算并带来源列表。 */
export function computeDerived(sheet: Record<string, unknown>): Record<string, unknown> {
  const ac = typeof sheet.ac === 'number' ? sheet.ac : 10;
  return { ac: { value: ac, sources: ['base'] } };
}

export class CharacterService {
  private readonly repository: CharacterRepository;

  constructor(private readonly executor: DatabasePort) {
    this.repository = new CharacterRepository(executor);
  }

  async createDraft(ctx: CampaignAuthContext, input: CharacterDraftInput): Promise<CharacterDraft> {
    if (ctx.role !== 'player') {
      throw new AppError('FORBIDDEN', '只有玩家可以创建角色。');
    }
    const now = new Date().toISOString();
    const row: CharacterRow = {
      id: nanoid(24),
      campaign_id: ctx.campaignId,
      player_id: ctx.playerId ?? ctx.userId,
      name: input.name,
      status: 'draft',
      sheet_json: JSON.stringify(input.sheet),
      derived_json: '{}',
      submitted_at: null,
      approved_at: null,
      created_at: now,
      updated_at: now,
    };
    // insert + audit 同一事务。
    await this.executor.transaction(async (tx) => {
      const repo = new CharacterRepository(tx);
      await repo.insert(row);
      await repo.insertAudit(this.auditRow(ctx, row, 'create', null));
    });
    return mapDraft(row);
  }

  async updateDraft(ctx: CampaignAuthContext, characterId: string, input: CharacterDraftInput): Promise<CharacterDraft> {
    const updated = await this.ownTransition(
      ctx, characterId, ['draft', 'rejected'],
      (row) => {
        const now = new Date().toISOString();
        return {
          ...row,
          name: input.name,
          sheet_json: JSON.stringify(input.sheet),
          status: 'draft',
          submitted_at: null,
          updated_at: now,
        };
      },
      'update',
    );
    return mapDraft(updated);
  }

  async submitForReview(ctx: CampaignAuthContext, characterId: string): Promise<CharacterReview> {
    // 幂等：已是自己的 pending_review 直接返回当前值（纯读，无写）。
    const existing = await this.repository.findById(characterId);
    if (
      existing &&
      existing.campaign_id === ctx.campaignId &&
      existing.player_id === ctx.userId &&
      existing.status === 'pending_review'
    ) {
      return mapReview(existing);
    }
    const updated = await this.ownTransition(
      ctx, characterId, ['draft', 'rejected'],
      (row) => {
        const now = new Date().toISOString();
        return { ...row, status: 'pending_review', submitted_at: now, updated_at: now };
      },
      'submit',
    );
    return mapReview(updated);
  }

  async approve(ctx: CampaignAuthContext, characterId: string): Promise<ApprovedCharacter> {
    const updated = await this.campaignTransition(
      ctx, characterId, ['pending_review'],
      (row) => {
        const sheet = JSON.parse(row.sheet_json) as Record<string, unknown>;
        const derived = computeDerived(sheet);
        const now = new Date().toISOString();
        return {
          ...row,
          status: 'approved',
          derived_json: JSON.stringify(derived),
          approved_at: now,
          updated_at: now,
        };
      },
      'approve',
    );
    return mapApproved(updated, JSON.parse(updated.derived_json) as Record<string, unknown>);
  }

  async reject(ctx: CampaignAuthContext, characterId: string): Promise<CharacterRejected> {
    const updated = await this.campaignTransition(
      ctx, characterId, ['pending_review'],
      (row) => {
        const now = new Date().toISOString();
        return { ...row, status: 'rejected', submitted_at: null, updated_at: now };
      },
      'reject',
    );
    return mapRejected(updated);
  }

  async projectForCampaign(ctx: CampaignAuthContext): Promise<CharacterProjection> {
    const rows = await this.repository.listByCampaign(ctx.campaignId);
    const mine = rows.filter((r) => r.player_id === ctx.userId);
    const reviews = ctx.role === 'owner' ? rows.filter((r) => r.status === 'pending_review') : [];
    const approvedSummaries = rows
      .filter((r) => r.status === 'approved')
      .map((r) => ({ id: r.id, name: r.name, playerId: r.player_id }));
    return {
      myDrafts: mine.filter((r) => r.status === 'draft').map(mapDraft),
      myPending: mine.filter((r) => r.status === 'pending_review').map(mapReview),
      myRejected: mine.filter((r) => r.status === 'rejected').map(mapRejected),
      myApproved: mine
        .filter((r) => r.status === 'approved')
        .map((r) => mapApproved(r, JSON.parse(r.derived_json) as Record<string, unknown>)),
      reviews: reviews.map(mapReview),
      approvedSummaries,
    };
  }

  /** 玩家本人操作的原子变更：读 + 状态检查 + 条件更新 + 审计 在同一事务内。 */
  private async ownTransition(
    ctx: CampaignAuthContext,
    characterId: string,
    expectedStatuses: CharacterStatus[],
    buildUpdated: (row: CharacterRow) => CharacterRow,
    action: string,
  ): Promise<CharacterRow> {
    return this.executor.transaction(async (tx) => {
      const repo = new CharacterRepository(tx);
      const row = await repo.findById(characterId);
      if (!row || row.campaign_id !== ctx.campaignId || row.player_id !== ctx.userId) {
        throw new AppError('NOT_FOUND', '角色不存在。');
      }
      if (!expectedStatuses.includes(row.status)) {
        throw new AppError('STATE_CONFLICT', '当前角色状态不允许该操作。');
      }
      return this.commitTransition(repo, ctx, row, buildUpdated, action);
    });
  }

  /** owner 操作的原子变更：读 + 状态检查 + 条件更新 + 审计 在同一事务内。 */
  private async campaignTransition(
    ctx: CampaignAuthContext,
    characterId: string,
    expectedStatuses: CharacterStatus[],
    buildUpdated: (row: CharacterRow) => CharacterRow,
    action: string,
  ): Promise<CharacterRow> {
    requireOwner(ctx);
    return this.executor.transaction(async (tx) => {
      const repo = new CharacterRepository(tx);
      const row = await repo.findById(characterId);
      if (!row || row.campaign_id !== ctx.campaignId) {
        throw new AppError('NOT_FOUND', '角色不存在。');
      }
      if (!expectedStatuses.includes(row.status)) {
        throw new AppError('STATE_CONFLICT', '当前角色状态不允许该操作。');
      }
      return this.commitTransition(repo, ctx, row, buildUpdated, action);
    });
  }

  private async commitTransition(
    repo: CharacterRepository,
    ctx: CampaignAuthContext,
    row: CharacterRow,
    buildUpdated: (row: CharacterRow) => CharacterRow,
    action: string,
  ): Promise<CharacterRow> {
    const updated = buildUpdated(row);
    const ok = await repo.updateContent(updated, row.status);
    if (!ok) {
      // 并发路径：另一请求已改变状态，条件更新未命中。
      throw new AppError('STATE_CONFLICT', '该角色状态已变化，请刷新后重试。');
    }
    await repo.insertAudit(this.auditRow(ctx, updated, action, row));
    return updated;
  }

  private auditRow(ctx: CampaignAuthContext, after: CharacterRow, action: string, before: CharacterRow | null): CharacterAuditRow {
    const now = new Date().toISOString();
    return {
      id: nanoid(24),
      character_id: after.id,
      campaign_id: after.campaign_id,
      actor_user_id: ctx.userId,
      action,
      before_json: before ? JSON.stringify(before) : null,
      after_json: JSON.stringify(after),
      created_at: now,
    };
  }
}

function mapDraft(row: CharacterRow): CharacterDraft {
  return {
    id: row.id, campaignId: row.campaign_id, playerId: row.player_id, name: row.name,
    status: 'draft', sheet: JSON.parse(row.sheet_json), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapReview(row: CharacterRow): CharacterReview {
  return {
    id: row.id, campaignId: row.campaign_id, playerId: row.player_id, name: row.name,
    status: 'pending_review', sheet: JSON.parse(row.sheet_json), createdAt: row.created_at,
    updatedAt: row.updated_at, submittedAt: row.submitted_at ?? row.updated_at,
  };
}

function mapRejected(row: CharacterRow): CharacterRejected {
  return {
    id: row.id, campaignId: row.campaign_id, playerId: row.player_id, name: row.name,
    status: 'rejected', sheet: JSON.parse(row.sheet_json), createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApproved(row: CharacterRow, derived: Record<string, unknown>): ApprovedCharacter {
  return {
    id: row.id, campaignId: row.campaign_id, playerId: row.player_id, name: row.name,
    status: 'approved', sheet: JSON.parse(row.sheet_json), createdAt: row.created_at,
    updatedAt: row.updated_at, approvedAt: row.approved_at ?? row.updated_at, derived,
  };
}
```

`server/src/routes/characterRoutes.ts`（必须 `Router({ mergeParams: true })`，读取父级 `:campaignId`；`POST /:id/submit` 只玩家；`POST /:id/review` 直接 approve/reject，owner 不得调用 submit；审核动作用 `characterReviewActionSchema.parse` 消费 contract）：

```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { characterDraftInputSchema, characterReviewActionSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { CharacterService } from '../modules/characters/CharacterService.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';

export function createCharacterRouter(executor: QueryExecutor, characters: CharacterService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.json({ projection: await characters.projectForCampaign(getCampaignContext(req)) });
  }));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = characterDraftInputSchema.parse(req.body);
    res.status(201).json({ character: await characters.createDraft(ctx, input) });
  }));

  router.put('/:characterId', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = characterDraftInputSchema.parse(req.body);
    res.json({ character: await characters.updateDraft(ctx, stringParam(req, 'characterId'), input) });
  }));

  router.post('/:characterId/submit', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    if (ctx.role !== 'player') {
      throw new AppError('FORBIDDEN', '只有玩家可以提交角色审核。');
    }
    res.json({ character: await characters.submitForReview(ctx, stringParam(req, 'characterId')) });
  }));

  router.post('/:characterId/review', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const action = characterReviewActionSchema.parse(req.body?.action);
    const id = stringParam(req, 'characterId');
    if (action === 'approve') {
      res.json({ character: await characters.approve(ctx, id) });
      return;
    }
    res.json({ character: await characters.reject(ctx, id) });
  }));

  return router;
}

function stringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) {
    // 坏 resourceId 表示资源不存在，用 NOT_FOUND（而非 CAMPAIGN_NOT_FOUND）。
    throw new AppError('NOT_FOUND', '角色不存在。');
  }
  return value;
}
```

`server/src/app.ts` 挂载（在平台块内、`errorMiddleware` 之前）：

```ts
import { createCharacterRouter } from './routes/characterRoutes.js';
import { CharacterService } from './modules/characters/CharacterService.js';
// ...
if (options.platformDb) {
  const identity = new IdentityService(options.platformDb);
  const campaigns = new CampaignService(options.platformDb);
  const characters = new CharacterService(options.platformDb);
  app.use(createSessionMiddleware(identity));
  app.use('/api/auth', createAuthRouter(identity));
  app.use('/api/campaigns', createCampaignRouter(campaigns));
  app.use('/api/campaigns/:campaignId/characters', createCharacterRouter(options.platformDb, characters));
  app.use(errorMiddleware);
}
```

注意：`CharacterService` 构造入参为 `DatabasePort`（既能 `query/execute` 又能 `transaction`）；`createCharacterRouter` 只依赖 `QueryExecutor` 的 `requireCampaignMember`。

### Step 4：运行确认通过

```bash
rtk npm test -- --run server/src/modules/characters/character.test.ts server/src/modules/campaigns/campaign.test.ts server/src/modules/campaigns/campaign-access.test.ts server/src/modules/visibility/visibility.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：角色测试全绿；`platform_characters`/`platform_character_audits` 经 `003_characters.sql` 创建；`derived_json` 落库断言成立；audit 行数断言成立；既有战役/访问/可见性测试不回退；build 把 `003_characters.sql` 复制进 `dist`。

### Step 5：提交

```bash
rtk git add server/src/platform/database/migrations/003_characters.sql server/src/modules/characters server/src/routes/characterRoutes.ts packages/contracts/src/character.ts server/src/app.ts
rtk git commit -m "feat: add character creation and owner review backend" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4：HTTP 垂直验收（owner/player/playerB 三 cookie jar）

**依赖：** Task 2（campaign middleware/ctx）、Task 3（角色服务/路由/迁移）；Task 1（可复现基线）。

**目标：** 作为**独立验收测试**（非 TDD 任务），用真实 `app.listen(0)` + `fetch` 在 Task 2/3 已实现的整合上跑通完整角色流程，验证权限隔离与 DTO 洁净，并同时运行既有 authCampaignRoutes/database/contracts 测试。本任务不要求先红。

### Files

- Create: `server/src/tests/vertical-characters-http.test.ts`

### Step 1：写验收测试

本任务是**独立验收测试**：它在 Task 3 完成（路由/服务已挂载）之后创建并运行，验证的是已实现的整合行为，**不要求先红**（writing-plans 的“每任务必红”只适用于 TDD 任务，本任务没有新生产代码）。若运行暴露下方“已知错误形态”，说明 Task 2/3 实现有误，需回到对应任务修复。

`server/src/tests/vertical-characters-http.test.ts`：

```ts
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // platformDb.close() 已关闭它复用的 raw 连接（reuseRaw），只关一次，避免 double-close 资源泄漏。
      await platformDb.close();
    },
  };
}

interface Actor {
  cookies: string;
  userId: string;
}

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

      const createRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'POST',
        headers: jsonHeaders(owner.cookies),
        body: JSON.stringify({ name: '失落矿坑', ruleset: 'dnd5e' }),
      });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };

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

      const approveRes = await fetch(`${charsBase}/${charId}/review`, {
        method: 'POST',
        headers: jsonHeaders(owner.cookies),
        body: JSON.stringify({ action: 'approve' }),
      });
      expect(approveRes.status).toBe(200);
      const approved = (await approveRes.json()) as { character: { status: string; derived: unknown } };
      expect(approved.character.status).toBe('approved');
      expect(approved.character.derived).toHaveProperty('ac');

      // playerA 本人能看到自己的已批准完整角色（含 derived）。
      const aOwnView = (await (await fetch(`${charsBase}`, { headers: { cookie: playerA.cookies } })).json()) as {
        projection: { myApproved: Array<{ id: string; derived: unknown }>; myPending: unknown[] };
      };
      expect(aOwnView.projection.myApproved.map((c) => c.id)).toContain(charId);
      expect(aOwnView.projection.myPending).toEqual([]);

      // playerB 看不到他人 draft/pending/rejected；但能看到已批准角色的安全 summary。
      const bList = await fetch(`${charsBase}`, { headers: { cookie: playerB.cookies } });
      const bProjection = (await bList.json()) as {
        projection: {
          myDrafts: unknown[]; myPending: unknown[]; myRejected: unknown[]; myApproved: unknown[];
          reviews: unknown[]; approvedSummaries: Array<{ name: string }>;
        };
      };
      expect(bProjection.projection.myDrafts).toEqual([]);
      expect(bProjection.projection.myPending).toEqual([]);
      expect(bProjection.projection.myRejected).toEqual([]);
      expect(bProjection.projection.myApproved).toEqual([]);
      expect(bProjection.projection.reviews).toEqual([]);
      expect(bProjection.projection.approvedSummaries.map((s) => s.name)).toContain('薇拉');

      // player 不能 approve。
      const playerApprove = await fetch(`${charsBase}/${charId}/review`, {
        method: 'POST',
        headers: jsonHeaders(playerA.cookies),
        body: JSON.stringify({ action: 'approve' }),
      });
      expect(playerApprove.status).toBe(403);

      // playerB 的 draft 不被 playerA 看到：断言整个 playerA projection JSON 都不含 playerB 名字/属性。
      const bDraft = await fetch(`${charsBase}`, {
        method: 'POST',
        headers: jsonHeaders(playerB.cookies),
        body: JSON.stringify({ name: '卡恩', sheet: { ac: 16 } }),
      });
      expect(bDraft.status).toBe(201);
      const aListText = await (await fetch(`${charsBase}`, { headers: { cookie: playerA.cookies } })).text();
      expect(aListText).not.toContain('卡恩');
      expect(aListText).not.toContain('"ac":16');
      const aProjection = JSON.parse(aListText) as { projection: { myDrafts: unknown[] } };
      expect(aProjection.projection.myDrafts).toEqual([]);

      // 没有 owner 调用 submit 的路径：路由在 submit handler 前置 role 校验，返回 FORBIDDEN。
      const ownerSubmit = await fetch(`${charsBase}/${charId}/submit`, {
        method: 'POST',
        headers: jsonHeaders(owner.cookies),
      });
      expect(ownerSubmit.status).toBe(403);

      // /api/auth/me 响应不含 password_hash。
      const meText = await (await fetch(`${baseUrl}/api/auth/me`, {
        headers: { cookie: owner.cookies },
      })).text();
      expect(meText).not.toContain('password_hash');
      expect(meText).not.toContain('passwordHash');

      // DTO 不含敏感字段：campaign 视图无 invite/hash；角色 DTO 无 audit 内部字段。
      const viewText = await (await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}`, {
        headers: { cookie: owner.cookies },
      })).text();
      expect(viewText).not.toContain('inviteCode');
      expect(viewText).not.toContain('invite_code_hash');
      expect(JSON.stringify(approved.character)).not.toContain('sheet_json');
      expect(JSON.stringify(approved.character)).not.toContain('character_id');
      expect(JSON.stringify(approved.character)).not.toContain('actor_user_id');
    } finally {
      await server.close();
    }
  });
});
```

### Step 2：运行确认通过

```bash
rtk npm test -- --run server/src/tests/vertical-characters-http.test.ts
```

预期：**直接通过**——Task 3 已把 `/api/campaigns/:campaignId/characters` 挂载到 `createApp`，本验收测试验证该整合（owner/player/playerB 三 cookie jar 完整流程、隐私隔离、DTO 洁净、`password_hash` 不泄漏）。若此步失败，按 Step 3 的错误形态清单定位 Task 2/3 缺陷并修复，不是改测试绕过。

### Step 3：无新生产文件（错误形态检查清单）

本任务没有新生产文件，只依赖 Task 2/3 已实现的路由、middleware 与服务。若验收失败，逐项检查以下已知错误形态（命中即修复 Task 2/3 实现）：

- `requireCampaignMember` 被全局挂到 `/api/campaigns` router（会阻塞 list/create/join）。
- `POST /:id/review` 允许 owner 调用 `submit` 路径（本设计 owner submit 一律 `FORBIDDEN`）。
- 玩家通过 `projectForCampaign` 读到他人 `sheet_json`/audit 内部字段，或投影缺少 `myPending`/`myApproved`。
- 派生值未写入 `derived_json`（approve 后 `derived` 为空）。
- `Router` 未用 `mergeParams`（`campaignId` 无法在子路由解析）。
- 条件更新未命中时未抛 `STATE_CONFLICT`（approve/reject 可双写）。
- 路由 `stringParam` 对坏 `characterId` 抛错类型非 `NOT_FOUND`，或审核动作未用 `characterReviewActionSchema.parse`。

### Step 4：全量相关测试

```bash
rtk npm test -- --run server/src/tests/vertical-characters-http.test.ts server/src/tests/authCampaignRoutes.test.ts server/src/modules/characters/character.test.ts server/src/platform/database/database.test.ts server/src/platform/database/postgres-contract.test.ts packages/contracts/src/contracts.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：垂直验收、既有 authCampaignRoutes、character/database/contracts 测试全绿；typecheck/build 通过。全程使用内存 SQLite，不触碰真实 `server/dnd.sqlite`。

### Step 5：提交

```bash
rtk git add server/src/tests/vertical-characters-http.test.ts
rtk git commit -m "test: verify character HTTP vertical flow with three actors" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 本阶段验收门检查清单

- [ ] `.nvmrc` 固定 22.12.0；根 `package.json` engines `>=22.12.0 <23`；`node-engine.test.ts` 静态一致性测试通过
- [ ] `better-sqlite3` 固定 12.10.0，`package-lock.json` 同步
- [ ] SQLite/Postgres `DatabasePort` contract suite 抽取完成（资源 `randomUUID()` 唯一、`try/finally` 清理）；无 `POSTGRES_TEST_URL` 时 Postgres 套件跳过
- [ ] `resolveCampaignContext`/`requireOwner`/`campaignMiddleware` 实现并有测试；非成员隐藏存在性；probe router 证明父级 `:campaignId` 可解析
- [ ] `VisibilityPolicy`：owner 全量、player 只见 public + 自己 knownBy 的 player_private、owner_only 不越权
- [ ] `003_characters.sql`（platform_characters + platform_character_audits）经迁移创建；build 复制进 dist
- [ ] 角色服务（create/update/submit/approve/reject/audit/投影）实现并有测试；派生值写入 `derived_json`；条件更新未命中抛 `STATE_CONFLICT`
- [ ] 角色投影含 `myDrafts`/`myPending`/`myRejected`/`myApproved`/owner-only `reviews`/party `approvedSummaries`
- [ ] 角色路由挂 `/api/campaigns/:campaignId/characters`（`Router({ mergeParams: true })` + campaign middleware）；`stringParam` 坏 id 抛 `NOT_FOUND`；审核动作用 `characterReviewActionSchema.parse`
- [ ] HTTP 垂直验收（owner/player/playerB 三 cookie jar）通过；playerA 整个投影不含 playerB 数据；DTO 无 `password_hash`/`invite_code_hash`/audit 内部 JSON；server 与 platformDb 资源正确关闭
- [ ] 既有 authCampaignRoutes/database/contracts 测试不回归；typecheck/build 通过
- [ ] 两级 review（本计划 review + 实现 review）通过；通过后按总路线图编写 Phase 2 详细计划

## 已知错误形态（本阶段不得出现）

- campaign middleware 全局挂载到现有 `/api/campaigns` router，阻塞 list/create/join。
- owner 调用 `submit` 路径成功（应 `FORBIDDEN`）。
- 玩家通过投影读到他人 draft/pending/rejected 或 audit 内部字段，或投影缺少 `myPending`/`myApproved`。
- 派生值未实际写入 `derived_json`（approve 后 `derived` 为空）。
- 读+状态检查+条件更新+审计不在同一事务（approve/reject 并发可双写），或条件更新未命中时未抛 `STATE_CONFLICT`。
- 路由未用 `Router({ mergeParams: true })`，`campaignId` 在子路由解析失败。
- 路由 `stringParam` 对坏 `characterId` 抛错类型非 `NOT_FOUND`，或审核动作未用 contract schema 校验。
- `.nvmrc`/engines 缺失时配置测试不失败（TDD 顺序颠倒）。

## 规格覆盖对照（本阶段）

| 设计成功标准 | 覆盖任务 |
| --- | --- |
| 玩家创建角色 | Task 3 |
| 拥有者审核角色 | Task 3 |
| 向不同玩家发布不同可见内容（角色投影） | Task 2（VisibilityPolicy）+ Task 3（projectForCampaign） |
| 认证与战役成员权限 | 基线 Task 3 + 本阶段 Task 2（campaign-scoped ctx） |
