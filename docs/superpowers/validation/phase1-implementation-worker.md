# Phase 1 实施日志（worker）

- 日期：2026-08-12
- 分支/HEAD：main / 641709e（未提交任何改动）
- 唯一实施依据：`docs/superpowers/plans/2026-08-12-dnd-ai-dm-v1-phase1-legacy-removal.md`（已 PASS / 0 Blocker / 0 Major / 0 Minor）
- 工作树保持原有脏状态；未执行 git add/commit/amend/stash/reset/clean/checkout。

## Task 1：InstanceLock + migration manifest（GREEN）

- RED：`server/src/platform/ops/InstanceLock.test.ts`、`migrationManifest.test.ts` 模块不存在（vitest failed: Cannot find module）。
- GREEN：
  - `server/src/platform/ops/InstanceLock.ts`：`.dnd-instance.lock` + `wx` + 0600 + token-verified release；`:memory:` no-op；stale/corrupt 一律 fail closed 不自动 break。
  - `server/src/platform/ops/migrationManifest.ts` + `migrations.manifest.json`（001-011 normalized-LF SHA-256）；canonical regex `/^\d{3}_[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/` + ASCII sort；strict parser（format/duplicate name/duplicate version/sha256 格式）。
  - `server/scripts/migration-manifest-shared.mjs` + `.d.mts`（build 共享同一 contract，测试锁定两份实现一致）。
  - `MigrationRunner.ts` 改用 canonical predicate + code-unit sort；`runSync` 本 Task 暂留。
  - `copy-migrations.mjs` 重写：清 stale `.sql`/旧 manifest → 复制 → 验证 source+dist（exact set + hash）。
  - `.gitignore` 增加 `.dnd-instance.lock`。
- 验证：`npx vitest run server/src/platform/ops server/src/platform/database/database.test.ts` → 53 passed；`npm run build --workspace server` → copy-migrations 清理 11 stale + 复制 11 + manifest，source/dist 均验证通过；手动放入 `999_stale.sql`/空 manifest 后重建消失。

## Task 2：单请求 Provider transport + 删除 retry 配置面（GREEN）

- RED：`open-ai-compatible-transport.test.ts` 模块不存在；`config.test.ts`/`open-ai-compatible-resolution.test.ts` 因 `maxAttempts` 仍存在而失败。
- GREEN：
  - 新增 `server/src/modules/ai-runtime/OpenAiCompatibleTransport.ts`：单请求（fetch count 恰为 1）、timeout/abort、`redirect:'manual'` + 3xx 拒绝、URL join、Bearer、`stream:false`、API key 脱敏、错误正文 ≤1000 chars、JSON/`data:` SSE 容错解析、`fetchImpl` seam；不导出 Mock/retry/tool-calling。
  - `config.ts`/`.env.example` 删除 `AI_PROVIDER_MAX_ATTEMPTS`/`maxAttempts`；`OpenAiCompatibleAiProvider`/`createAiProvider.ts`/`AiProviderConfigService`（test() 固定 15s/temperature 0、resolve()）切到新 transport。
  - 测试更新：`config.test.ts`（断言输出对象无 maxAttempts、env 忽略该值）、`create-ai-provider.test.ts`、`open-ai-compatible-resolution.test.ts`；`ai-provider-config-service.test.ts` 新增 `test()` 恰好一次请求断言。
- 验证：8 个相关测试文件 53 passed；`npm run typecheck --workspace server` 通过；平台 production 不再 import legacy `services/aiProvider.js`（仅 legacy routes 保留到 Task 5 删除）。

## Task 3：`createPlatformApp(DatabasePort)` + harness 转换（GREEN）

- RED：`platform-composition.test.ts` 6/6 失败（旧 `createApp(raw,{platformDb})` 不满足新接口）。
- GREEN：
  - `server/src/app.ts` 原地收敛为 `createPlatformApp(options: CreatePlatformAppOptions): { app, realtimeRuntime }`；`database: DatabasePort` 必填；移除 `(app as any).realtimeRuntime` cast；无条件挂载全部平台路由；legacy `/api/admin`、`/api/player`、`/events` 不再挂载（由 404 catch-all 返回 exact JSON `{"error":{"code":"NOT_FOUND","message":"接口不存在。"}}`）。
  - `errorMiddleware.ts` 删除 legacy prefix 转发，成为统一 error boundary。
  - `SqliteDatabaseAdapter.ts` 移除 `reuseRaw`；本地 raw 类型改名 `RawSqliteConnection`（避免 `AppDatabase` token）；`createSqliteDatabase(path?)` 单参。
  - 临时平台-only `index.ts`（Task 4 被 coordinator 替换）。
  - 提前删除三个直接 import `createApp` 的 legacy 测试（integration / embeddingService / playerTurnSuggestionService）。
  - `httpTestHarness.ts` 改 `startTestPlatformServer` + `createSqliteDatabase(':memory:')`；`phase4BrowserServer.ts` 同；8 个 HTTP/vertical 测试文件同步改名。
  - `database.test.ts` 提前移除 legacy describe（冻结删除清单内容）以保持编译。
- 验证：9 个 platform/vertical 测试文件 34 passed；`npm run typecheck --workspace server` 通过。

## Task 4：startup coordinator、credential fail-closed 与 sentinel（GREEN）

- RED：`CredentialStartupGate.test.ts`、`startPlatformServer.test.ts` 模块不存在；`legacy-sentinel-startup.test.ts` 用例（旧启动会改 fixture/建 legacy 表）。
- GREEN：
  - `CredentialKeyStore.ts` 拆出 `loadCredentialCipher()` / `createCredentialCipher()`，删除 `loadOrCreateCredentialCipher`（有密文时杜绝绕过 policy）。
  - 新增 `CredentialStartupGate.ts`：密文存在 → 只 load 并 decrypt-all，missing/corrupt/wrong-key/损坏 envelope 全部 fail closed 且不写 key/不改密文；零密文 → 过渡性 load/create（`wx`+0600，EEXIST 回退 load）。
  - 新增 `startPlatformServer.ts`：lock.acquire → manifest.verify → database.open → migrate → credential gate → app.create → listen；失败路径 listener/realtime/db/lock 依次清理、锁最后 release；close 幂等（server → realtime → db → lock）。
  - `index.ts` 降为薄入口（loadConfig + coordinator + 幂等 signal close）。
  - 新增 `legacy-sentinel-startup.test.ts`：existing legacy fixture（rooms/players/characters/rule_sources/schema_migrations + index + trigger + Unicode/BLOB/null 行）在真实 pre-listen startup 后 DDL/row 快照逐项相等且平台 001-011 正常；fresh DB 不建任何 legacy 表；关闭后 lock 消失。
- 验证：startup + gate + sentinel 16 passed；server typecheck 通过。

## Task 5：删除 legacy server tree + import guard + clean-dist（GREEN）

- RED：production import-graph guard 扫描到 192 项违规（legacy routes/services/db/domain + token）；dist artifact 扫描命中旧编译产物。
- GREEN：
  - 删除 10 个 legacy routes、37 个 services、`db/connection.ts`、`db/schema.ts`、`db/seedRules.ts`、`domain/types.ts`、26 个 legacy tests（另 3 个 Task 3 已删，共 29）。
  - `DatabasePort.ts` 删除 `SyncMigrationExecutor`；`MigrationRunner.ts` 删除 `runSync()`。
  - `SqliteDatabaseAdapter.ts` 本地类型改名 `RawSqliteConnection`（去掉 `AppDatabase` token）。
  - `platform-composition.test.ts` 增加生产 import-graph guard（排除 tests）+ test-support guard（harness/fixtures）+ `server/dist` legacy artifact 扫描（routes/admin*、playerRoutes、sseRoutes、services/、db/schema、db/connection、db/seedRules、domain/types）。
  - 新增 `server/scripts/clean-dist.mjs`（只允许 `resolve(target) === resolve(serverRoot,'dist')`）；`server/package.json` build 固定为 contracts build → clean-dist → tsc → copy-migrations。
  - 两个 production 注释改写以通过计划静态扫描。
- 验证：guard 9/9 通过；`npx vitest run server/src` → 353 passed / 14 skipped；server typecheck 通过；`npm run build --workspace server` 通过（clean-dist 清空 dist、copy-migrations 复制 11 + manifest、dist 无 legacy 编译产物）。

## Task 6：删除 legacy client + NotFound + Chromium 场景（GREEN）

- RED：router.test.tsx 旧断言（/admin/room-1 显示「旧入口迁移提示」）→ 改为 NotFound 断言后失败。
- GREEN：
  - `AppRouter.tsx` 删除 `LegacyMigratePage` 与 `/admin/:roomId`、`/player/:token` 路由；旧 URL 落 catch-all `NotFoundPage`（不 redirect、无迁移提示、无 legacy 请求）。
  - 删除 19 个 client legacy 文件（根 api.ts/types.ts/displayLabels.ts、4 pages、8 components、4 测试）。
  - `client/package.json` + `package-lock.json` 移除 `marked`（唯一 consumer 已删）。
  - `phase4-browser-flow.test.ts` 追加 Phase 1 场景：guest/logged-in 访问 `/admin/room-1`、`/player/token-1` → `页面不存在`、pathname 原地、pathname exact/prefix 监听（拒绝 `/api/admin*`、`/api/player*`、`/events*`，不用 `includes('/events')`）、sanity `/` → `/login` / `/campaigns`。
- 验证：router 10/10；client 保留测试 105 passed；client typecheck 通过；`npm run test:phase4-browser` → 15 步全过（含 phase1 legacy URLs）。

## Task 7：聚合验证

- `npm test -- --maxWorkers=1`：508 passed / 22 skipped（postgres `describe.skipIf(!url)` 门控）/ 0 failed（重跑确认稳定）。
- `npm run typecheck`：PASS；`npm run typecheck --workspace @dnd/contracts`：PASS。
- `npm run build`：PASS（server clean-dist → tsc → copy-migrations source+dist 验证；client vite build）。
- `npm run test:phase4-browser`：PASS（15 步）。
- 静态扫描：production 无 `services/|db/connection|db/schema|db/seedRules|domain/types|createAdminRouter|createPlayerRouter|createSseRouter` 命中；harness/fixtures 无 legacy import；client 无 `LegacyMigratePage`。`maxAttempts` 仅剩 `config.test.ts` 中的回归断言（证明移除）与 transport 注释改写后无命中。
- migrations 001-011 内容全部未变（normalized-LF SHA-256 逐一比对）；无 migration 012。
- `git diff --cached --name-only` 为空（0 个暂存文件）。

## 默认 DB/key baseline 复核

- `dnd.sqlite` / `dnd.sqlite-wal` / `dnd.sqlite-shm`：size+sha256+mtime 全部 MATCH。
- `server/dnd.sqlite`：size 51511296 + sha256 `b0b74c55…` MATCH（主数据文件字节级未变）。
- `server/dnd.sqlite-wal`：size 107152 + sha256 `0849cfbe…` MATCH。
- `server/dnd.sqlite-shm`：**sha256/mtime DIFFERS**。证据表明是外部进程（会话开始前已运行的 node 进程，StartTime 2026-08-12 00:15 / 20:56-21:08）打开 `server/dnd.sqlite`（WAL 模式连接会重建 SHM 索引）；触发时间 22:40:07 落在本 worker 命令间隙，本 worker 全部测试仅使用 `:memory:` 或 `mkdtemp` 临时绝对路径（grep 证实无任何非临时 open）。SHM 为可重建的 WAL 共享内存索引，主 DB 与 WAL 字节均未变，数据未受影响。
- `server/.dnd-ai-credential-key`：size 45 + sha256 `63412f07…` MATCH；根目录 `.dnd-ai-credential-key` 保持 absent。
- 全程未启动默认 server；所有 startup/sentinel 测试显式使用临时 DATABASE_PATH/key path/port 0。

## 剩余风险 / 未解决

1. **pre-existing flaky**：`server/src/modules/ai-runtime/state-change-materializer.test.ts`（脏工作树既有修改文件）中 `ORDER BY created_at ASC` 且 created_at 同毫秒时间戳时行序不确定；全量运行时偶发 1 例失败，隔离/重跑均通过。非本 Phase 引入；未改该文件。
2. `server/dnd.sqlite-shm` 被外部进程重建（见上），主数据无变化。
3. Phase 1 Chromium 使用 Vite dev harness（按计划），不替代 Phase 7-8 production artifact Chromium gate。
4. 零密文自动建 key 是 001-011 过渡代理（计划 §3.6），Phase 2 enrollment/fingerprint 会替换。

## 确认

- 未执行任何 git add/commit/amend/stash/reset/clean/checkout；暂存区为空。
- 未创建 migration 012；001-011 SQL 内容未改。
- 未打开/修改默认 `dnd.sqlite*` 或真实 credential key。
