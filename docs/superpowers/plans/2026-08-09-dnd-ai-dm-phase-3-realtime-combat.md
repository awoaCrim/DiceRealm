# DND AI-DM Phase 3：SSE 实时投递与结构化战斗实施计划

> 状态：首轮独立规格审查 `APPROVED`；工程质量首审及两轮针对性复审的所有 Blocker/Major 已关闭，最终结论 `PASS`。本计划已批准执行。
>
> 执行方式覆盖：总路线图的旧模板要求逐任务 commit/`rtk` 前缀；本会话遵从用户当前指令，**不 stage、不 commit、不 push**，并使用当前环境可用的普通 npm/git 命令。该偏差在 Phase 3 review 中记录。
>
> 权威范围：[`2026-08-02-dnd-ai-dm-rearchitecture-revised.md`](./2026-08-02-dnd-ai-dm-rearchitecture-revised.md) Phase 3；前置门：[`2026-08-03-phase-2b-archives-ai-runtime-review.md`](../reviews/2026-08-03-phase-2b-archives-ai-runtime-review.md) = `READY_FOR_PHASE_3`。

## 目标

在 Phase 2 的事务性 outbox、AI runtime 和真实存档之上，交付两条可运行的服务端垂直能力：

1. `GET /api/campaigns/:campaignId/events`：经 campaign 权限校验的 SSE，使用同一 outbox 数据源与同一事件投影完成断线重放和 live tail；
2. `009_combat.sql`：结构化遭遇、战斗员、白名单战斗命令、AI 战斗适配，并将战斗状态纳入自动/手动存档与恢复。

本阶段不建立前端、不删除 legacy 战斗/SSE、不新增错误码、不修改真实 `server/dnd.sqlite`。

## 已确认的测试缝

- **SSE HTTP 缝**：`GET /api/campaigns/:campaignId/events?after=<sequence>` 的状态码、响应头、SSE frame、重放、live、可见性和断开清理。
- **战斗命令缝**：`CombatService` 的 start/read/execute 接口和 `/api/campaigns/:campaignId/combat` HTTP 路由。
- **AI 战斗缝**：`StateChangeMaterializer` 通过 `CombatAiAdapter` 将 `kind: 'combat'` 变更映射为同一白名单命令。
- **存档缝**：`ArchiveService.createManual/createAutomatic/restore` 对 schema v1/v2 快照的行为。

测试只通过这些公开缝观察行为，不断言私有方法或内部调用次数；数据库直查仅用于验证事务、隐私和无半截写等无法从 DTO 充分观察的不变量。

## 架构决定

### A. SSE 使用 outbox polling，不使用共享 `published_at`

新增深模块 `EventStreamService`：每个订阅只维护 `{ campaignId, viewer, cursor, timer, inFlight, closed }`，通过同一个事务安全的 outbox tail reader 完成首次 replay 和后续 live tail。

`EventStreamService` 不直接用持有外层 SQLite executor 的 repository 裸读：Task 3 在 `DatabasePort` 新增 `readCommitted(work)`。SQLite 将 read work 与 write transaction 放入同一 adapter 队列，但不执行 `BEGIN IMMEDIATE`，所以读取等待已有事务 commit/rollback 后再执行且不抢写锁；PostgreSQL 用短 read-only transaction/同一 client snapshot。每个 tail 批次调用 `executor.readCommitted(reader => new OutboxRepository(reader).listAfter(...))`。两个 adapter 都用 adapter-scoped `AsyncLocalStorage<'transaction' | 'read'>` 在**入队/取 client 前**拒绝任何嵌套组合（transaction→transaction/read、read→transaction/read），抛清晰内部错误而不是等待队列；不得在已有业务 tx/read callback 内再次调用顶层端口。

轮询必须 single-flight：首次立即 `poll()`，每次 poll settle 后才用 `setTimeout` 调度下一次；禁止 `setInterval`，禁止同一订阅出现两个并行 `listAfter`。

原因：

- 当前所有事件只在业务事务内写 outbox，没有安全的 post-commit 通知端口；
- 单一 `published_at` 无法表达 owner/playerA/playerB 三种不同投影的投递状态；
- polling 让 replay/live 天然共用同一读取和 `projectEvent` 投影；
- 目标规模为每战役 2–8 人、单部署几十用户，短间隔 polling 足够且更简单可靠。

每个批次在投影/写帧之前先记住该批最后一个 sequence，并对**所有读取行**推进内部 cursor，即使事件对当前 viewer 不可见或某行 payload 损坏，避免私密事件或 poison row 让当前连接永久重复读取同一尾部。坏行的固定策略是：仅调用 `onProjectionError(sequence)` 做脱敏诊断，跳过该行并继续投递同批后续合法事件；projection error 不关闭 subscription、不调用 fatal `onError`、不修改/删除 outbox，也不把原始 payload/parse 错误发送给客户端。若坏行位于尾部且客户端先断线，下一连接可能再次跳过它，直到后续合法事件把浏览器 Last-Event-ID 推进；这不会形成定时 fatal loop。

投递语义为 at-least-once：客户端按 SSE id 去重；进程崩溃且客户端未保存最后 id 时允许重放。`after` 大于当前最大 sequence 时返回空 tail 并继续等待 live。

### B. 事件投影唯一来源

新增 `projectEvent(viewer, row)`，内部：

1. JSON parse + `campaignEventSchema.parse`；
2. 校验 payload `campaignId === row.campaign_id`、payload type 与 row type 一致；
3. 调用 contracts 已有 `canReadEvent(viewer, event)`；
4. 返回 `CampaignEvent | null`；parse/行列不一致时抛内部受控 `EventProjectionError`，不得包含原始 payload。

replay 和 live 只能调用该函数，不能分别实现过滤。

固定可见性：

- `ai.preview.started/delta/failed`：public，玩家可见；
- `interaction.requested`：目标玩家和 owner 可见；
- `owner.debug`：owner-only；事件只携带 `{ runId, kind }`，敏感正文继续由 owner-only AI run detail 查询；
- `combat.updated`：public，只携带 encounter id，客户端随后刷新战斗查询。

### C. 结构化战斗命令面

HTTP 战斗写命令 owner-only；玩家只读投影。AI-DM 通过 `CombatAiAdapter` 调用相同命令端口。战斗命令禁止任意 JSON patch。

命令语义：

- `start_encounter`：创建 preparation encounter 和至少一个战斗员；同一战役最多一个未完成 encounter；
- `roll_initiative`：空 payload；服务端使用注入 RNG 掷 d20 + `initiativeBonus`，稳定排序，进入 active 并设置首个 activeCombatantId；
- `advance_turn`：空 payload；移动到下一可行动战斗员，回绕时 round + 1；
- `apply_attack`：`{ actorCombatantId, targetCombatantId, attackBonus, damageDie, damageDice, damageBonus }`；服务端掷攻击 d20，按目标 AC 判定，命中后服务端掷伤害；`damageDie` 只允许 `d4|d6|d8|d10|d12|d20|d100`，dice 1–20，bonus 为整数；
- `apply_saving_throw`：`{ actorCombatantId, targetCombatantId, saveBonus, dc, damageOnFailure }`；服务端为目标掷 d20 + saveBonus，失败时应用非负整数 damageOnFailure；
- `apply_damage/apply_healing`：`{ actorCombatantId, targetCombatantId, amount }`，amount 为非负整数；
- `add_condition/remove_condition`：`{ actorCombatantId, targetCombatantId, condition }`，condition trim 后非空；
- `end_encounter`：空 payload；置 completed、清 activeCombatantId。

攻击/伤害/治疗/状态/豁免命令的 `actorCombatantId` 必须等于 activeCombatantId；否则 `STATE_CONFLICT`。攻击与豁免结果只能由服务端 RNG 产生，HTTP/AI 不得自报 roll/total。HP 下限 0、上限 hpMax。条件去重，移除不存在条件为幂等成功。所有状态冲突发生时，combat row 与 outbox 都不改变。

`startEncounterInputSchema` 的具体输入为：

```ts
{
  name: string;
  combatants: Array<{
    name: string;
    characterId: string | null;
    initiativeBonus: number;
    hpCurrent: number;
    hpMax: number;
    ac: number;
    conditions: string[];
    visibility: 'public' | 'player_private' | 'owner_only';
    targetPlayerId: string | null;
  }>;
}
```

`characterId`/`targetPlayerId`/`initiative` 在 DTO 中按数据库可空性为 nullable；conditions 去重并 trim。关联 character 时必须属于同 campaign 且 status=approved；`targetPlayerId` 必须是该 campaign 的 player member。Phase 3 允许 NPC 的 characterId=null。

玩家对 preparation encounter 的固定可见性：encounter 元数据（id/name/status/round）可见，因为 `combat.updated` 是 public；战斗员仍按逐行 visibility 投影。player DTO 对可见的 player_private 行保留 `visibility='player_private'`，只返回自己的 `targetPlayerId`；public/owner_only target 为 null；不可见行整体删除。

### D. 战斗可见性

战斗员增加 `visibility` + `targetPlayerId`：

- public：所有成员可见，target=null；
- player_private：owner 与目标玩家可见，target 必填；
- owner_only：仅 owner 可见，target=null。

`CombatService.get/list` 使用现有 `VisibilityPolicy.canRead`，把 target 转为 `knownBy`。玩家不会看到被过滤战斗员，也不会通过 activeCombatantId 获得隐藏战斗员 id；如果当前活动战斗员不可见，player DTO 的 `activeCombatantId` 返回 null。

### E. 存档 schema v2

既有 schema v1 必须继续可恢复。当前导出的 `archiveSnapshotSchema` 从 literal-v1 schema 变为 v1/v2 discriminated union；同时新增导出 `archiveSnapshotV1Schema`、`archiveSnapshotV2Schema` 和对应类型。现有 consumers 必须按 `schemaVersion` 显式 narrow。v2 在 v1 公共字段基础上加入必填完整 `encounters`（encounter + combatants）；新存档一律写 v2。合法 v2 若缺 encounters 必须 schema fail，并由 restore 归一为 `INTERNAL_ERROR`，不得静默按无战斗恢复。

恢复规则：

- v2：快照内 encounters/combatants upsert 并解除 superseded；快照外当前战斗历史标记 superseded，不物理删除；
- v1：视为“当时尚无平台战斗状态”，恢复时把当前 unsuperseded encounters/combatants 全部标记为快照后的历史；
- `supersedeHistory` 与 `restoreSnapshotState` 均必须按 schemaVersion 显式分支；
- combat repositories 的普通 find/list/command/validator 查询默认只返回 `superseded_at IS NULL` 的 encounter/combatant；恢复后旧 encounter id 对 HTTP 表现为 NOT_FOUND，对 AI pre-validation 表现为 AI_OUTPUT_INVALID；
- 自动存档在 AI formal apply tx 内、战斗命令之后捕获，因此保存应用后的战斗状态；
- 恢复仍先 supersede、再恢复状态、最后发布 `archive.restored`。

### F. owner.debug emit

AI 成功 formal apply 时，在 `markSucceeded` 后、turn completed 前，同一事务发布一个 `owner.debug { runId, kind: 'result' }`。不把 context/result/raw debug 塞入事件。失败继续只发 public `ai.preview.failed`；失败的 debug 可由 owner 查询 failed run detail，不额外发敏感事件。

## 数据库迁移 009

`server/src/platform/database/migrations/009_combat.sql`：

### `platform_encounters`

- `id TEXT PRIMARY KEY`
- `campaign_id TEXT NOT NULL REFERENCES campaigns(id)`
- `name TEXT NOT NULL`
- `status preparation|active|completed`
- `active_combatant_id TEXT`（不声明循环 FK，由 service 校验）
- `round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1)`
- `superseded_at TEXT`
- `superseded_by_archive_id TEXT REFERENCES platform_archives(id)`
- `created_at/updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- index `(campaign_id, status, superseded_at)`

### `platform_combatants`

- `id TEXT PRIMARY KEY`
- `encounter_id TEXT NOT NULL REFERENCES platform_encounters(id)`
- `campaign_id TEXT NOT NULL REFERENCES campaigns(id)`
- `character_id TEXT REFERENCES platform_characters(id)`（NPC 可空）
- `name TEXT NOT NULL`
- `initiative INTEGER`
- `initiative_bonus INTEGER NOT NULL DEFAULT 0`
- `hp_current INTEGER NOT NULL CHECK (hp_current >= 0)`
- `hp_max INTEGER NOT NULL CHECK (hp_max > 0)`
- `ac INTEGER NOT NULL CHECK (ac >= 0)`
- `conditions_json TEXT NOT NULL DEFAULT '[]'`
- `visibility public|player_private|owner_only`
- `target_player_id TEXT REFERENCES users(id)`
- `position INTEGER NOT NULL CHECK (position >= 0)`
- `superseded_at TEXT`
- `superseded_by_archive_id TEXT REFERENCES platform_archives(id)`
- `created_at/updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`（repository 插入/更新仍显式写 ISO 时间，避免 SQLite/Postgres 默认文本格式差异）
- `UNIQUE(encounter_id, position)`
- visibility/target CHECK 与 turn entries 同构
- indexes `(encounter_id, position)`、`(campaign_id, superseded_at)`

SQL 保持 SQLite/PostgreSQL 可移植，不使用 driver-specific 函数。

---

## Task 1：扩展 combat/archive contracts 并创建 009 迁移

**Files**

- Modify: `packages/contracts/src/combat.ts`
- Create: `packages/contracts/src/combat.test.ts`
- Modify: `packages/contracts/src/archive.ts`
- Modify: `packages/contracts/src/archive.test.ts`
- Create: `server/src/platform/database/migrations/009_combat.sql`
- Modify: `server/src/platform/database/database.test.ts`（或现有迁移测试所在文件，仅增加 009 表/连续性断言）

**依赖**

- Phase 2B contracts/outbox/archive 已完成；无代码任务依赖。

**Red**

1. combat contract 测试覆盖 10 种严格命令、未知 kind、额外字段、visibility/target 配对、encounter DTO round/characterId；
2. archive contract 测试证明 v1 仍 parse，v2 必须含 encounters，v2 combatant payload 严格；
3. migration 测试证明 009 创建两表、FK/CHECK/visibility-target/position 约束生效，普通读写 timestamp 由 repository 显式 ISO；不在 unit test 读取可能陈旧的 `dist`。

**Green**

扩展 contract：

- `combatantSchema` 增 nullable `characterId`/`initiative`/`targetPlayerId`、`initiativeBonus`，并锁定 visibility-target 配对；
- `encounterSchema` 增 `round`；
- `startEncounterInputSchema` 使用架构决定 C 中已枚举的字段；
- `combatCommandSchema` 使用 `{ kind, payload }` discriminated union，payload 字段严格采用架构决定 C；
- `archiveSnapshotV1Schema` 保留；新增 `archiveSnapshotV2Schema`；`archiveSnapshotSchema = discriminatedUnion(schemaVersion, [v1,v2])`。

命令 payload 必须 `.strict()`，所有 amount 为非负整数，actor/target id 非空。

**Verify**

```bash
npm test -- packages/contracts/src/combat.test.ts packages/contracts/src/archive.test.ts server/src/platform/database/database.test.ts
npm run typecheck --workspace server
npm run build --workspace server
test -f server/dist/platform/database/migrations/009_combat.sql
```

---

## Task 2：实现 CombatRepository、CombatService、投影和存档 v2

**Files**

- Create: `server/src/modules/combat/CombatRepository.ts`
- Create: `server/src/modules/combat/CombatService.ts`
- Create: `server/src/modules/combat/combat.test.ts`
- Modify: `server/src/modules/archives/ArchiveService.ts`
- Modify: `server/src/modules/archives/archive.test.ts`

**依赖**

- Task 1 contracts 与 009 migration。

**接口**

```ts
export interface CombatCommandPort {
  applyIn(
    tx: QueryExecutor,
    campaignId: string,
    encounterId: string,
    command: CombatCommand,
  ): Promise<Encounter>;
}

export class CombatService implements CombatCommandPort {
  constructor(
    executor: DatabasePort,
    outbox: EventPublisherPort,
    random?: () => number,
  );

  start(ctx: CampaignAuthContext, input: StartEncounterInput): Promise<Encounter>;
  execute(ctx: CampaignAuthContext, encounterId: string, command: CombatCommand): Promise<Encounter>;
  get(ctx: CampaignAuthContext, encounterId: string): Promise<Encounter>;
  list(ctx: CampaignAuthContext): Promise<Encounter[]>;
  applyIn(tx: QueryExecutor, campaignId: string, encounterId: string, command: CombatCommand): Promise<Encounter>;
}
```

`start_encounter` 只经 `start()`，`execute/applyIn` 若收到 start 命令以 `VALIDATION_ERROR`（HTTP/service）或由 adapter 转换为 `AI_OUTPUT_INVALID` 拒绝。

**Red/Green 垂直循环**

1. owner start → preparation + combatants + `combat.updated` 同 tx；player start → FORBIDDEN；同 campaign 第二个未完成 encounter → STATE_CONFLICT；character/targetPlayer 归属和 visibility 配对受控拒绝；
2. roll initiative 使用注入 RNG，排序稳定（total desc，平手按原 position/id），状态 active；attack/save 同样使用服务端 RNG 并覆盖命中/未命中、豁免成功/失败；initiative reorder 与 archive restore 的 position 重排必须两阶段执行（先把同 encounter positions 整体加安全 offset，再写最终 0..n-1），避免 `UNIQUE(encounter_id, position)` 的瞬时冲突；攻击最终伤害 `max(0, diceTotal + damageBonus)`，负总值不得治疗目标；
3. advance turn 与 round 回绕；
4. attack/damage/heal/save/condition 命令，非活动 actor → STATE_CONFLICT 且数据库/outbox 都无变化；
5. end encounter；
6. owner/player 投影、preparation 元数据可见性、targetPlayerId 遮罩、跨 campaign 隐藏；所有普通 repository find/list/load 默认过滤 encounter/combatant `superseded_at IS NULL`；
7. archive v2 round-trip；v2 缺 encounters → INTERNAL_ERROR；v1 restore supersede 当前战斗；快照内解除 superseded、快照外标记历史；恢复失败整体回滚；
8. 创建/更新时间显式写 ISO，不依赖数据库默认格式。

每个写命令均在一个 transaction 内完成 campaign 行锁、active-only 归属/状态校验、写入和 `combat.updated` publish。`applyIn(tx,...)` 只复用调用方 formal apply tx，不再开 transaction。

**Verify**

```bash
npm test -- server/src/modules/combat/combat.test.ts server/src/modules/archives/archive.test.ts
npm run typecheck --workspace server
```

---

## Task 3：实现统一投影的 SSE replay/live

**Files**

- Modify: `server/src/platform/database/DatabasePort.ts`
- Modify: `server/src/platform/database/SqliteDatabaseAdapter.ts`
- Modify: `server/src/platform/database/PostgresDatabaseAdapter.ts`
- Modify: `server/src/platform/database/databaseContractSuite.ts`
- Modify: `server/src/platform/database/database.test.ts`
- Modify: `server/src/platform/events/OutboxRepository.ts`
- Create: `server/src/platform/realtime/EventProjection.ts`
- Create: `server/src/platform/realtime/EventStreamService.ts`
- Create: `server/src/platform/realtime/event-stream.test.ts`
- Create: `server/src/routes/eventRoutes.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/tests/httpTestHarness.ts`
- Create: `server/src/tests/realtime-events-http.test.ts`

**依赖**

- Task 1 outbox row contract；可与 Task 2 独立实现，但按单写入通道串行执行。

**接口**

```ts
export interface EventStreamOptions {
  pollIntervalMs?: number;      // production default 250
  batchSize?: number;           // default 200
  heartbeatIntervalMs?: number; // route production default 15_000，测试可注入短间隔
}

export interface EventFrame {
  event: 'campaign';
  id: number;
  data: CampaignEvent;
}

export interface EventSubscription {
  close(): void;
  flush(): Promise<void>;    // deterministic tests
}

export interface EventBatchReader {
  listAfter(campaignId: string, after: number, limit: number): Promise<OutboxEventRow[]>;
}

export interface EventStreamRuntime {
  service: EventStreamService;
  closeAll(): void;
}

/** 每次读取用 DatabasePort.readCommitted 的 QueryReader，在 SQLite 事务队列后读取 committed snapshot 而不抢写锁。 */
export class TransactionalOutboxTailReader implements EventBatchReader {
  constructor(executor: DatabasePort);
}

export class EventStreamService {
  constructor(reader: EventBatchReader, options?: EventStreamOptions);
  subscribe(input: {
    campaignId: string;
    viewer: EventViewer;
    after: number;
    onFrame(frame: EventFrame): boolean | void; // false = backpressure，立即关闭，客户端重连补发
    onProjectionError?(sequence: number): void; // 仅诊断，不带 payload
    onError(error: unknown): void;              // reader/timer fatal error
  }): EventSubscription;
}
```

`DatabasePort.readCommitted(work)` 是 Task 3 的窄平台扩展：新增只暴露 `query` 的 `QueryReader`（不能 `execute`）。SQLite read/write 共用单一 FIFO，Postgres 用 `BEGIN READ ONLY` + 同一 client + COMMIT/ROLLBACK。两个 adapter 都必须复用/扩展 adapter-scoped AsyncLocalStorage guard：任何 active `transaction`/`read` callback 内调用顶层 `transaction()` 或 `readCommitted()`，都在入队/checkout 前立即 reject，覆盖 transaction→read、read→transaction、read→read 和既有 transaction→transaction，绝不能静默挂起或污染后续队列。shared database contract suite 覆盖 query-only API、三个新增嵌套方向都快速失败、失败后 adapter 继续服务、并发 read 绝不看见未提交或 rollback 行；SQLite-specific contract 额外覆盖 read 在暂停中的前序 write transaction commit/rollback 前不 resolve。Postgres 多连接可先返回旧 snapshot，因此不得跨 engine 断言 read 一定等待 writer settle。

`OutboxRepository.listAfter(campaignId, after, limit)`：只读 active（`superseded_at IS NULL`）事件，`sequence > after` 升序，带 LIMIT。生产只能由 `TransactionalOutboxTailReader` 在 `readCommitted` callback 中调它；不得从长期持有的外层 SQLite executor 裸读。

**Red/Green 垂直循环**

1. `projectEvent` owner/player/private/debug/preview/failed 过滤；payload/row campaign 或 type 不一致生成不含原始 payload 的受控 projection error；
2. replay after、after>max 空 tail、批量 drain、不可见尾部 cursor 前进、superseded gap；poison row 在批次 cursor 已推进后仅报告其 sequence 并跳过，后续合法事件仍投递，下一 poll 不重读；
3. live flush/poll 无缺失无重复；用延迟 reader 证明 single-flight、禁止重叠 poll；close 后停止 timer/写入；
4. HTTP 未登录 401、非成员 404；query/header cursor 非 safe integer 或负数 → 400，`?after` 存在时优先于 `Last-Event-ID`；
5. SSE 立即 `flushHeaders()`；headers/frame 格式；空闲每 15 秒 `: ping\n\n`；`res.write` 返回 false 时关闭 subscription 并 destroy response，依靠最后成功 id 重连补发；
6. owner/playerA/playerB 重放隐私；public preview 和 failed 对玩家可见，owner.debug 不泄漏；
7. close 测试必须先真实读到至少一个 SSE frame，再证明主动 abort 与测试服务器关闭均不挂起；
8. SQLite 可见性回归：业务 tx 插入 outbox 后暂停再 rollback，期间并发 flush 不得 resolve/投递未提交行；commit 情况只能在 commit 后投递。跨 engine contract 只要求并发 read 不返回未提交/rollback 行，允许 PostgreSQL 在 writer settle 前返回旧 snapshot；
9. 三个新增嵌套方向 transaction→readCommitted、readCommitted→transaction、readCommitted→readCommitted 必须在短 timeout 内以清晰错误 reject，随后普通 transaction/readCommitted 仍成功，证明无队列 poisoning。

路由设置 `Content-Type: text/event-stream`、`Cache-Control: no-cache, no-transform`、`Connection: keep-alive`、`X-Accel-Buffering: no` 并立即 `flushHeaders()`。heartbeat 只发 SSE comment，不分配 event id、不进入 outbox；测试通过可注入的短 heartbeatIntervalMs 验证，不等待生产 15 秒。若 frame/heartbeat `res.write()` 返回 false，则清理 timer/subscription 并销毁连接，禁止无限缓冲。`createApp` 的平台 composition root 只创建一个共享 `EventStreamService`/runtime；route 不得按请求 new service。runtime 跟踪 active subscriptions，`closeAll()` 幂等关闭它们；test harness 在关 DB 前必须调用，避免 timer 持有已关闭连接。

`httpTestHarness.close()` 必须先调用 realtime runtime 的 `closeAll()`，再创建并发起 `server.close()` promise、调用 `server.closeAllConnections()`，最后 await close callback 并关闭 DB。该共享行为变更须有现有 HTTP harness 回归测试/全量测试兜底。SSE 测试主动 abort reader，server close 仅作为兜底。

**Verify**

```bash
npm test -- server/src/platform/database/database.test.ts server/src/platform/realtime/event-stream.test.ts server/src/tests/realtime-events-http.test.ts
npm run typecheck --workspace server
```

---

## Task 4：AI 战斗适配、上下文、owner debug 和 HTTP 战斗路由

**Files**

- Create: `server/src/modules/combat/CombatAiAdapter.ts`
- Create: `server/src/modules/combat/combat-ai-adapter.test.ts`
- Modify: `server/src/modules/ai-runtime/StateChangeMaterializer.ts`
- Modify: `server/src/modules/ai-runtime/TurnResolutionValidator.ts`
- Modify: `server/src/modules/ai-runtime/AiContextBuilder.ts`
- Modify: `server/src/modules/ai-runtime/AiResolutionService.ts`
- Modify: `server/src/modules/ai-runtime/state-change-materializer.test.ts`
- Modify: `server/src/modules/ai-runtime/turn-resolution-validator.test.ts`
- Modify: `server/src/modules/ai-runtime/ai-context-builder.test.ts`
- Modify: `server/src/modules/ai-runtime/ai-resolution.test.ts`
- Create: `server/src/routes/combatRoutes.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/tests/httpTestHarness.ts`（注入 RNG/共享 realtime runtime 时保持单实例）
- Create: `server/src/tests/vertical-sse-combat-http.test.ts`

**依赖**

- Task 2 CombatService/archive v2；Task 3 EventStreamService/SSE route。

**CombatAiAdapter**

- 只接受 `change.kind === 'combat'`；
- `change.targetId` 是既有且 unsuperseded 的 encounter id；Phase 3 的 AI stateChange 不允许 start encounter（创建遭遇由 owner HTTP 明确操作）——此限制为 Phase 3 的历史范围决定，后续产品修正已放宽：AI 经结算的创建式 `encounterStarts` 字段发起遭遇（见 [2026-08-09-dnd-ai-dm-ai-world-encounter-creation.md](./2026-08-09-dnd-ai-dm-ai-world-encounter-creation.md)），stateChanges 仍保持 update-only；
- patch 必须为 `{ command: <non-start kind>, ...payloadFields }` 且严格 parse；adapter 唯一负责把它转换为 contracts 的 `{ kind: command, payload: payloadFields }`；
- parse/跨 campaign/目标不存在 → `AI_OUTPUT_INVALID`；
- 战斗状态冲突（非活动 actor、encounter 非 active 等）保持 `STATE_CONFLICT`；
- 调用 `CombatCommandPort.applyIn(tx, ...)`，因此与 AI entries、archive、turn complete 在同一 formal apply tx。

`StateChangeMaterializer` 构造函数接收 `CombatStateChangeApplier`，combat case 委托 adapter；未注入时保留 Phase 2 的 `STATE_CONFLICT`，以便隔离测试和安全默认。

`TurnResolutionValidator` 对 combat target 做 campaign 归属预校验；不解析命令细节（由 adapter 负责）。

`AiContextBuilder` 加入当前 active/preparation encounter 的 **owner projection** 结构化摘要；由于 `AiPrompt.audience='owner_only'`，owner 可见全部 unsuperseded 战斗员，player HTTP/SSE 投影规则不得反向污染 DM 上下文。

> 后续产品修正：`AiContextBuilder` 另在 prompt 中显式描述创建式 `worldFactCreations` / `encounterStarts` 字段、成员/角色 id 规则、服务端生成 id、同一结算内禁止引用新 id 以及服务端权威掷先攻（见 [2026-08-09-dnd-ai-dm-ai-world-encounter-creation.md](./2026-08-09-dnd-ai-dm-ai-world-encounter-creation.md)）。

`AiResolutionService` 成功 formal apply 发布 `owner.debug kind=result`；自动 archive 在 combat apply 后捕获 v2。

**HTTP**

- `POST /api/campaigns/:campaignId/combat` start（owner-only）
- `GET /api/campaigns/:campaignId/combat`
- `GET /api/campaigns/:campaignId/combat/:encounterId`
- `POST /api/campaigns/:campaignId/combat/:encounterId/commands`（owner-only，拒绝 start command）

全部 `Router({ mergeParams: true })` + campaign middleware + `asyncHandler`。

**Vertical acceptance**

真实内存 SQLite + owner/playerA/playerB：

1. 创建战役、加入、批准角色；
2. 三方打开 SSE；
3. owner start/initiative，收到 `combat.updated`；
4. 非活动 actor 命令 409 且无状态变化；活动 actor damage 成功；
5. owner 手动存档，修改战斗，再 restore，战斗 round-trip；
6. 锁定回合，Scripted provider 返回 combat stateChange；resolve 成功、战斗更新与 entries/archive/turn resolved 原子；
7. player 只见投影后的战斗员，SSE 不见 owner.debug；owner 可见 owner.debug；
8. 断线以最后 id 重连，无重复、补齐缺失。

**Verify**

```bash
npm test -- \
  server/src/modules/combat/combat-ai-adapter.test.ts \
  server/src/modules/ai-runtime/state-change-materializer.test.ts \
  server/src/modules/ai-runtime/turn-resolution-validator.test.ts \
  server/src/modules/ai-runtime/ai-context-builder.test.ts \
  server/src/modules/ai-runtime/ai-resolution.test.ts \
  server/src/tests/vertical-sse-combat-http.test.ts
npm run typecheck
npm run build
```

---

## Task 5：稳定旧随机测试、全量验收和文档收口

**Files**

- Modify only if reproduced: `server/src/tests/integration.test.ts` and/or legacy test setup to inject deterministic random without weakening assertions
- Modify: `docs/superpowers/plans/2026-08-02-dnd-ai-dm-rearchitecture-revised.md`
- Create: `docs/superpowers/reviews/2026-08-09-phase-3-realtime-combat-review.md`

**依赖**

- Tasks 1–4 全部通过 focused tests。

基线在 Node 24.11.1 下全量测试曾出现一个 legacy 随机 flaky：该 HTTP 验收在随机 initiative 排序后仍用固定 combatant index 发起攻击并按固定 index 读取“地精”；actor/target 身份会漂移，且某些 actor 的伤害 bonus 可使总伤害非正，导致“hit 时目标 HP 必下降”断言失败。不得删除/放宽该行为断言；若全量复现，用固定 `Math.random` 序列或 legacy seam 的注入 RNG 固定 initiative/attack/damage，使已知战士命中已知地精并造成正伤害，同时断言返回身份与 damageTotal。只有在 Phase 3 全量复现时才修改，且必须有回归证据。

最终执行：

```bash
npm test
npm run typecheck
npm run build
git diff --check
git status --short --branch
```

验收记录必须包含：

- 009 迁移进入 `server/dist`；
- SSE replay/live 同一投影与三 actor 隐私；
- 10 种命令 contract、核心命令行为与非活动 actor 门禁；
- AI combat formal apply 原子性；
- archive v1 兼容和 v2 战斗 round-trip；
- Node 24 未提交基线改动保持不被覆盖；
- Postgres 门控未运行时明确记录残余风险。

## 工作树与 Git 约束

- 当前 `.nvmrc`、`package.json`、`package-lock.json` 有用户已有 Node 24 升级改动；实现必须保留并在其上验证，不回退、不覆盖。
- `.pi/`、`.pi-subagents/` 是工具运行产物，不纳入业务改动。
- 不修改真实 `server/dnd.sqlite`。
- 用户未要求提交：本次实现不得 `git add`、不得 commit、不得 push。

## 完成定义

Phase 3 只有在以下全部成立时完成：

- SSE 权限、replay、live、断线重连、投影和清理测试通过；异步 poll single-flight，poison row 不形成定时错误循环，SQLite 不投递未提交/回滚事件；
- 009 两表与约束存在并进入 build 产物；
- combat commands 严格白名单，非活动 actor `STATE_CONFLICT`；
- AI combat adapter 启用，Phase 2 combat gate 被安全替换；
- owner.debug 独立且玩家不可见；
- archive v1 兼容、v2 包含并恢复战斗；
- 全量 test/typecheck/build 通过（Postgres 门控允许因环境缺失而 skip，但必须记录）；
- 独立规格审查与工程质量审查无 Blocker/Major；
- 总路线图 Phase 3 清单更新为完成，允许进入 Phase 4 详细计划。
