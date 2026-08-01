# 2026-08-02 计划与基线复审

> 复审对象：`docs/superpowers/plans/2026-08-01-dnd-ai-dm-rearchitecture.md` 及其后完成的基础平台实现。
> 复审结论：不回滚 Task 1-3；原计划自 Task 4 起停止原样执行，改用 2026-08-02 修订版计划。

## 一、当前基线

- 当前 HEAD：`ef2c1e3`（`feat: add account and campaign boundaries`）
- 当前分支：`main`（相对 `origin/codex/upload-initial-code` 领先 25 个提交）
- 工作树：干净（`rtk git status` 无已跟踪/未跟踪修改）
- 未做任何 stash 恢复，未修改 `server/dnd.sqlite` 等运行数据。

### Task 1-3 完成情况

| 任务 | 提交 | 说明 |
| --- | --- | --- |
| Task 1 共享 contract | `5fa0606` | `packages/contracts` workspace，`src/{auth,campaign,character,turn,combat,ai,events,errors}.ts` 与 `index.ts`，独立 dist build 与声明输出 |
| Task 2 数据库端口与迁移 | `e886580` | `DatabasePort`/`QueryExecutor`/`MigrationExecutor`/`SyncMigrationExecutor`，`SqliteDatabaseAdapter`、`PostgresDatabaseAdapter`、`MigrationRunner`、`001_initial_platform.sql`、`002_campaign_invites.sql` |
| Task 3 Identity/Campaign/权限 | `ef2c1e3` | `IdentityService`、`CampaignService`、`sessionMiddleware`、`errorMiddleware`、`AppError`、`authRoutes`、`campaignRoutes` |

### 测试与构建基线（已实测）

- 全量测试：`rtk npm test` → **430 passed / 38 files**。
- 类型检查：`rtk npm run typecheck`（server + client）通过。
- 构建：`rtk npm run build` 通过；`@dnd/contracts` 产出 `dist`（含 `.d.ts`），`server` 构建经 `tsc -p tsconfig.build.json` 后由 `scripts/copy-migrations.mjs` 把 `001/002` 两份 SQL 复制到 `server/dist/platform/database/migrations/`，client `vite build` 通过。

## 二、关键计划问题（2026-08-01 原计划）

以下问题导致原计划自 Task 4 起不宜原样执行：

1. **垂直切片太晚**：完整 `create → join → approve → submit → lock → resolve → archive → project` 验收集中在原 Task 13；前 12 个任务各自为战，长时间没有一条可运行端到端流程可验证，风险暴露过晚。
2. **Task 5 前端依赖 Task 9**：Task 5 创建 `CharacterBuilderPage.tsx`/`CharacterReviewPanel.tsx`，但前端 App Shell、路由、React Query provider（Task 9）尚不存在，产生无法挂载的孤立页面与依赖倒置。
3. **Task 6 依赖 Task 7/8**：Task 6 的 `resolveTurn` 结算在事务中"创建自动存档"（Task 7）、"发布领域事件"（Task 8 的 outbox），但这两个能力在任务顺序上更靠后，形成环状依赖。
4. **Task 5-8 缺迁移**：原计划 Task 5（角色）、Task 6（回合/行动）、Task 7（战斗/存档）、Task 8（outbox）均未定义对应 `*.sql` 迁移文件，表结构来源不明。
5. **Task 4 world 过早**：WorldService/WorldFactRepository 在回合、存档、outbox 之前实现，没有真实的"生产/消费"边界（谁读、谁写、如何投影），过早造轮子。
6. **campaign-scoped auth context 缺失**：`AuthContext` 含可选 `role/playerId/campaignId`，但原计划未定义生成方式；`sessionMiddleware` 只填 `userId`，没有任何机制解析"该用户在该战役中的角色/玩家身份"。
7. **Task 12 `INVALID_RULE_SOURCE` 未纳入 errors**：测试引用 `code: 'INVALID_RULE_SOURCE'`，但 `packages/contracts/src/errors.ts` 没有该码，测试无法通过，实现无从谈起。
8. **SSE 事件 `campaignId/sequence/auth` 未定义**：`campaignEventSchema` 仅部分事件带 `campaignId`，无每战役 sequence，无连接鉴权与重连游标定义，`outbox` 表结构也未给出。
9. **Task 5 UI 与 Task 10/11 重复**：CharacterBuilder/Review UI 在 Task 5 提前建立，与 Task 10（owner 工作区）重复维护两套入口。

## 三、已完成实现偏离原计划但应保留的项

1. **contracts 独立 dist build**：`@dnd/contracts` 用独立 `tsconfig.json` 产出 `dist`（`.js` + `.d.ts` + sourcemap），`exports` 指向 `dist`；`server` 的 `build` 先构建 contracts 再 `tsc -p tsconfig.build.json`。比原计划"直接引用 `src/index.ts`"更利于产物隔离与消费者（server/client）分别编译。
2. **AppError 与额外错误码**：`server/src/platform/http/AppError.ts` 建立统一错误类 + `DEFAULT_HTTP_STATUS` 映射；`errors.ts` 在原 10 个码之外增加了 `VALIDATION_ERROR`、`INTERNAL_ERROR`、`NOT_FOUND` 三个码（共 13 个）。错误响应体统一为 `{ "error": { code, message } }`。
3. **002 invite migration**：`002_campaign_invites.sql` 为 `campaigns` 增加 `invite_code_hash TEXT` 列（可空、可移植的 `ALTER TABLE ADD COLUMN`），库中永不保存邀请码明文。
4. **randomBytes + hash 邀请码**：`server/src/modules/campaigns/inviteCodes.ts` 用 `randomBytes(16)` 生成 128 bit base64url 邀请码，`sha256` 摘要存储，`timingSafeEqual` 校验，替代了旧的可预测派生码。
5. **server tsconfig.build**：`server/tsconfig.build.json` 用于生产构建（`rootDir: src`、排除测试），与 `tsconfig.json`（typecheck 全量含测试与 contracts 源码）分离。
6. **copy-migrations**：`server/scripts/copy-migrations.mjs` 把 `src/platform/database/migrations/*.sql` 复制进 `dist`，`MigrationRunner` 以 `import.meta.url` 相对路径发现迁移；`MigrationRunner` 跟踪表刻意命名 `platform_migrations` 以避免与旧 `schema_migrations` 冲突。

以上偏离均改善了长期可维护性，纳入修订版计划的基线。

## 四、复审结论

- **不回滚 Task 1-3**：现有提交（`5fa0606`、`e886580`、`ef2c1e3`）测试与构建全绿，架构方向（模块化单体 + 端口隔离 + 统一 contract）符合设计，回滚只会丢失正确工作。
- **原计划自 Task 4 起停止原样执行**：Task 4-14 因上文问题不再作为执行来源，仅作为历史参考保留。
- **先采用修订版计划**：`docs/superpowers/plans/2026-08-02-dnd-ai-dm-rearchitecture-revised.md` 按可运行垂直切片重排，修复上述全部问题。

## 五、风险记录

1. **真实 PostgreSQL contract test 尚缺**：`database.test.ts` 目前只真实运行 SQLite 适配器；PostgreSQL 仅测试占位符重写（`rewritePlaceholders`）。修订版 Task A 以 `POSTGRES_TEST_URL` 门控补充同一组 contract tests，无 URL 时跳过；建议在部署 PostgreSQL 环境后实际跑一次。
2. **Node / better-sqlite3 ABI 需版本约束**：`better-sqlite3` 是原生模块，Node 主版本升级可能导致 ABI 不匹配；仓库当前没有任何 `engines` 约束。修订版 Task A 在 `package.json` 固定 `engines.node` 并用测试断言运行版本满足约束。
3. **表名冲突风险**：平台迁移与旧 schema 共用同一 `dnd.sqlite`；平台新增表名（`characters`、`turns`、`actions`、`rule_sources` 等）与旧表同名，`CREATE TABLE IF NOT EXISTS` 会静默跳过导致平台仓储读取错误结构。修订版对冲突表统一使用 `platform_` 前缀，并在 Task C 起落实。

## 六、计划拆分决定

整体系统跨账号、战役、角色、世界、回合、AI、实时、战斗与前端多个子系统，单一巨型计划（此前 4081 行修订版草稿 Task A-P）无法同时保证正确性与可执行性，且其中大量未经实现验证的伪代码在复审中暴露了 P0/P1 缺陷。因此复审决定：

- **总路线图**：`docs/superpowers/plans/2026-08-02-dnd-ai-dm-rearchitecture-revised.md` 重写为权威总路线图与计划索引，只保留阶段边界、依赖、迁移连续性、验收门与硬约束，不再承载逐任务伪代码。原 Task A-P 的范围被重新划分到 Phase 1-5（Task A/B/C 对应 Phase 1；D-H 对应 Phase 2；I/J 对应 Phase 3；K-M 对应 Phase 4；N-P 对应 Phase 5）。
- **阶段一详细计划**：[`docs/superpowers/plans/2026-08-02-dnd-ai-dm-phase-1-access-characters.md`](../plans/2026-08-02-dnd-ai-dm-phase-1-access-characters.md) 是唯一立即可执行的详细 implementation plan，覆盖基线硬化、campaign-scoped access/visibility、角色后端与 HTTP 垂直验收，共 4 个小任务，均含 TDD 步骤、真实可编译测试、运行命令与指定路径 commit。
- **后续阶段详细计划按门编写**：Phase 2-5 的详细计划只能在各自前一阶段通过验收与两级 review 后再编写，避免过早生成未经实现验证的伪代码漂移。阶段边界、依赖、迁移编号（`004_world_state`、`005_events_outbox`、`006_turns_actions`、`007_archives`、`008_ai_runtime`、`009_combat`、`010_rules_providers`）与关键不可变约束（事务、visibility、idempotency、preview）已固化在总路线图中。
- **后续详细计划的硬约束**（已写入总路线图）：所有 repository 写操作可接收同一 tx；不硬编码 campaignId/owner ctx；outbox sequence 并发安全；archive 保存真实快照与真实恢复；AI locked→resolving→completed/needs_owner_attention；public preview 与 player-private 投影分离；Provider 禁止 base64/默认密钥；E2E 真实 owner + 2 玩家；每个新错误码同步 contracts + AppError map；commit trailer 精确为 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 七、阶段一完成状态（2026-08-02 追加）

- **Phase 1 已完成并通过最终审查**，审查结论 **READY_FOR_PHASE_2**，详见：[`2026-08-02-phase-1-access-characters-review.md`](./2026-08-02-phase-1-access-characters-review.md)。
- 阶段一提交范围：`62c40df` → `ddf149f` → `aa8bf8b` → `6e11c7a`（4 个 commit，覆盖基线硬化、campaign-scoped access/visibility、角色后端与 HTTP 垂直验收）。
- 最终基线：Node 22.12.0 / jsdom 28.1.0 / better-sqlite3 12.10.0；全量 `rtk npm test` 43 files passed / 1 skipped、453 tests passed / 4 skipped（Postgres contract 因 `POSTGRES_TEST_URL` 未配置跳过）；root typecheck/build 通过；工作树干净；`main` 相对 `origin/codex/upload-initial-code` 领先 30 个提交（记录时）。
- 下一步：按总路线图编写 Phase 2 详细计划（拆分 Phase 2A（world + outbox + turn，迁移 `004_world_state` → `005_events_outbox` → `006_turns_actions`）与 Phase 2B（archive + AI，迁移 `007_archives` → `008_ai_runtime`））。**Phase 2A 详细计划已编写**：`2026-08-02-dnd-ai-dm-phase-2a-world-outbox-turns.md`；Phase 2B 在 2A 完成并通过复审后编写。
