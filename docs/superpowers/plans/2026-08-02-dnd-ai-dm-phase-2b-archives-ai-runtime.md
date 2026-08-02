# DND AI-DM 平台重构：阶段二 B（Phase 2B）详细计划（存档、AI 运行时与服务端 AI 垂直流程）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本文是 `2026-08-02-dnd-ai-dm-rearchitecture-revised.md`（权威总路线图）中 **Phase 2B** 的唯一可执行详细计划，覆盖 7 个小任务：契约 + `archive.restored` 事件 + `007_archives.sql` + superseded 基础；`008_ai_runtime.sql` + AI 持久化 + provider 端口；存档捕获/恢复；AI 上下文/输出校验/投影/白名单 materializer；`AiResolutionService`；HTTP AI 路由与 app 装配；三 actor 服务端 AI 垂直验收。

## 状态：⏭ 待执行

**状态：** 详细计划已编写，**待执行**。Phase 2A 已完成并通过最终审查（**READY_FOR_PHASE_2B**，见 [`2026-08-02-phase-2a-world-outbox-turns-review.md`](../reviews/2026-08-02-phase-2a-world-outbox-turns-review.md)）。本文件是 Phase 2B 的待执行计划；本文中的所有 Task 步骤均为**计划指令**，尚未实现。**Phase 2 总体验收（服务端 AI 垂直流程 + 两级 review）仍未完成。**

**Goal:** 在 Phase 2A（`b12059c`–`4d57bd7`）已建成的 world facts / 事务性 outbox / turn-actions 基线上，产出（1）存档数据面（`007_archives.sql`：真实快照 + 真实恢复 + `archive.restored` 系统事件 + 恢复后历史 superseded 不物理删除），（2）AI 运行时数据面（`008_ai_runtime.sql`：AI runs / turn entries / interaction requests + 每战役 AI run 序列），（3）短事务 lifecycle 的 `AiResolutionService`（claim → preview → success/fail，idempotency、retry、自动存档、下一回合），（4）HTTP AI/存档/entries 路由与 app 装配（生产默认 `UnavailableAiProvider`，`ScriptedAiProvider` 仅测试注入），（5）owner + playerA + playerB 三 actor 的真实 HTTP 服务端 AI 垂直流程 `create → join → approve → submit → lock → resolve → archive → project`，另覆盖 provider fail / invalid / retry / 无半截写。

**Architecture:** 所有新平台表统一 `platform_` 前缀，迁移编号连续（`007_archives.sql` → `008_ai_runtime.sql`）。存档 per-campaign version 用「原子 upsert 计数器 + `RETURNING`」在写事务内取得，**绝不 MAX+1**（与 outbox sequence 同一模式）。AI runtime 采用短事务 lifecycle：claim tx（campaign/turn 行锁 + idempotency/attempt + context 快照 + run=running + turn=resolving + preview.started）→ provider 在 tx 外运行（每个 preview delta 独立短 tx publish）→ 成功一个 formal apply tx（白名单 state changes → entries/requests → run succeeded → turn completed → `turn.resolved`/`interaction.requested` 全部事件 → 自动存档 → 下一回合）或失败一个 fail tx（run failed → turn=needs_owner_attention → preview.failed → 无正式写）。**绝不嵌套调用 `TurnService.transaction`**：`AiResolutionService` 在 formal apply tx 内用 `tx` 重新构造 repositories 并直接创建下一回合。Provider 是 `AiProviderPort` 端口；生产默认 `UnavailableAiProvider`（resolve 安全失败 `AI_PROVIDER_FAILED`），`Mock/ScriptedAiProvider` 只放测试支持并通过 `CreateAppOptions.aiProvider` 显式注入。Provider final output 类型必须 `unknown`，由应用层 `turnResolutionSchema` parse；schema/规则/可见性校验失败 → `AI_OUTPUT_INVALID`（combat 能力门禁 → `STATE_CONFLICT`）。Turn entries 投影复用 `VisibilityPolicy`（owner 全量；player public + 自己的 private；owner_only 不泄漏）；raw debug/context/result 仅 owner AI run view。

**Tech Stack:** Node.js 22.12.0、TypeScript、Express、SQLite（`better-sqlite3` 12.10.0 固定）、PostgreSQL（`pg`）、Zod、Vitest。不写真实 `server/dnd.sqlite`，一律内存 SQLite；Postgres 契约由既有 `POSTGRES_TEST_URL` 门控套件覆盖（本阶段为 007 restore/version 与 008 idempotency/claim 新增门控测试，未配置时 skip）。

---

## 执行前约束

- 不 `git stash pop` 归档 stash；不修改 `server/dnd.sqlite` 等运行数据；不使用 `git add .`，每次只暂存任务列出的具体路径。
- 所有外部 CLI 使用 `rtk` 前缀。
- 每个任务一个只含该任务文件的 commit，trailer 精确为 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- **本任务（编写计划）只改文档，不改生产/测试代码，不运行真实数据库，不创建临时脚本。**
- 本阶段不建立任何前端文件；不建立 SSE live/replay（Phase 3）；不建立真实 Provider/API key 管理（Phase 5）；不建立完整 combat mutation（Phase 3）；不新增错误码（只用既有码：`FORBIDDEN`/`CAMPAIGN_NOT_FOUND`/`STATE_CONFLICT`/`VALIDATION_ERROR`/`NOT_FOUND`/`TURN_LOCKED`/`TURN_NOT_ACTIVE`/`AI_PROVIDER_FAILED`/`AI_OUTPUT_INVALID`/`INTERNAL_ERROR`）。
- 迁移严格 `007_archives.sql` → `008_ai_runtime.sql`，编号连续；允许迁移内创建必要 helper tables 与对既有表一次性 portable ALTER。`MigrationRunner` 保证每份迁移只跑一次。
- **Provider 固定决策**：生产 app 默认 `UnavailableAiProvider`，resolve 安全失败 `AI_PROVIDER_FAILED`；`Mock/ScriptedAiProvider` 只放测试支持并通过 `CreateAppOptions.aiProvider` 显式注入。**绝不能默认 Mock**。Provider final output 类型必须 `unknown`，由应用层 `turnResolutionSchema` parse。
- **短事务 lifecycle 固定决策**：provider/stream 期间绝不持有 DB tx。claim tx 锁 campaign/turn 行、校验 `locked` 或 `needs_owner_attention`、分配新 idempotencyKey/attempt、capture 稳定 context_json、run=running、turn=resolving、publish `preview.started`；provider 在 tx 外运行；每个 preview delta 由独立短 tx publish 且保持顺序；success 一个 formal apply tx；failure 一个 fail tx；任何 formal apply 失败整体 rollback。
- **idempotency 固定决策**：resolve body 必填受限长度 `idempotencyKey`（`trim().min(1).max(64)`）。`UNIQUE(campaign_id, idempotency_key)` 作不变量兜底；同 key 返回既有 run，**绝不再次调用 provider / 写 entries / archive / events**；failed retry 必须新 key；attempt 在 turn/campaign 锁内单调分配。**并发固定 API 语义：同 key 命中 running run 时立即返回 `{ created:false, status:'running' }`，不等待、不重复调 provider；客户端可 GET run 轮询**。并发同/不同 key 测试必须明确，且用确定性 gate（首个 provider claim 后阻塞）验证，禁止把状态兼容成 running 或 succeeded 二选一的 race 弱断言。
- **失败固定决策**：provider throw → `AI_PROVIDER_FAILED`；**preview delta 的短 tx/outbox publish 失败（本地 DB 写入失败，非 provider 输出问题）→ 包装为受控 `INTERNAL_ERROR`，provider 阶段 catch 保留该 AppError，绝不当 `AI_PROVIDER_FAILED` 误报**；schema/规则/可见性输出无效 → `AI_OUTPUT_INVALID`（combat 能力门禁使用 `STATE_CONFLICT`）；formal apply 内未知 DB/非 AppError 错误 → `INTERNAL_ERROR`（绝不当 `AI_PROVIDER_FAILED` 误报）；turn=needs_owner_attention；保留锁定 actions；无正式 entries/state changes/archive/next turn/turn.resolved；`preview.failed` 发出，客户端未来丢弃此前 delta。
- **成功 formal apply tx 顺序（固定）**：锁定/校验 run+turn → 白名单 apply state changes → 写 public/private/dice entries 与 interaction requests → run succeeded/result/debug → turn completed → 预生成 automatic archiveId → publish `turn.resolved` 和所有 `interaction.requested` 得到正式事件最高 sequence → snapshot 的 outbox watermark 包含这些事件 → insert automatic archive → create 下一 waiting_for_actions turn + requirements（同 tx）→ commit。不得嵌套调用 `TurnService.transaction`。
- **owner.debug 固定决策**：2B 只存 `raw_debug_json`，**不 emit** `owner.debug` 事件；Phase 3 再决定 realtime。
- 存档 manual label 必填 trimmed；automatic label=null；per-campaign version 用 atomic upsert+RETURNING，绝不 MAX+1；回滚/并发测试必须有。
- 恢复必须 owner-only、campaign 行锁、单 tx；当前存在 unsuperseded resolving turn/run 时拒绝 `STATE_CONFLICT`。
- 不硬编码 ctx/campaignId；所有领域服务只消费 `resolveCampaignContext` 生成的 `CampaignAuthContext`。
- 所有路由挂在 `/api/campaigns/:campaignId/*`，`Router({ mergeParams: true })` + campaign middleware，且在平台 `errorMiddleware` 之前注册。
- 玩家 DTO 不得泄露他人 private entries、owner_only 内容、AI run 的 context/result/raw debug 与任何 `*_json`/内部字段。
- 时间戳精度为毫秒（Phase 2A 观察项）：涉及 `updatedAt` 变化的断言依赖测试内 5ms sleep 保证不同毫秒。

## 本阶段 Files 总览（先读后写）

- Create: `packages/contracts/src/archive.ts`
- Create: `packages/contracts/src/archive.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/events.ts`（`archive.restored` variant）
- Modify: `packages/contracts/src/events.test.ts`
- Modify: `packages/contracts/src/ai.ts`（run/entry/request/version schemas）
- Create: `packages/contracts/src/ai.test.ts`
- Modify: `packages/contracts/src/turn.ts`（`DiceResult.targetPlayerId`）
- Modify: `packages/contracts/src/contracts.test.ts`
- Create: `server/src/platform/database/migrations/007_archives.sql`
- Create: `server/src/platform/database/migrations/008_ai_runtime.sql`
- Create: `server/src/platform/database/superseded-foundations.test.ts`
- Create: `server/src/platform/database/postgres-archives-ai.test.ts`（`POSTGRES_TEST_URL` 门控，T3 建、T5 扩展）
- Modify: `server/src/modules/turns/TurnRepository.ts`
- Modify: `server/src/modules/world/WorldFactRepository.ts`
- Modify: `server/src/platform/events/OutboxRepository.ts`
- Modify: `server/src/modules/characters/CharacterRepository.ts`
- Create: `server/src/modules/archives/ArchiveRepository.ts`
- Create: `server/src/modules/archives/ArchiveService.ts`
- Create: `server/src/modules/archives/archive.test.ts`
- Create: `server/src/routes/archiveRoutes.ts`
- Create: `server/src/modules/ai-runtime/AiProviderPort.ts`
- Create: `server/src/modules/ai-runtime/UnavailableAiProvider.ts`
- Create: `server/src/modules/ai-runtime/ScriptedAiProvider.ts`
- Create: `server/src/modules/ai-runtime/AiRunRepository.ts`
- Create: `server/src/modules/ai-runtime/TurnEntryRepository.ts`
- Create: `server/src/modules/ai-runtime/ai-persistence.test.ts`
- Create: `server/src/modules/ai-runtime/AiContextBuilder.ts`
- Create: `server/src/modules/ai-runtime/TurnResolutionValidator.ts`
- Create: `server/src/modules/ai-runtime/StateChangeMaterializer.ts`
- Create: `server/src/modules/ai-runtime/ai-context-builder.test.ts`
- Create: `server/src/modules/ai-runtime/turn-resolution-validator.test.ts`
- Create: `server/src/modules/ai-runtime/state-change-materializer.test.ts`
- Create: `server/src/modules/ai-runtime/turn-entries-projection.test.ts`
- Create: `server/src/modules/ai-runtime/AiResolutionService.ts`
- Create: `server/src/modules/ai-runtime/ai-resolution.test.ts`
- Create: `server/src/routes/aiRoutes.ts`
- Modify: `server/src/app.ts`（T3 挂 archive 路由；T6 挂 ai 路由 + `aiProvider` 装配）
- Modify: `server/src/tests/httpTestHarness.ts`（`aiProvider` 注入）
- Create: `server/src/tests/ai-routes-http.test.ts`
- Create: `server/src/tests/vertical-ai-resolution-http.test.ts`

## 任务依赖图

```
Task 1（contracts + archive.restored + 007 + superseded 基础）────┐
Task 2（008 AI 持久化 + repositories + provider 端口）────────────┼──→ Task 3（存档捕获/恢复 + routes）
Task 1 是 2/3/4 的迁移与契约前提；Task 2 建立 AI watermarks 供 Task 3 完整存档 service
Task 4（context builder + validator + projection + materializer）──→ Task 5（AiResolutionService）
Task 5 依赖 Task 2（provider/run repo）、Task 3（自动存档）、Task 4（context/validator/materializer）
Task 6（HTTP 路由 + app 装配 + harness 注入 + route 集成）依赖 Task 3/5
Task 7（三 actor 垂直验收）依赖 Task 6；是 Phase 2 总体验收门
```

---

## Task 1：`archive.restored` 事件 + 存档契约 + `007_archives.sql` + superseded 基础

**依赖：** Phase 2A 的 `campaignEventSchema`（`events.ts`）、`turnSummarySchema`/`turnActionSchema`/`visibilitySchema`/`worldFactKindSchema`（`turn.ts`/`world.ts`）；既有 `TurnRepository`/`WorldFactRepository`/`OutboxRepository`；`MigrationRunner` 单次执行保证。无本阶段前置任务。

**目标：** （1）存档契约 `packages/contracts/src/archive.ts`（archive/kind/version、snapshot schemaVersion=1、restore result、manual input）；（2）`archive.restored` 事件 variant + 默认受众 public；（3）`007_archives.sql` 建 `platform_archives` + `platform_archive_sequences`（per-campaign version 原子计数器）并对既有 `platform_turns`/`platform_world_facts`/`platform_outbox_events` 一次性 portable `ALTER` 增 `superseded_at`/`superseded_by_archive_id`；（4）既有 repository 默认 active 查询过滤 superseded（`findUnfinishedTurn`/`listByCampaign`/`lockTurnRow`/world `listByCampaign`/outbox `listByCampaign`/`listUnpublished`），并保留明确审计全量查询；`TurnRepository.maxTurnNumber` **必须包含 superseded**（避免复用号码）。

### Files

- Create: `packages/contracts/src/archive.ts`
- Create: `packages/contracts/src/archive.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/events.test.ts`
- Create: `server/src/platform/database/migrations/007_archives.sql`
- Modify: `server/src/modules/turns/TurnRepository.ts`
- Modify: `server/src/modules/world/WorldFactRepository.ts`
- Modify: `server/src/platform/events/OutboxRepository.ts`
- Create: `server/src/platform/database/superseded-foundations.test.ts`

### Step 1：写失败测试

`packages/contracts/src/archive.ts`（snapshot 至少含 campaignId/ruleset/characters/worldFacts/currentTurn/watermarks，schemaVersion=1，能被 `archiveSnapshotSchema.parse` 恢复）：

```ts
import { z } from 'zod';
import { visibilitySchema, turnSummarySchema, turnActionSchema } from './turn.js';
import { worldFactKindSchema } from './world.js';
import { characterStatusSchema } from './character.js';

/** 存档 contract：owner 创建/恢复；真实快照 + 真实恢复，不物理删除历史。 */

export const archiveKindSchema = z.enum(['automatic', 'manual']);
export type ArchiveKind = z.infer<typeof archiveKindSchema>;

/** manual 存档输入：label 必填 trimmed。automatic label=null（不经此 schema）。 */
export const manualArchiveInputSchema = z.object({
  label: z.string().trim().min(1),
});
export type ManualArchiveInput = z.infer<typeof manualArchiveInputSchema>;

export const archiveSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  kind: archiveKindSchema,
  turnId: z.string().nullable(),
  label: z.string().nullable(),
  version: z.number().int(),
  superseded: z.boolean(),
  createdByUserId: z.string().min(1),
  createdAt: z.string(),
});
export type Archive = z.infer<typeof archiveSchema>;

/** 快照角色：完整 owner current state（draft/pending_review/rejected/approved/archived 全保留），
 *  不含 audit / password / invite hash / 原始 DB 列名。 */
export const archiveSnapshotCharacterSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  playerId: z.string().min(1),
  name: z.string().min(1),
  status: characterStatusSchema,
  sheet: z.record(z.string(), z.unknown()),
  derived: z.record(z.string(), z.unknown()),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ArchiveSnapshotCharacter = z.infer<typeof archiveSnapshotCharacterSchema>;

/** 快照世界事实：与 WorldFact DTO 同形（不含 *_json 内部字段）。 */
export const archiveSnapshotWorldFactSchema = z.object({
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
export type ArchiveSnapshotWorldFact = z.infer<typeof archiveSnapshotWorldFactSchema>;

export const archiveSnapshotRequirementSchema = z.object({
  playerId: z.string().min(1),
  submitted: z.boolean(),
});
export type ArchiveSnapshotRequirement = z.infer<typeof archiveSnapshotRequirementSchema>;

export const archiveSnapshotTurnSchema = z.object({
  turn: turnSummarySchema,
  actions: z.array(turnActionSchema),
  requirements: z.array(archiveSnapshotRequirementSchema),
});
export type ArchiveSnapshotTurn = z.infer<typeof archiveSnapshotTurnSchema>;

/** 快照：schemaVersion=1；currentTurn 可为 null（setup / 无进行中回合）；watermarks 记录历史边界。 */
export const archiveSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  campaignId: z.string().min(1),
  ruleset: z.string().min(1),
  characters: z.array(archiveSnapshotCharacterSchema),
  worldFacts: z.array(archiveSnapshotWorldFactSchema),
  currentTurn: archiveSnapshotTurnSchema.nullable(),
  watermarks: z.object({
    outboxSequence: z.number().int(),
    aiRunCampaignSequence: z.number().int(),
    /** 捕获时 unsuperseded 历史最大 turn number（setup 无回合 = 0）。 */
    turnNumber: z.number().int(),
  }),
});
export type ArchiveSnapshot = z.infer<typeof archiveSnapshotSchema>;

export const archiveRestoreResultSchema = z.object({
  archive: archiveSchema,
  restoredTurnId: z.string().nullable(),
});
export type ArchiveRestoreResult = z.infer<typeof archiveRestoreResultSchema>;

export const archiveListEntrySchema = archiveSchema;
export type ArchiveListEntry = z.infer<typeof archiveListEntrySchema>;
```

在 `packages/contracts/src/index.ts` 追加 `export * from './archive.js';`。

`packages/contracts/src/archive.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { archiveSnapshotSchema, manualArchiveInputSchema } from './index';

describe('archive contracts', () => {
  it('parses a complete schemaVersion=1 snapshot', () => {
    const snapshot = archiveSnapshotSchema.parse({
      schemaVersion: 1,
      campaignId: 'c1',
      ruleset: 'dnd5e',
      characters: [{
        id: 'char-1', campaignId: 'c1', playerId: 'p1', name: '薇拉', status: 'approved',
        sheet: { ac: 14 }, derived: { ac: { value: 14, sources: ['base'] } },
        submittedAt: '2026-08-02T00:00:00.000Z', approvedAt: '2026-08-02T00:00:00.000Z',
        createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
      }],
      worldFacts: [{
        id: 'f1', campaignId: 'c1', title: '酒馆', kind: 'location', content: '热闹。',
        visibility: 'public', knownBy: [], createdAt: 'now', updatedAt: 'now',
      }],
      currentTurn: {
        turn: {
          id: 't1', campaignId: 'c1', number: 1, status: 'completed', lockedAt: 'now',
          completedAt: 'now', createdAt: 'now', updatedAt: 'now',
        },
        actions: [{
          id: 'a1', turnId: 't1', campaignId: 'c1', playerId: 'p1', body: '我搜索房间。',
          submittedAt: 'now', updatedAt: 'now',
        }],
        requirements: [{ playerId: 'p1', submitted: true }, { playerId: 'p2', submitted: true }],
      },
      watermarks: { outboxSequence: 4, aiRunCampaignSequence: 1, turnNumber: 1 },
    });
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.currentTurn?.turn.status).toBe('completed');
    expect(snapshot.watermarks.outboxSequence).toBe(4);
    expect(snapshot.watermarks.turnNumber).toBe(1);
    // 快照不得包含审计 / password / invite / *_json 内部字段。
    expect(JSON.stringify(snapshot)).not.toContain('_json');
    expect(JSON.stringify(snapshot)).not.toContain('password');
    expect(JSON.stringify(snapshot)).not.toContain('invite');
  });

  it('parses a setup snapshot without a current turn', () => {
    const snapshot = archiveSnapshotSchema.parse({
      schemaVersion: 1, campaignId: 'c1', ruleset: 'dnd5e',
      characters: [], worldFacts: [], currentTurn: null,
      watermarks: { outboxSequence: 0, aiRunCampaignSequence: 0, turnNumber: 0 },
    });
    expect(snapshot.currentTurn).toBeNull();
  });

  it('rejects a snapshot with unknown schemaVersion', () => {
    expect(() => archiveSnapshotSchema.parse({
      schemaVersion: 99, campaignId: 'c1', ruleset: 'dnd5e', characters: [], worldFacts: [],
      currentTurn: null, watermarks: { outboxSequence: 0, aiRunCampaignSequence: 0, turnNumber: 0 },
    })).toThrow();
  });

  it('trims and requires a manual archive label', () => {
    expect(manualArchiveInputSchema.parse({ label: '  进入矿洞前  ' }).label).toBe('进入矿洞前');
    expect(() => manualArchiveInputSchema.parse({ label: '   ' })).toThrow();
  });
});
```

`packages/contracts/src/events.ts` 追加 `archive.restored` variant（在 `interaction.requested` 之后、`owner.debug` 之前），并把 `campaignEventTypeSchema` 同步追加：

```ts
  z.object({ type: z.literal('archive.restored'), campaignId: z.string().min(1), archiveId: z.string().min(1), version: z.number().int() }),
```

`packages/contracts/src/events.test.ts` 追加（默认受众 public，owner 与 player 都可见）：

```ts
  it('accepts archive.restored as a public event', () => {
    const event = campaignEventSchema.parse({ type: 'archive.restored', campaignId: 'c', archiveId: 'a1', version: 2 });
    expect(eventDefaultAudience(event)).toEqual({ visibility: 'public', targetPlayerId: null });
    expect(canReadEvent({ role: 'player', playerId: 'p1' }, event)).toBe(true);
  });
```

`server/src/platform/database/superseded-foundations.test.ts`（SQLite 实测 007 ALTER 列存在 + 默认 active 查询过滤 superseded + maxTurnNumber 包含 superseded + outbox 审计全量查询保留）：

```ts
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from './SqliteDatabaseAdapter.js';
import { OutboxRepository } from '../events/OutboxRepository.js';
import { TurnRepository } from '../../modules/turns/TurnRepository.js';
import { WorldFactRepository } from '../../modules/world/WorldFactRepository.js';

async function seedCampaign(db: ReturnType<typeof createSqliteDatabase>, campaignId: string): Promise<void> {
  const ownerId = `owner-${campaignId}`;
  const now = new Date().toISOString();
  await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', [ownerId, `${ownerId}@example.test`, 'hash']);
  await db.execute(
    'INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [campaignId, ownerId, `campaign-${campaignId}`, 'setup', 'dnd5e', now, now],
  );
}

describe('007 superseded foundations', () => {
  it('adds superseded columns to turns/world_facts/outbox_events', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const turnCols = await db.query<{ name: string }>('PRAGMA table_info(platform_turns)');
    expect(turnCols.map((c) => c.name)).toEqual(expect.arrayContaining(['superseded_at', 'superseded_by_archive_id']));
    const factCols = await db.query<{ name: string }>('PRAGMA table_info(platform_world_facts)');
    expect(factCols.map((c) => c.name)).toEqual(expect.arrayContaining(['superseded_at', 'superseded_by_archive_id']));
    const outboxCols = await db.query<{ name: string }>('PRAGMA table_info(platform_outbox_events)');
    expect(outboxCols.map((c) => c.name)).toEqual(expect.arrayContaining(['superseded_at', 'superseded_by_archive_id']));
    await db.close();
  });

  it('excludes superseded rows from default active queries', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const now = new Date().toISOString();
    await db.execute(
      "INSERT INTO platform_turns (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at) VALUES (?, ?, 1, 'completed', NULL, ?, ?, ?)",
      ['t1', 'c1', now, now, now],
    );
    await db.execute(
      "INSERT INTO platform_turns (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at) VALUES (?, ?, 2, 'waiting_for_actions', NULL, NULL, ?, ?)",
      ['t2', 'c1', now, now],
    );
    // 2 号回合被某次恢复 supersede：默认查询不应再把它当进行中回合。
    await db.execute('UPDATE platform_turns SET superseded_at = ?, superseded_by_archive_id = ? WHERE id = ?', [now, 'arch-1', 't2']);
    const turns = new TurnRepository(db);
    expect(await turns.findUnfinishedTurn('c1')).toBeNull();
    expect((await turns.listByCampaign('c1')).map((r) => r.id)).toEqual(['t1']);
    // maxTurnNumber 必须包含 superseded：恢复后新回合不得复用 2 号。
    expect(await turns.maxTurnNumber('c1')).toBe(2);
    // lockTurnRow 对 superseded 回合返回未命中（改不了已恢复覆盖的历史回合）。
    expect(await turns.lockTurnRow('t2', 'c1')).toBe(false);
    await db.close();
  });

  it('excludes superseded world facts and outbox events but keeps audit queries', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const repo = new WorldFactRepository(db);
    await repo.insert({
      id: 'f-active', campaign_id: 'c1', title: '酒馆', kind: 'location', content: '热闹。',
      visibility: 'public', known_by_json: '[]', created_at: 'now', updated_at: 'now',
    });
    await repo.insert({
      id: 'f-dead', campaign_id: 'c1', title: '旧密信', kind: 'item', content: 'x',
      visibility: 'player_private', known_by_json: '["p1"]', created_at: 'now', updated_at: 'now',
    });
    await db.execute('UPDATE platform_world_facts SET superseded_at = ? WHERE id = ?', ['now', 'f-dead']);
    expect((await repo.listByCampaign('c1')).map((r) => r.id)).toEqual(['f-active']);

    const outbox = new OutboxRepository(db);
    await db.transaction((tx) => outbox.publishIn(tx, { type: 'turn.locked', campaignId: 'c1', turnId: 't1' }));
    await db.transaction((tx) => outbox.publishIn(tx, { type: 'turn.locked', campaignId: 'c1', turnId: 't2' }));
    await db.execute('UPDATE platform_outbox_events SET superseded_at = ? WHERE sequence = 1', ['now']);
    expect((await outbox.listByCampaign('c1')).map((r) => r.sequence)).toEqual([2]);
    expect((await outbox.listUnpublished('c1')).map((r) => r.sequence)).toEqual([2]);
    // 审计全量查询保留 superseded 行。
    expect((await outbox.listAllByCampaign('c1')).map((r) => r.sequence)).toEqual([1, 2]);
    await db.close();
  });
});
```

### Step 2：运行确认失败

```bash
rtk npm test -- --run packages/contracts/src/archive.test.ts packages/contracts/src/events.test.ts server/src/platform/database/superseded-foundations.test.ts
```

预期：失败——`packages/contracts/src/archive.ts` 不存在（import 失败）；`events.ts` 缺 `archive.restored` variant；`007_archives.sql` 未创建（`platform_archives`/superseded 列不存在）；`TurnRepository`/`WorldFactRepository`/`OutboxRepository` 尚不按 superseded 过滤（`findUnfinishedTurn` 返回 t2、`maxTurnNumber` 断言不满足、`listAllByCampaign` 方法缺失）。失败集中在缺失模块与缺失迁移，不涉及既有行为。

### Step 3：实现

`server/src/platform/database/migrations/007_archives.sql`（可移植：TEXT 主外键、`DEFAULT CURRENT_TIMESTAMP`、无 SQLite-only 函数；`ALTER TABLE ADD COLUMN` 无 `IF NOT EXISTS`，依赖 `MigrationRunner` 单次执行保证；postgres simple protocol 支持多语句）：

```sql
-- 007_archives.sql
-- Campaign archives (real snapshot + real restore) and superseded-history foundations.
-- Version per campaign is allocated by an atomic upsert of platform_archive_sequences
-- INSIDE the write transaction (same pattern as the outbox sequence counter);
-- UNIQUE(campaign_id, version) is only an invariant, never the allocation mechanism.
-- Safe to run once via MigrationRunner; portable across SQLite and PostgreSQL.

CREATE TABLE IF NOT EXISTS platform_archive_sequences (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  last_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_archives (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  kind TEXT NOT NULL CHECK (kind IN ('automatic','manual')),
  turn_id TEXT REFERENCES platform_turns(id),
  label TEXT,
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (campaign_id, version)
);

CREATE INDEX IF NOT EXISTS platform_archives_campaign_version_idx
  ON platform_archives(campaign_id, version);

-- Superseded-history foundations on existing platform tables.
ALTER TABLE platform_turns ADD COLUMN superseded_at TEXT;
ALTER TABLE platform_turns ADD COLUMN superseded_by_archive_id TEXT;
ALTER TABLE platform_world_facts ADD COLUMN superseded_at TEXT;
ALTER TABLE platform_world_facts ADD COLUMN superseded_by_archive_id TEXT;
ALTER TABLE platform_outbox_events ADD COLUMN superseded_at TEXT;
ALTER TABLE platform_outbox_events ADD COLUMN superseded_by_archive_id TEXT;
```

`server/src/modules/turns/TurnRepository.ts` 改动（默认 active 查询过滤 superseded；`maxTurnNumber` 保持不过滤；新增 `listAllByCampaign` 供存档/恢复审计与 supersede）：

- `findUnfinishedTurn`：`WHERE campaign_id = ? AND status IN (...) AND superseded_at IS NULL`。
- `listByCampaign`：`WHERE campaign_id = ? AND superseded_at IS NULL ORDER BY number ASC`。
- `lockTurnRow`：`UPDATE ... WHERE id = ? AND campaign_id = ? AND superseded_at IS NULL`（superseded 回合不可再被提交/结算）。
- `maxTurnNumber`：**不变**（`SELECT MAX(number)` 覆盖所有行，包含 superseded）——加注释说明这是有意为之，恢复后新回合不得复用号码。
- 新增 `listAllByCampaign(campaignId)`：`WHERE campaign_id = ? ORDER BY number ASC`（审计全量，含 superseded）。

`server/src/modules/world/WorldFactRepository.ts` 改动：

- `listByCampaign`：`WHERE campaign_id = ? AND superseded_at IS NULL ORDER BY created_at ASC`。
- 新增 `listAllByCampaign(campaignId)`：审计全量（含 superseded）。

`server/src/platform/events/OutboxRepository.ts` 改动：

- `listByCampaign`：`WHERE campaign_id = ? AND superseded_at IS NULL ORDER BY sequence ASC`。
- `listUnpublished`：`WHERE campaign_id = ? AND published_at IS NULL AND superseded_at IS NULL ORDER BY sequence ASC`。
- 新增 `listAllByCampaign(campaignId)`：`WHERE campaign_id = ? ORDER BY sequence ASC`（审计全量，供 SSE replayable 未来使用与恢复 supersede 依据）。

### Step 4：运行确认通过

```bash
rtk npm test -- --run packages/contracts/src/archive.test.ts packages/contracts/src/events.test.ts packages/contracts/src/contracts.test.ts server/src/platform/database/superseded-foundations.test.ts server/src/modules/turns/turn.test.ts server/src/modules/world/world.test.ts server/src/platform/events/outbox.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：archive/events/superseded-foundations 测试全绿；`007_archives.sql` 被复制进 `dist`；既有 turn/world/outbox 测试不回退（无 superseded 行时过滤是 no-op）；`turn.test.ts`/`world.test.ts`/`outbox.test.ts` 全绿。存档契约 fixture 覆盖 schemaVersion=1 全字段、setup 快照 currentTurn=null、未知 schemaVersion 拒绝、manual label trimmed 必填。

### Step 5：提交

```bash
rtk git add packages/contracts/src/archive.ts packages/contracts/src/archive.test.ts packages/contracts/src/index.ts packages/contracts/src/events.ts packages/contracts/src/events.test.ts server/src/platform/database/migrations/007_archives.sql server/src/modules/turns/TurnRepository.ts server/src/modules/world/WorldFactRepository.ts server/src/platform/events/OutboxRepository.ts server/src/platform/database/superseded-foundations.test.ts
rtk git commit -m "feat: add archive contracts and superseded-history foundations" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2：`008_ai_runtime.sql` + AI 持久化 + repositories + provider 端口（unavailable / scripted）

**依赖：** Task 1（迁移编号 007 已占用，本任务 008）。Phase 2A 的 `AiProviderConfig`/`aiRunStatusSchema`（`packages/contracts/src/ai.ts`，本任务按需收敛）。既有 `OutboxRepository.nextSequence` 原子 upsert 模式（AI run 序列复用同一模式）。

**目标：** （1）AI runtime contract 收敛：`aiRunStatusSchema` 改为 `running`/`succeeded`/`failed`、`aiProviderKindSchema` 增 `scripted`/`unavailable`、`aiRunViewSchema`/`aiRunDetailSchema`/`turnEntrySchema`/`turnEntryKindSchema`/`interactionRequestViewSchema`/`resolveTurnInputSchema`；（2）`008_ai_runtime.sql` 建 `platform_ai_run_sequences`（per campaign 原子计数器，先建 AI watermarks 供 Task 3 完整存档 service）、`platform_ai_runs`（campaign_sequence/attempt/idempotency_key/status/context/result/error/raw_debug/superseded；`UNIQUE turn+attempt`、`UNIQUE campaign+idempotency`）、`platform_turn_entries`（entry_kind/entry_index/visibility/target_player_id/payload_json/superseded；`UNIQUE ai_run+index`）、`platform_interaction_requests`（request/target/prompt/pending/superseded）；（3）`AiProviderPort` 端口 + `UnavailableAiProvider`（生产默认，resolve 安全失败 `AI_PROVIDER_FAILED`）+ `ScriptedAiProvider`（测试支持，final output `unknown`）；（4）`AiRunRepository`/`TurnEntryRepository`（含 watermarks 的 supersede 方法）。

### Files

- Modify: `packages/contracts/src/ai.ts`
- Create: `packages/contracts/src/ai.test.ts`
- Create: `server/src/platform/database/migrations/008_ai_runtime.sql`
- Create: `server/src/modules/ai-runtime/AiProviderPort.ts`
- Create: `server/src/modules/ai-runtime/UnavailableAiProvider.ts`
- Create: `server/src/modules/ai-runtime/ScriptedAiProvider.ts`
- Create: `server/src/modules/ai-runtime/AiRunRepository.ts`
- Create: `server/src/modules/ai-runtime/TurnEntryRepository.ts`
- Create: `server/src/modules/ai-runtime/ai-persistence.test.ts`

### Step 1：写失败测试

`packages/contracts/src/ai.ts` 收敛（保留既有 `aiProviderConfigSchema`/`aiProviderPublicConfigSchema`；`aiPromptSchema` 增结构化 `characters` 字段供 provider/测试脚本读取成员 id；`aiRunStatusSchema` 改为结算生命周期）。**这是对 Phase 2A `ai.ts` 的 breaking 收敛**：`aiRunStatusSchema` 的取值、`aiProviderKindSchema` 的枚举都发生变化，当前阶段**无消费点**（provider 状态机仅本计划使用）；验收门（Step 4 全量 typecheck/测试）必须确认无其它模块依赖旧取值后回归通过：

```ts
import { z } from 'zod';
import { visibilitySchema } from './turn.js';

export const aiPromptSchema = z.object({
  campaignId: z.string().min(1),
  audience: visibilitySchema,
  system: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    }),
  ),
  /** 结构化已批准角色（id/playerId/name）：provider 与测试脚本直接从该字段读成员 id，
   *  不再解析人类可读 prompt 字符串；不含 sheet/derived 之外的敏感详情。 */
  characters: z.array(
    z.object({
      id: z.string().min(1),
      playerId: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
});
export type AiPrompt = z.infer<typeof aiPromptSchema>;

export const aiProviderKindSchema = z.enum(['mock', 'scripted', 'unavailable', 'openai-compatible']);
export type AiProviderKind = z.infer<typeof aiProviderKindSchema>;

export const aiProviderConfigSchema = z.object({
  provider: aiProviderKindSchema,
  baseUrl: z.string().min(1).default(''),
  model: z.string().min(1).default(''),
  apiKey: z.string().default(''),
});
export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;

/** 返回给前端的脱敏 Provider 配置，永远不包含 API Key。 */
export const aiProviderPublicConfigSchema = z.object({
  provider: aiProviderKindSchema,
  baseUrl: z.string().min(1).default(''),
  model: z.string().min(1).default(''),
  configured: z.boolean(),
});
export type AiProviderPublicConfig = z.infer<typeof aiProviderPublicConfigSchema>;

/** AI run 结算生命周期：claim 置 running，成功 succeeded / 失败 failed。 */
export const aiRunStatusSchema = z.enum(['running', 'succeeded', 'failed']);
export type AiRunStatus = z.infer<typeof aiRunStatusSchema>;

/** resolve 请求体：idempotencyKey 必填受限长度。 */
export const resolveTurnInputSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(64),
});
export type ResolveTurnInput = z.infer<typeof resolveTurnInputSchema>;

/** AI run 视图（owner 可读；不含 context/result/rawDebug 敏感字段）。 */
export const aiRunViewSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  campaignSequence: z.number().int(),
  turnId: z.string().min(1),
  attempt: z.number().int(),
  idempotencyKey: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  status: aiRunStatusSchema,
  errorCode: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  superseded: z.boolean(),
});
export type AiRunView = z.infer<typeof aiRunViewSchema>;

/** owner AI run 详情：附加 context/result/rawDebug（仅 owner view，普通 player 不可读）。 */
export const aiRunDetailSchema = aiRunViewSchema.extend({
  context: z.unknown(),
  result: z.unknown(),
  rawDebug: z.unknown(),
});
export type AiRunDetail = z.infer<typeof aiRunDetailSchema>;

export const turnEntryKindSchema = z.enum(['narrative', 'private_update', 'dice_result']);
export type TurnEntryKind = z.infer<typeof turnEntryKindSchema>;

/** turn entry DTO：owner 全量；player 只见 public + 自己的 private（投影在 service）。 */
export const turnEntrySchema = z.object({
  id: z.string().min(1),
  aiRunId: z.string().min(1),
  turnId: z.string().min(1),
  campaignId: z.string().min(1),
  entryKind: turnEntryKindSchema,
  entryIndex: z.number().int(),
  visibility: visibilitySchema,
  targetPlayerId: z.string().nullable(),
  payload: z.unknown(),
  createdAt: z.string(),
});
export type TurnEntry = z.infer<typeof turnEntrySchema>;

export const interactionRequestViewSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  turnId: z.string().min(1),
  aiRunId: z.string().min(1),
  targetPlayerId: z.string().min(1),
  prompt: z.string(),
  status: z.enum(['pending', 'answered']),
  createdAt: z.string(),
});
export type InteractionRequestView = z.infer<typeof interactionRequestViewSchema>;
```

`packages/contracts/src/ai.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { aiRunViewSchema, resolveTurnInputSchema, turnEntrySchema } from './index';

describe('ai runtime contracts', () => {
  it('rejects an empty or overlong idempotencyKey', () => {
    expect(resolveTurnInputSchema.parse({ idempotencyKey: '  k1  ' }).idempotencyKey).toBe('k1');
    expect(() => resolveTurnInputSchema.parse({ idempotencyKey: '  ' })).toThrow();
    expect(() => resolveTurnInputSchema.parse({ idempotencyKey: 'x'.repeat(65) })).toThrow();
  });

  it('parses an ai run view without sensitive fields', () => {
    const view = aiRunViewSchema.parse({
      id: 'run-1', campaignId: 'c1', campaignSequence: 1, turnId: 't1', attempt: 1,
      idempotencyKey: 'k1', provider: 'scripted', model: 'scripted', status: 'succeeded',
      errorCode: null, startedAt: 'now', completedAt: 'now', superseded: false,
    });
    expect(view.status).toBe('succeeded');
    expect(JSON.stringify(view)).not.toContain('context');
    expect(JSON.stringify(view)).not.toContain('rawDebug');
  });

  it('parses a turn entry with a player_private target', () => {
    const entry = turnEntrySchema.parse({
      id: 'e1', aiRunId: 'run-1', turnId: 't1', campaignId: 'c1', entryKind: 'private_update',
      entryIndex: 0, visibility: 'player_private', targetPlayerId: 'p1',
      payload: { text: '你发现了暗门。' }, createdAt: 'now',
    });
    expect(entry.targetPlayerId).toBe('p1');
    expect(JSON.stringify(entry)).not.toContain('_json');
  });
});
```

`server/src/modules/ai-runtime/ai-persistence.test.ts`（SQLite 实测 008 表 + 原子序列 + UNIQUE 不变量 + supersede-by-watermark）：

```ts
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { AiRunRepository, type AiRunInsertRow } from './AiRunRepository.js';
import { TurnEntryRepository, type TurnEntryInsertRow } from './TurnEntryRepository.js';

async function seedCampaign(db: ReturnType<typeof createSqliteDatabase>, campaignId: string, turnId: string): Promise<void> {
  const ownerId = `owner-${campaignId}`;
  const now = new Date().toISOString();
  await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', [ownerId, `${ownerId}@example.test`, 'hash']);
  await db.execute('INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [campaignId, ownerId, `c-${campaignId}`, 'setup', 'dnd5e', now, now]);
  await db.execute('INSERT INTO platform_turns (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at) VALUES (?, ?, 1, ?, ?, NULL, ?, ?)', [turnId, campaignId, 'locked', now, now, now]);
}

describe('ai runtime persistence', () => {
  it('allocates per-campaign ai run sequences atomically', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1', 't1');
    const repo = new AiRunRepository(db);
    const seq1 = await db.transaction((tx) => repo.nextCampaignSequence(tx, 'c1'));
    const seq2 = await db.transaction((tx) => repo.nextCampaignSequence(tx, 'c1'));
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    await db.close();
  });

  it('rolls back run and sequence counter together', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1', 't1');
    const repo = new AiRunRepository(db);
    await expect(db.transaction(async (tx) => {
      // 先分配 campaign_sequence（counter 写入与 run 同 tx），再插 run，整体回滚。
      const seq = await repo.nextCampaignSequence(tx, 'c1');
      await repo.insertRun(tx, runRow('run-1', 'c1', 't1', 1, 'k1', seq));
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await repo.listByTurn('t1')).toEqual([]);
    const counters = await db.query<{ campaign_id: string }>('SELECT campaign_id FROM platform_ai_run_sequences');
    expect(counters).toEqual([]);
    await db.close();
  });

  it('enforces UNIQUE(turn, attempt) and UNIQUE(campaign, idempotency_key)', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1', 't1');
    const repo = new AiRunRepository(db);
    // campaign_sequence 用 1/2/3 区分，使每个断言只命中目标 UNIQUE 约束。
    await db.transaction((tx) => repo.insertRun(tx, runRow('run-1', 'c1', 't1', 1, 'k1', 1)));
    await expect(db.transaction((tx) => repo.insertRun(tx, runRow('run-2', 'c1', 't1', 1, 'k2', 2)))).rejects.toThrow(); // UNIQUE(turn, attempt)
    await expect(db.transaction((tx) => repo.insertRun(tx, runRow('run-3', 'c1', 't1', 2, 'k1', 3)))).rejects.toThrow(); // UNIQUE(campaign, idempotency)
    await db.close();
  });

  it('supersedes runs/entries/requests by the ai run campaign watermark', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1', 't1');
    const runs = new AiRunRepository(db);
    const entries = new TurnEntryRepository(db);
    await db.transaction(async (tx) => {
      await runs.insertRun(tx, runRow('run-1', 'c1', 't1', 1, 'k1', 1));
      await runs.insertRun(tx, runRow('run-2', 'c1', 't1', 2, 'k2', 2));
      await entries.insertEntry(tx, entryRow('e1', 'run-2', 't1', 'c1', 0));
    });
    const now = new Date().toISOString();
    // superseded_by_archive_id 有 FK → 先插入真实 platform_archives 行（含必要 owner/campaign/archive sequence 前置），
    // 再用它的 id，不能传不存在的 'arch-9' 撞 FK。
    await db.execute('INSERT INTO platform_archive_sequences (campaign_id, last_version) VALUES (?, ?)', ['c1', 1]);
    await db.execute(
      `INSERT INTO platform_archives
        (id, campaign_id, kind, turn_id, label, version, state_json, created_by_user_id, superseded_at, superseded_by_archive_id, created_at)
       VALUES (?, ?, 'automatic', ?, NULL, 1, '{}', ?, NULL, NULL, ?)`,
      ['arch-9', 'c1', 't1', 'owner-c1', now],
    );
    await db.transaction((tx) => runs.supersedeByWatermark(tx, 'c1', 'arch-9', 1, now));
    // run-1 (seq 1) 保留；run-2 (seq 2) 与它的 entries supersede。
    expect((await runs.listByTurn('t1')).map((r) => r.id)).toEqual(['run-1']);
    expect(await entries.listByTurn('t1')).toEqual([]);
    await db.close();
  });
});

function runRow(id: string, campaignId: string, turnId: string, attempt: number, idempotencyKey: string, campaignSequence = 0): AiRunInsertRow {
  const now = new Date().toISOString();
  return {
    id, campaign_id: campaignId, campaign_sequence: campaignSequence, turn_id: turnId, attempt,
    idempotency_key: idempotencyKey, provider: 'scripted', model: 'scripted',
    status: 'running', context_json: '{}', result_json: null, error_code: null,
    error_json: null, raw_debug_json: null, started_at: now, completed_at: null,
  };
}

function entryRow(id: string, aiRunId: string, turnId: string, campaignId: string, entryIndex: number): TurnEntryInsertRow {
  return {
    id, ai_run_id: aiRunId, turn_id: turnId, campaign_id: campaignId,
    entry_kind: 'narrative', entry_index: entryIndex, visibility: 'public',
    target_player_id: null, payload_json: '{"text":"x"}', created_at: new Date().toISOString(),
  };
}
```

### Step 2：运行确认失败

```bash
rtk npm test -- --run packages/contracts/src/ai.test.ts server/src/modules/ai-runtime/ai-persistence.test.ts
```

预期：失败——`ai.ts` 尚未收敛（`aiRunStatusSchema` 仍为 pending/previewing/resolved/failed，`resolveTurnInputSchema` 缺失）；`008_ai_runtime.sql` 未创建（`platform_ai_runs` 等不存在）；`AiRunRepository`/`TurnEntryRepository`/`AiProviderPort`/`UnavailableAiProvider`/`ScriptedAiProvider` 不存在。

### Step 3：实现

`server/src/platform/database/migrations/008_ai_runtime.sql`（FK/CHECK/index 完整、portable；`platform_ai_run_sequences` 是 per campaign 原子计数器，与 outbox 同模式）：

```sql
-- 008_ai_runtime.sql
-- AI runtime persistence: per-campaign run sequences, ai runs, turn entries and
-- interaction requests. Safe to run once via MigrationRunner; portable across
-- SQLite and PostgreSQL. campaign_sequence is allocated by an atomic upsert of
-- platform_ai_run_sequences INSIDE the write transaction (same pattern as outbox).

CREATE TABLE IF NOT EXISTS platform_ai_run_sequences (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  last_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_ai_runs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  campaign_sequence INTEGER NOT NULL,
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  attempt INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  context_json TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  error_json TEXT,
  raw_debug_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  UNIQUE (campaign_id, campaign_sequence),
  UNIQUE (campaign_id, idempotency_key),
  UNIQUE (turn_id, attempt)
);

CREATE INDEX IF NOT EXISTS platform_ai_runs_turn_idx
  ON platform_ai_runs(turn_id, attempt);

CREATE TABLE IF NOT EXISTS platform_turn_entries (
  id TEXT PRIMARY KEY,
  ai_run_id TEXT NOT NULL REFERENCES platform_ai_runs(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('narrative','private_update','dice_result')),
  entry_index INTEGER NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','player_private','owner_only')),
  target_player_id TEXT REFERENCES users(id),
  payload_json TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ai_run_id, entry_index),
  -- 可见性不变量：player_private 必须有目标玩家；public/owner_only 必须无目标玩家。
  CHECK (
    (visibility = 'player_private' AND target_player_id IS NOT NULL)
    OR
    (visibility IN ('public','owner_only') AND target_player_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS platform_turn_entries_turn_idx
  ON platform_turn_entries(turn_id, visibility);

CREATE TABLE IF NOT EXISTS platform_interaction_requests (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  ai_run_id TEXT NOT NULL REFERENCES platform_ai_runs(id),
  -- provider_id：provider 输出中的客户端引用 id（同输出内唯一）；DB 主键是内部 nanoid，
  -- 避免跨 run/跨 campaign 复用 'i1' 之类短 id 撞全局主键。客户端应答/投影用内部 id。
  provider_id TEXT NOT NULL,
  target_player_id TEXT NOT NULL REFERENCES users(id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered')),
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS platform_interaction_requests_turn_idx
  ON platform_interaction_requests(turn_id, target_player_id);
```

`server/src/modules/ai-runtime/AiProviderPort.ts`：

```ts
import type { AiPrompt } from '@dnd/contracts';

/** 公开 preview delta：2B 只有 text；Phase 3 扩展结构化增量。 */
export interface AiPreviewDelta {
  kind: 'text';
  text: string;
}

export interface AiPreviewHooks {
  onDelta(delta: AiPreviewDelta): Promise<void>;
}

/** Provider 端口：stream 返回 final output（unknown），由应用层 turnResolutionSchema parse。绝不持有 DB tx。 */
export interface AiProviderPort {
  readonly name: string;
  stream(input: AiPrompt, hooks: AiPreviewHooks): Promise<unknown>;
}
```

`server/src/modules/ai-runtime/UnavailableAiProvider.ts`：

```ts
import { AppError } from '../../platform/http/AppError.js';
import type { AiPreviewHooks, AiProviderPort } from './AiProviderPort.js';
import type { AiPrompt } from '@dnd/contracts';

/** 生产默认 Provider：resolve 安全失败 AI_PROVIDER_FAILED，绝不默认 Mock。 */
export class UnavailableAiProvider implements AiProviderPort {
  readonly name = 'unavailable';
  async stream(_input: AiPrompt, _hooks: AiPreviewHooks): Promise<unknown> {
    throw new AppError('AI_PROVIDER_FAILED', '未配置 AI Provider，无法结算回合。');
  }
}
```

`server/src/modules/ai-runtime/ScriptedAiProvider.ts`（测试支持；final output `unknown`；附结构化 `approvedPlayerIds` helper，供测试脚本从 `AiPrompt.characters` 读取真实成员 id，不再解析人类 prompt 字符串）：

```ts
import type { AiPrompt } from '@dnd/contracts';
import type { AiPreviewHooks, AiProviderPort } from './AiProviderPort.js';

/** 测试用 Provider 脚本：返回 final output（unknown）或 throw。只应通过 CreateAppOptions.aiProvider 注入。 */
export type AiProviderScript = (input: AiPrompt, hooks: AiPreviewHooks) => Promise<unknown>;

export class ScriptedAiProvider implements AiProviderPort {
  readonly name = 'scripted';
  constructor(private readonly script: AiProviderScript) {}
  stream(input: AiPrompt, hooks: AiPreviewHooks): Promise<unknown> {
    return this.script(input, hooks);
  }
}

/** 辅助：先按 deltaTexts 逐条 emit preview delta，再返回 resolution 对象（未 parse，由应用层 parse）。 */
export function scriptedResolution(resolution: unknown, deltaTexts: string[] = []): AiProviderScript {
  return async (_input, hooks) => {
    for (const text of deltaTexts) {
      await hooks.onDelta({ kind: 'text', text });
    }
    return resolution;
  };
}

/**
 * 结构化读取 prompt 中已批准角色的 playerId：测试脚本用它构造真实成员 id 的
 * privateUpdates/dice/interactions，避免硬编码 id 与真实成员不一致。
 * 直接消费 AiPrompt.characters（结构化字段），不解析人类可读 prompt 字符串。
 */
export function approvedPlayerIds(prompt: AiPrompt): string[] {
  return prompt.characters.map((c) => c.playerId);
}
```

`server/src/modules/ai-runtime/AiRunRepository.ts`（`nextCampaignSequence` 复用 outbox 的原子 upsert+RETURNING 模式；`supersedeByWatermark` 同时把 entries/requests 按 run 的 campaign_sequence 标记）：

```ts
import type { AiRunStatus } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface AiRunRow {
  id: string;
  campaign_id: string;
  campaign_sequence: number;
  turn_id: string;
  attempt: number;
  idempotency_key: string;
  provider: string;
  model: string;
  status: AiRunStatus;
  context_json: string;
  result_json: string | null;
  error_code: string | null;
  error_json: string | null;
  raw_debug_json: string | null;
  started_at: string;
  completed_at: string | null;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
}

export interface AiRunInsertRow {
  id: string;
  campaign_id: string;
  campaign_sequence: number;
  turn_id: string;
  attempt: number;
  idempotency_key: string;
  provider: string;
  model: string;
  status: AiRunStatus;
  context_json: string;
  result_json: string | null;
  error_code: string | null;
  error_json: string | null;
  raw_debug_json: string | null;
  started_at: string;
  completed_at: string | null;
}

export class AiRunRepository {
  constructor(private readonly executor: QueryExecutor) {}

  /** 每战役 AI run 序列原子分配：upsert 计数器 + RETURNING（与 outbox nextSequence 同模式）。 */
  async nextCampaignSequence(tx: QueryExecutor, campaignId: string): Promise<number> {
    const rows = await tx.query<{ last_seq: number }>(
      `INSERT INTO platform_ai_run_sequences (campaign_id, last_seq)
       VALUES (?, 1)
       ON CONFLICT (campaign_id) DO UPDATE SET last_seq = platform_ai_run_sequences.last_seq + 1
       RETURNING last_seq`,
      [campaignId],
    );
    return Number(rows[0].last_seq);
  }

  /** attempt 在 turn 锁内单调分配：该 turn 已有最大 attempt + 1。 */
  async maxAttempt(tx: QueryExecutor, turnId: string): Promise<number> {
    const rows = await tx.query<{ max: number | null }>(
      'SELECT MAX(attempt) AS max FROM platform_ai_runs WHERE turn_id = ?',
      [turnId],
    );
    return Number(rows[0].max ?? 0);
  }

  async insertRun(tx: QueryExecutor, row: AiRunInsertRow): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_ai_runs
        (id, campaign_id, campaign_sequence, turn_id, attempt, idempotency_key,
         provider, model, status, context_json, result_json, error_code, error_json,
         raw_debug_json, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.campaign_sequence, row.turn_id, row.attempt,
       row.idempotency_key, row.provider, row.model, row.status, row.context_json,
       row.result_json, row.error_code, row.error_json, row.raw_debug_json,
       row.started_at, row.completed_at],
    );
  }

  /** 幂等查询：同 key 同 turn 的既有 run（claim 前置检查）。 */
  async findByIdempotencyKey(tx: QueryExecutor, campaignId: string, idempotencyKey: string): Promise<AiRunRow | null> {
    const rows = await tx.query<AiRunRow>(
      'SELECT * FROM platform_ai_runs WHERE campaign_id = ? AND idempotency_key = ?',
      [campaignId, idempotencyKey],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<AiRunRow | null> {
    const rows = await this.executor.query<AiRunRow>('SELECT * FROM platform_ai_runs WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  /** 默认 active 查询：排除 superseded 的 run。 */
  async listByTurn(turnId: string): Promise<AiRunRow[]> {
    return this.executor.query<AiRunRow>(
      'SELECT * FROM platform_ai_runs WHERE turn_id = ? AND superseded_at IS NULL ORDER BY attempt ASC',
      [turnId],
    );
  }

  async findRunningRun(campaignId: string): Promise<AiRunRow | null> {
    const rows = await this.executor.query<AiRunRow>(
      "SELECT * FROM platform_ai_runs WHERE campaign_id = ? AND status = 'running' AND superseded_at IS NULL ORDER BY campaign_sequence ASC LIMIT 1",
      [campaignId],
    );
    return rows[0] ?? null;
  }

  /** 条件成功：仅当仍为 running 时置 succeeded（防并发重复应用）。 */
  async markSucceeded(tx: QueryExecutor, runId: string, resultJson: string, rawDebugJson: string, completedAt: string): Promise<boolean> {
    const result = await tx.execute(
      `UPDATE platform_ai_runs SET status = 'succeeded', result_json = ?, raw_debug_json = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
      [resultJson, rawDebugJson, completedAt, runId],
    );
    return result.changes === 1;
  }

  /** 条件失败：仅当仍为 running 时置 failed。 */
  async markFailed(tx: QueryExecutor, runId: string, errorCode: string, errorJson: string, rawDebugJson: string, completedAt: string): Promise<boolean> {
    const result = await tx.execute(
      `UPDATE platform_ai_runs SET status = 'failed', error_code = ?, error_json = ?, raw_debug_json = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
      [errorCode, errorJson, rawDebugJson, completedAt, runId],
    );
    return result.changes === 1;
  }

  /** 恢复：按 AI run campaign watermark 标记 run 及其 entries/requests superseded。 */
  async supersedeByWatermark(tx: QueryExecutor, campaignId: string, archiveId: string, watermark: number, now: string): Promise<void> {
    await tx.execute(
      'UPDATE platform_ai_runs SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL AND campaign_sequence > ?',
      [now, archiveId, campaignId, watermark],
    );
    await tx.execute(
      `UPDATE platform_turn_entries SET superseded_at = ?, superseded_by_archive_id = ?
       WHERE campaign_id = ? AND superseded_at IS NULL
         AND ai_run_id IN (SELECT id FROM platform_ai_runs WHERE campaign_id = ? AND campaign_sequence > ?)`,
      [now, archiveId, campaignId, campaignId, watermark],
    );
    await tx.execute(
      `UPDATE platform_interaction_requests SET superseded_at = ?, superseded_by_archive_id = ?
       WHERE campaign_id = ? AND superseded_at IS NULL
         AND ai_run_id IN (SELECT id FROM platform_ai_runs WHERE campaign_id = ? AND campaign_sequence > ?)`,
      [now, archiveId, campaignId, campaignId, watermark],
    );
  }
}
```

`server/src/modules/ai-runtime/TurnEntryRepository.ts`（entries 写入/投影/插入 interaction requests）：

```ts
import type { Visibility } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface TurnEntryRow {
  id: string;
  ai_run_id: string;
  campaign_id: string;
  turn_id: string;
  entry_kind: 'narrative' | 'private_update' | 'dice_result';
  entry_index: number;
  visibility: Visibility;
  target_player_id: string | null;
  payload_json: string;
  created_at: string;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
}

export interface TurnEntryInsertRow {
  id: string;
  ai_run_id: string;
  campaign_id: string;
  turn_id: string;
  entry_kind: 'narrative' | 'private_update' | 'dice_result';
  entry_index: number;
  visibility: Visibility;
  target_player_id: string | null;
  payload_json: string;
  created_at: string;
}

export class TurnEntryRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async insertEntry(tx: QueryExecutor, row: TurnEntryInsertRow): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_turn_entries
        (id, ai_run_id, campaign_id, turn_id, entry_kind, entry_index, visibility, target_player_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.ai_run_id, row.campaign_id, row.turn_id, row.entry_kind, row.entry_index,
       row.visibility, row.target_player_id, row.payload_json, row.created_at],
    );
  }

  async insertInteractionRequest(tx: QueryExecutor, row: { id: string; provider_id: string; campaign_id: string; turn_id: string; ai_run_id: string; target_player_id: string; prompt: string; created_at: string }): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_interaction_requests (id, provider_id, campaign_id, turn_id, ai_run_id, target_player_id, prompt, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [row.id, row.provider_id, row.campaign_id, row.turn_id, row.ai_run_id, row.target_player_id, row.prompt, row.created_at],
    );
  }

  /** 默认 active 查询（owner 全量）。 */
  async listByTurn(turnId: string): Promise<TurnEntryRow[]> {
    return this.executor.query<TurnEntryRow>(
      'SELECT * FROM platform_turn_entries WHERE turn_id = ? AND superseded_at IS NULL ORDER BY entry_index ASC',
      [turnId],
    );
  }
}
```

> **Task 2 实现说明**：`TurnEntryRepository` 只新增 `insertEntry`/`insertInteractionRequest`/`listByTurn` 三个方法。**不新增「按 campaign 读取 pending interaction 的方法」**——Phase 2B 没有 interaction 响应/消费路由，该方法当前无消费点，避免死代码；未来 Phase 3（interaction 应答/SSE）再按需引入。

### Step 4：运行确认通过

```bash
rtk npm test -- --run packages/contracts/src/ai.test.ts server/src/modules/ai-runtime/ai-persistence.test.ts server/src/platform/events/outbox.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：ai contract 与 ai-persistence 测试全绿（原子序列、回滚无残留、UNIQUE 不变量、watermark supersede）；`008_ai_runtime.sql` 复制进 `dist`；既有 outbox 测试不回退。`platform_interaction_requests` 含 `provider_id` 列（provider 短 id 不撞全局主键）；`ai.test.ts` 覆盖 idempotencyKey trim/长度限制、ai run view 无敏感字段、turn entry 带 player_private 目标。

### Step 5：提交

```bash
rtk git add packages/contracts/src/ai.ts packages/contracts/src/ai.test.ts server/src/platform/database/migrations/008_ai_runtime.sql server/src/modules/ai-runtime/AiProviderPort.ts server/src/modules/ai-runtime/UnavailableAiProvider.ts server/src/modules/ai-runtime/ScriptedAiProvider.ts server/src/modules/ai-runtime/AiRunRepository.ts server/src/modules/ai-runtime/TurnEntryRepository.ts server/src/modules/ai-runtime/ai-persistence.test.ts
rtk git commit -m "feat: add ai runtime persistence and provider port" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3：存档捕获/恢复 repository/service/routes + 并发/回滚/superseded 测试

**依赖：** Task 1（007 + superseded 基础 + 契约）、Task 2（AI watermarks 使完整存档 service 可含 AI run watermark）。Phase 2A 的 `CharacterRepository`/`WorldFactRepository`/`TurnRepository`/`OutboxRepository`。

**目标：** `ArchiveService`（capture/restore）与 `ArchiveRepository`：per-campaign version 原子分配；manual archive 在 turn=resolving 时 `STATE_CONFLICT`，允许无 turn/setup、waiting、locked、needs_owner_attention、completed 的明确行为；restore owner-only + campaign 行锁 + 单 tx + 先 supersede 历史再 publish `archive.restored`；restore completed snapshot 在同 tx 创建新 waiting turn（`MAX+1` 包含 superseded、不复用）；restore waiting/locked/needs_owner_attention 恢复该状态不自动开新回合；resolving snapshot 拒绝；version counter 永不回退；回滚/并发测试。路由 `POST /archives`（owner 手动存档）、`POST /archives/:archiveId/restore`（owner）、`GET /archives`（owner）。

### Files

- Create: `server/src/modules/archives/ArchiveRepository.ts`
- Create: `server/src/modules/archives/ArchiveService.ts`
- Create: `server/src/modules/archives/archive.test.ts`
- Create: `server/src/routes/archiveRoutes.ts`
- Modify: `server/src/app.ts`（挂 `/api/campaigns/:campaignId/archives`）
- Modify: `server/src/modules/characters/CharacterRepository.ts`（restore 辅助：`upsertRestored`/`archiveCharactersNotIn`；`archiveCharactersNotIn` 每个真实状态变化同 tx 写 `archive_restore_supersede` audit，actor=owner；文件头部补 `import { nanoid }`）
- Modify: `server/src/modules/turns/TurnRepository.ts`（restore 辅助：`replaceActions`/`replaceRequirements`/`restoreTurnState`/`listAllByCampaign`/`findByNumber`/`findResolvingTurn`/`supersedeTurnsAfterNumber`/`clearSuperseded`；**不新增专门的回合插入方法，恢复与自动结算直接复用现有 insertTurn（number 由调用方传入）**；setup 与 idle 统一由 `supersedeTurnsAfterNumber(turnNumber)` 实现——setup 的 turnNumber=0 自然覆盖全部回合，不再提供单独的全量 supersede 辅助；`markResolving`/`markCompleted` 属 Task 5 AiResolutionService）
- Create: `server/src/platform/database/postgres-archives-ai.test.ts`（`POSTGRES_TEST_URL` 门控，本任务覆盖 archive version/restore；T5 扩展 idempotency/claim）

### Step 1：写失败测试

`server/src/modules/archives/archive.test.ts`（先写失败测试；fixture 复用 Phase 2A 模式：identity + campaigns + characters + turns；`nanoid` 用于生成 automatic archiveId）：

```ts
import { describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import type { CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { TurnService } from '../turns/TurnService.js';
import { ArchiveService } from './ArchiveService.js';
import type { ArchiveSnapshot } from '@dnd/contracts';

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
  const turns = new TurnService(db, new OutboxRepository(db));
  const archives = new ArchiveService(db, new OutboxRepository(db));
  return { db, characters, turns, archives, ownerCtx, aCtx, bCtx, cCtx };
}

describe('archives', () => {
  it('owner creates a manual archive with a trimmed label and atomic version', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, turn.id, { body: 'A 行动' });
    await turns.submitAction(bCtx, turn.id, { body: 'B 行动' });
    const first = await archives.createManual(ownerCtx, '  进入矿洞前  ');
    expect(first.kind).toBe('manual');
    expect(first.label).toBe('进入矿洞前');
    expect(first.version).toBe(1);
    expect(first.turnId).toBe(turn.id);
    const second = await archives.createManual(ownerCtx, '再走一步');
    expect(second.version).toBe(2);
    await db.close();
  });

  it('rejects a manual archive while the current turn is resolving', async () => {
    const { db, turns, archives, ownerCtx } = await makeFixture();
    const turn = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'resolving' WHERE id = ?", [turn.id]);
    await expect(archives.createManual(ownerCtx, '结算中')).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('rejects a player creating, restoring or listing an archive', async () => {
    const { archives, aCtx } = await makeFixture();
    await expect(archives.createManual(aCtx, '越权')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(archives.restore(aCtx, 'any')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(archives.listForCampaign(aCtx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('round-trips all character statuses and audits restore + supersede changes', async () => {
    const { db, characters, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    // 为 A 建五个状态的角色；再为 B 建一个 approved（恢复前存在、快照外的角色，会被 supersede 为 archived）。
    const draft = await characters.createDraft(aCtx, { name: '草稿', sheet: { ac: 12 } });
    const pending = await characters.createDraft(aCtx, { name: '待审', sheet: { ac: 13 } });
    await characters.submitForReview(aCtx, pending.id);
    const approved = await characters.createDraft(aCtx, { name: '已批准', sheet: { ac: 14 } });
    await characters.submitForReview(aCtx, approved.id);
    await characters.approve(ownerCtx, approved.id);
    const rejected = await characters.createDraft(aCtx, { name: '已退回', sheet: { ac: 11 } });
    await characters.submitForReview(aCtx, rejected.id);
    await characters.reject(ownerCtx, rejected.id);
    const archived = await characters.createDraft(aCtx, { name: '已归档', sheet: { ac: 10 } });
    await characters.submitForReview(aCtx, archived.id);
    await characters.approve(ownerCtx, archived.id);
    await db.execute("UPDATE platform_characters SET status = 'archived' WHERE id = ?", [archived.id]);

    // 手动存档：快照含全部五个状态的角色。
    const manual = await archives.createManual(ownerCtx, '全状态');
    const snapshot = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [manual.id]))[0].state_json) as { characters: Array<{ id: string; status: string }> };
    const byId = Object.fromEntries(snapshot.characters.map((c) => [c.id, c.status]));
    expect(byId[draft.id]).toBe('draft');
    expect(byId[pending.id]).toBe('pending_review');
    expect(byId[approved.id]).toBe('approved');
    expect(byId[rejected.id]).toBe('rejected');
    expect(byId[archived.id]).toBe('archived');

    // 恢复前制造快照外角色（B 的新 approved 角色），恢复时会被 supersede 为 archived。
    const bDraft = await characters.createDraft(bCtx, { name: 'B 新建', sheet: { ac: 15 } });
    await characters.submitForReview(bCtx, bDraft.id);
    await characters.approve(ownerCtx, bDraft.id);
    // 手动改一个快照内角色状态为 rejected（archived 之外的变化），验证恢复把状态还原为快照值。
    await db.execute("UPDATE platform_characters SET status = 'rejected' WHERE id = ?", [approved.id]);

    await archives.restore(ownerCtx, manual.id);

    const rows = await db.query<{ id: string; status: string; approved_at: string | null }>(
      'SELECT id, status, approved_at FROM platform_characters WHERE campaign_id = ?', [ownerCtx.campaignId],
    );
    const after = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(after[draft.id]).toBe('draft');
    expect(after[pending.id]).toBe('pending_review');
    expect(after[approved.id]).toBe('approved'); // 恢复把 rejected 还原为 approved
    expect(after[rejected.id]).toBe('rejected');
    expect(after[archived.id]).toBe('archived');
    expect(after[bDraft.id]).toBe('archived'); // 快照外角色被 archived，不物理删除
    // 恢复后已批准角色的 approved_at 与快照一致（round-trip 字段保留）。
    const approvedRow = rows.find((r) => r.id === approved.id);
    expect(approvedRow?.approved_at).toBeTruthy();

    // 审计：快照内角色 upsert 有 archive_restore；快照外角色有 archive_restore_supersede。
    const audits = await db.query<{ character_id: string; action: string; actor_user_id: string }>(
      'SELECT character_id, action, actor_user_id FROM platform_character_audits WHERE campaign_id = ? ORDER BY character_id, created_at', [ownerCtx.campaignId],
    );
    const restoreAudits = audits.filter((a) => a.action === 'archive_restore');
    expect(restoreAudits.map((a) => a.character_id)).toEqual(expect.arrayContaining([draft.id, pending.id, approved.id, rejected.id, archived.id]));
    // 快照内每个角色无论字段是否相同均恰一条 archive_restore audit（restore 是独立可审计动作），不按字段变化去重。
    for (const id of [draft.id, pending.id, approved.id, rejected.id, archived.id]) {
      expect(restoreAudits.filter((a) => a.character_id === id)).toHaveLength(1);
    }
    expect(restoreAudits.every((a) => a.actor_user_id === ownerCtx.userId)).toBe(true);
    expect(audits.some((a) => a.character_id === bDraft.id && a.action === 'archive_restore_supersede' && a.actor_user_id === ownerCtx.userId)).toBe(true);
    await db.close();
  });

  it('restores a completed automatic snapshot: supersedes later turns and creates the next turn with MAX+1 no reuse', async () => {
    const { db, characters, turns, archives, ownerCtx, aCtx, bCtx, cCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    // 快照中含一个 draft 角色（c 的唯一角色）：恢复后的下一回合 requirements 不得把 c 列为必需玩家。
    await characters.createDraft(cCtx, { name: '草稿', sheet: { ac: 9 } });
    // 完成 t1，并模拟 AiResolutionService 生成 automatic 存档（snapshot currentTurn = t1 completed）。
    // actorUserId 用真实 owner（created_by FK 指向 users(id)，不能用 'ai-resolution' 之类不存在用户）。
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    const autoArchiveId = nanoid(24);
    const auto = await db.transaction((tx) => archives.createAutomatic(tx, t1.campaignId, t1.id, ownerCtx.userId, autoArchiveId));
    expect(auto.kind).toBe('automatic');
    expect(auto.label).toBeNull();
    expect(auto.version).toBe(1);
    // 后续历史：t2、t3 完成（超过快照 watermark number=1）。
    const t2 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t2.id]);
    const t3 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t3.id]);
    // 恢复 completed 自动存档：t2/t3 supersede，同 tx 创建新 waiting turn number=4（不复用）。
    const restored = await archives.restore(ownerCtx, auto.id);
    expect(restored.restoredTurnId).toBeTruthy();
    const rows = await db.query<{ id: string; number: number; status: string; superseded_at: string | null }>(
      'SELECT id, number, status, superseded_at FROM platform_turns WHERE campaign_id = ? ORDER BY number',
      [t1.campaignId],
    );
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3, 4]);
    expect(rows[1].superseded_at).not.toBeNull(); // t2 被 supersede
    expect(rows[2].superseded_at).not.toBeNull(); // t3 被 supersede
    expect(rows[3].status).toBe('waiting_for_actions'); // 新回合
    // 新回合 requirements 直接断言：只包含快照中 approved 角色（distinct），draft/pending/rejected/archived 均不包含。
    const reqs = await db.query<{ player_id: string }>(
      'SELECT player_id FROM platform_turn_requirements WHERE turn_id = ? ORDER BY player_id', [restored.restoredTurnId as string],
    );
    expect(reqs.map((r) => r.player_id).sort())
      .toEqual([aCtx.playerId as string, bCtx.playerId as string].sort());
    expect(reqs.map((r) => r.player_id)).not.toContain(cCtx.playerId); // 只有 draft 的 c 不是必需玩家
    await db.close();
  });

  it('restores a waiting snapshot without auto-creating a new turn', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    const manual = await archives.createManual(ownerCtx, '锁定时'); // snapshot currentTurn = t1 locked
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    const restored = await archives.restore(ownerCtx, manual.id);
    const turn = await db.query<{ status: string; superseded_at: string | null }>(
      'SELECT status, superseded_at FROM platform_turns WHERE id = ?', [t1.id],
    );
    expect(turn[0].status).toBe('locked'); // 恢复到锁定状态，不开新回合
    expect(turn[0].superseded_at).toBeNull();
    await db.close();
  });

  it('restores a setup snapshot (turnNumber=0) and supersedes all later turns', async () => {
    const { db, turns, archives, ownerCtx } = await makeFixture();
    // 存档前无任何回合：setup 快照 currentTurn=null、turnNumber=0。
    const setup = await archives.createManual(ownerCtx, 'setup');
    const setupSnapshot = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [setup.id]))[0].state_json);
    expect(setupSnapshot.currentTurn).toBeNull();
    expect(setupSnapshot.watermarks.turnNumber).toBe(0);
    // 后续历史：t1、t2 完成。
    const t1 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    const t2 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t2.id]);
    const restored = await archives.restore(ownerCtx, setup.id);
    expect(restored.restoredTurnId).toBeNull(); // setup 快照无 currentTurn，不开新回合
    const rows = await db.query<{ number: number; superseded_at: string | null }>(
      'SELECT number, superseded_at FROM platform_turns WHERE campaign_id = ? ORDER BY number', [t1.campaignId],
    );
    expect(rows.map((r) => r.number)).toEqual([1, 2]);
    expect(rows[0].superseded_at).not.toBeNull(); // t1 被 supersede（number=1 > 0）
    expect(rows[1].superseded_at).not.toBeNull(); // t2 被 supersede
    await db.close();
  });

  it('restores an idle-after-completed snapshot: keeps turns <= turnNumber, supersedes > turnNumber, consistent with outbox watermark', async () => {
    const { db, turns, archives, ownerCtx } = await makeFixture();
    // 完成后（无进行中回合）创建 manual 存档：currentTurn=null、turnNumber=1。
    const t1 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    const idle = await archives.createManual(ownerCtx, '完成后');
    const idleSnapshot = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [idle.id]))[0].state_json);
    expect(idleSnapshot.currentTurn).toBeNull();
    expect(idleSnapshot.watermarks.turnNumber).toBe(1);
    // 后续历史：t2、t3 完成（number > turnNumber 水位）。
    const t2 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t2.id]);
    const t3 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t3.id]);
    await archives.restore(ownerCtx, idle.id);
    const rows = await db.query<{ number: number; superseded_at: string | null }>(
      'SELECT number, superseded_at FROM platform_turns WHERE campaign_id = ? ORDER BY number', [t1.campaignId],
    );
    // <=1（t1）保留、>1（t2/t3）supersede；快照无 currentTurn，不开新回合。
    expect(rows).toHaveLength(3);
    expect(rows[0].superseded_at).toBeNull();
    expect(rows[1].superseded_at).not.toBeNull();
    expect(rows[2].superseded_at).not.toBeNull();
    // 与 outbox watermark 一致：archive.restored 事件 sequence 大于快照 outbox watermark（不被本次 supersede）。
    const events = await db.query<{ event_type: string; sequence: number; superseded_at: string | null }>(
      'SELECT event_type, sequence, superseded_at FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence', [t1.campaignId],
    );
    const restoredEvent = events.find((e) => e.event_type === 'archive.restored');
    expect(restoredEvent).toBeTruthy();
    expect(restoredEvent!.superseded_at).toBeNull();
    expect(restoredEvent!.sequence).toBeGreaterThan(idleSnapshot.watermarks.outboxSequence);
    await db.close();
  });

  it('rejects restore while an unsuperseded resolving turn exists', async () => {
    const { db, turns, archives, ownerCtx } = await makeFixture();
    const turn = await turns.startTurn(ownerCtx);
    const manual = await archives.createManual(ownerCtx, 'pre'); // snapshot currentTurn = t1 waiting
    await db.execute("UPDATE platform_turns SET status = 'resolving' WHERE id = ?", [turn.id]);
    await expect(archives.restore(ownerCtx, manual.id)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('rejects restore while a running AI run exists but the turn is not resolving (second guard)', async () => {
    // 第二道 guard 独立覆盖：turn 非 resolving（人工改回 waiting），但 platform_ai_runs 仍有一条
    // running run（如 provider 挂起、run 未终结）。若没有第二道 guard，restore 会放行并污染恢复状态。
    const { db, turns, archives, ownerCtx } = await makeFixture();
    const turn = await turns.startTurn(ownerCtx);
    const manual = await archives.createManual(ownerCtx, 'pre');
    // 手动构造异常窗口：turn 不是 resolving，但存在一条 unsuperseded running run。
    await db.execute("UPDATE platform_turns SET status = 'waiting_for_actions' WHERE id = ?", [turn.id]);
    await db.execute(
      `INSERT INTO platform_ai_runs
        (id, campaign_id, campaign_sequence, turn_id, attempt, idempotency_key, provider, model, status,
         context_json, result_json, error_code, error_json, raw_debug_json, started_at, completed_at, superseded_at, superseded_by_archive_id)
       VALUES (?, ?, 1, ?, 1, 'run-guard', 'scripted', 'scripted', 'running', '{}', NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL)`,
      ['guard-run-1', turn.campaignId, turn.id, new Date().toISOString()],
    );
    await expect(archives.restore(ownerCtx, manual.id)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('rolls back restore on failure without partial superseding', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    const manual = await archives.createManual(ownerCtx, 'rollback');
    // 人为破坏存档 state_json → restore 的 snapshot parse 失败 → 整体回滚。
    await db.execute('UPDATE platform_archives SET state_json = ? WHERE id = ?', ['{bad json', manual.id]);
    await expect(archives.restore(ownerCtx, manual.id)).rejects.toBeTruthy();
    const active = await db.query<{ id: string }>(
      'SELECT id FROM platform_turns WHERE campaign_id = ? AND superseded_at IS NULL', [t1.campaignId],
    );
    expect(active.map((r) => r.id)).toEqual([t1.id]); // 没有任何回合被 supersede
    await db.close();
  });

  it('publishes an archive.restored event after superseding (not superseded itself)', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    const manual = await archives.createManual(ownerCtx, 'pre');
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    await archives.restore(ownerCtx, manual.id);
    const events = await db.query<{ event_type: string; payload_json: string; superseded_at: string | null; sequence: number }>(
      'SELECT event_type, payload_json, superseded_at, sequence FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence', [t1.campaignId],
    );
    const restored = events.find((e) => e.event_type === 'archive.restored');
    expect(restored).toBeTruthy();
    expect(JSON.parse(restored!.payload_json)).toMatchObject({ type: 'archive.restored', campaignId: t1.campaignId, archiveId: manual.id });
    expect(restored!.superseded_at).toBeNull(); // 本次 restored 事件不能被本次 supersede
    // snapshot 的 outbox watermark 只覆盖 restore 前已存在的事件；restored 事件在 supersede 后发布，
    // sequence 必须大于 watermark，证明它未被本次恢复 supersede。
    const snapshotWatermark = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [manual.id]))[0].state_json).watermarks.outboxSequence as number;
    expect(restored!.sequence).toBeGreaterThan(snapshotWatermark);
    await db.close();
  });

  it('keeps the version counter monotonic across restores', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    const manual = await archives.createManual(ownerCtx, 'v1');
    expect(manual.version).toBe(1);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    await archives.restore(ownerCtx, manual.id);
    const after = await archives.createManual(ownerCtx, 'v2');
    expect(after.version).toBe(2); // 恢复后 version counter 不回退
    await db.close();
  });

  it('assigns distinct versions under concurrent creates', async () => {
    const { archives, ownerCtx } = await makeFixture();
    const results = await Promise.allSettled([
      archives.createManual(ownerCtx, '并发A'),
      archives.createManual(ownerCtx, '并发B'),
    ]);
    const versions = results
      .filter((r): r is PromiseFulfilledResult<{ version: number }> => r.status === 'fulfilled')
      .map((r) => r.value.version);
    expect(versions).toEqual(expect.arrayContaining([1, 2]));
    await expect(archives.createManual(ownerCtx, 'again')).resolves.toMatchObject({ version: 3 });
  });
});
```

`server/src/platform/database/postgres-archives-ai.test.ts`（门控；T3 先写 archive 部分，T5 扩展 AI 部分）：

```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresDatabaseAdapter } from './PostgresDatabaseAdapter.js';
import { CampaignService } from '../../modules/campaigns/CampaignService.js';
import { CharacterService } from '../../modules/characters/CharacterService.js';
import { IdentityService } from '../../modules/identity/IdentityService.js';
import { resolveCampaignContext } from '../../modules/campaigns/CampaignAccess.js';
import { TurnService } from '../../modules/turns/TurnService.js';
import { OutboxRepository } from '../events/OutboxRepository.js';
import { ArchiveService } from '../../modules/archives/ArchiveService.js';

const url = process.env.POSTGRES_TEST_URL;

describe.skipIf(!url)('postgres archives + ai runtime', () => {
  it('allocates archive versions and restores a completed snapshot (no number reuse)', async () => {
    const db = new PostgresDatabaseAdapter(new pg.Pool({ connectionString: url, max: 1 }));
    try {
      await db.migrate();
      const identity = new IdentityService(db);
      const campaigns = new CampaignService(db);
      const characters = new CharacterService(db);
      // 共享 Postgres 测试库：每次运行用 randomUUID 唯一 login，避免重复运行撞 UNIQUE(login) 与残留。
      const suffix = randomUUID();
      const owner = await identity.register({ login: `owner-${suffix}@example.test`, password: 'correct-password' });
      const a = await identity.register({ login: `a-${suffix}@example.test`, password: 'correct-password' });
      const b = await identity.register({ login: `b-${suffix}@example.test`, password: 'correct-password' });
      const created = await campaigns.create(owner.userId, { name: '矿坑', ruleset: 'dnd5e' });
      await campaigns.join({ userId: a.userId }, created.campaign.id, created.inviteCode);
      await campaigns.join({ userId: b.userId }, created.campaign.id, created.inviteCode);
      const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
      const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
      const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
      for (const ctx of [aCtx, bCtx]) {
        const draft = await characters.createDraft(ctx, { name: '角色', sheet: { ac: 12 } });
        await characters.submitForReview(ctx, draft.id);
        await characters.approve(ownerCtx, draft.id);
      }
      const turns = new TurnService(db, new OutboxRepository(db));
      const archives = new ArchiveService(db, new OutboxRepository(db));
      const t1 = await turns.startTurn(ownerCtx);
      await turns.submitAction(aCtx, t1.id, { body: 'A' });
      await turns.submitAction(bCtx, t1.id, { body: 'B' });
      // 完成 t1 并创建 automatic 存档（snapshot currentTurn = t1 completed）。actorUserId 用真实 owner。
      await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
      const autoArchiveId = randomUUID();
      const auto = await db.transaction((tx) => archives.createAutomatic(tx, t1.campaignId, t1.id, ownerCtx.userId, autoArchiveId));
      expect(auto.kind).toBe('automatic');
      expect(auto.version).toBe(1);
      // 后续历史：t2 completed（超过快照 number=1 水位）。
      const t2 = await turns.startTurn(ownerCtx);
      await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t2.id]);
      // 恢复 completed 自动存档：t2 supersede；同 tx 创建新 waiting turn number=3（MAX+1 含 superseded，不复用 2）。
      const restored = await archives.restore(ownerCtx, auto.id);
      expect(restored.archive.id).toBe(auto.id);
      const rows = await db.query<{ number: number; status: string; superseded_at: string | null }>(
        'SELECT number, status, superseded_at FROM platform_turns WHERE campaign_id = ? ORDER BY number', [t1.campaignId],
      );
      expect(rows.map((r) => r.number)).toEqual([1, 2, 3]);
      expect(rows[1].superseded_at).not.toBeNull(); // t2 被 supersede
      expect(rows[2].status).toBe('waiting_for_actions'); // 恢复自动开的新回合，number=3 不复用
    } finally {
      await db.close();
    }
  });
});
```

### Step 2：运行确认失败
```bash
rtk npm test -- --run server/src/modules/archives/archive.test.ts
```

预期：失败——`ArchiveService`/`ArchiveRepository`/`archiveRoutes` 不存在；`CharacterRepository`/`TurnRepository` 缺 restore 辅助方法。`postgres-archives-ai.test.ts` 在 `POSTGRES_TEST_URL` 未配置时被 `describe.skipIf` 跳过（不报红）。

### Step 3：实现

`server/src/modules/archives/ArchiveRepository.ts`（version 原子分配 + 恢复 supersede 全量查询；所有方法接收 `QueryExecutor`，可注入 tx）：

```ts
import type { ArchiveKind } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface ArchiveRow {
  id: string;
  campaign_id: string;
  kind: ArchiveKind;
  turn_id: string | null;
  label: string | null;
  version: number;
  state_json: string;
  created_by_user_id: string;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
  created_at: string;
}

export class ArchiveRepository {
  constructor(private readonly executor: QueryExecutor) {}

  /** per-campaign version 原子分配：upsert 计数器 + RETURNING；绝不 MAX+1。 */
  async nextVersion(tx: QueryExecutor, campaignId: string): Promise<number> {
    const rows = await tx.query<{ last_version: number }>(
      `INSERT INTO platform_archive_sequences (campaign_id, last_version)
       VALUES (?, 1)
       ON CONFLICT (campaign_id) DO UPDATE SET last_version = platform_archive_sequences.last_version + 1
       RETURNING last_version`,
      [campaignId],
    );
    return Number(rows[0].last_version);
  }

  async insert(tx: QueryExecutor, row: ArchiveRow): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_archives
        (id, campaign_id, kind, turn_id, label, version, state_json, created_by_user_id, superseded_at, superseded_by_archive_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.campaign_id, row.kind, row.turn_id, row.label, row.version,
       row.state_json, row.created_by_user_id, row.superseded_at, row.superseded_by_archive_id, row.created_at],
    );
  }

  async findById(id: string): Promise<ArchiveRow | null> {
    const rows = await this.executor.query<ArchiveRow>('SELECT * FROM platform_archives WHERE id = ?', [id]);
    return rows[0] ?? null;
  }

  async listByCampaign(campaignId: string): Promise<ArchiveRow[]> {
    return this.executor.query<ArchiveRow>(
      'SELECT * FROM platform_archives WHERE campaign_id = ? AND superseded_at IS NULL ORDER BY version ASC', [campaignId],
    );
  }

  async maxOutboxSequence(campaignId: string): Promise<number> {
    const rows = await this.executor.query<{ max: number | null }>(
      'SELECT MAX(sequence) AS max FROM platform_outbox_events WHERE campaign_id = ?', [campaignId],
    );
    return Number(rows[0].max ?? 0);
  }

  async maxAiRunSequence(campaignId: string): Promise<number> {
    const rows = await this.executor.query<{ max: number | null }>(
      'SELECT MAX(campaign_sequence) AS max FROM platform_ai_runs WHERE campaign_id = ?', [campaignId],
    );
    return Number(rows[0].max ?? 0);
  }
}
```

`server/src/modules/characters/CharacterRepository.ts` 追加（restore 辅助；不改既有方法）。文件头部追加 `import { nanoid } from 'nanoid';`（restore audit 与 archive_restore_supersede audit 生成 id 需要）：

```ts
  /** 恢复：无条件 upsert 快照角色（INSERT ... ON CONFLICT(id) DO UPDATE）。返回 void；
   *  恢复本身由调用方在 restore tx 内写 `archive_restore` audit 记录（不依赖返回值）。 */
  async upsertRestored(row: CharacterRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_characters
        (id, campaign_id, player_id, name, status, sheet_json, derived_json, submitted_at, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         player_id = excluded.player_id,
         name = excluded.name,
         status = excluded.status,
         sheet_json = excluded.sheet_json,
         derived_json = excluded.derived_json,
         submitted_at = excluded.submitted_at,
         approved_at = excluded.approved_at,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [row.id, row.campaign_id, row.player_id, row.name, row.status, row.sheet_json,
       row.derived_json, row.submitted_at, row.approved_at, row.created_at, row.updated_at],
    );
  }

  /** 恢复：快照外（存档后新建）的角色一律 archived（不物理删除审计历史）。
   *  每个真实状态变化都在 restore tx 内写 character audit（action=archive_restore_supersede，
   *  before/after、actor=owner），使恢复过程可审计。 */
  async archiveCharactersNotIn(tx: QueryExecutor, campaignId: string, keptIds: string[], now: string, actorUserId: string): Promise<void> {
    const placeholders = keptIds.map(() => '?').join(',');
    const rows = await tx.query<CharacterRow>(
      keptIds.length > 0
        ? `SELECT * FROM platform_characters WHERE campaign_id = ? AND id NOT IN (${placeholders}) AND status != 'archived'`
        : `SELECT * FROM platform_characters WHERE campaign_id = ? AND status != 'archived'`,
      keptIds.length > 0 ? [campaignId, ...keptIds] : [campaignId],
    );
    for (const row of rows) {
      const archived: CharacterRow = { ...row, status: 'archived', updated_at: now };
      await tx.execute(
        "UPDATE platform_characters SET status = 'archived', updated_at = ? WHERE id = ? AND status != 'archived'",
        [now, row.id],
      );
      await tx.execute(
        `INSERT INTO platform_character_audits
          (id, character_id, campaign_id, actor_user_id, action, before_json, after_json, created_at)
         VALUES (?, ?, ?, ?, 'archive_restore_supersede', ?, ?, ?)`,
        [nanoid(24), row.id, campaignId, actorUserId,
         JSON.stringify(row), JSON.stringify(archived), now],
      );
    }
  }
```

`server/src/modules/turns/TurnRepository.ts` 追加（restore 辅助；直接复用现有 insertTurn——number 由调用方传入；replaceActions/replaceRequirements 为既有方法）：

```ts
  async findResolvingTurn(campaignId: string): Promise<TurnRow | null> {
    const rows = await this.executor.query<TurnRow>(
      "SELECT * FROM platform_turns WHERE campaign_id = ? AND status = 'resolving' AND superseded_at IS NULL ORDER BY number ASC LIMIT 1",
      [campaignId],
    );
    return rows[0] ?? null;
  }

  /** 存档 watermark：捕获时 unsuperseded 历史最大 turn number（setup 无回合 = 0）。
   *  必须显式过滤 superseded：与 maxTurnNumber（含 superseded，防号码复用）语义不同。 */
  async maxActiveTurnNumber(campaignId: string): Promise<number> {
    const rows = await this.executor.query<{ max: number | null }>(
      'SELECT MAX(number) AS max FROM platform_turns WHERE campaign_id = ? AND superseded_at IS NULL',
      [campaignId],
    );
    return Number(rows[0].max ?? 0);
  }

  async findByNumber(campaignId: string, number: number): Promise<TurnRow | null> {
    const rows = await this.executor.query<TurnRow>(
      'SELECT * FROM platform_turns WHERE campaign_id = ? AND number = ?', [campaignId, number],
    );
    return rows[0] ?? null;
  }

  /** 恢复：清掉快照当前回合的 superseded 标记，使其成为当前状态。 */
  async clearSuperseded(turnId: string): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_turns SET superseded_at = NULL, superseded_by_archive_id = NULL WHERE id = ?', [turnId],
    );
  }

  /** 恢复：恢复现有回合的状态字段（status/locked_at/completed_at/updated_at），
   *  使已完成行恢复到快照中的 locked/waiting/needs_owner_attention 等状态。
   *  注意：completed_at 按快照原样恢复（可能保留快照中的 completed_at 时间）。
   *  只有 currentTurn 快照的 turn 才调用；null 快照不会走到这里。 */
  async restoreTurnState(
    turnId: string,
    patch: { status: TurnStatus; lockedAt: string | null; completedAt: string | null; updatedAt: string },
  ): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_turns SET status = ?, locked_at = ?, completed_at = ?, updated_at = ? WHERE id = ?',
      [patch.status, patch.lockedAt, patch.completedAt, patch.updatedAt, turnId],
    );
  }

  /** 恢复：该回合的所有动作替换为快照动作（delete + insert，同 tx）。 */
  async replaceActions(turnId: string, campaignId: string, actions: ActionRow[]): Promise<void> {
    await this.executor.execute('DELETE FROM platform_actions WHERE turn_id = ?', [turnId]);
    for (const action of actions) {
      await this.executor.execute(
        `INSERT INTO platform_actions (id, turn_id, campaign_id, player_id, body, submitted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [action.id, turnId, campaignId, action.player_id, action.body, action.submitted_at, action.updated_at],
      );
    }
  }
  async replaceRequirements(turnId: string, campaignId: string, requirements: RequirementRow[]): Promise<void> {
    await this.executor.execute('DELETE FROM platform_turn_requirements WHERE turn_id = ?', [turnId]);
    for (const requirement of requirements) {
      await this.executor.execute(
        'INSERT INTO platform_turn_requirements (turn_id, campaign_id, player_id, submitted) VALUES (?, ?, ?, ?)',
        [turnId, campaignId, requirement.player_id, requirement.submitted],
      );
    }
  }

  /** 恢复：超 watermark 的回合（number 更大）一律 supersede。setup 与 idle-after-completed 统一走本方法：
   *  setup 快照（turnNumber=0）→ 所有回合 number>0 全部 supersede（等效全量 supersede）；
   *  idle-after-completed 快照（currentTurn=null, turnNumber=N>0）→ 只 supersede number>N 的 later turns，
   *  保留 <=N 的既有 completed 历史。绝不在 null currentTurn 时从 `currentTurn===null` 推断 supersede 全部。 */
  async supersedeTurnsAfterNumber(campaignId: string, number: number, archiveId: string, now: string): Promise<void> {
    await this.executor.execute(
      'UPDATE platform_turns SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL AND number > ?',
      [now, archiveId, campaignId, number],
    );
  }
```

`server/src/modules/world/WorldFactRepository.ts` 追加（恢复辅助）：

```ts
  /** 恢复：快照内事实 upsert 并清 superseded；快照外事实 supersede（archiveId 由调用方传入）。 */
  async upsertRestored(row: WorldFactRow): Promise<void> {
    await this.executor.execute(
      `INSERT INTO platform_world_facts
        (id, campaign_id, title, kind, content, visibility, known_by_json, created_at, updated_at, superseded_at, superseded_by_archive_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         title = excluded.title,
         kind = excluded.kind,
         content = excluded.content,
         visibility = excluded.visibility,
         known_by_json = excluded.known_by_json,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         superseded_at = NULL,
         superseded_by_archive_id = NULL`,
      [row.id, row.campaign_id, row.title, row.kind, row.content, row.visibility,
       row.known_by_json, row.created_at, row.updated_at],
    );
  }

  async supersedeFactsNotIn(campaignId: string, keptIds: string[], archiveId: string, now: string): Promise<void> {
    const placeholders = keptIds.map(() => '?').join(',');
    const sql = keptIds.length > 0
      ? `UPDATE platform_world_facts SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL AND id NOT IN (${placeholders})`
      : `UPDATE platform_world_facts SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL`;
    await this.executor.execute(sql, keptIds.length > 0 ? [now, archiveId, campaignId, ...keptIds] : [now, archiveId, campaignId]);
  }
```

`server/src/modules/archives/ArchiveService.ts`（capture/restore 核心算法）：

```ts
import { nanoid } from 'nanoid';
import type { Archive, ArchiveKind, ArchiveRestoreResult, ArchiveSnapshot, ArchiveSnapshotCharacter, ArchiveSnapshotRequirement, ManualArchiveInput, TurnAction } from '@dnd/contracts';
import { archiveSnapshotSchema, manualArchiveInputSchema } from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { CharacterRepository, type CharacterRow } from '../characters/CharacterRepository.js';
import { TurnRepository, type ActionRow, type RequirementRow, type TurnRow } from '../turns/TurnRepository.js';
import { WorldFactRepository, type WorldFactRow } from '../world/WorldFactRepository.js';
import { ArchiveRepository, type ArchiveRow } from './ArchiveRepository.js';
import { AiRunRepository } from '../ai-runtime/AiRunRepository.js';

export class ArchiveService {
  private readonly repository: ArchiveRepository;

  constructor(
    private readonly executor: DatabasePort,
    private readonly outbox: EventPublisherPort,
  ) {
    this.repository = new ArchiveRepository(executor);
  }

  /** owner 手动存档：label 必填 trimmed；current turn resolving → STATE_CONFLICT；无 turn/setup、waiting、locked、needs_owner_attention、completed 均允许。 */
  async createManual(ctx: CampaignAuthContext, label: string): Promise<Archive> {
    requireOwner(ctx);
    // label 必须非空且 trim；路由已用 manualArchiveInputSchema.parse，但 service 也要自校验（单元测试直接调用）。
    const input = manualArchiveInputSchema.parse({ label });
    return this.executor.transaction(async (tx) => {
      const repo = new ArchiveRepository(tx);
      const turns = new TurnRepository(tx);
      // 当前回合 resolving → STATE_CONFLICT（AI 结算中不允许存档，防止把中间状态写进快照）。
      if (await turns.findResolvingTurn(ctx.campaignId)) {
        throw new AppError('STATE_CONFLICT', '存在结算中的回合，无法手动存档。');
      }
      const version = await repo.nextVersion(tx, ctx.campaignId);
      const snapshot = await this.captureSnapshot(tx, ctx.campaignId, { forResolvedTurn: false });
      const archiveId = nanoid(24);
      const row = this.buildRow(ctx.campaignId, 'manual', snapshot.currentTurn?.turn.id ?? null, input.label, version, snapshot, ctx.userId, archiveId);
      await repo.insert(tx, row);
      return mapArchive(row);
    });
  }

  /** 恢复：owner-only + campaign 行锁 + 单 tx；先 supersede 旧历史，再 publish archive.restored。 */
  async restore(ctx: CampaignAuthContext, archiveId: string): Promise<ArchiveRestoreResult> {
    requireOwner(ctx);
    return this.executor.transaction(async (tx) => {
      // 1) campaign 行锁（Postgres 行锁；SQLite 写事务串行）。
      await tx.execute('UPDATE campaigns SET updated_at = updated_at WHERE id = ?', [ctx.campaignId]);
      const repo = new ArchiveRepository(tx);
      const archive = await repo.findById(archiveId);
      if (!archive || archive.campaign_id !== ctx.campaignId) {
        throw new AppError('NOT_FOUND', '存档不存在。');
      }
      // 2) 不存在 unsuperseded resolving turn / running run → 防止 provider 晚到结果污染恢复状态。
      //    两道独立守卫：① resolving turn（claim 已把 turn 置 resolving）；② running run（防御性兜底，
      //    覆盖 turn 非 resolving 但 run 仍 running 的异常窗口，如人工把 turn 改回其它状态而 run 未终结）。
      const turns = new TurnRepository(tx);
      const aiRuns = new AiRunRepository(tx);
      if (await turns.findResolvingTurn(ctx.campaignId)) {
        throw new AppError('STATE_CONFLICT', '存在结算中的回合，无法恢复存档。');
      }
      if (await aiRuns.findRunningRun(ctx.campaignId)) {
        throw new AppError('STATE_CONFLICT', '存在运行中的 AI 结算，无法恢复存档。');
      }
      // 3) 解析快照。
      const parsed = archiveSnapshotSchema.safeParse(JSON.parse(archive.state_json));
      if (!parsed.success) {
        throw new AppError('INTERNAL_ERROR', '存档快照无效。');
      }
      const snapshot = parsed.data;
      const now = new Date().toISOString();
      // 4) 先 supersede 旧历史（被恢复 archive 的 version 作为 archives 超水位）。
      await this.supersedeHistory(tx, ctx.campaignId, archive.id, archive.version, snapshot, now);
      // 5) 恢复快照状态。
      const restoredTurnId = await this.restoreSnapshotState(tx, ctx.campaignId, snapshot, ctx.userId, now);
      // 5b) 选中 archive 自身解除 superseded，成为当前 active checkpoint（产品语义：选中的存档成为当前状态）。
      //      version > target 的更新存档仍保持 superseded；version counter 不回退。
      await repo.clearSuperseded(archive.id);
      // 6) 最后 publish archive.restored（public；其 sequence > watermark，不被本次 supersede）。
      await this.outbox.publishIn(tx, {
        type: 'archive.restored', campaignId: ctx.campaignId, archiveId: archive.id, version: archive.version,
      });
      // 返回 DTO 前重读：确保 archive.superseded=false（选中 checkpoint 已重新激活）。
      const restoredArchive = (await repo.findById(archive.id)) as ArchiveRow;
      return { archive: mapArchive(restoredArchive), restoredTurnId };
    });
  }

  /** AiResolutionService 在 formal apply tx 内创建 automatic 存档（本方法不自开事务）。
   *  archiveId 由调用方预生成并传入，保证 `turn.resolved` 事件携带的 archiveId 与正式存档 id 一致。 */
  async createAutomatic(
    tx: QueryExecutor,
    campaignId: string,
    resolvedTurnId: string,
    actorUserId: string,
    archiveId: string,
  ): Promise<Archive> {
    const repo = new ArchiveRepository(tx);
    const version = await repo.nextVersion(tx, campaignId);
    const snapshot = await this.captureSnapshot(tx, campaignId, { forResolvedTurn: true, resolvedTurnId });
    const row = this.buildRow(campaignId, 'automatic', resolvedTurnId, null, version, snapshot, actorUserId, archiveId);
    await repo.insert(tx, row);
    return mapArchive(row);
  }

  async listForCampaign(ctx: CampaignAuthContext): Promise<Archive[]> {
    requireOwner(ctx); // 存档列表 owner-only
    const rows = await this.repository.listByCampaign(ctx.campaignId);
    return rows.map(mapArchive);
  }

  /** 快照：schemaVersion=1，含 campaignId/ruleset/characters(全部角色完整 owner current state)/active world facts/current turn+actions+requirements/watermarks。
   *  watermarks 含 outboxSequence/aiRunCampaignSequence/turnNumber（turnNumber 为捕获时 unsuperseded 历史最大
   *  turn number，供 restore 决定 turns 的 supersede 水位；setup 无回合 = 0）。 */
  private async captureSnapshot(
    tx: QueryExecutor,
    campaignId: string,
    opts: { forResolvedTurn: boolean; resolvedTurnId?: string },
  ): Promise<ArchiveSnapshot> {
    const campaign = (await tx.query<{ id: string; ruleset: string }>(
      'SELECT id, ruleset FROM campaigns WHERE id = ?', [campaignId],
    ))[0];
    const chars = new CharacterRepository(tx);
    const facts = new WorldFactRepository(tx);
    const turns = new TurnRepository(tx);
    const archiveRepo = new ArchiveRepository(tx);

    // 快照角色取 campaign 全部角色（draft/pending_review/rejected/approved/archived 全保留），
    // 完整 owner current state。context builder 仍只取 approved——二者解耦。
    const characterRows = (await chars.listByCampaign(campaignId)).map(toSnapshotCharacter);
    // 快照事实取 active 全量（含 public/player_private/owner_only，恢复时按原 visibility 还原）。
    const factRows = (await facts.listByCampaign(campaignId)).map(toSnapshotWorldFact);

    let currentTurnSnapshot: ArchiveSnapshot['currentTurn'] = null;
    if (opts.forResolvedTurn && opts.resolvedTurnId) {
      // automatic：resolved turn 已 completed、entries 已写、下一回合尚未创建。
      currentTurnSnapshot = await this.turnSnapshot(tx, campaignId, opts.resolvedTurnId);
    } else {
      const active = await turns.findUnfinishedTurn(campaignId);
      if (active) {
        currentTurnSnapshot = await this.turnSnapshot(tx, campaignId, active.id);
      }
    }

    return {
      schemaVersion: 1,
      campaignId,
      ruleset: campaign.ruleset,
      characters: characterRows,
      worldFacts: factRows,
      currentTurn: currentTurnSnapshot,
      watermarks: {
        outboxSequence: await archiveRepo.maxOutboxSequence(campaignId),
        aiRunCampaignSequence: await archiveRepo.maxAiRunSequence(campaignId),
        // 捕获时 unsuperseded 历史最大 turn number：setup 无回合 = 0；idle-after-completed 快照
        // 的 currentTurn=null 但 turnNumber=N（恢复时保留 <=N 的 completed 历史，只 supersede >N）。
        // 注意：这是恢复时 turns 的 supersede 水位，与 maxTurnNumber（含 superseded，防号码复用）语义不同。
        turnNumber: await new TurnRepository(tx).maxActiveTurnNumber(campaignId),
      },
    };
  }

  private async turnSnapshot(tx: QueryExecutor, campaignId: string, turnId: string): Promise<NonNullable<ArchiveSnapshot['currentTurn']>> {
    const turns = new TurnRepository(tx);
    const turn = (await turns.findTurnById(turnId)) as TurnRow;
    const actions = (await turns.listActionsByTurn(turnId)).map(mapAction);
    const requirements = (await turns.listRequirements(turnId)).map((r) => ({ playerId: r.player_id, submitted: r.submitted === 1 }));
    return { turn: mapTurnSummary(turn), actions, requirements };
  }

  private buildRow(
    campaignId: string,
    kind: ArchiveKind,
    turnId: string | null,
    label: string | null,
    version: number,
    snapshot: ArchiveSnapshot,
    actorUserId: string,
    archiveId: string,
  ): ArchiveRow {
    return {
      id: archiveId, campaign_id: campaignId, kind, turn_id: turnId, label, version,
      state_json: JSON.stringify(snapshot), created_by_user_id: actorUserId,
      superseded_at: null, superseded_by_archive_id: null, created_at: new Date().toISOString(),
    };
  }

  /** 恢复时先 supersede 旧历史（顺序：outbox → AI runs/entries/requests → turns → archives → world facts → characters archived）。 */  private async supersedeHistory(
    tx: QueryExecutor,
    campaignId: string,
    archiveId: string,
    restoredVersion: number,
    snapshot: ArchiveSnapshot,
    now: string,
  ): Promise<void> {
    await tx.execute(
      'UPDATE platform_outbox_events SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL AND sequence > ?',
      [now, archiveId, campaignId, snapshot.watermarks.outboxSequence],
    );
    await new AiRunRepository(tx).supersedeByWatermark(tx, campaignId, archiveId, snapshot.watermarks.aiRunCampaignSequence, now);
    // 统一用 supersedeTurnsAfterNumber(turnNumber) 处理回合历史：turnNumber 是捕获时 unsuperseded
    // 历史最大 turn number（setup 无回合 = 0）。setup 快照（turnNumber=0）→ 所有回合 number>0
    // 全部 supersede（等效全量 supersede）；idle-after-completed 快照（currentTurn=null, turnNumber=N）
    // → 只 supersede number>N 的 later turns，保留 <=N 的既有 completed 历史。
    const turns = new TurnRepository(tx);
    await turns.supersedeTurnsAfterNumber(campaignId, snapshot.watermarks.turnNumber, archiveId, now);
    // 比被恢复存档更新的 archives（version 更大）一律 supersede；version counter 永不回退。
    // 注意：选中 archive 自身的 reactivation 不在本方法内——restore 主流程在第 5b 步调用
    // ArchiveRepository.clearSuperseded(archive.id)，使「选中的存档成为当前 active checkpoint」，
    // 而 version > target 的存档保持 superseded。本 UPDATE 的 `version > ?` 条件天然排除 target 自身。
    await tx.execute(
      'UPDATE platform_archives SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL AND version > ?',
      [now, archiveId, campaignId, restoredVersion],
    );
    const facts = new WorldFactRepository(tx);
    await facts.supersedeFactsNotIn(campaignId, snapshot.worldFacts.map((f) => f.id), archiveId, now);
  }
}
```

（续 `ArchiveService` 恢复快照状态算法）

```ts
  /** 恢复快照状态：characters upsert + archive_restore audits；world facts upsert + 清除 superseded；currentTurn 恢复；completed 快照创建新 waiting turn（null 快照不开新回合）。 */
  private async restoreSnapshotState(
    tx: QueryExecutor,
    campaignId: string,
    snapshot: ArchiveSnapshot,
    actorUserId: string,
    now: string,
  ): Promise<string | null> {
    const chars = new CharacterRepository(tx);
    const facts = new WorldFactRepository(tx);
    const turns = new TurnRepository(tx);

    // 快照外角色一律 archived；快照内角色按原状态/字段 upsert + archive_restore audit。
    // archiveCharactersNotIn 每个真实状态变化（archived）也写 character audit，actor=owner。
    const keptCharacterIds = snapshot.characters.map((c) => c.id);
    await chars.archiveCharactersNotIn(tx, campaignId, keptCharacterIds, now, actorUserId);
    for (const snapshotChar of snapshot.characters) {
      const before = await chars.findById(snapshotChar.id);
      const row: CharacterRow = {
        id: snapshotChar.id, campaign_id: snapshotChar.campaignId, player_id: snapshotChar.playerId,
        name: snapshotChar.name, status: snapshotChar.status, sheet_json: JSON.stringify(snapshotChar.sheet),
        derived_json: JSON.stringify(snapshotChar.derived), submitted_at: snapshotChar.submittedAt,
        approved_at: snapshotChar.approvedAt, created_at: snapshotChar.createdAt, updated_at: now,
      };
      await chars.upsertRestored(row);
      await chars.insertAudit({
        id: nanoid(24), character_id: row.id, campaign_id, actor_user_id: actorUserId,
        action: 'archive_restore', before_json: before ? JSON.stringify(before) : null,
        after_json: JSON.stringify(row), created_at: now,
      });
    }

    // 快照内事实 upsert + 清 superseded（快照外事实已在 supersedeHistory 中 supersede，这里不重复操作）。
    for (const snapshotFact of snapshot.worldFacts) {
      await facts.upsertRestored({
        id: snapshotFact.id, campaign_id: snapshotFact.campaignId, title: snapshotFact.title,
        kind: snapshotFact.kind, content: snapshotFact.content, visibility: snapshotFact.visibility,
        known_by_json: JSON.stringify(snapshotFact.knownBy), created_at: snapshotFact.createdAt,
        updated_at: now,
      });
    }

    // currentTurn 恢复。
    const current = snapshot.currentTurn;
    if (!current) {
      // 快照无 currentTurn（setup 或 idle-after-completed）：不开新回合。
      // supersede 语义已由 supersedeHistory 按 turnNumber watermark 完成——
      // setup(turnNumber=0) supersede 全部 later turns；idle-after-completed(turnNumber=N)
      // 保留 <=N 历史。这里只恢复 characters/worldFacts，不创建/恢复任何回合。
      return null;
    }
    const existing = await turns.findByNumber(campaignId, current.turn.number);
    if (existing) {
      // 恢复现有回合的状态字段（已完成行可能需恢复为 locked/waiting/needs_owner_attention），
      // 再替换 actions/requirements。绝不清 superseded_by_archive_id 之外的字段。
      await turns.clearSuperseded(existing.id);
      await turns.restoreTurnState(existing.id, {
        status: current.turn.status,
        lockedAt: current.turn.lockedAt,
        completedAt: current.turn.completedAt,
        updatedAt: now,
      });
      await turns.replaceActions(existing.id, campaignId, current.actions.map((a) => fromSnapshotAction(existing.id, campaignId, a)));
      await turns.replaceRequirements(existing.id, campaignId, current.requirements.map((r) => fromSnapshotRequirement(existing.id, campaignId, r)));
    } else {
      await turns.insertTurn({
        id: current.turn.id, campaign_id: campaignId, number: current.turn.number, status: current.turn.status,
        locked_at: current.turn.lockedAt, completed_at: current.turn.completedAt,
        created_at: current.turn.createdAt, updated_at: now,
      });
      await turns.replaceActions(current.turn.id, campaignId, current.actions.map((a) => fromSnapshotAction(current.turn.id, campaignId, a)));
      await turns.replaceRequirements(current.turn.id, campaignId, current.requirements.map((r) => fromSnapshotRequirement(current.turn.id, campaignId, r)));
    }

    if (current.turn.status === 'completed') {
      // completed 快照：同 tx 创建新 waiting turn，number = 全局 MAX+1（含 superseded，不复用）。
      const number = (await turns.maxTurnNumber(campaignId)) + 1;
      const newTurnId = nanoid(24);
      await turns.insertTurn({
        id: newTurnId, campaign_id: campaignId, number, status: 'waiting_for_actions',
        locked_at: null, completed_at: null, created_at: now, updated_at: now,
      });
      // 新 waiting turn requirements 只取快照中 status='approved' 的 playerId（distinct）；
      // draft/pending/rejected/archived 不是必需玩家（Task 3 archive.test 直接断言该行为）。
      const approvedPlayerIds = snapshot.characters
        .filter((c) => c.status === 'approved')
        .map((c) => c.playerId);
      for (const playerId of [...new Set(approvedPlayerIds)]) {
        await turns.insertRequirement(newTurnId, campaignId, playerId);
      }
      return newTurnId;
    }
    // waiting/locked/needs_owner_attention 快照：恢复该状态，不自动开新回合。
    return current.turn.id;
  }
```

`mapArchive`/`toSnapshotCharacter`/`toSnapshotWorldFact`/`mapAction`/`mapTurnSummary`/`fromSnapshotAction`/`fromSnapshotRequirement` 为纯映射 helper，按 Phase 2A 的 `mapSummary`/`mapAction` 风格实现，输出契约形对象、绝不输出 `*_json`/内部字段。

`fromSnapshotAction`/`fromSnapshotRequirement` 的显式定义（恢复时 turn_id/campaign_id 一律映射到**目标恢复 turn**，杜绝残留/冲突）：

```ts
/** 快照 action → 目标恢复 turn 的 ActionRow：turn_id 固定为目标 turn，campaign_id 固定为目标 campaign。 */
function fromSnapshotAction(turnId: string, campaignId: string, action: TurnAction): ActionRow {
  return {
    id: action.id, turn_id: turnId, campaign_id: campaignId, player_id: action.playerId,
    body: action.body, submitted_at: action.submittedAt, updated_at: action.updatedAt,
  };
}

/** 快照 requirement → 目标恢复 turn 的 RequirementRow：turn_id/campaign_id 固定为目标 turn/campaign。 */
function fromSnapshotRequirement(turnId: string, campaignId: string, requirement: ArchiveSnapshotRequirement): RequirementRow {
  return {
    turn_id: turnId, campaign_id: campaignId, player_id: requirement.playerId,
    submitted: requirement.submitted ? 1 : 0,
  };
}
```

调用处必须显式传目标 turn：`current.actions.map((a) => fromSnapshotAction(existingId, campaignId, a))`、`current.requirements.map((r) => fromSnapshotRequirement(existingId, campaignId, r))`（`existingId` 为恢复目标 turn id；setup 快照新建/已完成快照恢复均以目标 turn id 为准）。

> **`maxTurnNumber` 语义（关键，勿混淆）**：`TurnRepository.maxTurnNumber(campaignId)` 的 `SELECT MAX(number)` **不过滤 superseded**——这是**有意为之**，恢复后新回合不得复用号码（既有 Task 1 决策）。快照 capture 的 `turnNumber` watermark 用**新增的 `maxActiveTurnNumber`**（显式 `WHERE superseded_at IS NULL`），二者语义不同，实现时必须分开。

`toSnapshotCharacter` 显式定义（快照角色必须含全部真实字段与状态，`submitted_at`/`approved_at` 按原样映射，绝不硬编码 approved）：

```ts
/** CharacterRow → 快照角色：保留 status/submitted_at/approved_at 完整 owner current state；不含 *_json 内部字段。 */
function toSnapshotCharacter(row: CharacterRow): ArchiveSnapshotCharacter {
  return {
    id: row.id, campaignId: row.campaign_id, playerId: row.player_id, name: row.name,
    status: row.status, sheet: JSON.parse(row.sheet_json) as Record<string, unknown>,
    derived: JSON.parse(row.derived_json) as Record<string, unknown>,
    submittedAt: row.submitted_at, approvedAt: row.approved_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
```

`server/src/routes/archiveRoutes.ts`（`mergeParams` + campaign middleware；`POST /` 只 owner、`POST /:archiveId/restore` 只 owner、`GET /` 只 owner）：

```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { manualArchiveInputSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { ArchiveService } from '../modules/archives/ArchiveService.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AppError } from '../platform/http/AppError.js';

export function createArchiveRouter(executor: QueryExecutor, archives: ArchiveService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    // 存档列表 owner-only：service 内 enforce（listForCampaign 调 requireOwner），player 不可见。
    res.json({ archives: await archives.listForCampaign(getCampaignContext(req)) });
  }));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = manualArchiveInputSchema.parse(req.body);
    res.status(201).json({ archive: await archives.createManual(ctx, input.label) });
  }));

  router.post('/:archiveId/restore', asyncHandler(async (req: Request, res: Response) => {
    res.json({ result: await archives.restore(getCampaignContext(req), stringParam(req, 'archiveId')) });
  }));

  return router;
}

function stringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new AppError('NOT_FOUND', '存档不存在。');
  return value;
}
```

`server/src/app.ts` 挂载（新增 routes 插在既有唯一 errorMiddleware 之前；注入 concrete `OutboxRepository`。**不重复注册 errorMiddleware**）：

```ts
import { ArchiveService } from './modules/archives/ArchiveService.js';
import { createArchiveRouter } from './routes/archiveRoutes.js';
// ...
if (options.platformDb) {
  // ... 既有 identity/campaigns/characters/worldFacts/turns ...
  const archives = new ArchiveService(options.platformDb, new OutboxRepository(options.platformDb));
  app.use('/api/campaigns/:campaignId/archives', createArchiveRouter(options.platformDb, archives));
  // 不重复注册 errorMiddleware：文件末尾已有唯一兜底。
}
```

> **Task 3 实现说明**：`app.ts` 只保留文件末尾既有的一次 errorMiddleware 注册；archive 路由在它之前注册即可，不要重复注册。

> **Task 3 实现说明**：`restoreSnapshotState` 的快照角色 restore 走 `CharacterRepository.upsertRestored` 并在同一 restore tx 内写 `archive_restore` audit；快照外角色由 `archiveCharactersNotIn` 标记 `archived` 并写 `archive_restore_supersede` audit（actor 都是当前 owner）。因此**恢复的角色状态变化必然伴随同 tx 的 character audit**，且 restore 只对**实际发生的** supersede（快照外角色）与快照角色 upsert 写 audit。新 waiting turn 的 requirements 只取快照中 `status='approved'` 的 playerId（draft/pending/rejected/archived 不是必需玩家）。

> **Task 3 实现说明**：`restoreSnapshotState` 恢复现有 currentTurn 时，`replaceActions`/`replaceRequirements` 的 turn_id/campaign_id 一律映射到目标恢复 turn，杜绝残留/冲突；`currentTurn` 恢复后的 `supersedeTurnsAfterNumber` 只超水位 supersede 号码更大的回合，绝不清掉被恢复回合本身。

### Step 4：运行确认通过

```bash
rtk npm test -- --run server/src/modules/archives/archive.test.ts server/src/modules/turns/turn.test.ts server/src/modules/world/world.test.ts server/src/platform/events/outbox.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：archive 测试全绿——manual label trimmed/version 原子、resolving 拒绝 `STATE_CONFLICT`、player `FORBIDDEN`、全部五个角色状态（draft/pending_review/rejected/approved/archived）快照 round-trip、`archive_restore`/`archive_restore_supersede` audit 齐备（actor=owner）、completed 快照恢复后 t2/t3 supersede + 新回合 number=4 不复用且 requirements 只含 approved 玩家、waiting 快照恢复后 t1 locked 且不开新回合、resolving turn 存在时 restore `STATE_CONFLICT`、回滚无部分 supersede、`archive.restored` 事件 sequence > snapshot watermark 且不被本次 supersede、version counter 不回退、并发 version 1/2/3；既有 turn/world/outbox 不回退；`007_archives.sql` 复制进 dist。

### Step 5：提交

```bash
rtk git add server/src/modules/archives server/src/routes/archiveRoutes.ts server/src/app.ts server/src/modules/characters/CharacterRepository.ts server/src/modules/turns/TurnRepository.ts server/src/modules/world/WorldFactRepository.ts server/src/platform/database/postgres-archives-ai.test.ts
rtk git commit -m "feat: add campaign archive capture and restore" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4：AI 上下文构建 + 输出校验 + turn entries 投影 + 白名单 materializer

**依赖：** Task 1（`archiveSnapshotSchema` 中 character/fact 形状）、Task 2（`turnEntrySchema`/`resolveTurnInputSchema`）。Phase 2A 的 `VisibilityPolicy.canRead`、`CharacterRepository`/`WorldFactRepository`/`TurnRepository`、`computeDerived`（`CharacterService`）。

**目标：** （1）`DiceResult` contract 补 `targetPlayerId`（player_private 必填非空、public/owner_only 必为 null）并同步 `contracts.test.ts`；`turnResolutionSchema.publicNarrative` 加 `.min(1)`（空叙事判无效输出，invalid 测试与 combat gate 分离）；（2）`AiContextBuilder`：claim tx 内 capture 稳定 context（campaign/ruleset、locked actions、approved characters 必要 owner state、active world facts；**不含** password_hash/invite_code_hash/audit/raw DB 名），产出 `AiPrompt`；（3）`TurnResolutionValidator`：`turnResolutionSchema.parse` provider final output，private updates/dice/interactions target 必须是该 campaign 当前 player 成员，stateChange target 归属该校验；（4）`StateChangeMaterializer`：character/world/quest 精确 patch 白名单、target campaign 归属、character 派生值与 audit（audit actor 用真实 owner/user id）、world knownBy 校验；kind=combat 明确抛 `STATE_CONFLICT` 且无任何正式写；（5）turn entries 投影复用 `VisibilityPolicy`。

### Files

- Modify: `packages/contracts/src/turn.ts`（`DiceResult.targetPlayerId`；`turnResolutionSchema.publicNarrative` 加 `.min(1)`，空叙事视为无效输出）
- Modify: `packages/contracts/src/contracts.test.ts`
- Create: `server/src/modules/ai-runtime/AiContextBuilder.ts`
- Create: `server/src/modules/ai-runtime/TurnResolutionValidator.ts`
- Create: `server/src/modules/ai-runtime/StateChangeMaterializer.ts`
- Create: `server/src/modules/ai-runtime/ai-context-builder.test.ts`
- Create: `server/src/modules/ai-runtime/turn-resolution-validator.test.ts`
- Create: `server/src/modules/ai-runtime/state-change-materializer.test.ts`
- Create: `server/src/modules/ai-runtime/turn-entries-projection.test.ts`

### Step 1：写失败测试

`packages/contracts/src/turn.ts` 的 `diceResultSchema` 改为（保留 `id/formula/total/visibility`，新增 `targetPlayerId` + superRefine），并把 `turnResolutionSchema.publicNarrative` 改为 `.min(1)`：

```ts
export const diceResultSchema = z.object({
  id: z.string().min(1),
  formula: z.string().min(1),
  total: z.number().int(),
  visibility: visibilitySchema,
  /** player_private 必填非空；public/owner_only 必为 null。 */
  targetPlayerId: z.string().min(1).nullable(),
}).superRefine((dice, ctx) => {
  if (dice.visibility === 'player_private' && !dice.targetPlayerId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'player_private dice result 必须指定 targetPlayerId。' });
  }
  if (dice.visibility !== 'player_private' && dice.targetPlayerId !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'public/owner_only dice result 的 targetPlayerId 必须为 null。' });
  }
});
export type DiceResult = z.infer<typeof diceResultSchema>;

/** 公开叙事必填非空：空叙事视为无效输出（invalid 测试不再依赖 combat 触发）。 */
export const turnResolutionSchema = z.object({
  publicNarrative: z.string().min(1),
  privateUpdates: z.array(privateUpdateSchema),
  diceResults: z.array(diceResultSchema),
  stateChanges: z.array(stateChangeSchema),
  interactionRequests: z.array(interactionRequestSchema),
});
```

`packages/contracts/src/contracts.test.ts` 同步（既有测试补 `targetPlayerId: null`，新增 player_private 断言）：

```ts
  it('accepts a structured dice result with visibility', () => {
    const result = turnResolutionSchema.parse({
      publicNarrative: '剑刃劈开空气。',
      privateUpdates: [],
      diceResults: [
        { id: 'dice-1', formula: '1d20+5', total: 18, visibility: 'public', targetPlayerId: null },
      ],
      stateChanges: [
        { kind: 'combat', targetId: 'goblin-1', patch: { hpCurrent: 3 }, visibility: 'public' },
      ],
      interactionRequests: [
        { id: 'interaction-1', targetPlayerId: 'player-2', prompt: '酒馆老板等待你的回答。' },
      ],
    });
    expect(result.diceResults[0].targetPlayerId).toBeNull();
  });

  it('requires a non-null targetPlayerId for player_private dice', () => {
    expect(() => turnResolutionSchema.parse({
      publicNarrative: 'x', privateUpdates: [], stateChanges: [],
      diceResults: [{ id: 'd', formula: '1d20', total: 7, visibility: 'player_private', targetPlayerId: null }],
      interactionRequests: [],
    })).toThrow();
  });

  it('rejects an empty publicNarrative', () => {
    expect(() => turnResolutionSchema.parse({
      publicNarrative: '', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [],
    })).toThrow();
  });
```

`server/src/modules/ai-runtime/ai-context-builder.test.ts`（fixture 建 campaign + 角色 + locked turn；断言 context 不含敏感字段、含 locked actions/approved characters/active facts）：

```ts
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { TurnService } from '../turns/TurnService.js';
import { WorldFactService } from '../world/WorldFactService.js';
import { AiContextBuilder } from './AiContextBuilder.js';

describe('ai context builder', () => {
  it('builds an owner-safe prompt from locked actions, approved characters and active world facts', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const identity = new IdentityService(db);
    const campaigns = new CampaignService(db);
    const characters = new CharacterService(db);
    const worldFacts = new WorldFactService(db);
    const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
    const a = await identity.register({ login: 'a@example.test', password: 'correct-password' });
    const b = await identity.register({ login: 'b@example.test', password: 'correct-password' });
    const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
    for (const user of [a, b]) await campaigns.join({ userId: user.userId }, created.campaign.id, created.inviteCode);
    const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
    const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
    const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
    const approve = async (ctx: typeof aCtx, name: string) => {
      const draft = await characters.createDraft(ctx, { name, sheet: { ac: 14, hpCurrent: 10 } });
      await characters.submitForReview(ctx, draft.id);
      await characters.approve(ownerCtx, draft.id);
    };
    await approve(aCtx, '薇拉');
    await approve(bCtx, '卡恩');
    await worldFacts.create(ownerCtx, { title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public' });
    await worldFacts.create(ownerCtx, { title: '密信', kind: 'item', content: '给 A。', visibility: 'player_private', knownBy: [aCtx.playerId as string] });
    const turns = new TurnService(db, new OutboxRepository(db));
    const turn = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, turn.id, { body: '我搜索房间。' });
    await turns.submitAction(bCtx, turn.id, { body: '我警戒门口。' });

    const builder = new AiContextBuilder(db);
    const pkg = await builder.buildForTurn(created.campaign.id, turn.id, db);
    expect(pkg.prompt.campaignId).toBe(created.campaign.id);
    const userText = JSON.stringify(pkg.prompt.messages.map((m) => m.content).join('\n'));
    expect(userText).toContain('搜索房间');
    expect(userText).toContain('薇拉');
    expect(userText).toContain('酒馆');
    // 不含敏感字段与原始 DB 列名。
    expect(userText).not.toContain('password_hash');
    expect(userText).not.toContain('invite_code_hash');
    expect(userText).not.toContain('_json');
    expect(userText).not.toContain('known_by_json');
    await db.close();
  });
});
```

`server/src/modules/ai-runtime/turn-resolution-validator.test.ts`（校验失败 → `AI_OUTPUT_INVALID`；target 必须是当前 player 成员）：

```ts
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { TurnResolutionValidator } from './TurnResolutionValidator.js';

async function makeDb() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const a = await identity.register({ login: 'a@example.test', password: 'correct-password' });
  const ghost = await identity.register({ login: 'ghost@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '矿坑', ruleset: 'dnd5e' });
  await campaigns.join({ userId: a.userId }, created.campaign.id, created.inviteCode);
  return { db, campaignId: created.campaign.id, playerA: a.userId, ghostId: ghost.userId };
}

describe('turn resolution validator', () => {
  it('parses a valid resolution and checks member targets', async () => {
    const { db, campaignId, playerA } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    const result = await validator.validate(campaignId, {
      publicNarrative: '雨停了。',
      privateUpdates: [{ playerId: playerA, content: '你发现了暗门。' }],
      diceResults: [{ id: 'd1', formula: '1d20', total: 7, visibility: 'public', targetPlayerId: null }],
      stateChanges: [],
      interactionRequests: [{ id: 'i1', targetPlayerId: playerA, prompt: '回答？' }],
    });
    expect(result.privateUpdates[0].playerId).toBe(playerA);
    await db.close();
  });

  it('rejects a private update targeting a non-member', async () => {
    const { db, campaignId, ghostId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, {
      publicNarrative: 'x', stateChanges: [], diceResults: [], interactionRequests: [],
      privateUpdates: [{ playerId: ghostId, content: '给幽灵' }],
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('rejects an empty publicNarrative as invalid output (independent of combat gate)', async () => {
    const { db, campaignId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, {
      publicNarrative: '', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [],
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('rejects an interaction targeting a non-member', async () => {
    const { db, campaignId, ghostId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, {
      publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [],
      interactionRequests: [{ id: 'i1', targetPlayerId: ghostId, prompt: 'x' }],
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('rejects malformed output with AI_OUTPUT_INVALID', async () => {
    const { db, campaignId } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, { bad: true } as never)).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('rejects duplicate dice result ids before touching the database', async () => {
    const { db, campaignId, playerA } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, {
      publicNarrative: 'x', privateUpdates: [], stateChanges: [],
      diceResults: [
        { id: 'd1', formula: '1d20', total: 7, visibility: 'public', targetPlayerId: null },
        { id: 'd1', formula: '1d20', total: 9, visibility: 'public', targetPlayerId: null },
      ],
      interactionRequests: [{ id: 'i1', targetPlayerId: playerA, prompt: 'x' }],
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('rejects duplicate interaction request ids before touching the database', async () => {
    const { db, campaignId, playerA } = await makeDb();
    const validator = new TurnResolutionValidator(db);
    await expect(validator.validate(campaignId, {
      publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [],
      interactionRequests: [
        { id: 'i1', targetPlayerId: playerA, prompt: 'x' },
        { id: 'i1', targetPlayerId: playerA, prompt: 'y' },
      ],
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });
});
```

`server/src/modules/ai-runtime/state-change-materializer.test.ts`（白名单 + 归属 + derived/audit + world knownBy + combat 门禁）：

```ts
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { WorldFactService } from '../world/WorldFactService.js';
import { StateChangeMaterializer } from './StateChangeMaterializer.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const characters = new CharacterService(db);
  const worldFacts = new WorldFactService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const a = await identity.register({ login: 'a@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '矿坑', ruleset: 'dnd5e' });
  await campaigns.join({ userId: a.userId }, created.campaign.id, created.inviteCode);
  const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const draft = await characters.createDraft(aCtx, { name: '薇拉', sheet: { ac: 14, hpCurrent: 10 } });
  await characters.submitForReview(aCtx, draft.id);
  const approved = await characters.approve(ownerCtx, draft.id);
  const fact = await worldFacts.create(ownerCtx, { title: '任务', kind: 'quest', content: '找钥匙。', visibility: 'public' });
  return { db, ownerCtx, aCtx, approved, fact };
}

describe('state change materializer', () => {
  it('applies a whitelisted character patch and recomputes derived with an audit', async () => {
    const { db, ownerCtx, approved } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await db.transaction((tx) => m.applyAll(tx, approved.campaignId, [
      { kind: 'character', targetId: approved.id, patch: { sheet: { hpCurrent: 7 } }, visibility: 'public' },
    ], ownerCtx.userId));
    const row = await db.query<{ sheet_json: string; derived_json: string }>(
      'SELECT sheet_json, derived_json FROM platform_characters WHERE id = ?', [approved.id],
    );
    expect(JSON.parse(row[0].sheet_json)).toMatchObject({ ac: 14, hpCurrent: 7 });
    expect(JSON.parse(row[0].derived_json)).toMatchObject({ ac: { value: 14 } });
    const audits = await db.query<{ action: string }>(
      'SELECT action FROM platform_character_audits WHERE character_id = ? ORDER BY created_at', [approved.id],
    );
    expect(audits.map((r) => r.action)).toContain('state_change');
    await db.close();
  });

  it('rejects a character patch with an unknown sheet key', async () => {
    const { db, ownerCtx, approved } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await expect(db.transaction((tx) => m.applyAll(tx, approved.campaignId, [
      { kind: 'character', targetId: approved.id, patch: { sheet: { admin: true } }, visibility: 'public' },
    ], ownerCtx.userId))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('applies a world patch and rejects a player_private knownBy that is not a member', async () => {
    const { db, fact, ownerCtx } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await db.transaction((tx) => m.applyAll(tx, fact.campaignId, [
      { kind: 'world', targetId: fact.id, patch: { content: '钥匙在井里。', visibility: 'public' }, visibility: 'public' },
    ], ownerCtx.userId));
    await expect(db.transaction((tx) => m.applyAll(tx, fact.campaignId, [
      { kind: 'world', targetId: fact.id, patch: { visibility: 'player_private', knownBy: ['ghost'] }, visibility: 'player_private' },
    ], ownerCtx.userId))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('gates combat state changes with STATE_CONFLICT and writes nothing', async () => {
    const { db, ownerCtx, approved } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await expect(db.transaction((tx) => m.applyAll(tx, approved.campaignId, [
      { kind: 'combat', targetId: 'enc-1', patch: { hpCurrent: 1 }, visibility: 'public' },
    ], ownerCtx.userId))).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    const entries = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_turn_entries', [],
    );
    expect(Number(entries[0].count)).toBe(0);
    await db.close();
  });

  it('rejects an unknown state change kind with AI_OUTPUT_INVALID and writes nothing', async () => {
    const { db, ownerCtx, approved } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await expect(db.transaction((tx) => m.applyAll(tx, approved.campaignId, [
      { kind: 'banana', targetId: 'x', patch: {}, visibility: 'public' },
    ] as never, ownerCtx.userId))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });
});
```

`server/src/modules/ai-runtime/turn-entries-projection.test.ts`（投影复用 `VisibilityPolicy`）：

```ts
import { describe, expect, it } from 'vitest';
import type { TurnEntryRow } from './TurnEntryRepository.js';
import { projectEntries } from './TurnEntryRepository.js';

describe('turn entries projection', () => {
  const entries: TurnEntryRow[] = [
    { id: 'e1', ai_run_id: 'r1', campaign_id: 'c1', turn_id: 't1', entry_kind: 'narrative', entry_index: 0, visibility: 'public', target_player_id: null, payload_json: '{"text":"公开"}', created_at: 'now', superseded_at: null, superseded_by_archive_id: null },
    { id: 'e2', ai_run_id: 'r1', campaign_id: 'c1', turn_id: 't1', entry_kind: 'private_update', entry_index: 1, visibility: 'player_private', target_player_id: 'p1', payload_json: '{"text":"给 A"}', created_at: 'now', superseded_at: null, superseded_by_archive_id: null },
    { id: 'e3', ai_run_id: 'r1', campaign_id: 'c1', turn_id: 't1', entry_kind: 'private_update', entry_index: 2, visibility: 'player_private', target_player_id: 'p2', payload_json: '{"text":"给 B"}', created_at: 'now', superseded_at: null, superseded_by_archive_id: null },
    { id: 'e4', ai_run_id: 'r1', campaign_id: 'c1', turn_id: 't1', entry_kind: 'narrative', entry_index: 3, visibility: 'owner_only', target_player_id: null, payload_json: '{"text":"DM 备注"}', created_at: 'now', superseded_at: null, superseded_by_archive_id: null },
  ];

  it('owner sees all entries; player sees public + own private only', () => {
    expect(projectEntries({ role: 'owner', playerId: null }, entries).map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(projectEntries({ role: 'player', playerId: 'p1' }, entries).map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(projectEntries({ role: 'player', playerId: 'p2' }, entries).map((e) => e.id)).toEqual(['e1', 'e3']);
  });

  it('never leaks owner_only to any player', () => {
    const projected = projectEntries({ role: 'player', playerId: 'p1' }, entries);
    expect(JSON.stringify(projected)).not.toContain('DM 备注');
  });
});
```

### Step 2：运行确认失败

```bash
rtk npm test -- --run packages/contracts/src/contracts.test.ts server/src/modules/ai-runtime/ai-context-builder.test.ts server/src/modules/ai-runtime/turn-resolution-validator.test.ts server/src/modules/ai-runtime/state-change-materializer.test.ts server/src/modules/ai-runtime/turn-entries-projection.test.ts
```

预期：失败——`diceResultSchema` 尚未补 `targetPlayerId`（既有 `contracts.test.ts` 通过是因为 schema 还没变；本任务改造后新旧断言都会在 Step 4 全绿，但 Step 2 先因 `AiContextBuilder`/`TurnResolutionValidator`/`StateChangeMaterializer`/`projectEntries` 不存在而 import 失败）。`contracts.test.ts` 在 `diceResultSchema` 改造前仍绿，改造后需随 Step 3 一起变。

### Step 3：实现

`server/src/modules/ai-runtime/AiContextBuilder.ts`（claim tx 内用传入 executor 读取；输出 `AiPrompt` 与结构化 `context`；**不含 password_hash/invite_code_hash/audit/raw DB 名**）：

```ts
import type { AiPrompt } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';
import { TurnRepository } from '../turns/TurnRepository.js';
import { WorldFactRepository } from '../world/WorldFactRepository.js';

export interface AiContextPackage {
  prompt: AiPrompt;
  /** 结构化 owner-safe context，由 claim 写入 context_json（与 prompt 一起）供 owner 调试；不含敏感字段。 */
  context: Record<string, unknown>;
}

export class AiContextBuilder {
  constructor(private readonly executor: QueryExecutor) {}

  /** claim tx 内调用时传入 tx，保证 context 快照与行锁同一事务（Postgres 必须用 tx，不能用外层池连接）。 */
  async buildForTurn(campaignId: string, turnId: string, executor: QueryExecutor = this.executor): Promise<AiContextPackage> {
    const campaign = (await executor.query<{ id: string; name: string; ruleset: string; status: string }>(
      'SELECT id, name, ruleset, status FROM campaigns WHERE id = ?', [campaignId],
    ))[0];
    const turns = new TurnRepository(executor);
    const characters = new CharacterRepository(executor);
    const facts = new WorldFactRepository(executor);

    const turn = (await turns.findTurnById(turnId))!;
    const actions = await turns.listActionsByTurn(turnId);
    const approved = (await characters.listByCampaign(campaignId))
      .filter((row) => row.status === 'approved')
      .map((row) => ({
        id: row.id, playerId: row.player_id, name: row.name,
        sheet: JSON.parse(row.sheet_json) as Record<string, unknown>,
        derived: JSON.parse(row.derived_json) as Record<string, unknown>,
      }));
    const activeFacts = (await facts.listByCampaign(campaignId)).map((row) => ({
      id: row.id, title: row.title, kind: row.kind, content: row.content,
      visibility: row.visibility, knownBy: JSON.parse(row.known_by_json) as string[],
    }));

    const context = {
      campaignId,
      ruleset: campaign.ruleset,
      campaignStatus: campaign.status,
      turn: { id: turn.id, number: turn.number, status: turn.status },
      actions: actions.map((a) => ({ playerId: a.player_id, body: a.body })),
      characters: approved,
      worldFacts: activeFacts,
    };

    const userContent = [
      `战役：${campaign.name}（规则集 ${campaign.ruleset}）`,
      `当前回合 #${turn.number}，已锁定。玩家行动：`,
      ...actions.map((a) => `- ${a.player_id}: ${a.body}`),
      // 人读文本里的 playerId 用于叙事可读性，不是 provider 取 id 的来源；
      // provider/测试脚本一律读结构化 prompt.characters（见 Task 2 决策，杜绝文本解析脆弱性）。
      '已批准角色状态：',
      ...approved.map((c) => `- ${c.name} (${c.playerId}): ${JSON.stringify(c.sheet)}`),
      '活跃世界事实：',
      ...activeFacts.map((f) => `- [${f.visibility}] ${f.title}: ${f.content}`),
      '请输出结构化结算（publicNarrative / privateUpdates / diceResults / stateChanges / interactionRequests）。',
    ].join('\n');

    const prompt: AiPrompt = {
      campaignId,
      audience: 'owner',
      // 结构化成员表（id/playerId/name）：provider 与测试脚本直接读 prompt.characters，不解析人类 prompt 字符串。
      characters: approved.map((c) => ({ id: c.id, playerId: c.playerId, name: c.name })),
      system: '你是 DND AI 地城主持人。只消费给定上下文，不得自行补写未提供的玩家行动或角色状态。privateUpdates 的 key 与 diceResults 的 targetPlayerId 必须使用上面"已批准角色状态"中括号内的真实 playerId。',
      messages: [{ role: 'system', content: '你是 DND AI 地城主持人。只消费给定上下文，不得自行补写未提供的玩家行动或角色状态。privateUpdates 的 key 与 diceResults 的 targetPlayerId 必须使用上面"已批准角色状态"中括号内的真实 playerId。' }, { role: 'user', content: userContent }],
    };
    return { prompt, context };
  }
}
```

`server/src/modules/ai-runtime/TurnResolutionValidator.ts`（parse + 成员校验 + 归属校验；失败 → `AI_OUTPUT_INVALID`）：

```ts
import type { TurnResolution } from '@dnd/contracts';
import { turnResolutionSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { WorldFactRepository } from '../world/WorldFactRepository.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';

export class TurnResolutionValidator {
  constructor(private readonly executor: QueryExecutor) {}

  async validate(campaignId: string, output: unknown): Promise<TurnResolution> {
    const parsed = turnResolutionSchema.safeParse(output);
    if (!parsed.success) {
      throw new AppError('AI_OUTPUT_INVALID', 'AI 输出不符合结构化结算契约。');
    }
    const resolution = parsed.data;
    const memberIds = new Set(
      (await this.executor.query<{ user_id: string }>(
        "SELECT user_id FROM campaign_members WHERE campaign_id = ? AND role = 'player'", [campaignId],
      )).map((row) => row.user_id),
    );
    // 在 SQL 之前拒绝重复 id：diceResults / interactionRequests 的 id 必须是唯一条目身份，
    // 重复会让条目身份不唯一，映射 AI_OUTPUT_INVALID，绝不能把 DB 唯一约束错误误报为 AI_PROVIDER_FAILED。
    const diceIds = resolution.diceResults.map((d) => d.id);
    if (new Set(diceIds).size !== diceIds.length) {
      throw new AppError('AI_OUTPUT_INVALID', 'diceResults 存在重复 id。');
    }
    const interactionIds = resolution.interactionRequests.map((i) => i.id);
    if (new Set(interactionIds).size !== interactionIds.length) {
      throw new AppError('AI_OUTPUT_INVALID', 'interactionRequests 存在重复 id。');
    }
    for (const update of resolution.privateUpdates) {
      if (!memberIds.has(update.playerId)) {
        throw new AppError('AI_OUTPUT_INVALID', `privateUpdates 目标玩家不是该战役成员：${update.playerId}`);
      }
    }
    for (const dice of resolution.diceResults) {
      if (dice.visibility === 'player_private' && dice.targetPlayerId && !memberIds.has(dice.targetPlayerId)) {
        throw new AppError('AI_OUTPUT_INVALID', `diceResults 目标玩家不是该战役成员：${dice.targetPlayerId}`);
      }
    }
    for (const interaction of resolution.interactionRequests) {
      if (!memberIds.has(interaction.targetPlayerId)) {
        throw new AppError('AI_OUTPUT_INVALID', `interactionRequests 目标玩家不是该战役成员：${interaction.targetPlayerId}`);
      }
    }
    await this.validateStateChangeTargets(campaignId, resolution);
    return resolution;
  }

  private async validateStateChangeTargets(campaignId: string, resolution: TurnResolution): Promise<void> {
    const characters = new CharacterRepository(this.executor);
    const facts = new WorldFactRepository(this.executor);
    for (const change of resolution.stateChanges) {
      if (change.kind === 'character') {
        const row = await characters.findById(change.targetId);
        if (!row || row.campaign_id !== campaignId) {
          throw new AppError('AI_OUTPUT_INVALID', `stateChanges.character 目标不属于该战役：${change.targetId}`);
        }
      } else if (change.kind === 'world' || change.kind === 'quest') {
        const row = await facts.findById(change.targetId);
        if (!row || row.campaign_id !== campaignId) {
          throw new AppError('AI_OUTPUT_INVALID', `stateChanges.${change.kind} 目标不属于该战役：${change.targetId}`);
        }
        if (change.kind === 'quest' && row.kind !== 'quest') {
          throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.quest 目标不是 quest 世界事实。');
        }
      }
      // kind=combat：target 归属不在本任务校验，由 materializer 在应用时抛 STATE_CONFLICT。
    }
  }
}
```

`server/src/modules/ai-runtime/StateChangeMaterializer.ts`（白名单 patch schema + 归属 + derived/audit + world knownBy + combat 门禁；`nanoid` 用于 audit id）：

```ts
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { StateChange } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import { CharacterRepository, type CharacterRow } from '../characters/CharacterRepository.js';
import { WorldFactRepository } from '../world/WorldFactRepository.js';
import { computeDerived } from '../characters/CharacterService.js';

/** 角色 sheet 白名单：只允许这些叶子键，禁止任意 JSON patch。 */
const sheetPatchSchema = z.object({
  hpCurrent: z.number().int().optional(),
  hpMax: z.number().int().optional(),
  ac: z.number().int().optional(),
  gold: z.number().int().optional(),
  level: z.number().int().optional(),
  experience: z.number().int().optional(),
  conditions: z.array(z.string()).optional(),
  inventory: z.array(z.string()).optional(),
}).strict();

const characterPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  sheet: sheetPatchSchema.optional(),
}).strict();

const worldFactPatchSchema = z.object({
  title: z.string().trim().min(1).optional(),
  content: z.string().optional(),
  visibility: z.enum(['public', 'player_private', 'owner_only']).optional(),
  knownBy: z.array(z.string().min(1)).optional(),
}).strict();

export class StateChangeMaterializer {
  constructor(private readonly executor: QueryExecutor) {}

  async applyAll(tx: QueryExecutor, campaignId: string, stateChanges: StateChange[], actorUserId: string): Promise<void> {
    // 未知 kind 在写任何正式状态之前以 AI_OUTPUT_INVALID 拒绝（与 member/duplicate 校验同一原则：
    // 绝不把非法输出拖到 DB 层）；combat 走能力门禁 STATE_CONFLICT。
    for (const change of stateChanges) {
      if (change.kind !== 'character' && change.kind !== 'world' && change.kind !== 'quest' && change.kind !== 'combat') {
        throw new AppError('AI_OUTPUT_INVALID', '未知 stateChange kind。');
      }
    }
    for (const change of stateChanges) {
      switch (change.kind) {
        case 'combat':
          throw new AppError('STATE_CONFLICT', '结构化战斗尚未启用（Phase 3 提供）。');
        case 'character':
          await this.applyCharacter(tx, campaignId, change, actorUserId);
          break;
        case 'world':
        case 'quest':
          await this.applyWorldFact(tx, campaignId, change);
          break;
        default:
          throw new AppError('AI_OUTPUT_INVALID', '未知 stateChange kind。');
      }
    }
  }

  private async applyCharacter(tx: QueryExecutor, campaignId: string, change: StateChange, actorUserId: string): Promise<void> {
    const patch = characterPatchSchema.safeParse(change.patch);
    if (!patch.success) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.character patch 不在白名单内。');
    }
    const characters = new CharacterRepository(tx);
    const existing = await characters.findById(change.targetId);
    if (!existing || existing.campaign_id !== campaignId) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.character 目标不属于该战役。');
    }
    const sheet = { ...(JSON.parse(existing.sheet_json) as Record<string, unknown>), ...patch.data.sheet };
    const derived = computeDerived(sheet);
    const updated: CharacterRow = {
      ...existing, name: patch.data.name ?? existing.name, sheet_json: JSON.stringify(sheet),
      derived_json: JSON.stringify(derived), updated_at: new Date().toISOString(),
    };
    await characters.updateContent(updated, existing.status);
    await characters.insertAudit({
      id: nanoid(24), character_id: existing.id, campaign_id: campaignId,
      actor_user_id: actorUserId, action: 'state_change',
      before_json: JSON.stringify(existing), after_json: JSON.stringify(updated),
      created_at: updated.updated_at,
    });
  }

  private async applyWorldFact(tx: QueryExecutor, campaignId: string, change: StateChange): Promise<void> {
    const patch = worldFactPatchSchema.safeParse(change.patch);
    if (!patch.success) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.world patch 不在白名单内。');
    }
    const facts = new WorldFactRepository(tx);
    const existing = await facts.findById(change.targetId);
    if (!existing || existing.campaign_id !== campaignId) {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.world 目标不属于该战役。');
    }
    if (change.kind === 'quest' && existing.kind !== 'quest') {
      throw new AppError('AI_OUTPUT_INVALID', 'stateChanges.quest 目标不是 quest 世界事实。');
    }
    const visibility = patch.data.visibility ?? existing.visibility;
    const knownByRaw = patch.data.knownBy ?? (existing.known_by_json ? (JSON.parse(existing.known_by_json) as string[]) : []);
    const knownBy = await this.validateKnownBy(tx, campaignId, visibility, knownByRaw);
    const ok = await facts.updateContent(existing.id, campaignId, {
      title: patch.data.title ?? existing.title, kind: existing.kind,
      content: patch.data.content ?? existing.content, visibility,
      known_by_json: JSON.stringify(knownBy), updated_at: new Date().toISOString(),
    });
    if (!ok) throw new AppError('NOT_FOUND', '世界事实不存在。');
  }

  private async validateKnownBy(tx: QueryExecutor, campaignId: string, visibility: string, knownBy: string[]): Promise<string[]> {
    if (visibility !== 'player_private') return [];
    if (knownBy.length === 0) throw new AppError('AI_OUTPUT_INVALID', 'player_private 世界事实必须指定可见玩家。');
    const members = new Set((await new WorldFactRepository(tx).listPlayerMemberIds(campaignId)));
    for (const playerId of knownBy) {
      if (!members.has(playerId)) throw new AppError('AI_OUTPUT_INVALID', '世界事实 knownBy 不是该战役玩家成员。');
    }
    return [...new Set(knownBy)];
  }
}
```

`server/src/modules/ai-runtime/TurnEntryRepository.ts` 追加投影函数（复用 `VisibilityPolicy.canRead`）：

```ts
import { canRead, type VisibilitySubject } from '../visibility/VisibilityPolicy.js';

/** Turn entries 唯一投影：owner 全量；player 只见 public + 自己的 player_private；owner_only 不泄漏。 */
export function projectEntries(subject: VisibilitySubject, rows: TurnEntryRow[]): TurnEntryRow[] {
  return rows.filter((row) => {
    if (subject.role === 'owner') return true;
    return canRead(subject, row.visibility, row.target_player_id ? [row.target_player_id] : []);
  });
}
```

### Step 4：运行确认通过

```bash
rtk npm test -- --run packages/contracts/src/contracts.test.ts server/src/modules/ai-runtime/ai-context-builder.test.ts server/src/modules/ai-runtime/turn-resolution-validator.test.ts server/src/modules/ai-runtime/state-change-materializer.test.ts server/src/modules/ai-runtime/turn-entries-projection.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：`contracts.test.ts`（含改造后的 `targetPlayerId`、空 publicNarrative 拒绝）、context builder（不含敏感字段/原始 DB 列名；`prompt.characters` 结构化成员表，provider 不解析人类 prompt）、validator（成员/归属校验 `AI_OUTPUT_INVALID`、重复 dice/interaction id 在 SQL 前拒绝 `AI_OUTPUT_INVALID`）、materializer（白名单 + derived/audit + world knownBy + combat `STATE_CONFLICT` 无正式写）、entries 投影（owner 全量 / player public+own private / owner_only 不泄漏）全绿；typecheck/build 通过。

### Step 5：提交

```bash
rtk git add packages/contracts/src/turn.ts packages/contracts/src/contracts.test.ts server/src/modules/ai-runtime/AiContextBuilder.ts server/src/modules/ai-runtime/TurnResolutionValidator.ts server/src/modules/ai-runtime/StateChangeMaterializer.ts server/src/modules/ai-runtime/TurnEntryRepository.ts server/src/modules/ai-runtime/ai-context-builder.test.ts server/src/modules/ai-runtime/turn-resolution-validator.test.ts server/src/modules/ai-runtime/state-change-materializer.test.ts server/src/modules/ai-runtime/turn-entries-projection.test.ts
rtk git commit -m "feat: add ai context, output validation, projection and whitelist materializers" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5：`AiResolutionService`（claim / preview / success / fail / idempotency / retry / 自动存档 / 下一回合）

**依赖：** Task 2（`AiProviderPort`/`UnavailableAiProvider`/`ScriptedAiProvider`/`AiRunRepository`/`TurnEntryRepository`）、Task 3（`ArchiveService.createAutomatic`/`captureSnapshot`）、Task 4（`AiContextBuilder`/`TurnResolutionValidator`/`StateChangeMaterializer`）。Phase 2A 的 `TurnRepository`（本任务追加 `markResolving`/`markCompleted`）。

**目标：** 短事务 lifecycle 的 `AiResolutionService.resolveTurn(ownerCtx, turnId, { idempotencyKey }): Promise<{ created, run }>`（`created` 供路由区分 201/200）：claim tx（campaign/turn 行锁、幂等查重**优先于**状态校验、校验 `locked`/`needs_owner_attention`、attempt 单调分配、context 快照、run=running、turn=resolving、`preview.started`）→ provider 在 tx 外运行（每个 delta 独立短 tx publish `preview.delta`）→ 成功 formal apply tx（顺序见执行前约束 #5）或失败 fail tx（run failed + turn=needs_owner_attention + `preview.failed`，无正式写）。**claim 内部返回值是 discriminated union `{ kind:'replay'; run } | { kind:'claimed'; run; prompt }`：`replay` 分支（同 key 同 turn 的既有 run，含 succeeded/completed 之后的 replay）不持有 prompt，`resolveTurn` 按 `kind` 分支后绝不触碰 provider/不写 entries/archive/events；只有 `claimed` 分支持有 context 快照供 provider 消费。**failed retry 必须新 key。**绝不嵌套调用 `TurnService.transaction`**。

### Files

- Create: `server/src/modules/ai-runtime/AiResolutionService.ts`
- Create: `server/src/modules/ai-runtime/ai-resolution.test.ts`
- Modify: `server/src/modules/turns/TurnRepository.ts`（`markResolving`/`markCompleted`）
- Modify: `server/src/modules/archives/ArchiveService.ts`（`createAutomatic` 已就绪，本任务仅确认签名）
- Modify: `server/src/platform/database/postgres-archives-ai.test.ts`（扩展 AI claim/idempotency 门控用例）

### Step 1：写失败测试

`server/src/modules/ai-runtime/ai-resolution.test.ts`（fixture 建 campaign + 角色 + 锁定回合 + scripted provider + 服务）：

```ts
import { describe, expect, it, vi } from 'vitest';
import type { CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { CampaignEvent } from '@dnd/contracts';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { TurnService } from '../turns/TurnService.js';
import { ArchiveService } from '../archives/ArchiveService.js';
import { AiContextBuilder } from './AiContextBuilder.js';
import { TurnResolutionValidator } from './TurnResolutionValidator.js';
import { StateChangeMaterializer } from './StateChangeMaterializer.js';
import { ScriptedAiProvider, scriptedResolution, approvedPlayerIds } from './ScriptedAiProvider.js';
import { AiResolutionService } from './AiResolutionService.js';
import type { AiProviderPort } from './AiProviderPort.js';

async function makeFixture(provider: AiProviderPort, options: { lockTurn?: boolean } = {}) {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const characters = new CharacterService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const a = await identity.register({ login: 'a@example.test', password: 'correct-password' });
  const b = await identity.register({ login: 'b@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  for (const user of [a, b]) await campaigns.join({ userId: user.userId }, created.campaign.id, created.inviteCode);
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
  const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
  const approve = async (ctx: CampaignAuthContext, name: string) => {
    const draft = await characters.createDraft(ctx, { name, sheet: { ac: 14 } });
    await characters.submitForReview(ctx, draft.id);
    await characters.approve(ownerCtx, draft.id);
  };
  await approve(aCtx, '薇拉');
  await approve(bCtx, '卡恩');
  const outbox = new OutboxRepository(db);
  const turns = new TurnService(db, outbox);
  const turn = await turns.startTurn(ownerCtx);
  if (options.lockTurn !== false) {
    await turns.submitAction(aCtx, turn.id, { body: '我搜索房间。' });
    await turns.submitAction(bCtx, turn.id, { body: '我警戒门口。' });
  }
  const archives = new ArchiveService(db, outbox);
  const service = new AiResolutionService(
    db, provider, outbox, archives,
    new AiContextBuilder(db), new TurnResolutionValidator(db), new StateChangeMaterializer(db),
  );
  return { db, service, ownerCtx, aCtx, bCtx, turn };
}

const validResolution = (playerA: string, playerB: string) => ({
  publicNarrative: '雨停了，队伍继续前进。',
  privateUpdates: [
    { playerId: playerA, content: '你发现墙上有暗门。' },
    { playerId: playerB, content: '你听见远处有脚步声。' },
  ],
  diceResults: [
    { id: 'd1', formula: '1d20+2', total: 17, visibility: 'public', targetPlayerId: null },
    { id: 'd2', formula: '1d20', total: 5, visibility: 'player_private', targetPlayerId: playerA },
  ],
  stateChanges: [],
  interactionRequests: [],
});

describe('ai resolution service', () => {
  it('claims, runs the provider, applies formal state and auto-archives', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      // 脚本经 approvedPlayerIds 从真实 prompt 解析成员 id，避免在 makeFixture 前引用 aCtx/bCtx（TDZ）。
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb), ['雨停了…'])(input, hooks);
      }),
    );
    const result = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'k1' });
    expect(result.created).toBe(true);
    const run = result.run;
    expect(run.status).toBe('succeeded');
    expect(run.attempt).toBe(1);
    const turnRow = await db.query<{ status: string; completed_at: string | null }>(
      'SELECT status, completed_at FROM platform_turns WHERE id = ?', [turn.id],
    );
    expect(turnRow[0].status).toBe('completed');
    expect(turnRow[0].completed_at).not.toBeNull();
    const entries = await db.query<{ entry_kind: string; visibility: string; target_player_id: string | null }>(
      'SELECT entry_kind, visibility, target_player_id FROM platform_turn_entries WHERE turn_id = ? ORDER BY entry_index', [turn.id],
    );
    expect(entries.map((e) => e.entry_kind)).toEqual(['narrative', 'private_update', 'private_update', 'dice_result', 'dice_result']);
    const archives = await db.query<{ kind: string; label: string | null }>(
      'SELECT kind, label FROM platform_archives WHERE campaign_id = ?', [turn.campaignId],
    );
    expect(archives).toEqual([{ kind: 'automatic', label: null }]);
    // 下一回合已创建（waiting），number=2。
    const next = await db.query<{ number: number; status: string }>(
      'SELECT number, status FROM platform_turns WHERE campaign_id = ? AND number = 2', [turn.campaignId],
    );
    expect(next).toEqual([{ number: 2, status: 'waiting_for_actions' }]);
    // outbox 事件：preview.started → deltas → turn.resolved（无 owner.debug emit）。
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence', [turn.campaignId],
    );
    expect(events.map((e) => e.event_type)).toContain('ai.preview.started');
    expect(events.map((e) => e.event_type)).toContain('ai.preview.delta');
    expect(events.map((e) => e.event_type)).toContain('turn.resolved');
    expect(events.map((e) => e.event_type)).not.toContain('owner.debug');
    await db.close();
  });

  it('is idempotent for the same key and does not call the provider again', async () => {
    let calls = 0;
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        calls += 1;
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }),
    );
    const first = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'same' });
    const second = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'same' });
    expect(calls).toBe(1);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.status).toBe('succeeded');
    // 同 key 不重写 entries/archive/events。
    const runs = await db.query<{ id: string }>('SELECT id FROM platform_ai_runs WHERE turn_id = ?', [turn.id]);
    expect(runs).toHaveLength(1);
    const entries = await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id]);
    expect(entries).toHaveLength(5);
    const archives = await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId]);
    expect(archives).toHaveLength(1);
    await db.close();
  });

  it('same-key resolve while a run is running returns the running run and stays deterministic', async () => {
    // 固定 API 语义（见执行前约束）：同 key 命中 running run 时立即返回 { created:false, status:'running' }，
    // 不等待、不重复调 provider；客户端可 GET run 轮询。测试用 gate 阻塞首个 provider claim 之后、
    // 其 formal apply 之前，确定性地验证第二次 resolve 的返回与状态。
    let calls = 0;
    let releaseProvider: (() => void) | null = null;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        calls += 1;
        await providerGate; // 第一次 provider 调用在此阻塞，直到测试放行
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }),
    );
    // 第一次 resolve 启动（claim 已提交：run=running、turn=resolving），provider 阻塞在 gate。
    // 注：SQLite 按 adapter 串行化异步事务，claim 先 commit 后 provider 才启动，因此 second resolve
    // 到达时 run 已持久化为 running（turn=resolving），幂等查重稳定命中。
    const firstPromise = service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'gate-same' });
    // 等待首个 provider 调用真正进入（calls === 1）后再发起第二个同 key resolve。
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'gate-same' });
    // 第二个同 key resolve 立即返回既有 running run（created=false），不等待、不重复调 provider。
    expect(second.created).toBe(false);
    expect(second.run.status).toBe('running');
    expect(second.run.id).toBeDefined();
    expect(calls).toBe(1); // provider 仍只被调用一次
    // 放行 provider → 第一个 resolve 完成 formal apply → succeeded。
    releaseProvider!();
    const first = await firstPromise;
    expect(first.created).toBe(true);
    expect(first.run.status).toBe('succeeded');
    expect(first.run.id).toBe(second.run.id);
    // 第三次同 key resolve = 完成后 replay，返回同一 succeeded run。
    const replay = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'gate-same' });
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.run.id);
    expect(replay.run.status).toBe('succeeded');
    // 始终只有一组 runs/entries/archive/events。
    expect((await db.query('SELECT id FROM platform_ai_runs WHERE turn_id = ?', [turn.id])).length).toBe(1);
    expect((await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id])).length).toBe(5);
    expect((await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId])).length).toBe(1);
    await db.close();
  });

  it('serializes concurrent different-key resolves: one claim wins, the other gets STATE_CONFLICT, attempts distinct', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }),
    );
    const results = await Promise.allSettled([
      service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'conc-a' }),
      service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'conc-b' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1); // 恰一个 claim 成功
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { code?: string }).code).toBe('STATE_CONFLICT'); // 后到者撞 resolving
    const runs = await db.query<{ attempt: number }>('SELECT attempt FROM platform_ai_runs WHERE turn_id = ?', [turn.id]);
    expect(runs).toHaveLength(1);
    expect(runs[0].attempt).toBe(1); // attempt 无重复、无跳号
    await db.close();
  });

  it('marks an internal formal-apply failure as INTERNAL_ERROR with no partial writes and consistent state', async () => {
    // formal apply 内 throw 非 AppError 的 DB/未知错误（materializer 或 insert 层）：
    // 必须 INTERNAL_ERROR（绝不当 AI_PROVIDER_FAILED 误报），turn=needs_owner_attention，
    // run 置 failed，且无任何半截正式写（entries/archive/next turn/turn.resolved 全无）。
    // 用依赖注入模拟 materializer：applyAll 抛 raw Error（非 AppError），provider 本身正常。
    const { db, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }),
    );
    const failing = new AiResolutionService(
      db,
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }),
      new OutboxRepository(db),
      new ArchiveService(db, new OutboxRepository(db)),
      new AiContextBuilder(db),
      new TurnResolutionValidator(db),
      new (class extends StateChangeMaterializer {
        override async applyAll(): Promise<void> {
          throw new Error('boom apply');
        }
      })(db),
    );
    await expect(failing.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'internal-2' })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    const runRow = await db.query<{ id: string; status: string; error_code: string | null }>(
      'SELECT id, status, error_code FROM platform_ai_runs WHERE turn_id = ?', [turn.id],
    );
    expect(runRow).toHaveLength(1);
    expect(runRow[0].status).toBe('failed');
    expect(runRow[0].error_code).toBe('INTERNAL_ERROR');
    // 落库脱敏文案也按 code 区分：INTERNAL_ERROR 不得出现 provider 专属文案（与 fail() 的
    // code-aware 脱敏一致），证明阶段分类在持久化层同样成立、绝不在落库层误报 provider 失败。
    const failedJson = await db.query<{ error_json: string | null }>('SELECT error_json FROM platform_ai_runs WHERE id = ?', [runRow[0].id]);
    expect(JSON.stringify(failedJson[0].error_json)).toContain('AI 结算内部错误，详情已脱敏。');
    expect(JSON.stringify(failedJson[0].error_json)).not.toContain('AI Provider 调用失败');
    const turnRow = await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]);
    expect(turnRow[0].status).toBe('needs_owner_attention');
    // 无半截正式写：无 entries、无 archive、无新回合、无 turn.resolved。
    const entries = await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id]);
    expect(entries).toHaveLength(0);
    const archives = await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId]);
    expect(archives).toHaveLength(0);
    const turnCount = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_turns WHERE campaign_id = ?', [turn.campaignId],
    );
    expect(Number(turnCount[0].count)).toBe(1); // 只有 t1，无下一回合
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM platform_outbox_events WHERE campaign_id = ?', [turn.campaignId],
    );
    expect(events.map((e) => e.event_type)).toContain('ai.preview.failed');
    expect(events.map((e) => e.event_type)).not.toContain('turn.resolved');
    await db.close();
  });

  it('fails provider errors into needs_owner_attention with AI_PROVIDER_FAILED and no partial writes', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async () => { throw new Error('provider down'); }),
    );
    await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'fail1' })).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
    const run = await db.query<{ status: string; error_code: string | null }>(
      'SELECT status, error_code FROM platform_ai_runs WHERE turn_id = ?', [turn.id],
    );
    expect(run[0].status).toBe('failed');
    expect(run[0].error_code).toBe('AI_PROVIDER_FAILED');
    const turnRow = await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]);
    expect(turnRow[0].status).toBe('needs_owner_attention');
    // 无正式 entries / archive / 下一回合 / turn.resolved。
    expect((await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id])).length).toBe(0);
    expect((await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId])).length).toBe(0);
    expect((await db.query('SELECT id FROM platform_turns WHERE campaign_id = ? AND number = 2', [turn.campaignId])).length).toBe(0);
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM platform_outbox_events WHERE campaign_id = ?', [turn.campaignId],
    );
    expect(events.map((e) => e.event_type)).toContain('ai.preview.failed');
    expect(events.map((e) => e.event_type)).not.toContain('turn.resolved');
    await db.close();
  });

  it('wraps a delta publish DB failure as INTERNAL_ERROR, not AI_PROVIDER_FAILED', async () => {
    // provider 成功 stream，但首个 delta 的短 tx/outbox publish 抛 raw DB 错误：
    // 必须按内部错误（INTERNAL_ERROR）归类，绝不当 provider 失败误报；无正式写、无原始 DB 信息泄漏。
    const { db, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb), ['雨停了…'])(input, hooks);
      }),
    );
    // 注入 outbox 失败：只在 ai.preview.delta 事件（provider 流式期间的短 tx/publish）抛 raw DB 错误，
    // 其它事件（claim 的 ai.preview.started、fail 的 ai.preview.failed）走真实实现，保证故障定位在 delta publish。
    const brokenOutbox = new (class extends OutboxRepository {
      override async publishIn(tx: QueryExecutor, event: CampaignEvent): Promise<number> {
        if (event.type === 'ai.preview.delta') {
          throw new Error('boom delta db');
        }
        return super.publishIn(tx, event);
      }
    })(db);
    const failing = new AiResolutionService(
      db,
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb), ['雨停了…'])(input, hooks);
      }),
      brokenOutbox,
      new ArchiveService(db, brokenOutbox),
      new AiContextBuilder(db),
      new TurnResolutionValidator(db),
      new StateChangeMaterializer(db),
    );
    await expect(failing.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'delta-internal' })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    const runRow = await db.query<{ status: string; error_code: string | null; error_json: string | null; raw_debug_json: string | null }>(
      'SELECT status, error_code, error_json, raw_debug_json FROM platform_ai_runs WHERE turn_id = ?', [turn.id],
    );
    expect(runRow).toHaveLength(1);
    expect(runRow[0].status).toBe('failed');
    expect(runRow[0].error_code).toBe('INTERNAL_ERROR');
    // 脱敏：原始 DB 错误文本与内部固定文案均不携带 'boom delta db'。
    const joined = `${runRow[0].error_json ?? ''}${runRow[0].raw_debug_json ?? ''}`;
    expect(joined).toContain('AI 预览流式写入内部错误。');
    expect(joined).not.toContain('boom delta db');
    expect(joined).not.toContain('AI Provider 调用失败');
    const turnRow = await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]);
    expect(turnRow[0].status).toBe('needs_owner_attention');
    // 无正式写：无 entries、无 archive、无下一回合、无 turn.resolved。
    expect((await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id])).length).toBe(0);
    expect((await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId])).length).toBe(0);
    expect((await db.query('SELECT id FROM platform_turns WHERE campaign_id = ? AND number = 2', [turn.campaignId])).length).toBe(0);
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM platform_outbox_events WHERE campaign_id = ?', [turn.campaignId],
    );
    expect(events.map((e) => e.event_type)).toContain('ai.preview.failed');
    expect(events.map((e) => e.event_type)).not.toContain('turn.resolved');
    await db.close();
  });

  it('sanitizes provider error messages so raw secrets never persist', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async () => { throw new Error('boom api_key=sk-secret-123&token=abc456'); }),
    );
    await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'fail-secret' }))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
    const rows = await db.query<{ error_json: string | null; raw_debug_json: string | null }>(
      'SELECT error_json, raw_debug_json FROM platform_ai_runs WHERE turn_id = ?', [turn.id],
    );
    const joined = `${rows[0].error_json ?? ''}${rows[0].raw_debug_json ?? ''}`;
    // 原始 provider 文本（secret/token 与 raw 前缀 boom）一律不落库；只有固定脱敏结构。
    expect(joined).not.toContain('sk-secret-123');
    expect(joined).not.toContain('abc456');
    expect(joined).not.toContain('boom');
    expect(joined).toContain('AI Provider 调用失败，详情已脱敏。');
    await db.close();
  });

  it('rejects invalid AI output with AI_OUTPUT_INVALID and no formal writes', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      // 空 publicNarrative 触发 schema 校验 AI_OUTPUT_INVALID；与 combat gate 分离。
      new ScriptedAiProvider(scriptedResolution({ publicNarrative: '', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] })),
    );
    await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'bad1' })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    const turnRow = await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]);
    expect(turnRow[0].status).toBe('needs_owner_attention');
    expect((await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId])).length).toBe(0);
    await db.close();
  });

  it('gates combat state changes with STATE_CONFLICT and writes no formal state', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(scriptedResolution({ publicNarrative: '战斗开始。', privateUpdates: [], diceResults: [], stateChanges: [{ kind: 'combat', targetId: 'enc-1', patch: { hpCurrent: 1 }, visibility: 'public' }], interactionRequests: [] })),
    );
    await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'combat1' })).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    const turnRow = await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]);
    expect(turnRow[0].status).toBe('needs_owner_attention');
    expect((await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId])).length).toBe(0);
    expect((await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id])).length).toBe(0);
    await db.close();
  });

  it('allows a failed retry with a NEW key and rejects the same key as a replay', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        throw new Error('boom');
      }),
    );
    await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'failA' })).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
    // 同 key 重试 = idempotent replay：返回既有 failed run（created=false），不调 provider。
    const replay = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'failA' });
    expect(replay.created).toBe(false);
    expect(replay.run.status).toBe('failed');
    // 新 key → 新 attempt 成功（换 provider 后重试）。
    const db2 = db; // 同库；换 provider 直接构造新服务验证新 key 重试
    const outbox = new OutboxRepository(db2);
    const archives = new ArchiveService(db2, outbox);
    const ok = new AiResolutionService(
      db2, new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }), outbox, archives,
      new AiContextBuilder(db2), new TurnResolutionValidator(db2), new StateChangeMaterializer(db2),
    );
    const retried = await ok.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'retryB' });
    expect(retried.created).toBe(true);
    expect(retried.run.attempt).toBe(2);
    expect(retried.run.status).toBe('succeeded');
    await db.close();
  });

  it('rejects resolving a waiting turn and a completed turn', async () => {
    // waiting 用例：makeFixture({ lockTurn: false }) 只 startTurn，不提交 action → turn 仍是 waiting_for_actions。
    const waiting = await makeFixture(new ScriptedAiProvider(scriptedResolution({ publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] })), { lockTurn: false });
    await expect(waiting.service.resolveTurn(waiting.ownerCtx, waiting.turn.id, { idempotencyKey: 'k-wait' })).rejects.toMatchObject({ code: 'TURN_NOT_ACTIVE' });
    await waiting.db.close();

    // completed 用例：locked fixture（默认 lockTurn: true 已提交并锁定）后在测试 SQL 直接置 completed
    // （等价于专用 helper 构造完成态）；completed 是终态已结算，新 key resolve 不得绕过 idempotency，
    // 因此必须 STATE_CONFLICT（同 key completed replay 返回既有 succeeded run，见下方独立用例）。
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(scriptedResolution({ publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] })),
    );
    const now = new Date().toISOString();
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", [
      now, now, turn.id,
    ]);
    await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'k-completed' })).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('rejects a player resolving', async () => {
    const { service, aCtx, turn } = await makeFixture(new ScriptedAiProvider(scriptedResolution({})));
    await expect(service.resolveTurn(aCtx, turn.id, { idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns created=false for an idempotent replay after the turn is completed (succeeded run)', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }),
    );
    const first = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'replay-after-success' });
    expect(first.created).toBe(true);
    expect(first.run.status).toBe('succeeded');
    // 成功后 turn 已 completed：同 key replay 仍应返回既有 succeeded run（created=false），不抛 STATE_CONFLICT。
    const replay = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'replay-after-success' });
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.run.id);
    expect(replay.run.status).toBe('succeeded');
    await db.close();
  });
});
```

`server/src/platform/database/postgres-archives-ai.test.ts` 追加（门控，008 claim/idempotency）：

```ts
  it('claims idempotently on postgres (same key returns the existing run)', async () => {
    const db = new PostgresDatabaseAdapter(new pg.Pool({ connectionString: url, max: 1 }));
    try {
      await db.migrate();
      // 复用与 restore 用例相同的最小 fixture（identity/campaign/2 角色/turn 锁定）。
      // 共享 Postgres 测试库：每次运行用 randomUUID 唯一 login，避免重复运行撞 UNIQUE(login) 与残留。
      const identity = new IdentityService(db);
      const campaigns = new CampaignService(db);
      const characters = new CharacterService(db);
      const suffix = randomUUID();
      const owner = await identity.register({ login: `o-${suffix}@example.test`, password: 'correct-password' });
      const a = await identity.register({ login: `pa-${suffix}@example.test`, password: 'correct-password' });
      const b = await identity.register({ login: `pb-${suffix}@example.test`, password: 'correct-password' });
      const created = await campaigns.create(owner.userId, { name: '矿坑', ruleset: 'dnd5e' });
      await campaigns.join({ userId: a.userId }, created.campaign.id, created.inviteCode);
      await campaigns.join({ userId: b.userId }, created.campaign.id, created.inviteCode);
      const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
      const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
      const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
      for (const ctx of [aCtx, bCtx]) {
        const draft = await characters.createDraft(ctx, { name: '角色', sheet: { ac: 12 } });
        await characters.submitForReview(ctx, draft.id);
        await characters.approve(ownerCtx, draft.id);
      }
      const turns = new TurnService(db, new OutboxRepository(db));
      const t1 = await turns.startTurn(ownerCtx);
      await turns.submitAction(aCtx, t1.id, { body: 'A' });
      await turns.submitAction(bCtx, t1.id, { body: 'B' });
      const outbox = new OutboxRepository(db);
      const archives = new ArchiveService(db, outbox);
      const service = new AiResolutionService(
        db, new ScriptedAiProvider(scriptedResolution({ publicNarrative: 'ok', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] })),
        outbox, archives, new AiContextBuilder(db), new TurnResolutionValidator(db), new StateChangeMaterializer(db),
      );
      const first = await service.resolveTurn(ownerCtx, t1.id, { idempotencyKey: 'pg-k1' });
      const second = await service.resolveTurn(ownerCtx, t1.id, { idempotencyKey: 'pg-k1' });
      expect(second.created).toBe(false);
      expect(second.run.id).toBe(first.run.id);
      expect(second.run.status).toBe('succeeded');
    } finally {
      await db.close();
    }
  });

  it('rejects concurrent different-key claims on postgres (one claim wins, other gets STATE_CONFLICT)', async () => {
    const db = new PostgresDatabaseAdapter(new pg.Pool({ connectionString: url, max: 1 }));
    try {
      await db.migrate();
      const identity = new IdentityService(db);
      const campaigns = new CampaignService(db);
      const characters = new CharacterService(db);
      const suffix = randomUUID();
      const owner = await identity.register({ login: `o2-${suffix}@example.test`, password: 'correct-password' });
      const a = await identity.register({ login: `pa2-${suffix}@example.test`, password: 'correct-password' });
      const b = await identity.register({ login: `pb2-${suffix}@example.test`, password: 'correct-password' });
      const created = await campaigns.create(owner.userId, { name: '并发矿坑', ruleset: 'dnd5e' });
      await campaigns.join({ userId: a.userId }, created.campaign.id, created.inviteCode);
      await campaigns.join({ userId: b.userId }, created.campaign.id, created.inviteCode);
      const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
      const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
      const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
      for (const ctx of [aCtx, bCtx]) {
        const draft = await characters.createDraft(ctx, { name: '角色', sheet: { ac: 12 } });
        await characters.submitForReview(ctx, draft.id);
        await characters.approve(ownerCtx, draft.id);
      }
      const turns = new TurnService(db, new OutboxRepository(db));
      const t1 = await turns.startTurn(ownerCtx);
      await turns.submitAction(aCtx, t1.id, { body: 'A' });
      await turns.submitAction(bCtx, t1.id, { body: 'B' });
      const outbox = new OutboxRepository(db);
      const archives = new ArchiveService(db, outbox);
      const service = new AiResolutionService(
        db, new ScriptedAiProvider(scriptedResolution({ publicNarrative: 'ok', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] })),
        outbox, archives, new AiContextBuilder(db), new TurnResolutionValidator(db), new StateChangeMaterializer(db),
      );
      const results = await Promise.allSettled([
        service.resolveTurn(ownerCtx, t1.id, { idempotencyKey: 'pg-ca' }),
        service.resolveTurn(ownerCtx, t1.id, { idempotencyKey: 'pg-cb' }),
      ]);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0].reason as { code?: string }).code).toBe('STATE_CONFLICT');
      const runs = await db.query<{ attempt: number }>('SELECT attempt FROM platform_ai_runs WHERE turn_id = ?', [t1.id]);
      expect(runs).toHaveLength(1);
      expect(runs[0].attempt).toBe(1);
    } finally {
      await db.close();
    }
  });
```

### Step 2：运行确认失败

```bash
rtk npm test -- --run server/src/modules/ai-runtime/ai-resolution.test.ts
```

预期：失败——`AiResolutionService` 不存在；`TurnRepository` 缺 `markResolving`/`markCompleted`；waiting 拒绝断言依赖 claim 的 `TURN_NOT_ACTIVE` 分支、completed 新 key 拒绝断言依赖 `STATE_CONFLICT` 分支（见 Step 3）。门控的 `postgres-archives-ai.test.ts` 在未配置 `POSTGRES_TEST_URL` 时跳过。

### Step 3：实现

`server/src/modules/turns/TurnRepository.ts` 追加：

```ts
  /** claim：仅当 locked 或 needs_owner_attention 时置 resolving（owner 可对失败回合用新 key 重试）。 */
  async markResolving(turnId: string, now: string): Promise<boolean> {
    const result = await this.executor.execute(
      "UPDATE platform_turns SET status = 'resolving', updated_at = ? WHERE id = ? AND status IN ('locked','needs_owner_attention')",
      [now, turnId],
    );
    return result.changes === 1;
  }

  /** formal apply：仅当仍为 resolving 时置 completed。 */
  async markCompleted(turnId: string, completedAt: string): Promise<boolean> {
    const result = await this.executor.execute(
      "UPDATE platform_turns SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'resolving'",
      [completedAt, completedAt, turnId],
    );
    return result.changes === 1;
  }
```

`server/src/modules/ai-runtime/AiResolutionService.ts`（短事务 lifecycle 核心；**绝不嵌套调用 `TurnService.transaction`**；`nanoid` 用于 runId/archiveId/entries id）：

```ts
import { nanoid } from 'nanoid';
import type { AiPrompt, AiRunView, ResolveTurnInput, TurnResolution } from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';
import { TurnRepository } from '../turns/TurnRepository.js';
import { ArchiveService } from '../archives/ArchiveService.js';
import { AiRunRepository, type AiRunRow } from './AiRunRepository.js';
import { TurnEntryRepository } from './TurnEntryRepository.js';
import { AiContextBuilder } from './AiContextBuilder.js';
import { TurnResolutionValidator } from './TurnResolutionValidator.js';
import { StateChangeMaterializer } from './StateChangeMaterializer.js';
import type { AiProviderPort } from './AiProviderPort.js';

export class AiResolutionService {
  constructor(
    private readonly executor: DatabasePort,
    private readonly provider: AiProviderPort,
    private readonly outbox: EventPublisherPort,
    private readonly archives: ArchiveService,
    private readonly context: AiContextBuilder,
    private readonly validator: TurnResolutionValidator,
    private readonly materializer: StateChangeMaterializer,
  ) {}

  /** 返回既有 run（幂等 replay）或新 run；created 供路由区分 201/200。 */
  async resolveTurn(ctx: CampaignAuthContext, turnId: string, input: ResolveTurnInput): Promise<{ created: boolean; run: AiRunView }> {
    requireOwner(ctx);
    const { idempotencyKey } = input;
    // 1) claim tx：campaign/turn 行锁 + 幂等查重 + attempt + context 快照 + run=running + turn=resolving + preview.started。
    //    claim 结果是 discriminated union：replay 不带 prompt（不触碰 provider），claimed 带 prompt 供 provider 消费。
    const claim = await this.claim(ctx.campaignId, turnId, idempotencyKey);
    if (claim.kind === 'replay') {
      // 幂等 replay：不调用 provider、不写 entries/archive/events，直接返回既有 run。
      return { created: false, run: this.toView(claim.run) };
    }
    const runId = claim.run.id;
    let finalOutput: unknown;
    try {
      // 2) provider 在 tx 外运行；每个 delta 独立短 tx publish。仅 claimed 分支持有 prompt。
      finalOutput = await this.provider.stream(claim.prompt, {
        onDelta: async (delta) => {
          try {
            // delta 短 tx/publish 失败（DB 中断、outbox 写失败等）不是 provider 输出问题：
            // 包装为受控 INTERNAL_ERROR（安全文案，不携带底层 DB 信息），由下方 catch 保留。
            await this.executor.transaction((tx) =>
              this.outbox.publishIn(tx, { type: 'ai.preview.delta', campaignId: ctx.campaignId, runId, text: delta.text }),
            );
          } catch {
            // 丢弃原始 DB 错误对象（绝不持久化/上 HTTP），只抛受控 INTERNAL_ERROR。
            throw new AppError('INTERNAL_ERROR', 'AI 预览流式写入内部错误。');
          }
        },
      });
    } catch (error) {
      // 3a) provider 阶段 catch 分类：
      //     - 受控 AppError（delta publish 失败包装的 INTERNAL_ERROR 等）原样保留其 code，
      //       绝不当 AI_PROVIDER_FAILED 误报（provider 本身可能成功、是本地 DB 写入失败）。
      //     - 其余 provider throw（网络/输出异常）→ AI_PROVIDER_FAILED（HTTP 502）。provider 抛出的
      //       原始 Error 绝不落库/上 HTTP；fail() 只写固定脱敏文案。
      if (error instanceof AppError) {
        await this.fail(ctx.campaignId, turnId, runId, error.code, error);
        throw error;
      }
      const appError = new AppError('AI_PROVIDER_FAILED', 'AI Provider 调用失败。');
      await this.fail(ctx.campaignId, turnId, runId, appError.code, error);
      throw appError;
    }
    try {
      // 3b) parse + 校验 + formal apply。actorUserId=ctx.userId（真实 owner，供 character audit 与自动存档 created_by FK）。
      //     schema/规则/可见性校验失败 → 原 AppError（AI_OUTPUT_INVALID / STATE_CONFLICT）；
      //     formal apply 内部任一失败整体 rollback（run 仍 running、turn 仍 resolving），随后进入 catch。
      const resolution = await this.validateAndParse(ctx.campaignId, finalOutput);
      await this.applyFormal(ctx.campaignId, turnId, runId, resolution, ctx.userId);
    } catch (error) {
      // 4) 校验/formal-apply 阶段：受控 AppError 保持原码（AI_OUTPUT_INVALID / STATE_CONFLICT）；
      //    未知 DB/formal-apply 错误（非 AppError）→ INTERNAL_ERROR（tx 已整体回滚，fail tx 再置
      //    needs_owner_attention），绝不当 AI_PROVIDER_FAILED 误报。
      if (error instanceof AppError) {
        await this.fail(ctx.campaignId, turnId, runId, error.code, error);
        throw error;
      }
      const internal = new AppError('INTERNAL_ERROR', 'AI 结算内部错误。');
      await this.fail(ctx.campaignId, turnId, runId, internal.code, error);
      throw internal;
    }
    // 5) post-commit reload 在 try/catch 之外：仅服务端成功返回。加载失败/丢失同样不应
    //    把已 succeeded 的 run 再标记 failed 或补发 ai.preview.failed——reload 查询自身抛错时
    //    会向上传播为服务端内部错误；`completed` 为 null 时 toView 显式抛 INTERNAL_ERROR 而非
    //    静默用空行返回（不 catch，绝不误报 provider 失败）。
    const completed = await new AiRunRepository(this.executor).findById(runId);
    if (!completed) {
      throw new AppError('INTERNAL_ERROR', 'AI 结算结果读取失败。');
    }
    return { created: true, run: this.toView(completed) };
  }

  /** claim：返回既有 run（replay）或新 run（claimed）。幂等优先：同 key 同 turn 的既有 run 直接返回
   *  （含 succeeded/completed 之后的 replay），不要求 turn 仍 locked/needs_owner_attention；只有创建新 run 时才校验回合状态。
   *  返回值是 discriminated union：`{ kind:'replay'; run }` 不含 prompt（resolveTurn 分支后不触碰 provider）；
   *  `{ kind:'claimed'; run; prompt }` 持有 context 快照供 provider 消费。 */
  private async claim(campaignId: string, turnId: string, idempotencyKey: string): Promise<{ kind: 'replay'; run: AiRunRow } | { kind: 'claimed'; run: AiRunRow; prompt: AiPrompt }> {
    return this.executor.transaction(async (tx) => {
      await tx.execute('UPDATE campaigns SET updated_at = updated_at WHERE id = ?', [campaignId]);
      const runs = new AiRunRepository(tx);
      const turns = new TurnRepository(tx);
      // 1) 归属确认：lockTurnRow 过滤 superseded 且返回未命中=不存在；只用于归属校验，不改状态。
      if (!(await turns.lockTurnRow(turnId, campaignId))) {
        throw new AppError('NOT_FOUND', '回合不存在。');
      }
      const turn = await turns.findTurnById(turnId);
      if (!turn) throw new AppError('NOT_FOUND', '回合不存在。');
      // 2) 幂等优先：同 key 已有 run → 直接返回（成功 replay 时 turn 已 completed，也先查幂等）。
      const existing = await runs.findByIdempotencyKey(tx, campaignId, idempotencyKey);
      if (existing) {
        if (existing.turn_id !== turnId) {
          throw new AppError('VALIDATION_ERROR', 'idempotencyKey 已用于其它回合。');
        }
        // 幂等 replay 不调用 provider、不写 entries/archive/events，直接返回既有 run（kind='replay'）。
        return { kind: 'replay', run: existing };
      }
      // 3) 只有创建新 run 时才校验回合状态：waiting 未锁定 → TURN_NOT_ACTIVE；
      //    completed 是终态（已结算），新 key 不得绕过 idempotency → STATE_CONFLICT；
      //    其余非许可状态（如 resolving 并发中）同样 STATE_CONFLICT。
      if (turn.status !== 'locked' && turn.status !== 'needs_owner_attention') {
        if (turn.status === 'waiting_for_actions') {
          throw new AppError('TURN_NOT_ACTIVE', '当前回合不允许结算。');
        }
        throw new AppError('STATE_CONFLICT', '当前回合状态不允许结算。');
      }
      // 4) attempt 单调分配（turn/campaign 锁内安全）。attempt 从 0 起：同 turn 首个 run attempt=1；
      //    失败重试（新 key）在 resolveTurn 的 claim 阶段先经这里分配 attempt=2。
      const attempt = (await runs.maxAttempt(tx, turnId)) + 1;
      const campaignSequence = await runs.nextCampaignSequence(tx, campaignId);
      // 5) context 快照：claim tx 内 capture（同 tx 读取，Postgres 行锁可见），provider 只消费该快照。
      const pkg = await this.context.buildForTurn(campaignId, turnId, tx);
      const now = new Date().toISOString();
      const runId = nanoid(24);
      await runs.insertRun(tx, {
        id: runId, campaign_id: campaignId, campaign_sequence: campaignSequence, turn_id: turnId,
        attempt, idempotency_key: idempotencyKey, provider: this.provider.name, model: this.provider.name,
        status: 'running', context_json: JSON.stringify({ prompt: pkg.prompt, context: pkg.context }), result_json: null,
        error_code: null, error_json: null, raw_debug_json: null, started_at: now, completed_at: null,
      });
      if (!(await turns.markResolving(turnId, now))) {
        throw new AppError('STATE_CONFLICT', '回合已不在结算许可状态。');
      }
      await this.outbox.publishIn(tx, { type: 'ai.preview.started', campaignId, runId });
      const created = (await runs.findById(runId)) as AiRunRow;
      return { kind: 'claimed', run: created, prompt: pkg.prompt };
    });
  }

  private async validateAndParse(campaignId: string, output: unknown): Promise<TurnResolution> {
    // schema parse + 规则/可见性校验统一在 validator 内；任一失败 → AI_OUTPUT_INVALID。
    return this.validator.validate(campaignId, output);
  }

  /** formal apply tx：白名单 state changes → entries/requests → run succeeded → turn completed → 正式事件 → 自动存档 → 下一回合。 */
  private async applyFormal(campaignId: string, turnId: string, runId: string, resolution: TurnResolution, actorUserId: string): Promise<void> {
    await this.executor.transaction(async (tx) => {
      await tx.execute('UPDATE campaigns SET updated_at = updated_at WHERE id = ?', [campaignId]);
      const turns = new TurnRepository(tx);
      const runs = new AiRunRepository(tx);
      // 1) 锁定/校验 run+turn。
      const run = await runs.findById(runId);
      if (!run || run.status !== 'running') throw new AppError('STATE_CONFLICT', 'AI run 不在可应用状态。');
      const turn = await turns.findTurnById(turnId);
      if (!turn || turn.status !== 'resolving') throw new AppError('STATE_CONFLICT', '回合不在结算中。');
      // 2) 白名单 state changes（combat → STATE_CONFLICT，无正式写）。actorUserId 供 character audit FK。
      await this.materializer.applyAll(tx, campaignId, resolution.stateChanges, actorUserId);
      // 3) 写 entries 与 interaction requests。
      const now = new Date().toISOString();
      const entriesRepo = new TurnEntryRepository(tx);
      let index = 0;
      await entriesRepo.insertEntry(tx, {
        id: nanoid(24), ai_run_id: runId, turn_id: turnId, campaign_id: campaignId,
        entry_kind: 'narrative', entry_index: index++, visibility: 'public',
        target_player_id: null, payload_json: JSON.stringify({ text: resolution.publicNarrative }), created_at: now,
      });
      for (const update of resolution.privateUpdates) {
        await entriesRepo.insertEntry(tx, {
          id: nanoid(24), ai_run_id: runId, turn_id: turnId, campaign_id: campaignId,
          entry_kind: 'private_update', entry_index: index++, visibility: 'player_private',
          target_player_id: update.playerId, payload_json: JSON.stringify({ text: update.content }), created_at: now,
        });
      }
      for (const dice of resolution.diceResults) {
        await entriesRepo.insertEntry(tx, {
          id: nanoid(24), ai_run_id: runId, turn_id: turnId, campaign_id: campaignId,
          entry_kind: 'dice_result', entry_index: index++, visibility: dice.visibility,
          target_player_id: dice.targetPlayerId,
          // payload 保留 { id, formula, total }：id 与 provider 输出一致，供前端/dice 投影稳定引用。
          payload_json: JSON.stringify({ id: dice.id, formula: dice.formula, total: dice.total }), created_at: now,
        });
      }
      const interactionIds: Array<{ requestId: string; targetPlayerId: string }> = [];
      for (const interaction of resolution.interactionRequests) {
        // DB 主键用内部 nanoid，provider 的 id 存 provider_id 列：跨 run/跨 campaign 复用 'i1'
        // 不会撞全局主键；interaction.requested 事件 requestId 与 InteractionRequestView.id 都是内部 id。
        const requestId = nanoid(24);
        await entriesRepo.insertInteractionRequest(tx, {
          id: requestId, provider_id: interaction.id, campaign_id: campaignId, turn_id: turnId, ai_run_id: runId,
          target_player_id: interaction.targetPlayerId, prompt: interaction.prompt, created_at: now,
        });
        interactionIds.push({ requestId, targetPlayerId: interaction.targetPlayerId });
      }
      // 4) run succeeded/result/debug（2B 只存 raw_debug_json，不 emit owner.debug）。
      const rawDebug = JSON.stringify({ resolution });
      if (!(await runs.markSucceeded(tx, runId, JSON.stringify(resolution), rawDebug, now))) {
        throw new AppError('STATE_CONFLICT', 'AI run 已被并发更新。');
      }
      // 5) turn completed。
      if (!(await turns.markCompleted(turnId, now))) {
        throw new AppError('STATE_CONFLICT', '回合已在结算中被并发修改。');
      }
      // 6) 预生成 automatic archiveId（与 createAutomatic 插入的正式存档 id 一致）。
      const automaticArchiveId = nanoid(24);
      // 7) publish turn.resolved + 所有 interaction.requested（同 tx 内获得正式事件最高 sequence）。
      await this.outbox.publishIn(tx, { type: 'turn.resolved', campaignId, turnId, archiveId: automaticArchiveId });
      for (const { requestId, targetPlayerId } of interactionIds) {
        await this.outbox.publishIn(tx, { type: 'interaction.requested', campaignId, requestId, targetPlayerId });
      }
      // 8) snapshot 的 outbox watermark 自动包含这些正式事件：captureSnapshot 的 maxOutboxSequence
      //    在事务内读取，此时 turn.resolved/interaction.requested 已插入，max sequence 覆盖它们。
      // 9) insert automatic archive（同 tx；kind=automatic、label=null、id=automaticArchiveId；actorUserId 为真实 owner，created_by FK 满足）。
      await this.archives.createAutomatic(tx, campaignId, turnId, actorUserId, automaticArchiveId);
      // 10) create 下一 waiting turn + requirements（同 tx；绝不嵌套 TurnService.transaction）。
      await this.createNextTurn(tx, campaignId);
      // 11) commit（async callback resolve 后由 adapter COMMIT）。
      // 注：自动存档的 turnNumber watermark 在 createAutomatic 内由 maxActiveTurnNumber 读取——
      //    此时 next turn 尚未插入，因此快照 turnNumber 是 resolved turn 的 number（正确）。
    });
  }

  private async createNextTurn(tx: QueryExecutor, campaignId: string): Promise<void> {
    const turns = new TurnRepository(tx);
    const characters = new CharacterRepository(tx);
    const playerIds = await characters.listApprovedPlayerIds(campaignId);
    const number = (await turns.maxTurnNumber(campaignId)) + 1; // 含 superseded，不复用
    const now = new Date().toISOString();
    const turnId = nanoid(24);
    await turns.insertTurn({
      id: turnId, campaign_id: campaignId, number, status: 'waiting_for_actions',
      locked_at: null, completed_at: null, created_at: now, updated_at: now,
    });
    for (const playerId of playerIds) {
      await turns.insertRequirement(turnId, campaignId, playerId);
    }
  }

  /** fail tx：run failed + turn=needs_owner_attention + preview.failed；无正式写。
   *  error_json/raw_debug 一律使用严格白名单结构：AppError（受控消息）保留 name/message/code；
   *  原始 provider Error / 未知 DB / formal-apply 错误只写固定脱敏文案，绝不持久化原始
   *  Error.message/stack（防止 URL/API key/Bearer token/堆栈位置泄漏），测试断言原始 secret
   *  与 raw 文本不落库。fail() 的条件更新保证失败路径不产生半截正式写。 */
  private async fail(campaignId: string, turnId: string, runId: string, code: string, error: unknown): Promise<void> {
    await this.executor.transaction(async (tx) => {
      const runs = new AiRunRepository(tx);
      const turns = new TurnRepository(tx);
      const now = new Date().toISOString();
      // 持久化结构是严格白名单：AppError（我们自己的受控消息）原样保留 name/message；
      // 非 AppError（provider/网络/未知 DB/formal-apply）只写固定脱敏文案，绝不持久化原始
      // Error.message/stack，防止 URL/API key/Bearer token/堆栈位置泄漏。测试断言原始
      // secret 与 raw 前缀都不落库。
      // 脱敏文案按 code 区分（与阶段分类一致）：AI_PROVIDER_FAILED → 固定 provider 文案
      // （AiProviderError 只是脱敏占位）；其它（INTERNAL_ERROR 等）→ 固定内部文案，
      // 绝不在落库层误报 provider 失败。
      const isControlled = error instanceof AppError;
      const isProviderFailure = code === 'AI_PROVIDER_FAILED';
      const sanitized = {
        code,
        name: isControlled ? error.name : (isProviderFailure ? 'AiProviderError' : 'AiResolutionInternalError'),
        message: isControlled
          ? error.message
          : isProviderFailure
            ? 'AI Provider 调用失败，详情已脱敏。'
            : 'AI 结算内部错误，详情已脱敏。',
        timestamp: now,
      };
      const errorJson = JSON.stringify(sanitized);
      await runs.markFailed(tx, runId, code, errorJson, errorJson, now);
      // 条件更新（仅当 turn 仍 resolving）：若并发已把 turn 改成其它状态，失败路径不写半截正式状态。
      await tx.execute(
        "UPDATE platform_turns SET status = 'needs_owner_attention', updated_at = ? WHERE id = ? AND status = 'resolving'",
        [now, turnId],
      );
      await this.outbox.publishIn(tx, { type: 'ai.preview.failed', campaignId, runId, code });
    });
  }
  private toView(row: AiRunRow): AiRunView {
    return {
      id: row.id, campaignId: row.campaign_id, campaignSequence: row.campaign_sequence,
      turnId: row.turn_id, attempt: row.attempt, idempotencyKey: row.idempotency_key,
      provider: row.provider, model: row.model, status: row.status,
      errorCode: row.error_code, startedAt: row.started_at, completedAt: row.completed_at,
      superseded: row.superseded_at !== null,
    };
  }
}
```

### Step 4：运行确认通过

```bash
rtk npm test -- --run server/src/modules/ai-runtime/ai-resolution.test.ts server/src/modules/ai-runtime/ai-persistence.test.ts server/src/modules/archives/archive.test.ts server/src/modules/turns/turn.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：ai-resolution 测试全绿——claim→provider→formal apply→automatic archive→下一回合 number=2；idempotency 同 key 不重复调 provider；成功 replay 在 turn completed 后返回既有 succeeded run（created=false）；并发同 key 恰一次 provider 调用、同 run、一组 entries/archive；并发不同 key 恰一 claim 成功、另一 `STATE_CONFLICT`、attempt 无重复；provider throw → `AI_PROVIDER_FAILED` + needs_owner_attention + 无 entries/archive/next turn/turn.resolved，且 error_json/raw_debug 为严格白名单脱敏结构（原始 provider 文本/secret/堆栈不落库）；**preview delta 短 tx/outbox publish 失败 → `INTERNAL_ERROR`（绝不当 `AI_PROVIDER_FAILED`），run failed/error_code=INTERNAL_ERROR、turn=needs_owner_attention、无正式 entries/archive/next turn、error_json 含内部固定文案 `AI 预览流式写入内部错误。` 且不含原始 DB 错误文本**；invalid 输出 → `AI_OUTPUT_INVALID`；combat → `STATE_CONFLICT`；formal-apply 内非 AppError → `INTERNAL_ERROR` + needs_owner_attention + 无半截正式写（materializer/insert 故障测试），且落库 error_json 脱敏文案为内部固定文案（`AI 结算内部错误，详情已脱敏。`）而非 provider 文案；failed retry 新 key → attempt=2 成功、同 key 重试返回既有 failed run；waiting turn 拒绝（`TURN_NOT_ACTIVE`）、completed turn 新 key 拒绝（`STATE_CONFLICT`，终态不得绕过 idempotency）；player 拒绝；既有 ai-persistence/archive/turn 不回退。

### Step 5：提交

```bash
rtk git add server/src/modules/ai-runtime/AiResolutionService.ts server/src/modules/ai-runtime/ai-resolution.test.ts server/src/modules/turns/TurnRepository.ts server/src/modules/archives/ArchiveService.ts server/src/platform/database/postgres-archives-ai.test.ts
rtk git commit -m "feat: add short-transaction ai resolution service with idempotency and auto-archive" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6：HTTP AI 路由 + 存档/entries/run 路由 + app 装配 + harness 注入 + route 集成测试

**依赖：** Task 3（`createArchiveRouter` 已挂）、Task 5（`AiResolutionService`）、Phase 2A 的 `TurnRepository`/`TurnEntryRepository`/`AiRunRepository`、`httpTestHarness`。

**目标：** （1）`aiRoutes.ts`：`POST /ai/turns/:turnId/runs`（owner resolve，body `{ idempotencyKey }`；**新 run → 201，同 key 幂等 replay → 200**）、`GET /ai/turns/:turnId/runs`（owner 列 run）、`GET /ai/runs/:runId`（owner 详情含 context/result/rawDebug）、`GET /ai/turns/:turnId/entries`（entries 投影：owner 全量，player public+自己的 private）；（2）`app.ts` 装配：默认 `UnavailableAiProvider`（绝不默认 Mock），`CreateAppOptions.aiProvider` 显式注入；挂 ai 路由；（3）`httpTestHarness` 增 `aiProvider` 注入选项；（4）route 集成测试（owner resolve 成功 + player 拒绝 + player entries 投影 + replay 200）。

### Files

- Create: `server/src/routes/aiRoutes.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/tests/httpTestHarness.ts`（`aiProvider` 注入选项）
- Create: `server/src/tests/ai-routes-http.test.ts`

### Step 1：写失败测试

`server/src/tests/ai-routes-http.test.ts`（用 harness 注入 `ScriptedAiProvider`；脚本经 `approvedPlayerIds` 解析真实成员 id 构造 privateUpdates/dice；验证路由与投影）：

```ts
import { describe, expect, it } from 'vitest';
import { jsonHeaders, registerAndLogin, startPlatformServer } from './httpTestHarness.js';
import { ScriptedAiProvider, scriptedResolution, approvedPlayerIds } from '../modules/ai-runtime/ScriptedAiProvider.js';

interface Actor { userId: string; cookieHeader: string; }

async function createCharacter(charsBase: string, actor: Actor, name: string): Promise<string> {
  const createRes = await fetch(`${charsBase}`, { method: 'POST', headers: jsonHeaders(actor.cookieHeader), body: JSON.stringify({ name, sheet: { ac: 14 } }) });
  expect(createRes.status).toBe(201);
  const body = (await createRes.json()) as { character: { id: string } };
  const submitRes = await fetch(`${charsBase}/${body.character.id}/submit`, { method: 'POST', headers: jsonHeaders(actor.cookieHeader) });
  expect(submitRes.status).toBe(200);
  return body.character.id;
}

describe('HTTP ai routes', () => {
  it('resolves a locked turn via HTTP, projects entries per player, and keeps runs owner-only', async () => {
    const server = await startPlatformServer({
      aiProvider: new ScriptedAiProvider(async (prompt, hooks) => {
        const [pa, pb] = approvedPlayerIds(prompt);
        return {
          publicNarrative: '雨停了，队伍继续前进。',
          privateUpdates: [
            { playerId: pa, content: '你发现暗门。' },
            { playerId: pb, content: '你听见脚步。' },
          ],
          diceResults: [
            { id: 'd1', formula: '1d20+2', total: 17, visibility: 'public', targetPlayerId: null },
            { id: 'd2', formula: '1d20', total: 5, visibility: 'player_private', targetPlayerId: pa },
          ],
          stateChanges: [],
          interactionRequests: [],
        };
      }),
    });
    try {
      const { baseUrl, platformDb } = server;
      const owner = await registerAndLogin(baseUrl, 'owner@example.test');
      const playerA = await registerAndLogin(baseUrl, 'a@example.test');
      const playerB = await registerAndLogin(baseUrl, 'b@example.test');
      const createRes = await fetch(`${baseUrl}/api/campaigns`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ name: '矿坑', ruleset: 'dnd5e' }) });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };
      for (const actor of [playerA, playerB]) {
        const joinRes = await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}/join`, { method: 'POST', headers: jsonHeaders(actor.cookieHeader), body: JSON.stringify({ inviteCode: createBody.inviteCode }) });
        expect(joinRes.status).toBe(201);
      }
      const charsBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/characters`;
      for (const [actor, name] of [[playerA, '薇拉'], [playerB, '卡恩']] as const) {
        const id = await createCharacter(charsBase, actor, name);
        const review = await fetch(`${charsBase}/${id}/review`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ action: 'approve' }) });
        expect(review.status).toBe(200);
      }
      const turnsBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/turns`;
      const startRes = await fetch(`${turnsBase}`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader) });
      const turn = (await startRes.json()) as { turn: { id: string } };
      const submit = async (actor: Actor, body: string) => {
        const res = await fetch(`${turnsBase}/${turn.turn.id}/actions`, { method: 'POST', headers: jsonHeaders(actor.cookieHeader), body: JSON.stringify({ body }) });
        expect(res.status).toBe(200);
      };
      await submit(playerA, '搜索房间');
      await submit(playerB, '警戒门口');
      const aiBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/ai`;

      // player 不能 resolve（owner-only）。
      const playerResolve = await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}/ai/turns/${turn.turn.id}/runs`, { method: 'POST', headers: jsonHeaders(playerA.cookieHeader), body: JSON.stringify({ idempotencyKey: 'k1' }) });
      expect(playerResolve.status).toBe(403);

      const resolveRes = await fetch(`${aiBase}/turns/${turn.turn.id}/runs`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ idempotencyKey: 'k1' }) });
      expect(resolveRes.status).toBe(201); // 新 run → 201
      const resolveBody = (await resolveRes.json()) as { run: { id: string; status: string } };
      expect(resolveBody.run.status).toBe('succeeded');

      // 同 key 幂等 replay → 200，返回同一 run，不重复调用 provider / 写 entries。
      const replayRes = await fetch(`${aiBase}/turns/${turn.turn.id}/runs`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ idempotencyKey: 'k1' }) });
      expect(replayRes.status).toBe(200);
      const replayBody = (await replayRes.json()) as { run: { id: string } };
      expect(replayBody.run.id).toBe(resolveBody.run.id);

      // 自动存档 + 下一回合。
      const archives = await platformDb.query<{ kind: string }>('SELECT kind FROM platform_archives WHERE campaign_id = ?', [createBody.campaign.id]);
      expect(archives).toEqual([{ kind: 'automatic' }]);
      const nextTurn = await platformDb.query<{ number: number; status: string }>('SELECT number, status FROM platform_turns WHERE campaign_id = ? AND number = 2', [createBody.campaign.id]);
      expect(nextTurn).toEqual([{ number: 2, status: 'waiting_for_actions' }]);

      // entries 投影：A 只见 public + 自己的 private（private_update + player_private dice 两条）；B 只见 public + 自己的 private。
      const aEntries = (await (await fetch(`${aiBase}/turns/${turn.turn.id}/entries`, { headers: { cookie: playerA.cookieHeader } })).json()) as { entries: Array<{ entryKind: string; visibility: string; targetPlayerId: string | null }> };
      expect(aEntries.entries.filter((e) => e.visibility === 'player_private')).toHaveLength(2);
      const bText = JSON.stringify(await (await fetch(`${aiBase}/turns/${turn.turn.id}/entries`, { headers: { cookie: playerB.cookieHeader } })).json());
      expect(bText).not.toContain('暗门');
      expect(bText).toContain('脚步');

      // run 详情 owner 可读 context/result；player 不可读（FORBIDDEN）。
      const detail = await fetch(`${aiBase}/runs/${resolveBody.run.id}`, { headers: { cookie: owner.cookieHeader } });
      expect(detail.status).toBe(200);
      const playerDetail = await fetch(`${aiBase}/runs/${resolveBody.run.id}`, { headers: { cookie: playerA.cookieHeader } });
      expect(playerDetail.status).toBe(403);

      // 存档路由：owner 手动存档 + player 恢复拒绝。
      const archivesBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/archives`;
      const manual = await fetch(`${archivesBase}`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ label: '手动' }) });
      expect(manual.status).toBe(201);
      const manualBody = (await manual.json()) as { archive: { id: string } };
      const playerRestore = await fetch(`${archivesBase}/${manualBody.archive.id}/restore`, { method: 'POST', headers: jsonHeaders(playerA.cookieHeader) });
      expect(playerRestore.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('rejects cross-campaign ai runs/entries access with NOT_FOUND', async () => {
    const server = await startPlatformServer({
      aiProvider: new ScriptedAiProvider(scriptedResolution({ publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] })),
    });
    try {
      const { baseUrl, platformDb } = server;
      const ownerA = await registerAndLogin(baseUrl, 'ownerA@example.test');
      const ownerB = await registerAndLogin(baseUrl, 'ownerB@example.test');
      const createCampaign = async (name: string, cookieHeader: string) => {
        const res = await fetch(`${baseUrl}/api/campaigns`, { method: 'POST', headers: jsonHeaders(cookieHeader), body: JSON.stringify({ name, ruleset: 'dnd5e' }) });
        expect(res.status).toBe(201);
        return ((await res.json()) as { campaign: { id: string } }).campaign.id;
      };
      const campA = await createCampaign('A', ownerA.cookieHeader);
      const campB = await createCampaign('B', ownerB.cookieHeader);
      // A 的一个真实回合（直接插入满足 FK 与 turn 路由归属校验），ownerB 通过 B 的 campaign URL 访问 → 必须 NOT_FOUND。
      const now = new Date().toISOString();
      const turnId = 'cross-turn-1';
      await platformDb.execute(
        "INSERT INTO platform_turns (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at) VALUES (?, ?, 1, 'locked', ?, NULL, ?, ?)",
        [turnId, campA, now, now, now],
      );
      const aiBaseB = `${baseUrl}/api/campaigns/${campB}/ai`;
      const entriesRes = await fetch(`${aiBaseB}/turns/${turnId}/entries`, { headers: { cookie: ownerB.cookieHeader } });
      expect(entriesRes.status).toBe(404);
      const runsRes = await fetch(`${aiBaseB}/turns/${turnId}/runs`, { headers: { cookie: ownerB.cookieHeader } });
      expect(runsRes.status).toBe(404);
      // 归属校验必须先于 owner 鉴权？不应——同 campaign 的 owner 也应能读取；这里再验一次 A owner 自己
      // 通过自己的 URL 能 200，B 的 URL 仍然 404（不因 owner 而绕过 campaign 边界）。
      const aiBaseA = `${baseUrl}/api/campaigns/${campA}/ai`;
      const selfRuns = await fetch(`${aiBaseA}/turns/${turnId}/runs`, { headers: { cookie: ownerA.cookieHeader } });
      expect(selfRuns.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
```

`server/src/tests/httpTestHarness.ts` 修改（`startPlatformServer` 增可选 `aiProvider`）：

```ts
import type { AiProviderPort } from '../modules/ai-runtime/AiProviderPort.js';
// ...
export async function startPlatformServer(options: { aiProvider?: AiProviderPort } = {}): Promise<StartedPlatform> {
  const raw = createMemoryDb();
  migrate(raw);
  const platformDb = createSqliteDatabase(undefined, { reuseRaw: raw });
  await platformDb.migrate();
  const app = createApp(raw, { platformDb, aiProvider: options.aiProvider });
  // ... 其余不变
}
```

### Step 2：运行确认失败

```bash
rtk npm test -- --run server/src/tests/ai-routes-http.test.ts
```

预期：失败——`aiRoutes` 不存在；`createApp` 不接受 `aiProvider` 选项；`httpTestHarness.startPlatformServer` 未透传 `aiProvider`（TS 编译错误暴露）。

### Step 3：实现

`server/src/routes/aiRoutes.ts`（`mergeParams` + campaign middleware；resolve/entries 投影）：

```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { resolveTurnInputSchema } from '@dnd/contracts';
import type { QueryExecutor } from '../platform/database/DatabasePort.js';
import { AppError } from '../platform/http/AppError.js';
import { getCampaignContext, requireCampaignMember } from '../platform/http/campaignMiddleware.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { AiResolutionService } from '../modules/ai-runtime/AiResolutionService.js';
import { AiRunRepository, type AiRunRow } from '../modules/ai-runtime/AiRunRepository.js';
import { TurnEntryRepository, projectEntries, type TurnEntryRow } from '../modules/ai-runtime/TurnEntryRepository.js';
import { TurnRepository } from '../modules/turns/TurnRepository.js';
import { requireOwner } from '../modules/campaigns/CampaignAccess.js';

export function createAiRouter(executor: QueryExecutor, ai: AiResolutionService): Router {
  const router = Router({ mergeParams: true });
  router.use(requireCampaignMember(executor));

  router.post('/turns/:turnId/runs', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const input = resolveTurnInputSchema.parse(req.body);
    // 新 run → 201；同 key 幂等 replay（既有 run）→ 200。service 返回 { created, run }。
    const result = await ai.resolveTurn(ctx, stringParam(req, 'turnId'), input);
    res.status(result.created ? 201 : 200).json({ run: result.run });
  }));

  router.get('/turns/:turnId/runs', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    requireOwner(ctx);
    const turnId = stringParam(req, 'turnId');
    await requireTurnInCampaign(executor, ctx.campaignId, turnId); // 跨 campaign 已知 turnId → NOT_FOUND
    const runs = await new AiRunRepository(executor).listByTurn(turnId);
    res.json({ runs: runs.map(toView) });
  }));

  router.get('/runs/:runId', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    requireOwner(ctx);
    const run = await new AiRunRepository(executor).findById(stringParam(req, 'runId'));
    if (!run || run.campaign_id !== ctx.campaignId) throw new AppError('NOT_FOUND', 'AI run 不存在。');
    res.json({ run: { ...toView(run), context: JSON.parse(run.context_json), result: run.result_json ? JSON.parse(run.result_json) : null, rawDebug: run.raw_debug_json ? JSON.parse(run.raw_debug_json) : null } });
  }));

  router.get('/turns/:turnId/entries', asyncHandler(async (req: Request, res: Response) => {
    const ctx = getCampaignContext(req);
    const turnId = stringParam(req, 'turnId');
    await requireTurnInCampaign(executor, ctx.campaignId, turnId); // 跨 campaign 已知 turnId → NOT_FOUND
    const rows = await new TurnEntryRepository(executor).listByTurn(turnId);
    const projected = projectEntries({ role: ctx.role, playerId: ctx.playerId }, rows);
    res.json({ entries: projected.map(toEntry) });
  }));

  return router;
}

/** 校验回合属于该 campaign：跨 campaign 的已知 turnId 直接 NOT_FOUND（路由边界，不能靠 repo 过滤绕过）。 */
async function requireTurnInCampaign(executor: QueryExecutor, campaignId: string, turnId: string): Promise<void> {
  const turn = await new TurnRepository(executor).findTurnById(turnId);
  if (!turn || turn.campaign_id !== campaignId) {
    throw new AppError('NOT_FOUND', '回合不存在。');
  }
}

function toView(row: AiRunRow) {
  return {
    id: row.id, campaignId: row.campaign_id, campaignSequence: row.campaign_sequence,
    turnId: row.turn_id, attempt: row.attempt, idempotencyKey: row.idempotency_key,
    provider: row.provider, model: row.model, status: row.status, errorCode: row.error_code,
    startedAt: row.started_at, completedAt: row.completed_at, superseded: row.superseded_at !== null,
  };
}

function toEntry(row: TurnEntryRow) {
  return {
    id: row.id, aiRunId: row.ai_run_id, turnId: row.turn_id, campaignId: row.campaign_id,
    entryKind: row.entry_kind, entryIndex: row.entry_index, visibility: row.visibility,
    targetPlayerId: row.target_player_id, payload: JSON.parse(row.payload_json), createdAt: row.created_at,
  };
}

function stringParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new AppError('NOT_FOUND', '资源不存在。');
  return value;
}
```

`server/src/app.ts` 修改（`CreateAppOptions` 增 `aiProvider?: AiProviderPort`；composition root 默认 `UnavailableAiProvider`；挂 ai 路由）：

```ts
import { AiResolutionService } from './modules/ai-runtime/AiResolutionService.js';
import { AiContextBuilder } from './modules/ai-runtime/AiContextBuilder.js';
import { TurnResolutionValidator } from './modules/ai-runtime/TurnResolutionValidator.js';
import { StateChangeMaterializer } from './modules/ai-runtime/StateChangeMaterializer.js';
import { UnavailableAiProvider } from './modules/ai-runtime/UnavailableAiProvider.js';
import type { AiProviderPort } from './modules/ai-runtime/AiProviderPort.js';
import { createAiRouter } from './routes/aiRoutes.js';

export interface CreateAppOptions {
  platformDb?: SqliteDatabaseAdapter;
  /** AI Provider：生产默认 UnavailableAiProvider（resolve 安全失败 AI_PROVIDER_FAILED）；测试注入 ScriptedAiProvider。绝不默认 Mock。 */
  aiProvider?: AiProviderPort;
}
// ...
if (options.platformDb) {
  const outbox = new OutboxRepository(options.platformDb);
  // ... 既有 identity/campaigns/characters/worldFacts/turns ...
  const archives = new ArchiveService(options.platformDb, outbox);
  const aiProvider = options.aiProvider ?? new UnavailableAiProvider();
  const ai = new AiResolutionService(
    options.platformDb, aiProvider, outbox, archives,
    new AiContextBuilder(options.platformDb),
    new TurnResolutionValidator(options.platformDb),
    new StateChangeMaterializer(options.platformDb),
  );
  app.use('/api/campaigns/:campaignId/archives', createArchiveRouter(options.platformDb, archives));
  app.use('/api/campaigns/:campaignId/ai', createAiRouter(options.platformDb, ai));
  // 不重复注册 errorMiddleware：文件末尾已有唯一兜底。
}
```

> **Task 6 实现说明**：`app.ts` 只保留文件末尾既有的一次 errorMiddleware 注册；archive/ai 路由在它之前注册即可，不要重复注册。

### Step 4：运行确认通过

```bash
rtk npm test -- --run server/src/tests/ai-routes-http.test.ts server/src/tests/vertical-world-outbox-turns-http.test.ts server/src/tests/vertical-characters-http.test.ts server/src/tests/authCampaignRoutes.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：ai-routes 集成测试全绿——owner resolve 201、同 key replay 200、player resolve 403、自动存档 + 下一回合、entries 投影隔离（A 不见 B 私密、B 不见 A 私密、owner_only 不泄漏）、run 详情 owner 200 / player 403、手动存档 201 / player restore 403、跨 campaign 已知 turnId 访问 runs/entries → 404（同 campaign owner 自访 → 200，证明归属校验不误伤）；既有 HTTP 垂直测试不回退（未注入 aiProvider 时默认 `UnavailableAiProvider`，不触达 AI 路径）；typecheck/build 通过。

### Step 5：提交

```bash
rtk git add server/src/routes/aiRoutes.ts server/src/app.ts server/src/tests/httpTestHarness.ts server/src/tests/ai-routes-http.test.ts
rtk git commit -m "feat: add ai and archive http routes with provider injection" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7：owner/playerA/playerB 三 actor 服务端 AI 垂直验收

**依赖：** Task 6（路由 + harness 注入 + `ScriptedAiProvider`）。

**目标：** 用 harness 内存 SQLite + `ScriptedAiProvider` 跑通完整服务端 AI 垂直流程 `create → join → approve → submit → lock → resolve → archive → project`，另覆盖 provider fail / invalid / retry / 无半截写、隐私隔离（A 不见 B 私密、player 不见 owner 调试）、owner/player 权限隔离。**本任务是独立验收测试，不要求先红。**

### Files

- Create: `server/src/tests/vertical-ai-resolution-http.test.ts`

### Step 1：写验收测试

`server/src/tests/vertical-ai-resolution-http.test.ts`（三 actor 全流程 + 失败/重试/无半截写断言；脚本经 `approvedPlayerIds` 解析真实成员 id 构造 privateUpdates/dice/interactions）：

```ts
import { describe, expect, it } from 'vitest';
import { jsonHeaders, registerAndLogin, startPlatformServer } from './httpTestHarness.js';
import { ScriptedAiProvider, approvedPlayerIds, type AiProviderScript } from '../modules/ai-runtime/ScriptedAiProvider.js';

interface Actor { userId: string; cookieHeader: string; }

const successScript: AiProviderScript = async (prompt, hooks) => {
  const [pa, pb] = approvedPlayerIds(prompt);
  await hooks.onDelta({ kind: 'text', text: '雨停了…' });
  return {
    publicNarrative: '雨停了，队伍在矿洞口重整。',
    privateUpdates: [
      { playerId: pa, content: '你发现墙上有暗门。' },
      { playerId: pb, content: '你听见远处传来脚步声。' },
    ],
    diceResults: [
      { id: 'd1', formula: '1d20+2', total: 17, visibility: 'public', targetPlayerId: null },
      { id: 'd2', formula: '1d20', total: 5, visibility: 'player_private', targetPlayerId: pa },
    ],
    stateChanges: [],
    interactionRequests: [{ id: 'i1', targetPlayerId: pa, prompt: '暗门似乎虚掩，你要推开吗？' }],
  };
};

async function makeFullCampaign(baseUrl: string) {
  const owner = await registerAndLogin(baseUrl, 'owner@example.test');
  const playerA = await registerAndLogin(baseUrl, 'a@example.test');
  const playerB = await registerAndLogin(baseUrl, 'b@example.test');
  const createRes = await fetch(`${baseUrl}/api/campaigns`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ name: '失落矿坑', ruleset: 'dnd5e' }) });
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };
  for (const actor of [playerA, playerB]) {
    const joinRes = await fetch(`${baseUrl}/api/campaigns/${created.campaign.id}/join`, { method: 'POST', headers: jsonHeaders(actor.cookieHeader), body: JSON.stringify({ inviteCode: created.inviteCode }) });
    expect(joinRes.status).toBe(201);
  }
  const charsBase = `${baseUrl}/api/campaigns/${created.campaign.id}/characters`;
  for (const [actor, name] of [[playerA, '薇拉'], [playerB, '卡恩']] as const) {
    const createChar = await fetch(`${charsBase}`, { method: 'POST', headers: jsonHeaders(actor.cookieHeader), body: JSON.stringify({ name, sheet: { ac: 14 } }) });
    const char = (await createChar.json()) as { character: { id: string } };
    await fetch(`${charsBase}/${char.character.id}/submit`, { method: 'POST', headers: jsonHeaders(actor.cookieHeader) });
    const review = await fetch(`${charsBase}/${char.character.id}/review`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ action: 'approve' }) });
    expect(review.status).toBe(200);
  }
  return { owner, playerA, playerB, campaignId: created.campaign.id };
}

async function lockTurn(baseUrl: string, campaignId: string, owner: Actor, playerA: Actor, playerB: Actor): Promise<{ turnId: string; aiBase: string }> {
  const turnsBase = `${baseUrl}/api/campaigns/${campaignId}/turns`;
  const startRes = await fetch(`${turnsBase}`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader) });
  expect(startRes.status).toBe(201);
  const turn = (await startRes.json()) as { turn: { id: string } };
  for (const [actor, body] of [[playerA, '我搜索房间。'], [playerB, '我警戒门口。']] as const) {
    const res = await fetch(`${turnsBase}/${turn.turn.id}/actions`, { method: 'POST', headers: jsonHeaders(actor.cookieHeader), body: JSON.stringify({ body }) });
    expect(res.status).toBe(200);
  }
  return { turnId: turn.turn.id, aiBase: `${baseUrl}/api/campaigns/${campaignId}/ai` };
}

describe('HTTP server-side AI vertical flow', () => {
  it('runs create → join → approve → submit → lock → resolve → archive → project with full privacy isolation', async () => {
    const server = await startPlatformServer({ aiProvider: new ScriptedAiProvider(successScript) });
    try {
      const { baseUrl, platformDb } = server;
      const { owner, playerA, playerB, campaignId } = await makeFullCampaign(baseUrl);
      const { turnId, aiBase } = await lockTurn(baseUrl, campaignId, owner, playerA, playerB);

      // owner resolve（幂等 key）。
      const resolveRes = await fetch(`${aiBase}/turns/${turnId}/runs`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ idempotencyKey: 'vertical-1' }) });
      expect(resolveRes.status).toBe(201);
      const run = (await resolveRes.json()) as { run: { id: string; status: string } };
      expect(run.run.status).toBe('succeeded');

      // 自动存档 + 下一回合 + interaction.requested 事件。
      const archives = await platformDb.query<{ kind: string; label: string | null; version: number }>(
        'SELECT kind, label, version FROM platform_archives WHERE campaign_id = ?', [campaignId],
      );
      expect(archives).toEqual([{ kind: 'automatic', label: null, version: 1 }]);
      const nextTurn = await platformDb.query<{ number: number; status: string }>(
        'SELECT number, status FROM platform_turns WHERE campaign_id = ? AND number = 2', [campaignId],
      );
      expect(nextTurn).toEqual([{ number: 2, status: 'waiting_for_actions' }]);
      const interactions = await platformDb.query<{ provider_id: string; target_player_id: string; status: string }>(
        'SELECT provider_id, target_player_id, status FROM platform_interaction_requests WHERE campaign_id = ?', [campaignId],
      );
      // provider 的 'i1' 只存 provider_id 列；DB 主键是内部 id，status pending。
      expect(interactions).toEqual([{ provider_id: 'i1', target_player_id: playerA.userId, status: 'pending' }]);

      // entries 投影：A 见 public + 自己的 private + 自己 target 的 dice；不见 B 私密与 owner_only。
      const aEntries = (await (await fetch(`${aiBase}/turns/${turnId}/entries`, { headers: { cookie: playerA.cookieHeader } })).json()) as { entries: Array<{ visibility: string; targetPlayerId: string | null }> };
      expect(aEntries.entries.filter((e) => e.visibility === 'player_private').map((e) => e.targetPlayerId)).toEqual([playerA.userId, playerA.userId]);
      const bEntries = JSON.stringify(await (await fetch(`${aiBase}/turns/${turnId}/entries`, { headers: { cookie: playerB.cookieHeader } })).json());
      expect(bEntries).not.toContain('暗门');
      expect(bEntries).toContain('脚步声');

      // run 详情 owner 可见；player FORBIDDEN。
      const playerRunDetail = await fetch(`${aiBase}/runs/${run.run.id}`, { headers: { cookie: playerA.cookieHeader } });
      expect(playerRunDetail.status).toBe(403);
      const ownerRunDetail = (await (await fetch(`${aiBase}/runs/${run.run.id}`, { headers: { cookie: owner.cookieHeader } })).json()) as { run: { context: unknown; rawDebug: unknown } };
      expect(ownerRunDetail.run.context).toBeTruthy();
      expect(ownerRunDetail.run.rawDebug).toBeTruthy();

      // 手动存档（label trimmed）+ 恢复：此时 AI 结算后回合 2 为 waiting，手动快照 currentTurn = 回合 2。
      // 恢复 waiting 快照 → 回合 2 恢复为 waiting（不被 supersede），不开新回合（number 仍为 2）。
      const archivesBase = `${baseUrl}/api/campaigns/${campaignId}/archives`;
      const manual = await fetch(`${archivesBase}`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ label: '  进洞前  ' }) });
      expect(manual.status).toBe(201);
      const manualArchive = (await manual.json()) as { archive: { id: string; label: string; version: number } };
      expect(manualArchive.archive.label).toBe('进洞前');
      const restoreRes = await fetch(`${archivesBase}/${manualArchive.archive.id}/restore`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader) });
      expect(restoreRes.status).toBe(200);
      // 恢复完成后：回合 2 仍是当前回合（waiting、不被 supersede），没有新增回合。
      const allTurns = await platformDb.query<{ number: number; status: string; superseded_at: string | null }>(
        'SELECT number, status, superseded_at FROM platform_turns WHERE campaign_id = ? ORDER BY number', [campaignId],
      );
      expect(allTurns.map((r) => r.number)).toEqual([1, 2]);
      expect(allTurns[1].status).toBe('waiting_for_actions');
      expect(allTurns[1].superseded_at).toBeNull(); // 恢复的是当前回合，不被 supersede
      // completed 快照恢复开新回合 MAX+1 不复用 的断言由 Task 3 archive.test.ts 与 postgres 门控用例覆盖。
    } finally {
      await server.close();
    }
  });

  it('fails provider errors with AI_PROVIDER_FAILED, retries with a new key, and writes nothing partial', async () => {
    let calls = 0;
    const flakyScript: AiProviderScript = async (prompt, hooks) => {
      calls += 1;
      if (calls === 1) throw new Error('provider down');
      return successScript(prompt, hooks);
    };
    const server = await startPlatformServer({ aiProvider: new ScriptedAiProvider(flakyScript) });
    try {
      const { baseUrl, platformDb } = server;
      const { owner, playerA, playerB, campaignId } = await makeFullCampaign(baseUrl);
      const { turnId, aiBase } = await lockTurn(baseUrl, campaignId, owner, playerA, playerB);

      // 第一次 resolve：provider throw → AI_PROVIDER_FAILED，turn=needs_owner_attention，无正式写。
      const failRes = await fetch(`${aiBase}/turns/${turnId}/runs`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ idempotencyKey: 'fail-1' }) });
      expect(failRes.status).toBe(502);
      const failBody = (await failRes.json()) as { error: { code: string } };
      expect(failBody.error.code).toBe('AI_PROVIDER_FAILED');
      const turnRow = await platformDb.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turnId]);
      expect(turnRow[0].status).toBe('needs_owner_attention');
      expect((await platformDb.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turnId])).length).toBe(0);
      expect((await platformDb.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [campaignId])).length).toBe(0);
      expect((await platformDb.query('SELECT id FROM platform_turns WHERE campaign_id = ? AND number = 2', [campaignId])).length).toBe(0);
      const events = await platformDb.query<{ event_type: string }>('SELECT event_type FROM platform_outbox_events WHERE campaign_id = ?', [campaignId]);
      expect(events.map((e) => e.event_type)).toContain('ai.preview.failed');
      expect(events.map((e) => e.event_type)).not.toContain('turn.resolved');

      // 同 key 重试 = idempotent replay（返回既有 failed run，不再调 provider）。
      const replayRes = await fetch(`${aiBase}/turns/${turnId}/runs`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ idempotencyKey: 'fail-1' }) });
      expect(replayRes.status).toBe(200);
      const replay = (await replayRes.json()) as { run: { status: string } };
      expect(replay.run.status).toBe('failed');
      const callsAfterReplay = calls;

      // 新 key 重试成功（attempt=2），正式写齐全。
      const retryRes = await fetch(`${aiBase}/turns/${turnId}/runs`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ idempotencyKey: 'retry-2' }) });
      expect(retryRes.status).toBe(201);
      const retry = (await retryRes.json()) as { run: { status: string; attempt: number } };
      expect(retry.run.status).toBe('succeeded');
      expect(retry.run.attempt).toBe(2);
      expect(calls).toBe(callsAfterReplay + 1);
      const archives = await platformDb.query<{ kind: string }>('SELECT kind FROM platform_archives WHERE campaign_id = ?', [campaignId]);
      expect(archives).toEqual([{ kind: 'automatic' }]);
      // 失败回合（fail-1 的 run）保留 failed；没有重复 entries（仅成功 run 的正式 entries）。
      const entries = await platformDb.query<{ ai_run_id: string }>('SELECT ai_run_id FROM platform_turn_entries WHERE turn_id = ?', [turnId]);
      expect(entries).toHaveLength(5);
      // 失败回合（fail-1 的 run）error_json/raw_debug 为严格白名单脱敏结构，原始 provider 文本/secret 不落库。
      const failed = await platformDb.query<{ error_json: string | null }>("SELECT error_json FROM platform_ai_runs WHERE turn_id = ? AND status = 'failed'", [turnId]);
      expect(failed).toHaveLength(1);
      const errorJson = JSON.parse(failed[0].error_json ?? '{}');
      expect(errorJson).toMatchObject({ code: 'AI_PROVIDER_FAILED' });
      // 固定脱敏文案 + 不包含原始 provider Error 文本（flaky 脚本抛 'provider down'）。
      expect(JSON.stringify(errorJson)).toContain('AI Provider 调用失败，详情已脱敏。');
      expect(JSON.stringify(errorJson)).not.toContain('provider down');
    } finally {
      await server.close();
    }
  });
});
```

### Step 2：运行确认通过

```bash
rtk npm test -- --run server/src/tests/vertical-ai-resolution-http.test.ts
```

预期：**直接通过**——Task 6 已把 ai/archives 路由挂到 `createApp`，`ScriptedAiProvider` 经 harness 注入；本验收测试验证整合。若失败，按 Step 3 错误形态清单定位 Task 5/6 缺陷并修复，不是改测试绕过。

### Step 3：无新生产文件（错误形态检查清单）

- owner resolve 返回非 201 或 run.status 非 succeeded（claim/formal apply 顺序错）。
- player 能调用 `POST /ai/turns/:turnId/runs` 或 `POST /archives/:id/restore`（应 `FORBIDDEN`）。
- entries 投影泄漏他人 private 或 owner_only（`projectEntries` 过滤失效）。
- run 详情 player 可读（应 `FORBIDDEN`）。
- 自动存档缺 `label=null`/`kind=automatic`/version 不为 1；下一回合 number 复用（`maxTurnNumber` 未包含 superseded）。
- provider throw 时出现半截 entries/archive/next turn/turn.resolved（fail tx 未整体回滚）。
- 同 key 重试再次调用 provider（idempotency 失效）。
- 恢复后 `archive.restored` 事件被本次 supersede（事件须在 supersede 后 publish）。
- DTO 含 `*_json`/内部字段（entries/run/archive DTO 洁净断言）。

### Step 4：全量相关测试

```bash
rtk npm test -- --run server/src/tests/vertical-ai-resolution-http.test.ts server/src/tests/ai-routes-http.test.ts server/src/tests/vertical-world-outbox-turns-http.test.ts server/src/tests/vertical-characters-http.test.ts server/src/tests/authCampaignRoutes.test.ts server/src/modules/ai-runtime/ai-resolution.test.ts server/src/modules/archives/archive.test.ts server/src/modules/turns/turn.test.ts
rtk npm run typecheck --workspace server
rtk npm run build --workspace server
```

预期：垂直验收、ai-routes 集成、既有三 HTTP 垂直、ai-resolution、archive、turn 全绿；typecheck/build 通过；`007/008` 两份迁移均复制进 `dist`。全程内存 SQLite，不触碰真实 `server/dnd.sqlite`。

### Step 5：提交

```bash
rtk git add server/src/tests/vertical-ai-resolution-http.test.ts
rtk git commit -m "test: verify server-side ai vertical flow with three actors" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 本阶段验收门检查清单（全部完成后勾选）

- [ ] `007_archives.sql` 创建；`platform_archives` + `platform_archive_sequences`；既有 `platform_turns`/`platform_world_facts`/`platform_outbox_events` 增 superseded 列；既有 repository 默认 active 查询过滤 superseded；`maxTurnNumber` 包含 superseded
- [ ] `archive.restored` 事件 variant 定义（public 受众）；`archive.test.ts`/`events.test.ts`/`superseded-foundations.test.ts` 全绿
- [ ] `008_ai_runtime.sql` 创建；`platform_ai_run_sequences`（per campaign 原子计数器）+ `platform_ai_runs`（`UNIQUE turn+attempt`、`UNIQUE campaign+idempotency`）+ `platform_turn_entries`（`UNIQUE ai_run+index`）+ `platform_interaction_requests`；`ai-persistence.test.ts` 全绿
- [ ] **`aiRunStatusSchema`/`aiProviderKindSchema` 是 Phase 2A `ai.ts` 的 breaking 收敛，当前无消费点**；验收门全量 `rtk npm run typecheck`/`rtk npm test`/`rtk npm run build` 必须确认无其它模块依赖旧取值后回归通过
- [ ] `AiProviderPort`/`UnavailableAiProvider`（生产默认，resolve 安全失败 `AI_PROVIDER_FAILED`）/`ScriptedAiProvider`（测试注入，final output `unknown`）就绪
- [ ] 存档 capture/restore：manual label trimmed、automatic label=null、version 原子分配不回退、resolving 拒绝 `STATE_CONFLICT`、restore owner-only + campaign 行锁 + 单 tx + 先 supersede 再 publish `archive.restored`、completed 快照恢复开新回合（MAX+1 不复用，新回合 requirements 直接断言只含快照 approved 角色）、waiting/locked/needs_owner_attention 恢复该状态不开新回合、快照含全部角色状态（draft/pending_review/rejected/approved/archived round-trip）、快照内每个角色恰一条 `archive_restore` audit（不按字段变化去重）与快照外角色 `archive_restore_supersede` audit 齐备、setup 快照（turnNumber=0）恢复 supersede 后来 turns、idle-after-completed 快照（turnNumber=N, currentTurn=null）恢复保留 <=N 且 supersede >N 并与 outbox watermark 一致、**running AI run 但 turn 非 resolving 时 restore 第二道守卫 `STATE_CONFLICT`（独立测试）**、回滚/并发测试全绿
- [ ] AI context builder 不含 password/invite/audit/raw DB 名；validator 成员/归属校验 `AI_OUTPUT_INVALID`、重复 dice/interaction id 在 SQL 前拒绝为 `AI_OUTPUT_INVALID`；materializer 白名单 + derived/audit + world knownBy + combat `STATE_CONFLICT` 无正式写；entries 投影复用 `VisibilityPolicy`；provider 原始 Error 一律不落库（fail 持久化是严格白名单固定脱敏结构，原始 secret/URL/key/堆栈不落库、不响应）
- [ ] `AiResolutionService` claim/preview/success/fail/idempotency/retry/自动存档/下一回合全绿；provider throw → `AI_PROVIDER_FAILED`、校验/formal-apply 受控 AppError → 原码、formal-apply 未知 DB/非 AppError → `INTERNAL_ERROR`、**preview delta publish 失败 → `INTERNAL_ERROR`（非 `AI_PROVIDER_FAILED`）**（均有对应测试）；**并发同 key 语义确定性验证：首个 provider claim 后 gate 阻塞，第二个同 key resolve 立即返回 running run（created=false、provider 调用仍 1 次），放行后首个 succeeded、第三次同 key replay 返回 succeeded，全程一组 entries/archive/events**；绝不嵌套 `TurnService.transaction`；provider/stream 期间不持有 DB tx；formal apply 失败整体 rollback；post-commit reload 在 try/catch 之外（succeeded run 绝不被二次标 failed）
- [ ] HTTP 路由（ai/archives/entries/run）+ app 装配（默认 `UnavailableAiProvider`、`CreateAppOptions.aiProvider` 注入）+ harness 注入通过；跨 campaign 已知 turnId 访问 runs/entries 一律 `NOT_FOUND`
- [ ] 服务端 AI 垂直流程（create→join→approve→submit→lock→resolve→archive→project）通过；provider fail/invalid/retry/无半截写通过；A/B 隐私隔离 + owner 调试隔离成立
- [ ] `POSTGRES_TEST_URL` 门控测试（007 restore/version + 008 idempotency/claim 并发不同 key）就绪，未配置时 skip；Postgres 用例每次运行用 `randomUUID` 唯一 login，避免共享测试库残留撞 UNIQUE(login)
- [ ] `rtk npm test`、`rtk npm run typecheck`、`rtk npm run build` 全绿；Phase 2B 两级 review（计划 review + 实现 review）通过

## 已知错误形态（本阶段不得出现）

- 生产 app 默认 `Mock/ScriptedAiProvider`（必须默认 `UnavailableAiProvider`，测试 provider 只经 `CreateAppOptions.aiProvider` 注入）。
- Provider final output 直接当 `TurnResolution` 用而不经 `turnResolutionSchema.parse`。
- provider/stream 期间持有 DB tx；claim 后 provider 用旧 context 而非 claim tx 内 capture 的快照。
- idempotency 失效：同 key 再次调用 provider / 再写 entries/archive/events；failed retry 复用旧 key 而不新建 attempt。
- formal apply 拆成多个 tx 或嵌套调用 `TurnService.transaction`；任一正式写失败不整体 rollback。
- fail 后仍写半截 entries/state changes/archive/next turn/turn.resolved；`preview.failed` 未发出。
- archive version 用 `MAX+1`（必须原子 upsert+RETURNING）；恢复后 version counter 回退。
- restore 不在单 tx / 无 campaign 行锁；存在 resolving turn/running run 时仍允许恢复；`archive.restored` 被本次 supersede。
- `TurnRepository.maxTurnNumber` 过滤 superseded 导致号码复用。
- entries/run/archive DTO 泄漏 `*_json`、他人 private、owner_only、AI run 的 context/result/raw debug 给普通 player。
- 恢复把快照外角色物理删除（必须 `status='archived'`，不删审计历史）。
- 快照只存 approved 角色而丢 draft/pending/rejected/archived 完整 owner state；restore 硬编码 status='approved' 而非按快照原状态/字段 upsert；`archiveCharactersNotIn` 状态变化不写 `archive_restore_supersede` audit。
- completed 快照恢复的下一回合把 draft/pending/rejected/archived 角色也列为必需玩家（必须只取 `status='approved'` 的 playerId）。
- 恢复把未变化的快照角色也写重复 audit（`archive_restore` 对快照内每个角色都写恰一条，restore 是独立可审计动作，不按字段变化去重；`archive_restore_supersede` 只对快照外真实状态变化写）。
- setup 快照（turnNumber=0）恢复必须 supersede 所有后来 turns；idle-after-completed 快照（currentTurn=null, turnNumber=N）恢复只 supersede number > N 的 later turns，保留 <=N 的既有 completed 历史——统一用 `supersedeTurnsAfterNumber(turnNumber)` 实现（setup 的 turnNumber=0 自然覆盖全部），不要另写全量 supersede 辅助，也不要从 `currentTurn===null` 推断 supersede 全部。
- 重复 dice/interaction request id 未在 SQL 之前以 `AI_OUTPUT_INVALID` 拒绝（被 DB 错误误报 `AI_PROVIDER_FAILED`）。
- provider 原始 Error message/stack 未经严格白名单直接持久化到 error_json/raw_debug（泄漏 URL/API key/堆栈）；跨 run/跨 campaign 复用 provider 短 id（如 `i1`）撞 `platform_interaction_requests.id` 全局主键（必须用内部 nanoid 作主键、provider id 存 `provider_id` 列）。
- post-commit run 重载失败被误报为 `AI_PROVIDER_FAILED` 并给已 succeeded 的 run 补发 `ai.preview.failed`（reload 必须在 try/catch 之外；reload 丢失/null 显式抛 `INTERNAL_ERROR`，不 catch、不二次标 failed）。
- 未知 DB/formal-apply 错误被当作 `AI_PROVIDER_FAILED` 响应且状态不一致（formal apply/校验阶段非 AppError → `INTERNAL_ERROR`；provider 阶段才 → `AI_PROVIDER_FAILED`；**preview delta publish 的本地 DB 失败必须包装为受控 `INTERNAL_ERROR`，provider 阶段 catch 保留该 code，不得改判 `AI_PROVIDER_FAILED`**；fail() 必须只在 run 仍 running、turn 仍 resolving 时条件更新；失败路径不产生半截正式写）。
- 跨 campaign 已知 turnId 访问 runs/entries 未在路由层校验 `turn.campaign_id === ctx.campaignId`（必须 `NOT_FOUND`）。
- 新增错误码（本阶段只使用既有码）。
- 真实 `server/dnd.sqlite` 被写入（一律内存 SQLite）。

## 规格覆盖对照（本阶段）

| 设计成功标准 | 覆盖任务 |
| --- | --- |
| AI 流式生成公开叙事（预览事件） | Task 5（`preview.started`/`preview.delta`/`preview.failed` 事件） |
| 校验结构化 AI 结果 | Task 4/5（`turnResolutionSchema.parse` + 成员/归属/白名单校验） |
| 应用角色、世界和战斗状态（角色/世界；combat 门禁） | Task 4（`StateChangeMaterializer` 白名单；combat → `STATE_CONFLICT`） |
| 创建自动存档 | Task 3/5（formal apply tx 内 `createAutomatic`，label=null） |
| 向不同玩家发布不同可见内容 | Task 4/6（`projectEntries` 复用 `VisibilityPolicy`；owner 全量 / player public+own private） |
| AI 失败时停在拥有者处理状态 | Task 5（fail tx → `needs_owner_attention` + 保留锁定 actions + 无正式写） |
| 从存档恢复并继续战役 | Task 3（restore owner-only + 单 tx + supersede 历史 + `archive.restored`） |
| 多名玩家提交本轮行动 / 最后一名锁定 | Phase 2A 已覆盖；Task 7 垂直复用 |

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
