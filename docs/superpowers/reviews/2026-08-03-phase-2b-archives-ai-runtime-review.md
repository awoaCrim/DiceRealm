# 2026-08-03 阶段二 B（存档、AI 运行时与服务端 AI 垂直流程）实现复审

> 复审对象：`docs/superpowers/plans/2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md`（阶段二 B 详细计划）的 7 个小任务实现结果。
> 复审结论：**READY_FOR_PHASE_3**。
> 依据：`docs/superpowers/plans/2026-08-02-dnd-ai-dm-rearchitecture-revised.md`（权威总路线图）、`docs/superpowers/reviews/2026-08-02-phase-2a-world-outbox-turns-review.md`（阶段二 A 复审）、`docs/superpowers/reviews/2026-08-02-plan-and-baseline-review.md`（基线复审）。

## 一、阶段二 B 提交记录

Phase 2B 实现范围：`4009c95` → `60d5d43`，共 14 个 commit（7 个小任务 + 迁移原子性修复链 + 存档 hardening 与 follow-up），每个任务一个只含该任务文件的 commit，trailer 均为 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。计划文档 commit（`2ef62c3` 编写计划、`2459aab` 修正 completed-turn 幂等语义）不属于实现范围，仅列于计划侧。

| 任务 | 提交 | 说明 |
| --- | --- | --- |
| 计划 | `2ef62c3` | `docs: add phase 2b archives and ai runtime plan`——Phase 2B 详细计划初稿（4557 行）并同步总路线图状态 |
| 计划 | `2459aab` | `docs: restore completed-turn idempotency semantics`——修正计划中 completed turn 后同 key 幂等 replay 的语义表述 |
| Task 1 存档契约 + superseded 基础 | `4009c95` | `feat: add archive contracts and superseded-history foundations`——`packages/contracts/src/archive.ts` + `archive.test.ts`；`events.ts` 增 `archive.restored`（public）；`007_archives.sql`（`platform_archives` + `platform_archive_sequences` + 对 `platform_turns`/`platform_world_facts`/`platform_outbox_events` 一次性 portable `ALTER` 增 superseded 列）；`TurnRepository`/`WorldFactRepository`/`OutboxRepository` 默认 active 查询过滤 superseded；`superseded-foundations.test.ts` |
| Task 1 follow-up | `33da01a` | `test: close in-memory DBs in superseded foundations tests`——补关内存 DB，消除测试资源泄漏 |
| 迁移原子性（review-driven 高价值修复） | `72066b5` | `fix: apply migrations and tracking atomically`——`MigrationRunner` 原来把迁移 SQL 与 `platform_migrations` 跟踪 INSERT 分两步执行，崩溃后 schema 已应用但未跟踪，重启会对 007 的非幂等 `ALTER TABLE ADD COLUMN` 重复执行报 duplicate column；给 SQLite async / Postgres async / legacy better-sqlite3 sync 三个执行器加 `applyMigration`，schema 脚本与 tracking 行同事务 commit/rollback |
| 迁移原子性 | `1c25569` | `test: prove async sqlite migration rollback on tracking failure`——修复 SQLite async 回滚测试：原测试从未先 `migrate()` 建真实平台表，`ALTER TABLE users` 先因"no such table"失败成为假证明；改为先建真实表再预置重复 version，断言失败来自 UNIQUE 约束、schema 回滚、tracking 无半提交行 |
| 迁移原子性 | `a7e8d25` | `fix: harden atomic migration failure handling`——跟踪 INSERT 共享为 `PLATFORM_MIGRATION_INSERT_SQL` 防止三处漂移；ROLLBACK 失败不再掩盖原始错误；文档化 `applyMigration` 仅启动期单线程使用、不得在业务 `transaction()` 回调内调用；SQLite/Postgres 回滚测试改随机唯一 version 并在 finally 清理 |
| Task 2 AI 持久化 + provider 端口 | `fa43c72` | `feat: add ai runtime persistence and provider port`——`008_ai_runtime.sql`（`platform_ai_run_sequences` + `platform_ai_runs` 含 `UNIQUE(campaign_id, idempotency_key)`/`UNIQUE(turn_id, attempt)` + `platform_turn_entries` + `platform_interaction_requests`）；`AiProviderPort`/`UnavailableAiProvider`（生产默认，resolve 安全失败 `AI_PROVIDER_FAILED`）/`ScriptedAiProvider`（测试注入，final output `unknown`）；`AiRunRepository`/`TurnEntryRepository`；`ai-persistence.test.ts` |
| Task 3 存档捕获/恢复 | `fbe8afe` | `feat: add campaign archive capture and restore`——`ArchiveRepository`/`ArchiveService`（真实快照 schemaVersion=1 + 真实恢复 + `archive.restored` + 先 supersede 再 publish）/`archiveRoutes`；`CharacterRepository`/`TurnRepository`/`WorldFactRepository` 只读新增；`archive.test.ts`；`postgres-archives-ai.test.ts`（`POSTGRES_TEST_URL` 门控） |
| Task 3 hardening | `e6bed40` | `test: harden archive restore with superseded guards and pg cleanup`——补 superseded 守卫测试与 Postgres 用例清理 |
| Task 3 修复 | `7255d06` | `fix: reject invalid archive snapshots and return restored turn`——恢复路径增强：malformed `state_json`/schema 校验失败统一归一为受控 `INTERNAL_ERROR`（不泄漏 `SyntaxError`）；快照自身 currentTurn 为 `resolving` 的快照不可恢复（`STATE_CONFLICT`）；`restoredTurnId` 重映射（快照 turn id 已删除、同号有 replacement 时返回实际落库 id）；`running` run 但 turn 非 resolving 时第二道守卫 `STATE_CONFLICT` |
| Task 3 修复 | `95ea961` | `fix: reactivate restored archive checkpoints`——恢复后选中 archive 自身解除 superseded 成为当前 active checkpoint（DTO `superseded=false`、listForCampaign 可见），version > target 仍 superseded；同步 Phase 2B 计划文档该语义 |
| Task 4 AI 上下文/校验/投影/materializer | `268e527` | `feat: add ai context, output validation, projection and whitelist materializers`——`AiContextBuilder`（claim tx 内 capture 稳定 context 快照，不含 password/invite/audit/raw DB 名）；`TurnResolutionValidator`（成员/归属校验 + 重复 dice/interaction id 在 SQL 前以 `AI_OUTPUT_INVALID` 拒绝）；`StateChangeMaterializer`（白名单 sheet/world patch + derived/audit + world knownBy 校验 + combat 能力门禁 `STATE_CONFLICT`）；`turn-entries-projection.test.ts`（复用 `VisibilityPolicy`）；对应单测 |
| Task 5 `AiResolutionService` | `d2ecb00` | `feat: add short-transaction ai resolution service with idempotency and auto-archive`——claim/preview/success/fail 短事务 lifecycle；绝不嵌套 `TurnService.transaction`；formal apply tx 内白名单 state changes → entries/requests → run succeeded → turn completed → `turn.resolved`/`interaction.requested` 事件 → 自动存档 → 下一回合；fail tx 置 `needs_owner_attention` + `ai.preview.failed` 无半截写；provider 原始 Error 一律不落库（严格白名单脱敏）；delta publish 失败包装受控 `INTERNAL_ERROR`；post-commit reload 在 try/catch 之外；`ai-resolution.test.ts` |
| Task 6 HTTP 路由 + app 装配 | `389247f` | `feat: add ai and archive http routes with provider injection`——`aiRoutes`（runs/entries/run 只读端点 + `requireOwner` + campaign 归属校验，跨 campaign 已知 turnId → `NOT_FOUND`）；`app.ts` 挂载 + `CreateAppOptions.aiProvider` 注入（生产默认 `UnavailableAiProvider`）；`httpTestHarness` 注入；`ai-routes-http.test.ts` |
| Task 7 三 actor 服务端 AI 垂直验收 | `60d5d43` | `test: verify server-side ai vertical flow with three actors`——`vertical-ai-resolution-http.test.ts`（owner/playerA/playerB 完整 `create → join → approve → submit → lock → resolve → archive → project`，另覆盖 provider fail/invalid/retry/无半截写、A/B 隐私隔离 + owner 调试隔离） |

## 二、最终基线（2026-08-03 实测）

### 测试与构建（全量实测）

- 全量测试：`rtk npm test` → **61 files passed / 2 skipped，575 tests passed / 8 skipped**（583 总）。2 个 skipped 文件均为 `POSTGRES_TEST_URL` 未配置被 `describe.skipIf` 门控：`server/src/platform/database/postgres-contract.test.ts`（4 个契约用例 + 1 个迁移原子性用例）与 `server/src/platform/database/postgres-archives-ai.test.ts`（3 个用例：archive restore/version、008 idempotency claim、并发不同 key claim）。
- 类型检查：`rtk npm run typecheck`（server + client）通过。
- 构建：`rtk npm run build` 通过；`007_archives.sql`/`008_ai_runtime.sql` 已复制进 `server/dist/platform/database/migrations/`（实测 dist 含 `001_initial_platform.sql` 至 `008_ai_runtime.sql` 八份连续迁移，`[copy-migrations] Copied 8 migration(s)`）。
- 工作树：干净（`rtk git status` 无已跟踪/未跟踪修改）；HEAD `60d5d43`。

### 迁移与契约

- `001` → `008` 连续创建，编号无跳号；`007/008` 均进 dist。
- `007_archives.sql`：`platform_archives`（`UNIQUE(campaign_id, version)`）+ `platform_archive_sequences`；对既有三表一次性 portable `ALTER` 增 superseded 列（迁移原子性修复使其安全，见第四节偏差 1）。
- `008_ai_runtime.sql`：`platform_ai_run_sequences`（per campaign 原子计数器）+ `platform_ai_runs`（`UNIQUE(campaign_id, campaign_sequence)`/`UNIQUE(campaign_id, idempotency_key)`/`UNIQUE(turn_id, attempt)`）+ `platform_turn_entries`（`UNIQUE(ai_run_id, entry_index)` + visibility/target 不变量 CHECK）+ `platform_interaction_requests`（DB 主键内部 nanoid、provider id 存 `provider_id` 列）。
- 存档真实快照 + 真实恢复：快照 schemaVersion=1 含 campaignId/ruleset/全部角色完整 owner current state（draft/pending_review/rejected/approved/archived round-trip）/active world facts/current turn+actions+requirements/watermarks；restore 单 tx + campaign 行锁 + owner-only + 先 supersede 再 publish `archive.restored`；快照内角色恰一条 `archive_restore` audit、快照外角色真实状态变化写 `archive_restore_supersede` audit；setup（turnNumber=0）与 idle-after-completed（turnNumber=N）快照统一用 `supersedeTurnsAfterNumber(turnNumber)`。
- AI runtime 短事务 lifecycle：claim tx（campaign/turn 行锁 + idempotency 查重 + attempt 单调 + context 快照 + run=running + turn=resolving + `preview.started`）→ provider tx 外运行（每个 delta 独立短 tx publish）→ 成功一个 formal apply tx 或失败一个 fail tx；同 key 幂等返回既有 run 不再调 provider；failed retry 必须新 key（attempt=2）。
- 全流程内存 SQLite，无真实 `server/dnd.sqlite` 写入。

## 三、验收门逐项核对

| 验收门 | 状态 | 核对结果 |
| --- | --- | --- |
| `007_archives.sql` 创建；真实快照 + 真实恢复；恢复后 superseded；manual label trimmed / automatic label=null；per-campaign version 原子分配 | ✅ | `platform_archives` + `platform_archive_sequences`；快照真实（全角色状态/事实/回合/watermarks）；restore 真实恢复（characters upsert + audits、facts upsert、turn 状态恢复、completed 快照开新回合 MAX+1 含 superseded 不复用、requirements 只取快照 approved 角色）；superseded 不物理删除；`archive.restored` public 受众；version 原子 upsert+RETURNING 绝不 MAX+1（回滚/并发测试覆盖） |
| `008_ai_runtime.sql` 创建；AI 状态机 locked→resolving→completed / needs_owner_attention；失败不写半截日志、不重复应用 | ✅ | `platform_ai_runs`/`platform_turn_entries`/`platform_interaction_requests`/`platform_ai_run_sequences`；claim 置 resolving、formal apply 置 completed 或 fail tx 置 needs_owner_attention；fail 无半截 entries/state changes/archive/next turn/turn.resolved；同 key 幂等返回既有 run（含 succeeded 后 replay）且不调 provider |
| 服务端 AI 垂直流程（create→join→approve→submit→lock→resolve→archive→project）通过；combat 门禁；生产默认 `UnavailableAiProvider` | ✅ | 三 actor HTTP 垂直验收（`60d5d43`）覆盖完整流程 + provider fail/invalid/retry/无半截写 + A/B 隐私隔离 + owner 调试隔离；`combat` stateChange 以 `STATE_CONFLICT` 门禁拒绝（`StateChangeMaterializer`，无正式写）；生产默认 `UnavailableAiProvider`（resolve 安全失败 `AI_PROVIDER_FAILED`），`ScriptedAiProvider` 只经 `CreateAppOptions.aiProvider` 注入 |
| typecheck/build 通过；两级 review 通过 | ✅ | 全量 61 files / 575 passed；typecheck（server+client）/build 通过；`007/008` 进 dist；两级 review（计划 review：`phase2b-plan-spec-review`/`phase2b-plan-quality-review`；实现 review：T1-T7 各 task 的 spec/quality review 子代理 + `phase2b-final-gate-review`）通过，结论 FINAL_GATE_PASS / READY_FOR_PHASE_3 |
| 详细计划已编写 | ✅ | `2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md` 已编写并已执行完毕（`2ef62c3` + `2459aab` 编写，实现锁定于 `60d5d43`），不再作为待执行计划 |

## 四、实现过程发现并修复的高价值偏差（全部修复，纳入后续阶段基线）

1. **迁移 `applyMigration` 原子性**（`72066b5` + `1c25569` + `a7e8d25`）：`MigrationRunner` 原来把每个迁移的 SQL 与 `platform_migrations` 跟踪 INSERT 分成两步执行，两步之间崩溃会留下「schema 已应用但未跟踪」的状态，重启会对非幂等 DDL（`007` 的 `ALTER TABLE ADD COLUMN`）重复执行并报 duplicate column。修复为给 SQLite async / Postgres async / legacy better-sqlite3 sync 三个执行器统一加 `applyMigration`，schema 脚本与 tracking 行在同一数据库事务内 commit/rollback；跟踪 INSERT 语句共享为导出的 `PLATFORM_MIGRATION_INSERT_SQL` 防止三处漂移；`ROLLBACK` 失败不再掩盖原始错误；`applyMigration` 文档化为启动期单线程专用、不得在业务 `transaction()` 回调内调用。测试真实证明两个 SQLite 路径回滚（先建真实平台表再预置重复 version，失败来自 UNIQUE 约束而非缺表，schema 回滚、tracking 无半提交行）与门控 Postgres 等价用例。属于解决根因的架构性修复，与长期可维护性原则一致。
2. **archive snapshot `resolving` guard + malformed JSON 归一 + `restoredTurnId` 重映射**（`7255d06`）：恢复路径有三处加固——(a) malformed `state_json` 与 schema 校验失败统一归一为受控 `INTERNAL_ERROR`，不把 `SyntaxError` 细节泄漏上 HTTP；(b) 快照自身 currentTurn 为 `resolving` 的快照不可恢复（即使 live DB 无 resolving turn / running run 的外部构造快照也拒绝 `STATE_CONFLICT`）；(c) `restoredTurnId` 返回实际落库的 turn id——同 number 已有 replacement id（快照 turn id 已被删除）时返回 `existing.id` 而非快照里的 `current.turn.id`，completed 快照返回新建 waiting turn id。另有第二道守卫：`running` AI run 但 turn 非 resolving 时 restore 同样拒绝（覆盖人工改库的异常窗口，独立测试）。已修复并被 archive.test 覆盖。
3. **archive reactivation**（`95ea961`）：恢复后选中 archive 自身解除 superseded 成为当前 active checkpoint（DTO `superseded=false`、`listForCampaign` 可见），`version > target` 的存档仍 superseded；产品语义为「选中的存档成为当前状态」。同一 commit 同步 Phase 2B 计划文档该语义描述，避免文档与实现漂移。
4. **其余计划内决策落地说明**（非偏差，均为按计划实现）：`owner.debug` 事件本阶段只存 `raw_debug_json` 不 emit（Phase 3 再决定 realtime）；provider 原始 Error 一律不落库（fail 持久化是严格白名单固定脱敏结构，测试断言原始 secret 与 raw 文本不落库）；interaction request DB 主键用内部 nanoid、provider id 存 `provider_id` 列（跨 run/跨 campaign 复用 `i1` 之类短 id 不会撞全局主键）；`ai.preview.*`/`ai.preview.failed` 对 player 可见的受众语义沿用 `eventDefaultAudience`/`canReadEvent`；preview delta publish 的本地 DB 失败包装为受控 `INTERNAL_ERROR` 而非 `AI_PROVIDER_FAILED`；post-commit run 重载在 try/catch 之外（succeeded run 绝不被二次标 failed、不补发 `ai.preview.failed`）；跨 campaign 已知 turnId 访问 runs/entries 在路由层返回 `NOT_FOUND`；`aiRunStatusSchema`/`aiProviderKindSchema` 是 Phase 2A `ai.ts` 的 breaking 收敛，验收门全量回归确认无其它模块依赖旧取值。

## 五、非阻断观察（不阻塞进入 Phase 3，后续阶段与测试需留意）

1. **Postgres 门控尚未真实运行**：`POSTGRES_TEST_URL` 未配置，8 个用例全部跳过（`postgres-contract.test.ts` 5 个 + `postgres-archives-ai.test.ts` 3 个，涵盖迁移原子性、archive restore/version、008 idempotency claim 与并发不同 key claim）。契约与门控用例代码已就绪，建议部署 Postgres 环境后实际跑一次确认占位符重写、驱动行为与 007/008 门控用例（Postgres 用例已用 `randomUUID` 唯一 login/资源并 finally 清理，避免共享测试库残留）。
2. **既有随机骰子测试曾观察 flaky**：legacy `diceService.test.ts`/`combatService.test.ts` 用 `vi.spyOn(Math, 'random').mockReturnValueOnce(...)` 序列 mock 随机骰子，mock 调用次数/顺序与实现内部 `Math.random` 调用数敏感，实施过程中个别运行曾观察到失败，但最终全量 run（61 files / 575 passed）全绿，未阻塞本阶段。Phase 3 若继续扩展随机相关测试（战斗先攻/伤害），需注意固定 RNG 或 mock 隔离，避免复现该脆弱性。
3. **`owner.debug` 事件仍未 emit**：本阶段只把 `raw_debug_json` 落库（owner-only AI run view），不发射事件；Phase 3 SSE 时需决定 owner 调试事件（独立事件、绝不出现在玩家流）的 realtime 时机。
4. **自动存档 outbox watermark 一致性设计**：formal apply tx 内 `turn.resolved`/`interaction.requested` 先插入，`captureSnapshot` 的 `maxOutboxSequence` 在事务内读取故自动包含这些正式事件；恢复时先 supersede 再 publish `archive.restored`（其 sequence > watermark，不被本次恢复 supersede）。Phase 3 SSE live/replay 必须沿用同一投影与同一事件数据源。
5. **时间戳毫秒精度**（Phase 2A 观察项延续）：涉及 `updatedAt` 变化的断言依赖测试内 5ms sleep 保证不同毫秒；后续阶段涉及时间戳比较的断言需注意同一精度限制。

## 六、复审结论

- **READY_FOR_PHASE_3**：阶段二 B 7 个小任务全部完成，实现范围 `4009c95` → `60d5d43` 共 14 个 commit 落地；最终基线可复现（全量 61 files / 575 passed、8 skipped 均为 Postgres 门控；typecheck/build 通过；`007/008` 迁移进 dist；工作树干净；HEAD `60d5d43`）；三 actor 服务端 AI 垂直验收锁定完整 `create → join → approve → submit → lock → resolve → archive → project` 流程、provider fail/invalid/retry/无半截写、A/B 隐私隔离 + owner 调试隔离、combat 能力门禁与生产默认 `UnavailableAiProvider`。Phase 2 总体验收（服务端 AI 垂直流程 + 两级 review）完成。
- 偏差 3 项（迁移原子性、archive resolving guard/malformed JSON/restoredTurnId、archive reactivation）均已修复并纳入后续阶段基线，均改善长期可维护性。
- 非阻断观察 5 项已记录，供 Phase 3 详细计划与后续全量回归参考。

## 七、下一步

- 按总路线图，**只有 Phase 2 完成并通过复审后才编写 Phase 3 详细计划**；现满足该条件，**允许编写 Phase 3 详细计划（由下一任务负责，本复审不编写，也不伪称 Phase 3 已实现或计划已完成）**。
- **Phase 3 实现范围**（SSE 实时投递 + 结构化战斗，迁移 `009_combat.sql`）：SSE 投递与断线重连（`GET /api/campaigns/:campaignId/events?after=<sequence>`，campaign middleware 鉴权，outbox 重放 + live 推送同一 `projectEvent` 投影，SSE 帧 `event: campaign` + `id: <sequence>`）；`009_combat.sql`（`platform_encounters` + `platform_combatants`，白名单 `combatCommandKindSchema` 命令、非活跃战斗员 `STATE_CONFLICT`）；`CombatAiAdapter` 把 `kind: 'combat'` 的 stateChange 映射为白名单命令并注入 `AiResolutionService`，同时**移除 Phase 2 的 combat 能力门禁**。Phase 3 详细计划必须满足事件可见性固定决策（公开预览对 player 可见、`ai.preview.failed` 对 player 可见、owner 调试走独立事件、live 与 replay 同一投影），并复用本复审第五节观察项。
