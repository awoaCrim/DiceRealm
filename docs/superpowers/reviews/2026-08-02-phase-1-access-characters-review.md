# 2026-08-02 阶段一（访问控制与角色后端）实现复审

> 复审对象：`docs/superpowers/plans/2026-08-02-dnd-ai-dm-phase-1-access-characters.md`（阶段一详细计划）的 4 个小任务实现结果。
> 复审结论：**READY_FOR_PHASE_2**。
> 依据：`docs/superpowers/plans/2026-08-02-dnd-ai-dm-rearchitecture-revised.md`（权威总路线图）、`docs/superpowers/reviews/2026-08-02-plan-and-baseline-review.md`（计划与基线复审）。

## 一、阶段一提交记录

| 任务 | 提交 | 说明 |
| --- | --- | --- |
| Task 1 可复现基线 | `62c40df` | `chore: pin node engine and gate postgres contract tests`——Node 引擎约束（`.nvmrc` + 根 `engines`）、`better-sqlite3` 固定 12.10.0、`jsdom` 固定 28.1.0、SQLite/Postgres 共用 `DatabasePort` contract suite（`databaseContractSuite.ts`）、`node-engine.test.ts`、`postgres-contract.test.ts` |
| Task 2 campaign access/visibility | `ddf149f` | `feat: add campaign-scoped access and visibility policy`——`CampaignAccess`/`resolveCampaignContext`/`requireOwner`、`VisibilityPolicy`/`ProjectionService`、`campaignMiddleware`、`sessionMiddleware` 扩展 `campaignContext` |
| Task 3 角色后端 | `aa8bf8b` | `feat: add character creation and owner review backend`——`platform_characters` + `platform_character_audits`（`003_characters.sql`）、`CharacterRepository`/`CharacterService`/`characterRoutes`、`packages/contracts/src/character.ts` 追加投影 schema、`SqliteDatabaseAdapter` 异步事务串行队列 + `database.test.ts` 并发用例 |
| Task 4 HTTP 垂直验收 | `6e11c7a` | `test: verify character HTTP vertical flow with three actors`——`server/src/tests/vertical-characters-http.test.ts`（owner/player/playerB 三 cookie jar 完整流程） |

阶段一提交范围：`62c40df` → `6e11c7a`，共 4 个 commit，每个任务一个只含该任务文件的 commit，trailer 均为 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 二、最终基线（2026-08-02 实测）

### 版本固定

- **Node**：`22.12.0`（`.nvmrc`），根 `package.json` `engines.node` 为 `>=22.12.0 <23`，`node-engine.test.ts` 静态一致性断言通过。
- **jsdom**：`28.1.0`（根 devDependency 固定）。
- **better-sqlite3**：`12.10.0`（`server/package.json` 固定，`package-lock.json` 同步）。

### 测试与构建（全量实测）

- 全量测试：`rtk npm test` → **43 files passed / 1 skipped，453 tests passed / 4 skipped**（457 总）。1 个 skipped 文件为 `postgres-contract.test.ts`（`POSTGRES_TEST_URL` 未配置被 `describe.skipIf` 门控，含其 4 个用例）。
- 类型检查：`rtk npm run typecheck`（server + client）通过。
- 构建：`rtk npm run build` 通过；`003_characters.sql` 已复制进 `server/dist/platform/database/migrations/`（实测 dist 目录含 `001_initial_platform.sql`、`002_campaign_invites.sql`、`003_characters.sql`）。
- 工作树：干净（`rtk git status` 无已跟踪/未跟踪修改）。
- 分支：`main` 相对 `origin/codex/upload-initial-code` **领先 30 个提交**（记录时）。

### 迁移与契约

- `001_initial_platform.sql`、`002_campaign_invites.sql`、`003_characters.sql`（`platform_characters` + `platform_character_audits`）连续创建，编号无跳号。
- `DatabasePort` contract suite 抽取完成：事务回滚/提交、参数化查询与 execute、迁移幂等；SQLite 真实运行，Postgres 由 `POSTGRES_TEST_URL` 门控。

## 三、计划偏差记录（全部判定合理，纳入后续阶段基线）

1. **jsdom 额外固定 `28.1.0`（commit `62c40df`）**：原计划 Task 1 只固定 `.nvmrc`/engines 与 `better-sqlite3`；实施时为消除 `jsdom` 升级触发的 **EBADENGINE** 且保留 `File.prototype.text()` 行为（client `ResourceImportPanel`/`ResourceReviewPanel` 等用 `await file.text()`），额外把根 `jsdom` 固定为 `28.1.0`。属于基线硬化的合理延伸，判定合理。
2. **Task 3 额外修改 `SqliteDatabaseAdapter.ts` + `database.test.ts`（commit `aa8bf8b`）**：原计划 Task 3 Files 不含数据库适配器；实施时发现同一 better-sqlite3 连接上并发 `transaction` 触发 `BEGIN` 冲突（`cannot start a transaction within a transaction` 裸 SQLITE_ERROR，HTTP 500）。解决方式为 per-adapter 异步事务互斥队列（前序事务 settle 后执行下一个）、嵌套事务调用立即抛清晰错误、事务失败回滚后队列继续服务；`database.test.ts` 新增 transaction serialization 三个用例（串行执行、失败后队列继续、嵌套拒绝）。修复的是 Phase 1 并发验收暴露的真实缺陷，判定合理。
3. **Phase 1 最终审查判定 READY_FOR_PHASE_2**：阶段一全部验收门通过，按总路线图流程进入 Phase 2 详细计划编写。

## 四、非阻断观察（不阻塞进入 Phase 2，后续阶段与测试需留意）

1. **`submitForReview` 并发重复提交**：幂等读（`findById`）在事务外执行，极端并发下两次重复提交可能一个成功、另一个因条件更新未命中抛 `STATE_CONFLICT`；条件更新兜底保证**无数据损坏**，属可接受行为，Phase 2 及并发测试无需特殊处理。
2. **SQLite 同连接事务中非事务读取可能看到同连接未提交状态**：同一 better-sqlite3 连接在事务内进行非事务读取时会看到该连接自己的未提交写入。平台服务遵循“读 + 状态检查 + 条件更新 + 审计在同一事务内”约定规避；跨连接/跨事务的隔离语义仍依赖 SQLite 默认隔离，Phase 2 的 outbox/存档等事务边界需继续遵守同一约定。
3. **真实 Postgres contract 仍需配置 URL 跑一次**：当前 `POSTGRES_TEST_URL` 未配置，4 个 postgres contract 用例跳过；契约套件代码已就绪，建议在部署 Postgres 环境后实际跑一次确认占位符重写与驱动行为。
4. **legacy 随机战斗测试历史 flaky**：`server/src/tests/combatService.test.ts`（随机先攻/伤害）历史上偶发失败；本次最终审查**连续两次全量运行均稳定**（43 files / 453 tests 全绿两次）。Phase 2+ 若改动相关共享依赖，建议全量回归时留意该文件。

## 五、复审结论

- **READY_FOR_PHASE_2**：阶段一 4 个任务全部完成，最终基线（Node 22.12 / jsdom 28.1 / better-sqlite3 12.10）可复现，全量测试/typecheck/build 通过，HTTP 垂直验收锁定权限与投影正确性，DTO 无敏感字段泄漏。
- 偏差 2 项均判定合理且改善长期可维护性（消除 EBADENGINE、修复并发 BEGIN 裸 500）。
- 非阻断观察 4 项已记录，供 Phase 2 详细计划与后续全量回归参考。

## 六、下一步

- 按总路线图，**只有 Phase 1 完成并通过复审后才编写 Phase 2 详细计划**；现满足该条件。
- **Phase 2A 详细计划已编写**：[`2026-08-02-dnd-ai-dm-phase-2a-world-outbox-turns.md`](../plans/2026-08-02-dnd-ai-dm-phase-2a-world-outbox-turns.md)，覆盖共享 HTTP harness 抽取、世界事实（`004_world_state`）、事件契约与事务性 outbox（`005_events_outbox`）、回合与行动（`006_turns_actions`）与三 actor HTTP 垂直验收。
- **Phase 2B（archives + AI runtime，迁移 `007_archives` → `008_ai_runtime`）在 Phase 2A 完成并通过复审后编写**。
