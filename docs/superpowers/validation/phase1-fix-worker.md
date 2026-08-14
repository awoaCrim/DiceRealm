# Phase 1 Fix Worker Ledger

- 日期：2026-08-12
- 角色：唯一 writer（forked worker）；未启动 subagents。
- 分支/HEAD：main / 641709e（未提交任何改动；staging 为空）。
- 未修改 `task_plan.md` / `progress.md` / `findings.md` / plan/spec/review 文档。
- 未创建 migration 012；001-011 SQL 内容未改（raw bytes 逐项与 baseline 一致；manifest 与 normalized-LF hash 自洽）。
- **未删除 `server/.dnd-instance.lock`（owner pid 21644 已死，但 pre-existing `tsx watch` pid 27148 仍存活，锁正保护默认 DB）；未停止任何既有进程。**
- 未启动默认 server；所有测试使用 `:memory:` 或 `mkdtemp` 临时路径。

## Fix 1 — migration-manifest-shared.mjs 严格契约（RED → GREEN）

- RED：`server/src/platform/ops/migrationManifest.test.ts` 新增 7 场景失败等价测试（rogue SQL、重复版本、重复文件名、非法 sha256、missing、extra、tamper）→ 首跑 1 failed：`.mjs` 对 rogue `.sql` 放行。
- GREEN：`server/scripts/migration-manifest-shared.mjs` 移植 runtime `assertStrictManifest`（format=1、条目形状、canonical 文件名、重复 name/version、64 位小写 hex sha256），并把非 canonical `.sql` 并入 extra 检查。
- 验证：`npx vitest run server/src/platform/ops/migrationManifest.test.ts` → 13 passed。

## Fix 2 — InstanceLock fsync（无测试 seam 变更）

- 实现：`server/src/platform/ops/InstanceLock.ts` 在 `writeFileSync(fd, ...)` 后、`closeSync(fd)` 前增加 `fsyncSync(fd)`（崩溃后不留下空/半写锁文件，避免误报“内容损坏”）。
- 未加 implementation-coupled mock（fsync 是模块级 fs 调用，spy 需要 vi.mock 整模块）；全部既有公开行为测试保留。
- 验证：`npx vitest run server/src/platform/ops/InstanceLock.test.ts` → 6 passed。

## Fix 3 — OpenAiCompatibleTransport 加固（RED → GREEN）

- RED：新增 2 个测试 → 2 failed：statusText（`sk-secret-key-123 top-secret-reason`）泄漏进错误消息；opaque-redirect（status 0 / type opaqueredirect）未按 redirect 拒绝。
- GREEN：`OpenAiCompatibleTransport.ts` 错误消息只含 status（丢弃 statusText）；在 3xx 检查之外显式拒绝 `status === 0 || type === 'opaqueredirect'`（稳定 redirect 错误，不 follow）。
- 验证：`npx vitest run server/src/modules/ai-runtime/open-ai-compatible-transport.test.ts` → 12 passed（含 fetch count=1、redaction、超时、SSE、export surface 等既有断言）。

## Fix 4 — startup/shutdown 生命周期（RED → GREEN）

- 设计：`PlatformListener` seam = `{ stopAccepting(), destroyConnections() }`；生产 `defaultListen` 用 `server.close()`（停接新连接）与 `server.closeAllConnections() + await 'close' event`（强制断连并等待完成）。coordinator 的 `shutdownAll()` 顺序：stopAccepting → realtime closeAll → destroyConnections → db.close → lock.release，每步 try/catch 异常隔离；`close.realtime`/`close.server`/`close.connections`/`close.database` 只在对应资源存在时 emit；close 幂等。新增 `appFactory` 注入 seam（供测试注入 throwing realtime）。
- 测试：更新 4 个既有事件断言，新增 4 个（stopAccepting 抛错 / realtime closeAll 抛错 / destroyConnections 抛错 / manifest 失败时无任何 close.* 资源事件）。
- 验证：`npx vitest run server/src/platform/startup/startPlatformServer.test.ts` → 11 passed。

## Fix 5 — 启动窗口内信号处理（RED → GREEN）

- 新增 `server/src/platform/startup/runServerWithSignals.ts`：启动前注册 SIGINT/SIGTERM；信号到达时等待启动 settle（成功则 close 再 exit；失败则直接 exit）；重复信号忽略；无信号且启动失败则原样抛出；`exit`/`onSignal`/`startServer` 均可注入。
- 新增 7 个测试（正常启动、启动后信号、启动中信号、启动失败+信号、启动失败无信号、双信号、env 透传）。
- `server/src/index.ts` 改为薄入口：`loadConfig()` → `runServerWithSignals(...)` → 配置完整性 probe；不再直接 open/migrate/load key。
- 验证：`npx vitest run server/src/platform/startup/runServerWithSignals.test.ts` → 7 passed。

## Fix 6 — client docstring + dev proxy

- `client/src/app/router/AppRouter.tsx`：`createAppRoutes` docstring 改为“legacy 旧入口 URL 由 catch-all NotFoundPage 处理，不 redirect”。
- `client/vite.config.ts`：删除 dev-only `'/events'` proxy，保留 `'/api'`。

## 回归与聚合验证

- `npx vitest run server/src/platform/ops server/src/platform/startup server/src/modules/ai-runtime/open-ai-compatible-transport.test.ts server/src/platform/database/database.test.ts` → 7 files / 84 passed。
- `npx vitest run server/src/tests/platform-composition.test.ts server/src/tests/legacy-sentinel-startup.test.ts server/src/platform/startup/CredentialStartupGate.test.ts client/src/app/router/router.test.tsx` → 4 files / 28 passed（初始 1 失败为 import-graph guard 命中新增 `createApp` 标识符；重命名为 `appFactory` 后通过）。
- `npx vitest run server/src` ×3：367 passed / 14 skipped（postgres gated）/ 0 failed 稳定复跑（早前 1 例间歇失败无法复现，指向 pre-existing `state-change-materializer.test.ts` 时间戳排序 flake，未触碰该文件）。
- `npx vitest run client/src` → 11 files / 105 passed / 8 skipped。
- `npm run typecheck --workspace server` → PASS；`npm run typecheck --workspace @dnd/contracts` → PASS；`npm run typecheck --workspace client` → PASS。
- `npm run build` → PASS（contracts build → clean-dist 清空 server/dist → tsc → copy-migrations 复制 11 + manifest 且 source/dist 验证通过 → client vite build）。
- staging 为空（`git diff --cached --name-only` 无输出）；无 migration 012；001-011 raw SHA-256 与实施前 baseline 完全一致。
- `server/.dnd-instance.lock` 内容未变（token 2a125d3f…）；watcher pid 27148 仍存活；未运行 `npm run dev` / `npm start`。

## 残余风险

1. `state-change-materializer.test.ts` 的 pre-existing 时间戳排序 flake（未触碰；隔离与全量复跑均通过）。
2. `server/.dnd-instance.lock` 由用户/运维在确认无 DND 进程后人工处理（父进程决定）。
3. 未运行 `npm test -- --maxWorkers=1`（root 全量，含 browser 门控）与 `npm run test:phase4-browser`（Chromium）——留给父进程/后续轮次；本 worker 已跑 server 全量 ×3、client 全量、三 workspace typecheck、root build。
4. `migration-manifest-shared.mjs` 现在与 runtime verifier 语义等价，但错误类型不同（Error vs MigrationManifestError）——契约测试按“双方都抛”断言，不要求同 class。
