# DND AI-DM 平台重构实施计划

> **已被修订版取代：** Task 1-3 的历史基线仍然有效；自 Task 4 起不再按本文执行。后续唯一执行来源为 [`2026-08-02-dnd-ai-dm-rearchitecture-revised.md`](./2026-08-02-dnd-ai-dm-rearchitecture-revised.md)。复审依据见 [`2026-08-02-plan-and-baseline-review.md`](../reviews/2026-08-02-plan-and-baseline-review.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在干净的 `main` 基线上，以模块化单体方式重建账号、战役、角色、回合、战斗、AI、可见性、存档和前端工作区，交付一条可恢复的多人 AI-DM 垂直流程。

**Architecture:** 先建立 `packages/contracts` 作为 API/domain contract 的单一事实源，再在 Express 应用内按领域模块组织应用服务、仓储端口和领域策略。SQLite 与 PostgreSQL 通过基础设施适配器隔离；AI 只输出经过 Zod 校验的结构化结果；SSE 只发布经过可见性投影的领域事件。前端使用统一 App Shell，按 owner/player 工作区加载 feature 查询与命令，不再维护巨型页面 Store。

**Tech Stack:** Node.js, TypeScript, Express, React, Vite, SQLite (`better-sqlite3`), PostgreSQL (`pg`), Zod, React Query, SSE, Vitest, Testing Library, Playwright。

---

## 执行前约束

- 当前已清理为唯一本地分支 `main`，不要恢复或删除以下归档：
  - `archive/pre-refactor/codex-upload-initial-code`
  - `archive/pre-refactor/worktree-dnd-ui-refactor`
  - `archive/pre-refactor/worktree-st-three-pipeline`
- 未提交内容已保存在 stash 和外部归档，不要对这些 stash 执行 `pop`。
- 不使用 `git add .`，每次只暂存任务列出的路径。
- 不修改或删除 `server/dnd.sqlite`、日志、用户规则资料等运行数据，除非某个迁移任务明确创建备份并通过测试。
- 不复制 SillyTavern、agnai、Dungeoneer、Fari 或其他 GPL/AGPL 项目的代码和素材；只实现设计文档中的独立方案。
- 规则内容在获得明确许可证和署名信息前，只实现来源/版本/许可证元数据和导入边界，不把第三方完整规则文本写入仓库。
- 每个任务完成后运行该任务列出的测试，并提交一个只包含该任务文件的 commit。

## 基线文件结构

当前基线的重要入口：

```text
package.json
server/
  src/app.ts
  src/index.ts
  src/config.ts
  src/db/connection.ts
  src/db/schema.ts
  src/domain/types.ts
  src/routes/*.ts
  src/services/*.ts
client/
  src/main.tsx
  src/App.tsx
  src/api.ts
  src/types.ts
  src/pages/*.tsx
  src/components/*.tsx
vitest.config.ts
tsconfig.base.json
```

重构后的目标边界：

```text
packages/contracts/
  src/auth.ts
  src/campaign.ts
  src/character.ts
  src/turn.ts
  src/combat.ts
  src/ai.ts
  src/events.ts
  src/index.ts
  src/*.test.ts

server/src/
  platform/
    database/
    http/
    realtime/
    security/
  modules/
    identity/
    campaigns/
    characters/
    world/
    turns/
    combat/
    rules/
    ai-runtime/
    visibility/
    archives/
  app.ts
  index.ts

client/src/
  app/
    router/
    providers/
    queryClient/
    realtime/
  entities/
    user/
    campaign/
    character/
    turn/
    combat/
    archive/
  features/
    auth/
    campaigns/
    owner/
    player/
  shared/
    ui/
    forms/
    feedback/
    formatting/
  api/
    auth/
    campaigns/
    turns/
    combat/
    ai/
    archives/
  main.tsx
```

---

### Task 1: 建立共享 contract 和统一错误模型

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/src/campaign.ts`
- Create: `packages/contracts/src/character.ts`
- Create: `packages/contracts/src/turn.ts`
- Create: `packages/contracts/src/combat.ts`
- Create: `packages/contracts/src/ai.ts`
- Create: `packages/contracts/src/events.ts`
- Create: `packages/contracts/src/errors.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/contracts.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.base.json`
- Modify: `vitest.config.ts`

- [ ] **Step 1: 扩展 workspace 并写失败测试**

在根 `package.json` 将 workspace 改为：

```json
{
  "workspaces": ["packages/*", "server", "client"]
}
```

创建 `packages/contracts/package.json`：

```json
{
  "name": "@dnd/contracts",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "zod": "latest"
  }
}
```

创建 `packages/contracts/src/contracts.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { campaignEventSchema, turnResolutionSchema } from './index';

describe('shared contracts', () => {
  it('accepts a structured turn resolution', () => {
    const result = turnResolutionSchema.parse({
      publicNarrative: '雨停了。',
      privateUpdates: [{ playerId: 'player-1', content: '你发现了暗门。' }],
      diceResults: [],
      stateChanges: [],
      interactionRequests: [],
    });

    expect(result.privateUpdates[0].playerId).toBe('player-1');
  });

  it('rejects an event without a visibility-safe event type', () => {
    expect(() => campaignEventSchema.parse({ type: 'database.row_dump' })).toThrow();
  });
});
```

- [ ] **Step 2: 运行 contract 测试确认失败**

运行：

```bash
rtk npm test -- --run packages/contracts/src/contracts.test.ts
```

预期：失败，原因是 `packages/contracts/src/index.ts` 尚不存在。

- [ ] **Step 3: 实现最小 contract**

`packages/contracts/src/turn.ts` 至少定义：

```ts
import { z } from 'zod';

export const turnStatusSchema = z.enum([
  'waiting_for_actions',
  'locked',
  'resolving',
  'needs_owner_attention',
  'completed',
]);

export const turnResolutionSchema = z.object({
  publicNarrative: z.string(),
  privateUpdates: z.array(z.object({
    playerId: z.string().min(1),
    content: z.string(),
  })),
  diceResults: z.array(z.object({
    id: z.string().min(1),
    formula: z.string().min(1),
    total: z.number().int(),
    visibility: z.enum(['public', 'player_private', 'owner_only']),
  })),
  stateChanges: z.array(z.object({
    kind: z.enum(['character', 'world', 'combat', 'quest']),
    targetId: z.string().min(1),
    patch: z.record(z.unknown()),
    visibility: z.enum(['public', 'player_private', 'owner_only']),
  })),
  interactionRequests: z.array(z.object({
    id: z.string().min(1),
    targetPlayerId: z.string().min(1),
    prompt: z.string(),
  })),
});
```

`packages/contracts/src/events.ts` 定义有限事件联合：

```ts
import { z } from 'zod';

export const campaignEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('player.joined'), campaignId: z.string(), playerId: z.string() }),
  z.object({ type: z.literal('turn.action_submitted'), turnId: z.string(), playerId: z.string() }),
  z.object({ type: z.literal('turn.locked'), turnId: z.string() }),
  z.object({ type: z.literal('ai.preview.started'), runId: z.string() }),
  z.object({ type: z.literal('ai.preview.delta'), runId: z.string(), text: z.string() }),
  z.object({ type: z.literal('ai.preview.failed'), runId: z.string(), code: z.string() }),
  z.object({ type: z.literal('turn.resolved'), turnId: z.string(), archiveId: z.string() }),
  z.object({ type: z.literal('combat.updated'), encounterId: z.string() }),
  z.object({ type: z.literal('interaction.requested'), requestId: z.string() }),
]);
```

`index.ts` 重新导出所有 schema，并导出：

```ts
export type TurnResolution = z.infer<typeof turnResolutionSchema>;
```

`errors.ts` 定义统一 `AppErrorCode`：

```ts
export const appErrorCodes = [
  'AUTH_REQUIRED', 'FORBIDDEN', 'CAMPAIGN_NOT_FOUND', 'TURN_NOT_ACTIVE',
  'TURN_LOCKED', 'CHARACTER_NOT_APPROVED', 'AI_PROVIDER_FAILED',
  'AI_OUTPUT_INVALID', 'STATE_CONFLICT', 'REALTIME_DISCONNECTED',
] as const;
export type AppErrorCode = typeof appErrorCodes[number];
```

- [ ] **Step 4: 让 TypeScript 和测试通过**

在 `tsconfig.base.json` 增加 `@dnd/contracts` path；在 `vitest.config.ts` 将 `packages/**/*.test.ts` 加入 include。

运行：

```bash
rtk npm install
rtk npm test -- --run packages/contracts/src/contracts.test.ts
rtk npm run typecheck --workspace client
```

预期：contract 测试通过；client 现有类型错误若仍存在，记录为基线问题，不在本任务扩大修复范围。

- [ ] **Step 5: 提交**

```bash
rtk git add package.json tsconfig.base.json vitest.config.ts packages/contracts
rtk git commit -m "refactor: add shared domain contracts" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 建立数据库端口和迁移基础

**Files:**
- Create: `server/src/platform/database/DatabasePort.ts`
- Create: `server/src/platform/database/SqliteDatabaseAdapter.ts`
- Create: `server/src/platform/database/PostgresDatabaseAdapter.ts`
- Create: `server/src/platform/database/migrations/001_initial_platform.sql`
- Create: `server/src/platform/database/migrations/MigrationRunner.ts`
- Create: `server/src/platform/database/database.test.ts`
- Modify: `server/src/db/connection.ts`
- Modify: `server/src/db/schema.ts`
- Modify: `server/package.json`
- Modify: `server/tsconfig.json`

- [ ] **Step 1: 写数据库端口测试**

`server/src/platform/database/database.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from './SqliteDatabaseAdapter';

describe('database adapter', () => {
  it('runs a transaction and rolls back on error', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await expect(db.transaction(async (tx) => {
      await tx.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u1', 'a', 'hash']);
      throw new Error('abort');
    })).rejects.toThrow('abort');

    const rows = await db.query<{ count: number }>('SELECT COUNT(*) AS count FROM users');
    expect(rows[0].count).toBe(0);
    await db.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
rtk npm test -- --run server/src/platform/database/database.test.ts
```

预期：失败，原因是 adapter 尚不存在。

- [ ] **Step 3: 实现 DatabasePort**

`DatabasePort.ts`：

```ts
export interface QueryExecutor {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface DatabasePort extends QueryExecutor {
  migrate(): Promise<void>;
  transaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

SQLite adapter 使用现有 `better-sqlite3` 连接，但所有同步调用通过 Promise 兼容接口暴露；事务必须使用 SQLite 原生 transaction 包裹 callback。PostgreSQL adapter 使用 `pg.Pool`，实现同一接口，并将 `?` 参数转换为 `$1`、`$2` 等占位符。

- [ ] **Step 4: 创建第一版平台表**

`001_initial_platform.sql` 建立最小表：

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  ruleset TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_members (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'player')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, user_id)
);
```

将旧 `db/schema.ts` 的初始化调用迁移到 `MigrationRunner`，但不要删除旧表，直到迁移任务覆盖已有数据。

- [ ] **Step 5: 添加 SQLite/PostgreSQL smoke test**

SQLite 测试必须真实运行；PostgreSQL 测试在没有 `POSTGRES_TEST_URL` 时跳过，在配置存在时运行同一组 contract tests。不得把 PostgreSQL 连接字符串写入仓库。

运行：

```bash
rtk npm test -- --run server/src/platform/database/database.test.ts
rtk npm run typecheck --workspace server
```

- [ ] **Step 6: 提交**

```bash
rtk git add server/src/platform/database server/src/db/connection.ts server/src/db/schema.ts server/package.json server/tsconfig.json
rtk git commit -m "refactor: isolate database adapters and migrations" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 实现 Identity、Campaign 和成员权限

**Files:**
- Create: `server/src/modules/identity/IdentityService.ts`
- Create: `server/src/modules/identity/IdentityRepository.ts`
- Create: `server/src/modules/identity/passwords.ts`
- Create: `server/src/modules/identity/identity.test.ts`
- Create: `server/src/modules/campaigns/CampaignService.ts`
- Create: `server/src/modules/campaigns/CampaignRepository.ts`
- Create: `server/src/modules/campaigns/campaign.test.ts`
- Create: `server/src/platform/http/sessionMiddleware.ts`
- Create: `server/src/platform/http/errorMiddleware.ts`
- Create: `server/src/routes/authRoutes.ts`
- Create: `server/src/routes/campaignRoutes.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Modify: `server/package.json`

- [ ] **Step 1: 写认证和权限失败测试**

测试必须覆盖：

```ts
it('does not authenticate with an invalid password', async () => {
  const service = makeIdentityService();
  await service.register({ login: 'owner@example.test', password: 'correct-password' });
  await expect(service.login({ login: 'owner@example.test', password: 'wrong-password' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
});

it('allows only the owner to update campaign settings', async () => {
  const fixture = await createCampaignFixture();
  await expect(fixture.service.updateSettings(fixture.playerContext, fixture.campaignId, { name: 'nope' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
```

- [ ] **Step 2: 实现密码和会话服务**

使用 Node `crypto.scrypt` 或经过审计的密码库；密码只保存哈希和随机 salt。`IdentityService` 暴露：

```ts
register(input: { login: string; password: string }): Promise<User>;
login(input: { login: string; password: string }): Promise<Session>;
logout(sessionId: string): Promise<void>;
resolveSession(sessionId: string): Promise<AuthenticatedUser | null>;
```

- [ ] **Step 3: 实现 CampaignService**

暴露：

```ts
create(ownerId: string, input: { name: string; ruleset: string }): Promise<Campaign>;
getForMember(ctx: AuthContext, campaignId: string): Promise<CampaignView>;
listOwnedOrJoined(userId: string): Promise<CampaignSummary[]>;
join(ctx: AuthContext, campaignId: string, inviteCode: string): Promise<CampaignMember>;
updateSettings(ctx: AuthContext, campaignId: string, input: CampaignSettingsPatch): Promise<Campaign>;
```

所有方法先验证用户身份和成员关系；owner-only 方法再验证 `role === 'owner'`。

- [ ] **Step 4: 添加 HTTP 路由和统一错误响应**

所有错误转换为：

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "你没有权限执行此操作。"
  }
}
```

不把堆栈、SQL、Provider Key 或原始 HTML 响应发给浏览器。

- [ ] **Step 5: 运行测试**

```bash
rtk npm test -- --run server/src/modules/identity/identity.test.ts server/src/modules/campaigns/campaign.test.ts
rtk npm run typecheck --workspace server
```

- [ ] **Step 6: 提交**

```bash
rtk git add server/src/modules/identity server/src/modules/campaigns server/src/platform/http server/src/routes/authRoutes.ts server/src/routes/campaignRoutes.ts server/src/app.ts server/src/index.ts server/package.json
rtk git commit -m "feat: add account and campaign boundaries" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 建立 VisibilityPolicy 和查询投影

**Files:**
- Create: `server/src/modules/visibility/VisibilityPolicy.ts`
- Create: `server/src/modules/visibility/ProjectionService.ts`
- Create: `server/src/modules/visibility/visibility.test.ts`
- Create: `server/src/modules/world/WorldFactRepository.ts`
- Create: `server/src/modules/world/WorldService.ts`
- Modify: `packages/contracts/src/campaign.ts`
- Modify: `packages/contracts/src/events.ts`
- Modify: `server/src/routes/campaignRoutes.ts`

- [ ] **Step 1: 写隔离测试**

```ts
it('does not expose another player private fact', () => {
  const full = {
    facts: [
      { id: 'f-public', visibility: 'public', knownBy: [] },
      { id: 'f-private', visibility: 'player_private', knownBy: ['player-a'] },
      { id: 'f-owner', visibility: 'owner_only', knownBy: [] },
    ],
  };

  expect(projectCampaign(full, { role: 'player', playerId: 'player-b' }).facts.map((f) => f.id))
    .toEqual(['f-public']);
  expect(projectCampaign(full, { role: 'player', playerId: 'player-a' }).facts.map((f) => f.id))
    .toEqual(['f-public', 'f-private']);
  expect(projectCampaign(full, { role: 'owner', userId: 'owner-1' }).facts.map((f) => f.id))
    .toEqual(['f-public', 'f-private', 'f-owner']);
});
```

- [ ] **Step 2: 实现单一可见性策略**

`VisibilityPolicy` 必须提供：

```ts
canRead(ctx: AuthContext, resource: VisibleResource): boolean;
projectCampaign(ctx: AuthContext, state: FullCampaignState): CampaignProjection;
projectEvent(ctx: AuthContext, event: CampaignEvent): CampaignEvent | null;
projectAiContext(ctx: AiContextAudience, state: FullCampaignState): AiContextPackage;
```

`knownBy` 只允许缩小范围，不允许绕过 `owner_only`。

- [ ] **Step 3: 将 owner/player 查询路由改为投影**

禁止 `GET /campaigns/:id/state` 直接返回数据库聚合对象。路由必须调用 `ProjectionService`，并为 owner 和指定 player 生成不同响应。

- [ ] **Step 4: 运行隔离测试**

```bash
rtk npm test -- --run server/src/modules/visibility/visibility.test.ts
rtk npm test -- --run server/src/tests/integration.test.ts
```

预期：玩家 A 无法看到玩家 B 私密行动、私密日志、隐藏角色字段和 owner AI 上下文。

- [ ] **Step 5: 提交**

```bash
rtk git add packages/contracts/src/campaign.ts packages/contracts/src/events.ts server/src/modules/visibility server/src/modules/world server/src/routes/campaignRoutes.ts
rtk git commit -m "feat: enforce campaign visibility projections" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 重建角色创建、审核和角色卡派生值

**Files:**
- Create: `server/src/modules/characters/CharacterService.ts`
- Create: `server/src/modules/characters/CharacterRepository.ts`
- Create: `server/src/modules/characters/CharacterAuditService.ts`
- Create: `server/src/modules/characters/character.test.ts`
- Create: `server/src/routes/characterRoutes.ts`
- Create: `client/src/features/player/character/CharacterBuilderPage.tsx`
- Create: `client/src/features/owner/characters/CharacterReviewPanel.tsx`
- Create: `client/src/entities/character/characterQueries.ts`
- Modify: `packages/contracts/src/character.ts`
- Modify: `server/src/modules/campaigns/CampaignService.ts`

- [ ] **Step 1: 写状态机测试**

覆盖：

```ts
it('creates a player character as pending_review', async () => {
  const result = await service.createDraft(playerContext, campaignId, draftInput);
  expect(result.status).toBe('pending_review');
});

it('prevents an unapproved character from submitting an action', async () => {
  await expect(turnService.submitAction(playerContext, turnId, 'look around')).rejects.toMatchObject({ code: 'CHARACTER_NOT_APPROVED' });
});

it('records the source of derived AC', async () => {
  const character = await service.approve(ownerContext, characterId);
  expect(character.derived.ac.sources).toEqual(expect.arrayContaining(['armor:chain-mail']));
});
```

- [ ] **Step 2: 实现角色 contract 和审核流程**

角色 API 必须区分：

```text
CharacterDraft
CharacterReview
ApprovedCharacter
CharacterDerivedValues
```

拥有者只能审核自己战役内的角色；玩家只能修改自己的草稿；审核后玩家不能直接修改已生效字段，修改会重新进入 `pending_review`。

- [ ] **Step 3: 建立可审计派生值**

`CharacterAuditService` 为 AC、HP、速度、豁免和技能保存来源列表。任何装备或属性变更都先计算派生值，再把结果和来源放入事务。

- [ ] **Step 4: 建立拥有者审核 UI 测试**

使用 Testing Library 验证：

- 草稿显示“待审核”；
- 拥有者可以批准和退回；
- 玩家不能看到其他人的草稿；
- 未批准角色不能提交行动。

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run server/src/modules/characters/character.test.ts client/src/features/owner/characters/CharacterReviewPanel.test.tsx
rtk npm run typecheck --workspace server
rtk npm run typecheck --workspace client
rtk git add packages/contracts/src/character.ts server/src/modules/characters server/src/routes/characterRoutes.ts client/src/features/player/character client/src/features/owner/characters client/src/entities/character server/src/modules/campaigns/CampaignService.ts
rtk git commit -m "feat: add character creation and owner review" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 重建回合、行动锁定和结构化 AI 结算

**Files:**
- Create: `server/src/modules/turns/TurnService.ts`
- Create: `server/src/modules/turns/TurnRepository.ts`
- Create: `server/src/modules/turns/TurnStateMachine.ts`
- Create: `server/src/modules/turns/turn.test.ts`
- Create: `server/src/modules/ai-runtime/AiProviderPort.ts`
- Create: `server/src/modules/ai-runtime/AiResolutionService.ts`
- Create: `server/src/modules/ai-runtime/StructuredOutputParser.ts`
- Create: `server/src/modules/ai-runtime/ai-runtime.test.ts`
- Create: `server/src/routes/turnRoutes.ts`
- Create: `server/src/routes/aiRoutes.ts`
- Modify: `packages/contracts/src/turn.ts`
- Modify: `packages/contracts/src/ai.ts`

- [ ] **Step 1: 写最后一名玩家锁定测试**

```ts
it('keeps a turn editable until the last required player submits', async () => {
  const first = await service.submitAction(playerA, turnId, '搜索房间');
  expect(first.turn.status).toBe('waiting_for_actions');

  const edited = await service.updateAction(playerA, first.action.id, '检查门锁');
  expect(edited.action.text).toBe('检查门锁');

  const last = await service.submitAction(playerB, turnId, '观察窗外');
  expect(last.turn.status).toBe('locked');
});

it('rejects edits after the last required player submits', async () => {
  await service.submitAction(playerA, turnId, '搜索房间');
  await service.submitAction(playerB, turnId, '观察窗外');
  await expect(service.updateAction(playerA, actionA.id, '修改')).rejects.toMatchObject({ code: 'TURN_LOCKED' });
});
```

- [ ] **Step 2: 实现 TurnStateMachine**

状态只能按下列路径前进：

```text
waiting_for_actions → locked → resolving → completed
                                      └→ needs_owner_attention
```

`submitAction` 在事务中：

1. 校验玩家和已批准角色；
2. 校验回合仍为 `waiting_for_actions`；
3. 创建或更新玩家行动；
4. 检查所有必需成员是否已提交；
5. 如果已齐，写入 `locked_at`，将回合改为 `locked`，发布锁定事件。

- [ ] **Step 3: 实现 Provider 端口和结构化输出**

```ts
export interface AiPrompt {
  campaignId: string;
  audience: 'owner' | 'public' | 'player_private';
  system: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

export interface AiProviderPort {
  stream(input: AiPrompt, hooks: {
    onPublicDelta(text: string): Promise<void>;
  }): Promise<unknown>;
}

export interface AiResolutionService {
  resolveTurn(turnId: string): Promise<TurnResolution>;
}
```

`StructuredOutputParser` 使用 `turnResolutionSchema.safeParse`，失败时抛出 `AI_OUTPUT_INVALID`，不得把原始 AI 输出直接应用到状态表。

- [ ] **Step 4: 实现预览与正式提交分离**

公开 delta 只写内存或短期 `ai_previews` 表；完整结果通过 schema、权限和状态检查后，才在一个数据库事务中写入正式日志和状态。

事务成功后依次创建：

- 领域事件；
- 自动存档；
- `turn.resolved` 事件。

失败时删除/标记临时预览，并把回合改为 `needs_owner_attention`。

- [ ] **Step 5: 测试 AI 失败和重复应用**

```ts
it('does not apply partial preview when provider fails', async () => {
  provider.stream.mockRejectedValueOnce(new Error('provider down'));
  await expect(ai.resolveTurn(lockedTurnId)).rejects.toThrow();
  expect(await logs.listOfficial(lockedTurnId)).toEqual([]);
  expect(await turns.get(lockedTurnId)).toMatchObject({ status: 'needs_owner_attention' });
});

it('does not apply the same resolution twice', async () => {
  const result = validResolution();
  await materializer.applyOnce(turnId, result);
  await materializer.applyOnce(turnId, result);
  expect(await logs.countForTurn(turnId)).toBe(1);
});
```

- [ ] **Step 6: 运行测试并提交**

```bash
rtk npm test -- --run server/src/modules/turns/turn.test.ts server/src/modules/ai-runtime/ai-runtime.test.ts
rtk npm run typecheck --workspace server
rtk git add packages/contracts/src/turn.ts packages/contracts/src/ai.ts server/src/modules/turns server/src/modules/ai-runtime server/src/routes/turnRoutes.ts server/src/routes/aiRoutes.ts
rtk git commit -m "feat: add turn locking and structured AI resolution" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 重建结构化战斗和存档

**Files:**
- Create: `server/src/modules/combat/CombatService.ts`
- Create: `server/src/modules/combat/CombatRepository.ts`
- Create: `server/src/modules/combat/combat.test.ts`
- Create: `server/src/modules/archives/ArchiveService.ts`
- Create: `server/src/modules/archives/ArchiveRepository.ts`
- Create: `server/src/modules/archives/archive.test.ts`
- Create: `server/src/routes/combatRoutes.ts`
- Create: `server/src/routes/archiveRoutes.ts`
- Modify: `packages/contracts/src/combat.ts`
- Modify: `packages/contracts/src/events.ts`

- [ ] **Step 1: 写战斗状态测试**

覆盖：

```ts
it('advances initiative and rejects actions from inactive combatants', async () => {
  const encounter = await combat.start(campaignId, fixtureEncounter());
  expect(encounter.activeCombatantId).toBe('hero-1');
  await combat.endTurn(ownerContext, encounter.id, 'hero-1');
  expect((await combat.get(encounter.id)).activeCombatantId).toBe('goblin-1');
  await expect(combat.applyAction(playerContext, encounter.id, { actorId: 'hero-1', kind: 'attack' })).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
});
```

- [ ] **Step 2: 实现先攻、HP、AC 和状态效果**

所有战斗状态变更使用白名单命令：

```text
startEncounter
rollInitiative
advanceTurn
applyAttack
applySavingThrow
applyDamage
applyHealing
addCondition
removeCondition
endEncounter
```

禁止接受任意 JSON patch 修改战斗表。

- [ ] **Step 3: 写自动/手动存档测试**

```ts
it('creates an automatic archive after a completed turn', async () => {
  await archive.createAfterTurn(turnId);
  const saved = await archive.list(campaignId);
  expect(saved[0]).toMatchObject({ kind: 'automatic', turnId });
});

it('restores an archive as active state without deleting later history', async () => {
  const saved = await archive.createNamed(ownerContext, campaignId, '进入矿洞前');
  await archive.restore(ownerContext, saved.id);
  expect(await archive.currentCampaignVersion(campaignId)).toBe(saved.version);
  expect(await archive.supersededEvents(campaignId)).toBeGreaterThan(0);
});
```

- [ ] **Step 4: 实现恢复事务**

恢复必须：

1. 校验 owner；
2. 锁定 campaign；
3. 写入当前状态版本；
4. 将之后事件标记 `superseded`；
5. 写入 `archive.restored` 系统事件；
6. 提交事务后才发布实时通知。

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run server/src/modules/combat/combat.test.ts server/src/modules/archives/archive.test.ts
rtk npm run typecheck --workspace server
rtk git add packages/contracts/src/combat.ts packages/contracts/src/events.ts server/src/modules/combat server/src/modules/archives server/src/routes/combatRoutes.ts server/src/routes/archiveRoutes.ts
rtk git commit -m "feat: add structured combat and campaign archives" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: 建立 Outbox 和 SSE 实时投影

**Files:**
- Create: `server/src/platform/realtime/EventPublisher.ts`
- Create: `server/src/platform/realtime/OutboxRepository.ts`
- Create: `server/src/platform/realtime/SseHub.ts`
- Create: `server/src/platform/realtime/eventProjection.ts`
- Create: `server/src/platform/realtime/realtime.test.ts`
- Create: `server/src/routes/realtimeRoutes.ts`
- Modify: `server/src/app.ts`
- Modify: `packages/contracts/src/events.ts`
- Modify: `server/src/modules/visibility/ProjectionService.ts`

- [ ] **Step 1: 写可见性和重连测试**

```ts
it('projects owner-only event out of a player stream', () => {
  const projected = projectEvent(playerContext, { type: 'ai.preview.delta', runId: 'r1', text: '公开片段' });
  expect(projected).toBeDefined();
  expect(projectEvent(playerContext, ownerOnlyDebugEvent)).toBeNull();
});

it('replays events after the client cursor', async () => {
  const events = await outbox.listAfter(campaignId, 'event-10');
  expect(events.every((event) => event.sequence > 10)).toBe(true);
});
```

- [ ] **Step 2: 实现 Outbox**

领域事务只写 outbox，不直接操作连接：

```ts
await tx.execute(
  'INSERT INTO outbox_events (id, campaign_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  [id, campaignId, sequence, event.type, JSON.stringify(event), now],
);
```

后台 publisher 读取未发布事件，经过 `projectEvent` 后推送给连接，并记录已发布状态。

- [ ] **Step 3: 实现 SSE 协议**

连接参数：

```text
GET /api/campaigns/:campaignId/events?after=<sequence>
Authorization: session cookie
```

事件格式：

```text
event: campaign
id: 42
data: {"type":"turn.locked","turnId":"turn-1"}

```

客户端断线后携带最后一个 event id 重连，服务端先补发 outbox，再发送 live events。

- [ ] **Step 4: 测试并提交**

```bash
rtk npm test -- --run server/src/platform/realtime/realtime.test.ts
rtk npm run typecheck --workspace server
rtk git add packages/contracts/src/events.ts server/src/platform/realtime server/src/routes/realtimeRoutes.ts server/src/app.ts server/src/modules/visibility/ProjectionService.ts
rtk git commit -m "feat: add visible realtime event delivery" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: 建立新的前端 App Shell、认证和战役列表

**Files:**
- Create: `client/src/app/router/AppRouter.tsx`
- Create: `client/src/app/providers/AppProviders.tsx`
- Create: `client/src/app/realtime/RealtimeSession.ts`
- Create: `client/src/shared/ui/AppShell.tsx`
- Create: `client/src/shared/ui/AsyncState.tsx`
- Create: `client/src/features/auth/LoginPage.tsx`
- Create: `client/src/features/auth/RegisterPage.tsx`
- Create: `client/src/features/campaigns/CampaignListPage.tsx`
- Create: `client/src/features/campaigns/CreateCampaignPage.tsx`
- Create: `client/src/api/auth/authApi.ts`
- Create: `client/src/api/campaigns/campaignApi.ts`
- Create: `client/src/entities/user/userQueries.ts`
- Create: `client/src/entities/campaign/campaignQueries.ts`
- Create: `client/src/features/auth/auth.test.tsx`
- Create: `client/src/features/campaigns/campaign-list.test.tsx`
- Modify: `client/src/main.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/package.json`
- Modify: `client/tsconfig.json`

- [ ] **Step 1: 添加客户端依赖并写路由测试**

添加：

```json
{
  "@tanstack/react-query": "latest",
  "react-router-dom": "latest",
  "lucide-react": "latest"
}
```

测试：

```tsx
it('shows campaign list after a successful session', async () => {
  render(<AppProviders><MemoryRouter initialEntries={['/campaigns']}><AppRouter /></MemoryRouter></AppProviders>);
  expect(await screen.findByRole('heading', { name: '我的战役' })).toBeInTheDocument();
});
```

- [ ] **Step 2: 实现 AppProviders**

Provider 顺序：

```tsx
<QueryClientProvider client={queryClient}>
  <AuthProvider>
    <RealtimeProvider>
      {children}
    </RealtimeProvider>
  </AuthProvider>
</QueryClientProvider>
```

`RealtimeProvider` 不在没有 campaignId 时建立连接。

- [ ] **Step 3: 实现路由守卫和认证页面**

路由必须区分：

```text
未登录 → /login
已登录无战役 → /campaigns
owner → /campaigns/:id/owner
player → /campaigns/:id/player
```

加载和错误状态使用 `AsyncState`，不能在 App 根部直接显示白屏或原始异常。

- [ ] **Step 4: 实现战役列表和创建向导**

创建向导只收集：名称、规则版本、Provider 和预计人数；提交后跳转 owner workspace。

- [ ] **Step 5: 运行客户端测试**

```bash
rtk npm test -- --run client/src/features/auth/auth.test.tsx client/src/features/campaigns/campaign-list.test.tsx
rtk npm run typecheck --workspace client
```

- [ ] **Step 6: 提交**

```bash
rtk git add client/package.json client/tsconfig.json client/src/main.tsx client/src/App.tsx client/src/app client/src/shared/ui client/src/features/auth client/src/features/campaigns client/src/api/auth client/src/api/campaigns client/src/entities/user client/src/entities/campaign
rtk git commit -m "feat: add authenticated campaign app shell" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: 实现拥有者工作区

**Files:**
- Create: `client/src/features/owner/OwnerWorkspacePage.tsx`
- Create: `client/src/features/owner/components/OwnerHeader.tsx`
- Create: `client/src/features/owner/components/OwnerSidebar.tsx`
- Create: `client/src/features/owner/components/OwnerInspector.tsx`
- Create: `client/src/features/owner/overview/OwnerOverviewPage.tsx`
- Create: `client/src/features/owner/turn/OwnerTurnPage.tsx`
- Create: `client/src/features/owner/combat/OwnerCombatPage.tsx`
- Create: `client/src/features/owner/characters/OwnerCharactersPage.tsx`
- Create: `client/src/features/owner/world/OwnerWorldPage.tsx`
- Create: `client/src/features/owner/ai/OwnerAiRunPage.tsx`
- Create: `client/src/features/owner/archives/OwnerArchivesPage.tsx`
- Create: `client/src/features/owner/owner-workspace.test.tsx`
- Create: `client/src/api/turns/turnApi.ts`
- Create: `client/src/api/combat/combatApi.ts`
- Create: `client/src/api/archives/archiveApi.ts`
- Create: `client/src/entities/turn/turnQueries.ts`
- Create: `client/src/entities/combat/combatQueries.ts`
- Create: `client/src/entities/archive/archiveQueries.ts`

- [ ] **Step 1: 写 owner 可见内容和路由测试**

```tsx
it('renders owner inspector with full AI status but keeps navigation stable', async () => {
  render(<OwnerWorkspacePage campaignId="campaign-1" />);
  expect(await screen.findByRole('navigation', { name: '战役导航' })).toBeInTheDocument();
  expect(screen.getByText('AI 运行')).toBeInTheDocument();
});
```

- [ ] **Step 2: 实现三栏 OwnerShell**

结构：

```tsx
<OwnerShell>
  <OwnerHeader />
  <OwnerSidebar />
  <OwnerMainPanel />
  <OwnerInspector />
</OwnerShell>
```

OwnerShell 只负责布局和区域导航；每个页面 feature 自己获取查询数据。

- [ ] **Step 3: 实现回合页**

回合页显示：

- 当前回合状态；
- 玩家提交进度；
- 已锁定行动的摘要，不显示给玩家的完整隐私内容除非 owner；
- AI 生成进度；
- 失败原因和重试动作；
- 结构化状态变化预览。

- [ ] **Step 4: 实现战斗、角色、AI 和存档页**

各页只调用对应 API/queries，不从 `OwnerWorkspacePage` 透传完整 `AdminState`。

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run client/src/features/owner/owner-workspace.test.tsx
rtk npm run typecheck --workspace client
rtk git add client/src/features/owner client/src/api/turns client/src/api/combat client/src/api/archives client/src/entities/turn client/src/entities/combat client/src/entities/archive
rtk git commit -m "feat: add owner campaign workspace" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: 实现玩家工作区和行动锁定交互

**Files:**
- Create: `client/src/features/player/PlayerWorkspacePage.tsx`
- Create: `client/src/features/player/components/PlayerHeader.tsx`
- Create: `client/src/features/player/components/PlayerInspector.tsx`
- Create: `client/src/features/player/story/PlayerStoryPage.tsx`
- Create: `client/src/features/player/action/PlayerActionComposer.tsx`
- Create: `client/src/features/player/character/PlayerCharacterPage.tsx`
- Create: `client/src/features/player/inventory/PlayerInventoryPage.tsx`
- Create: `client/src/features/player/combat/PlayerCombatPage.tsx`
- Create: `client/src/features/player/player-workspace.test.tsx`
- Create: `client/src/api/realtime/realtimeEvents.ts`
- Modify: `client/src/app/realtime/RealtimeSession.ts`

- [ ] **Step 1: 写行动编辑测试**

```tsx
it('allows editing before lock and disables the editor after turn.locked', async () => {
  const user = userEvent.setup();
  render(<PlayerActionComposer turn={waitingTurn} />);
  const input = screen.getByRole('textbox', { name: '本轮行动' });
  await user.type(input, '检查门');
  expect(input).not.toBeDisabled();

  rerender(<PlayerActionComposer turn={lockedTurn} />);
  expect(screen.getByRole('textbox', { name: '本轮行动' })).toBeDisabled();
  expect(screen.getByText('本回合已锁定')).toBeInTheDocument();
});
```

- [ ] **Step 2: 实现 PlayerShell**

玩家工作区只加载：

- 公开剧情；
- 自己的私密结果；
- 自己的角色、背包和战斗状态；
- 待自己处理的交互；
- 公开回合进度。

- [ ] **Step 3: 接入实时事件**

`RealtimeSession` 收到：

- `turn.action_submitted`：更新提交进度；
- `turn.locked`：锁定编辑器；
- `ai.preview.delta`：只更新公开预览；
- `ai.preview.failed`：丢弃预览并显示可恢复错误；
- `turn.resolved`：刷新公开剧情、玩家私密结果和角色/战斗查询。

- [ ] **Step 4: 运行客户端测试并提交**

```bash
rtk npm test -- --run client/src/features/player/player-workspace.test.tsx
rtk npm run typecheck --workspace client
rtk git add client/src/features/player client/src/api/realtime client/src/app/realtime/RealtimeSession.ts
rtk git commit -m "feat: add player campaign workspace" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: 实现规则资料和 AI Provider 管理边界

**Files:**
- Create: `server/src/modules/rules/RulesService.ts`
- Create: `server/src/modules/rules/RulesRepository.ts`
- Create: `server/src/modules/rules/rules.test.ts`
- Create: `server/src/modules/ai-runtime/ProviderCredentialService.ts`
- Create: `server/src/modules/ai-runtime/provider-credential.test.ts`
- Create: `server/src/routes/rulesRoutes.ts`
- Create: `server/src/routes/providerRoutes.ts`
- Create: `client/src/features/owner/rules/OwnerRulesPage.tsx`
- Create: `client/src/features/owner/ai/OwnerProviderPage.tsx`
- Create: `client/src/features/owner/rules/rules-page.test.tsx`
- Modify: `packages/contracts/src/ai.ts`
- Modify: `packages/contracts/src/campaign.ts`

- [ ] **Step 1: 写许可证和 Provider 隔离测试**

```ts
it('does not return provider API keys to the client', async () => {
  await providers.save(ownerContext, campaignId, { baseUrl: 'https://example.test', apiKey: 'secret', model: 'model-1' });
  const publicConfig = await providers.getClientConfig(ownerContext, campaignId);
  expect(publicConfig).toEqual({ baseUrl: 'https://example.test', model: 'model-1', configured: true });
  expect(JSON.stringify(publicConfig)).not.toContain('secret');
});

it('requires license metadata for platform rules', async () => {
  await expect(rules.publishPlatformContent({ name: 'Rules', version: '1' }, [])).rejects.toMatchObject({ code: 'INVALID_RULE_SOURCE' });
});
```

- [ ] **Step 2: 实现 RulesService**

来源记录必须包含：

```ts
{
  sourceName: string;
  version: string;
  license: string;
  attribution: string;
  contentHash: string;
  scope: 'platform' | 'campaign' | 'user';
}
```

战役绑定规则版本后，更新规则资料不能静默改变战役已使用的数据。

- [ ] **Step 3: 实现 ProviderCredentialService**

Key 只在服务端解密和调用；查询返回脱敏 DTO。第一阶段可以使用服务端环境密钥加密数据库字段，禁止写入日志。

- [ ] **Step 4: 实现 owner 规则和 Provider 页面**

页面只显示 Provider、模型、连接测试结果和配置状态，不显示 API Key 原文。

- [ ] **Step 5: 运行测试并提交**

```bash
rtk npm test -- --run server/src/modules/rules/rules.test.ts server/src/modules/ai-runtime/provider-credential.test.ts client/src/features/owner/rules/rules-page.test.tsx
rtk npm run typecheck --workspace server
rtk npm run typecheck --workspace client
rtk git add packages/contracts/src/ai.ts packages/contracts/src/campaign.ts server/src/modules/rules server/src/modules/ai-runtime/ProviderCredentialService.ts server/src/modules/ai-runtime/provider-credential.test.ts server/src/routes/rulesRoutes.ts server/src/routes/providerRoutes.ts client/src/features/owner/rules client/src/features/owner/ai
rtk git commit -m "feat: add versioned rules and provider boundaries" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: 建立旧 API 迁移适配层并完成垂直切片验收

**Files:**
- Create: `server/src/platform/legacy/LegacyStateAdapter.ts`
- Create: `server/src/platform/legacy/legacy-adapter.test.ts`
- Create: `client/src/api/legacy/legacyApiAdapter.ts`
- Create: `server/src/tests/vertical-campaign-flow.test.ts`
- Create: `client/src/tests/vertical-campaign-flow.test.tsx`
- Modify: `server/src/app.ts`
- Modify: `client/src/app/router/AppRouter.tsx`
- Modify: `package.json`
- Modify: `vitest.config.ts`

- [ ] **Step 1: 写旧数据适配测试**

适配器必须将旧字段映射为新 contract：

```ts
it('maps legacy room and player state to campaign projection', () => {
  const result = adaptLegacyState({
    room: { id: 'room-1', name: '旧房间', currentTurn: 2 },
    players: [{ id: 'p1', name: '玩家', token: 'legacy-token' }],
  });

  expect(result.campaign.id).toBe('room-1');
  expect(result.members[0].displayName).toBe('玩家');
  expect(result.members[0].legacyToken).toBeUndefined();
});
```

- [ ] **Step 2: 实现兼容适配器**

适配器只能用于迁移和读取旧数据，不允许新模块依赖旧 `AdminState` 或旧 `PlayerState`。所有新写入走新模块仓储。

- [ ] **Step 3: 写完整垂直集成测试**

```ts
it('runs create → join → approve → submit → lock → resolve → archive → project', async () => {
  const owner = await fixture.register('owner@example.test');
  const playerA = await fixture.register('a@example.test');
  const playerB = await fixture.register('b@example.test');
  const campaign = await fixture.createCampaign(owner);
  await fixture.join(campaign.id, playerA);
  await fixture.join(campaign.id, playerB);
  const characterA = await fixture.createAndApproveCharacter(playerA, owner, campaign.id);
  const characterB = await fixture.createAndApproveCharacter(playerB, owner, campaign.id);
  const turn = await fixture.startTurn(campaign.id, [characterA, characterB]);

  await fixture.submitAction(playerA, turn.id, '搜索入口');
  expect(await fixture.turnStatus(turn.id)).toBe('waiting_for_actions');
  await fixture.submitAction(playerB, turn.id, '观察守卫');
  expect(await fixture.turnStatus(turn.id)).toBe('locked');
  await fixture.resolveWithMockAi(turn.id);

  expect(await fixture.archiveCount(campaign.id)).toBe(1);
  expect(await fixture.playerView(playerA, campaign.id)).not.toContainPrivateDataOf(playerB);
});
```

- [ ] **Step 4: 浏览器验收**

启动：

```bash
rtk npm run dev
```

使用两个浏览器上下文完成：

```text
注册 owner
→ 创建战役
→ 注册 player A / player B
→ 两名玩家加入
→ 创建角色
→ owner 审核
→ 两名玩家提交行动
→ 验证最后一人提交后锁定
→ mock AI 结算
→ 验证 owner/private/public 投影
→ 验证自动存档
```

- [ ] **Step 5: 运行全量相关测试并提交**

```bash
rtk npm test -- --run server/src/tests/vertical-campaign-flow.test.ts client/src/tests/vertical-campaign-flow.test.tsx
rtk npm run typecheck --workspace server
rtk npm run typecheck --workspace client
rtk npm run build
rtk git add server/src/platform/legacy server/src/tests/vertical-campaign-flow.test.ts client/src/api/legacy client/src/tests/vertical-campaign-flow.test.tsx server/src/app.ts client/src/app/router/AppRouter.tsx package.json vitest.config.ts
rtk git commit -m "test: verify end-to-end campaign vertical slice" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 14: 清理旧入口并完成发布前审查

**Files:**
- Modify/Delete only after Task 13 passes: `server/src/routes/*.ts`, `server/src/services/*.ts`, `client/src/pages/*.tsx`, `client/src/components/*.tsx`
- Create: `docs/superpowers/reviews/2026-08-01-rearchitecture-cutover.md`
- Modify: `README.md`
- Modify: `.gitignore`

- [ ] **Step 1: 列出旧入口引用**

运行：

```bash
rtk git grep -n "AdminPage\|PlayerPage\|getAdminState\|subscribeRoom" -- server/src client/src
```

将每个引用归类为：

```text
新工作区仍需要
迁移适配层需要
旧代码已无引用可删除
```

- [ ] **Step 2: 只删除无引用旧代码**

禁止按文件名猜测删除。只有 `git grep`、测试和构建都证明无引用后，才能删除旧页面/路由/服务。

- [ ] **Step 3: 更新 README**

README 必须包含：

- 本地 SQLite 启动方式；
- PostgreSQL 环境变量；
- 用户注册和战役创建流程；
- AI Provider Key 的安全说明；
- 规则内容许可证责任；
- 自动存档和恢复说明；
- 公共/私密/owner-only 数据边界；
- 当前未实现的导出、社区和地图功能。

- [ ] **Step 4: 运行发布前检查**

```bash
rtk npm test -- --run
rtk npm run typecheck
rtk npm run build
rtk git status --short --branch
```

预期：工作树干净；所有新增垂直切片测试通过；仍存在的遗留失败必须写入审查文档并阻止发布，不能用忽略或删测试掩盖。

- [ ] **Step 5: 提交并请求代码审查**

```bash
rtk git add docs/superpowers/reviews/2026-08-01-rearchitecture-cutover.md README.md .gitignore
rtk git commit -m "docs: record rearchitecture cutover review" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

随后对整个 `main` 相对于归档基线执行一次规格审查和代码质量审查；未通过审查前不删除归档 tag、stash 或外部备份。

---

## 计划自检

### 规格覆盖

- 多用户账号：Task 3；
- owner/player 权限：Task 3、Task 4；
- SQLite/PostgreSQL：Task 2；
- D&D 5e 规则版本和许可证：Task 12；
- 玩家角色创建和 owner 审核：Task 5；
- 最后一名玩家提交后锁定：Task 6；
- AI 结构化输出和流式预览：Task 6；
- AI 失败进入 owner 处理：Task 6；
- 公开/玩家私密/owner-only：Task 4、Task 8；
- 结构化战斗：Task 7；
- 自动/手动存档和恢复：Task 7；
- SSE、断线重连和事件投影：Task 8；
- owner/player 前端工作区：Task 9–11；
- 桌面优先：Task 9–11；
- 旧代码迁移和垂直切片：Task 13–14；
- 导出、社区、地图等非目标：保留在设计文档，不加入本计划的第一阶段实现。

### 占位符检查

本计划不使用 `TODO`、`TBD` 或未定义的“以后补充”步骤；每个任务都有具体文件、接口、测试命令和提交范围。

### 类型一致性

- 共享 contract 统一从 `@dnd/contracts` 导出；
- `TurnResolution` 在 AI parser、materializer、事件和前端查询中复用；
- `CampaignEvent` 在 outbox、SSE projection 和 client realtime session 中复用；
- `AppErrorCode` 统一服务端错误响应和前端恢复 UI；
- `DatabasePort` 是 SQLite/PostgreSQL adapter 的共同接口。
