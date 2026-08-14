# Phase 3 复审：SSE 实时投递与结构化战斗

> 状态：**APPROVED（实施完成 + post-review Major 已修复 + 最终独立双审 PASS）**。详细计划 [`2026-08-09-dnd-ai-dm-phase-3-realtime-combat.md`](../plans/2026-08-09-dnd-ai-dm-phase-3-realtime-combat.md) 经计划级规格/工程审查批准后实施；实施后发现的 PostgreSQL 空列表 SQL Major 已通过 TDD 修复，最终规格/隐私复审与工程正确性复审均无 Blocker/Major。本评审记录实施结果、修复证据、最终验收与残余风险。

## 范围

按计划交付两条服务端垂直能力：

1. `GET /api/campaigns/:campaignId/events`：campaign 权限校验的 SSE，outbox 数据源 + 唯一 `projectEvent` 投影完成断线重放与 live tail。
2. `009_combat.sql`：结构化遭遇/战斗员、白名单战斗命令、AI 战斗适配，并把战斗状态纳入自动/手动存档 v2 与恢复（v1 兼容）。

## 实施交付

### 迁移与契约（Task 1）

- `server/src/platform/database/migrations/009_combat.sql`：`platform_encounters` + `platform_combatants`，含 FK、CHECK（hp/round/visibility-target/position）、`UNIQUE(encounter_id, position)`、`superseded_at/superseded_by_archive_id`、跨 campaign index。SQL 保持 SQLite/Postgres 可移植，时间戳由 repository 显式 ISO。构建产物 `server/dist/platform/database/migrations/009_combat.sql` 已确认。
- `packages/contracts/src/combat.ts`：`combatantSchema`（nullable characterId/initiative/targetPlayerId + initiativeBonus + visibility-target 配对）、`encounterSchema.round`、`startEncounterInputSchema`、`combatCommandSchema` 十种命令 discriminated union，payload 全部 `.strict()`，`damageDie` 白名单、dice 1–20、amount 非负。
- `packages/contracts/src/archive.ts`：`archiveSnapshotV1Schema`/`archiveSnapshotV2Schema` + `archiveSnapshotSchema` 判别联合；v2 必含 `encounters`（含战斗员，strict + visibility 配对）。

### 战斗服务（Task 2）

- `server/src/modules/combat/CombatRepository.ts`：active-only 默认查询（`superseded_at IS NULL`），恢复专用 upsert/clear/supersede 与两阶段 position 重排（含 superseded 行的 `offsetAllPositionsIncludingSuperseded`）。
- `server/src/modules/combat/CombatService.ts`：`start/execute/get/list/applyIn`；owner-only 写（`requireOwner`）；每个写命令单事务（campaign 行锁 → active-only 校验 → 命令应用 → `combat.updated` publish）；注入 RNG 掷骰（攻击/豁免/伤害/先攻）；伤害 `max(0, …)`；HP clamp `[0, hpMax]`；非活跃 actor `STATE_CONFLICT` 且 DB/outbox 无变化；player 投影用 `VisibilityPolicy.canRead`，隐藏 activeCombatantId 置 null、targetPlayerId 遮罩。
- `server/src/modules/archives/ArchiveService.ts`：新快照一律 v2（含全部 unsuperseded encounters/combatants）；`supersedeHistory`/`restoreSnapshotState` 按 schemaVersion 显式分支：v2 supersede 快照外战斗 + 快照内 upsert 解 superseded；v1 恢复把当前战斗全部标记为快照后历史。自动存档在 AI formal apply tx 内、战斗命令之后捕获。

### SSE（Task 3）

- `DatabasePort.readCommitted(reader)` + `QueryReader`（仅 query）；SQLite 与 write transaction 共用单一 FIFO（不 `BEGIN IMMEDIATE`，排队在已有事务之后，绝不见未提交/回滚行）；Postgres `BEGIN READ ONLY`。两个 adapter 都扩展 adapter-scoped `AsyncLocalStorage<'transaction'|'read'>` 在入队/checkout 前拒绝 transaction↔read 全部嵌套方向。
- `server/src/platform/realtime/EventProjection.ts`：唯一 `projectEvent(viewer, row)`（replay/live 共用）：parse + schema + campaign/type 行列一致 + `canReadEvent`；失败抛 `EventProjectionError`（不含原始 payload）。
- `server/src/platform/realtime/EventStreamService.ts`：single-flight（首次立即 poll，settle 后 `setTimeout`，禁 `setInterval`/并行 listAfter）；每批先记批次末尾 sequence，对所有读取行推进 cursor（含不可见/坏行）；poison row 仅 `onProjectionError(sequence)` + 跳过 + 继续同批后续事件；backpressure（onFrame=false）关闭；`closeAll()` 幂等。
- `server/src/routes/eventRoutes.ts`：SSE 头 + 立即 `flushHeaders`；heartbeat 仅 `: ping` comment（可注入间隔）；`res.write()===false` 清理并 destroy；cursor 解析 `?after` 优先 `Last-Event-ID`，非安全非负整数 → 400。
- `server/src/app.ts` 共享单例 realtime runtime；`httpTestHarness` 先 `closeAll()` 再 `server.close()` + `closeAllConnections()` + 关 DB。

### AI 适配与 owner.debug（Task 4）

- `server/src/modules/combat/CombatAiAdapter.ts`（`CombatStateChangeApplier`）：只接受 `kind:'combat'`，patch 为 `{ command: <非 start>, ...payload }` 严格映射到 contracts 命令，调 `CombatCommandPort.applyIn(tx,…)`（与 AI entries/archive/turn complete 同一 formal apply tx）；parse/目标不存在/跨 campaign → `AI_OUTPUT_INVALID`；战斗状态冲突保持 `STATE_CONFLICT`。
- `StateChangeMaterializer` 注入 applier；未注入保留 Phase 2 `STATE_CONFLICT` 安全默认。`TurnResolutionValidator` 对 combat target 做 campaign 归属预校验。`AiContextBuilder` 加入 owner 投影战斗摘要。`AiResolutionService` 成功 formal apply 后在 `markSucceeded` 后、turn completed 前同 tx 发布 `owner.debug { runId, kind:'result' }`。

## 验证证据

### 聚焦测试（全部通过）

| 套件 | 结果 |
| --- | --- |
| combat/archive contracts + database/migration 009 | 通过 |
| CombatService + archive v1/v2 round-trip | 通过 |
| databaseContractSuite（readCommitted/嵌套/回滚可见性）+ realtime event-stream + realtime-events HTTP | 通过 |
| CombatAiAdapter + materializer/validator/context/ai-resolution + vertical SSE+combat HTTP | 通过 |

- 全量：**Test Files 67 passed | 2 skipped；Tests 649 passed | 14 skipped（0 failed）**
- `npm run typecheck`（root）：通过
- `npm run build`（root）：通过；`server/dist/platform/database/migrations/009_combat.sql` 存在
- `git diff --check`：无错误（仅 CRLF warning）
- `git status --short --branch`：无 staged、无 commit

### 关键行为断言

- SSE replay/live 同一 `projectEvent`；owner/playerA/playerB 三 actor 隐私（`owner.debug` 不外泄）；`?after` 优先；心跳/背压/断线清理不挂起。
- SQLite 不投递未提交/回滚 outbox 行（暂停 writer + 并发 flush 回归测试）。
- 战斗命令严格白名单；非活跃 actor 409 且无状态变化；服务端 RNG 掷骰；player 只见投影战斗员、activeCombatantId 隐藏时置 null。
- archive v2 round-trip（含 combat）；v2 缺 encounters → `INTERNAL_ERROR`；v1 恢复 supersede 当前战斗；快照内解除 superseded、快照外标记历史；两阶段 position 无 UNIQUE 瞬时冲突。
- AI combat formal apply 原子（combat + entries + automatic archive + turn.resolved 同 tx）；`owner.debug` 仅 `{ runId, kind }`。
- legacy 随机 integration 测试在最终全量验收中复现后，已按计划注入测试内确定性 RNG、按名字解析战斗员索引，并保留/加强命中、身份、正伤害与 HP 必降断言；3 次隔离运行和 7+ 次全量运行连续通过。

## 残余风险

- **Postgres 门控未运行**：环境无 `POSTGRES_TEST_URL`，postgres-contract/archives-ai 套件 skip。`readCommitted`/嵌套 guard 的 Postgres 路径已按与 SQLite 相同的 ALS 语义实现但未在真实 Postgres 上验证；上线前应运行 `POSTGRES_TEST_URL=<test-db> npm test -- server/src/platform/database/postgres-contract.test.ts server/src/platform/database/postgres-archives-ai.test.ts`。
- SSE 每连接轮询 250ms：目标规模（每战役 2–8 人、几十用户）可接受；若扩大规模需评估连接上限与轮询间隔。
- 重复的并行全量运行曾出现未复现的瞬时超时；最终规格复审的首轮全量通过，后续压力重复仅在未修改的 client component 测试出现 5 秒超时且隔离运行通过，所有 Phase 3 服务端套件保持稳定。后续 CI 若复现，应按具体超时文件评估测试负载/时序，而不归因于未取得证据的 Phase 3 行为。

## 实施后复审（post-review Major）

**Major（已修复）：`CombatRepository.supersedeNotIn` 空列表生成非法 SQL `id NOT IN ()`。**

- 问题：`keptEncounterIds` 或 `keptCombatantIds` 为空时拼接出 `NOT IN ()`；SQLite 容忍，PostgreSQL 拒绝。合法 v2 快照常见 `encounters: []`（无战斗存档），且 encounter 快照可含 `combatants: []`，导致 Postgres 存档恢复失败，违反 SQLite/Postgres 可移植性。
- 修复（TDD）：
  1. RED：`server/src/modules/combat/combat.test.ts` 新增两个回归测试——公开缝 `restores a v2 no-combat archive and supersedes any later combat`（create/restore 无战斗 v2 存档，证明后续战斗被 supersede，覆盖空 encounter ids + 空 combatant ids 的 ArchiveService 路径）；repository SQL 缝 `RecordingExecutor` 桩记录 SQL 文本，证明空列表 UPDATE 不含 `NOT IN`、非空列表用参数化 `NOT IN`，并覆盖混合情形（encounter ids 非空 + combatant ids 空，及反向）。
  2. GREEN：`supersedeNotIn` 镜像 `WorldFactRepository.supersedeFactsNotIn`——空列表退化为无 `NOT IN` 条件的 UPDATE，非空列表保留参数化 `NOT IN`。
  3. 证据：修复前新增 2 个 SQL 测试失败；修复后 `npm test -- server/src/modules/combat/combat.test.ts server/src/modules/archives/archive.test.ts server/src/platform/database/database.test.ts` 77 passed；全量 `npm test` 649 passed / 14 skipped；typecheck/build 通过；`009_combat.sql` 在 dist。
- legacy 随机 flaky（`integration.test.ts`「admins can roll dice, manage combat, and view dice logs」）在修复后全量运行中复现（`expected 1 to be less than 1`，根因：initiative 随机排序后固定索引 0/2 身份漂移 + 法师 str -1 伤害可为零）——按计划以回归证据注入确定性 RNG（`vi.spyOn(Math,'random').mockReturnValue(0.95)` → 所有 d20=20、d8=8）+ 按名字解析战士/地精索引，断言返回身份与 `damageTotal>0`，原 HP 必降断言保留不弱化；RNG spy 在 `finally` 中恢复。3 次隔离 + 7+ 次全量连续通过。

## 最终独立验收

- 父会话独立复验：聚焦回归 **133/133**；全量 **649 passed / 14 skipped**；root typecheck/build 通过；`009_combat.sql` 存在于 dist；`git diff --check` 无错误；无 staged、无新 commit。
- 最终规格/隐私复审 `40d41cdf`：**PASS**，确认 former Major 的空/混合列表分支、无战斗 v2 恢复、严格命令/隐私/SSE 投影及范围约束均满足，无 Blocker/Major。
- 最终工程正确性复审 `82fa622c`：**PASS**，确认 SQL 与参数数量匹配、ArchiveService 恢复事务原子、回归测试可真实防止 `NOT IN ()` 回归、确定性 RNG 测试非 fake-green 且失败路径会恢复全局随机源，无 Blocker/Major。
- 生产入口 shutdown 窄评估 `39ae645c`：`server/src/index.ts` 未安装 signal handler 属 **Minor** 运维加固项；Node 默认终止会回收 SSE socket/timer，SQLite WAL 保证已提交事务持久性，不构成 Phase 3 完成门。

非门禁长尾：真实 Postgres 尚未运行；重复恢复对历史 position 使用固定 offset，理论上约千次同战役恢复后可能接近 Postgres `INTEGER` 上限，当前规模下记录为长期风险而非 Blocker/Major。

## 过程偏差

- 总路线图旧模板要求逐任务 commit/`rtk` 前缀；本会话遵从用户指令**不 stage、不 commit、不 push**，全部改动保留在工作树。
- `.nvmrc`/`package.json`/`package-lock.json` 的 Node 24 用户改动未被覆盖，验证运行于 Node v24.11.1。
- `.pi/`、`.pi-subagents/` 为工具产物，未纳入业务改动。
