# Phase 1 Final Fix Worker Ledger

- 日期：2026-08-12
- 角色：唯一 writer（delegated subagent）；未启动 subagents。
- 分支/HEAD：main / 641709e（未提交任何改动；staging 为空）。
- 未修改 `task_plan.md` / `progress.md` / `findings.md` / plan/spec/review 文档。
- 未创建 migration 012；001-011 SQL 内容未改（build 的 copy/verify 以同一 manifest 通过）。
- **未删除 `server/.dnd-instance.lock`（内容未变，token 2a125d3f…）；未停止 pre-existing `tsx watch` pid 27148（仍 alive）。**
- 未启动默认 server；所有测试使用 `:memory:`、`mkdtemp` 临时路径或临时 HTTP 端口。

## Fix 1 — startPlatformServer：close.lock 只在锁确实取得时发出（RED → GREEN）

- RED：`startPlatformServer.test.ts` 第二实例用例新增断言 `events === []`；旧实现无条件 `emit('close.lock')` → 得到 `['close.lock']`，RED。
- GREEN：`shutdownAll` 末段改为 `if (lock !== null) { lock.release(); emit('close.lock'); }`。
- 保留：manifest 失败（acquire 成功后）仍发出 `close.lock`（既有 `['lock.acquire','close.lock']` 断言不变）。

## Fix 2 — runServerWithSignals：粗粒度诊断 + 非零退出（RED → GREEN）

- RED：新增/改写两个用例：启动失败 + 信号 → 期待 `exit(1)` + report；close 拒绝 → 期待 `exit(1)` + report 且无堆栈；旧实现 `exit(0)` 且吞掉错误 → RED。
- GREEN：`RunServerWithSignalsOptions` 增加 `reportError` 注入 seam（默认 `console.error`）；`coarseErrorMessage` 只取 `.message`（截断 200 字符），不打印堆栈/密钥；handler 在 startup 失败时报告并 `exit(1)`，在 `server.close()` 拒绝时报告并 `exit(1)`。
- 保留：正常优雅信号关闭仍 `exit(0)`；无信号启动失败仍原样 rethrow；重复信号仍忽略。

## Fix 3 — 生产 listener seam 的真实 Node 覆盖（RED → GREEN）

- RED：新文件 `server/src/platform/startup/defaultListen.test.ts` 导入未导出的 `defaultListen` → 模块成员缺失，RED。
- GREEN：`defaultListen` 改为 `export`；`PlatformListener` 增加可选 `readonly server?: HttpServer`（仅测试/观测）；'listening' 后 `server.removeListener('error', onError)`，post-listen 错误不再被 settled promise 吞掉。
- 测试（真实 Node server + raw socket 保持打开的请求）：`stopAccepting` 后新连接被拒、保持请求不断；`destroyConnections` 关闭保持连接并等待 server 'close' 解析；`listener.server.listenerCount('error') === 0`。

## Fix 4 — Provider URL boundary（RED → GREEN）

- RED：新增 2 用例：`/v1?token=secret` 与 `/v1/?token=secret#frag` 最终请求 URL 必须为 `https://proxy.example/v1/chat/completions`（无 query/hash、一次 fetch）；无效 URL 必须抛 `OpenAiCompatibleTransportError` 且 0 次请求。旧实现 `replace(/\/*$/,'/')` join 会丢 `/v1` 或保留 query → RED。
- GREEN：`chatCompletionsUrl` 清除 `search`/`hash`、规范化 pathname 尾斜杠后再 join；`assertSafeProviderUrl` 的 AppError 在 transport 边界统一转成 `OpenAiCompatibleTransportError`；URL 计算移入 try（timeout/abort 逻辑不变，controller/timer 保留）。
- 既有 `/http/i` 用例仍通过（新 message 含 HTTP(S)）。

## Fix 5 — InstanceLock partial 文件清理（RED → GREEN）

- RED：新增用例用 `vi.mock('node:fs', { spy: true })` + `vi.mocked(writeFileSync).mockImplementationOnce(throw)`；旧实现写失败后留下 wx 创建的文件 → `existsSync(lock)` 为 true，RED。
- GREEN：write/fsync 失败分支在 close fd 后 best-effort `unlinkSync(lockPath)`（本进程 wx 创建的文件）再 rethrow；EEXIST 与 token-verified release 语义不变。
- 验证方式说明：采用 vitest 4 的 `node:fs` spy 注入（模块注册表级拦截，named import 绑定被替换），仅影响单个测试文件的单次调用，不做宽泛 mock。

## Fix 6 — browser runner 残留 /events proxy（GREEN 直达）

- `scripts/phase4-browser-validation.ts` 的 Vite proxy 覆盖只保留 `'/api'`，删除 `'/events'`（与 `client/vite.config.ts` 对齐；Phase 1 断言零 legacy `/events` 请求）。

## 回归与聚合验证

- 定向（5 文件）：`npx vitest run server/src/platform/startup/startPlatformServer.test.ts server/src/platform/startup/runServerWithSignals.test.ts server/src/platform/startup/defaultListen.test.ts server/src/modules/ai-runtime/open-ai-compatible-transport.test.ts server/src/platform/ops/InstanceLock.test.ts` → 41 passed。
- 核心 seam 套件：`npx vitest run server/src/platform/ops server/src/platform/startup server/src/platform/database/database.test.ts server/src/tests/platform-composition.test.ts server/src/tests/legacy-sentinel-startup.test.ts server/src/modules/ai-runtime/open-ai-compatible-transport.test.ts` → 10 files / 100 passed。
- Server 全量：`npx vitest run server/src` → 48 passed | 2 skipped（50）files，372 passed | 14 skipped（386）tests。
- Client 全量：`npx vitest run client/src` → 11 files，105 passed | 8 skipped。
- Router/vite-config：`npx vitest run client/src/app/router/router.test.tsx client/src/vite-config.test.ts` → 11 passed。
- typecheck：server / client / @dnd/contracts 三 workspace 均 PASS。
- Root build：PASS（contracts build → clean-dist 清空 server/dist → tsc → copy-migrations 11+manifest source/dist 验证 → client vite build）。
- Root 全量：`npm test -- --maxWorkers=1` → 66 passed | 2 skipped（68）files，527 passed | 22 skipped（549）tests / 0 failed。
- Browser gate：`npm run test:phase4-browser` → 15 步全过（含 phase1 legacy URLs → NotFound、零 legacy 请求断言）。

## 完整性复核

- `git diff --cached --name-only` 为空（0 个暂存文件）。
- 无 migration 012；001-011 未改动（manifest source/dist 验证通过）。
- 默认 DB/key baseline：root `dnd.sqlite*` 与 `server/dnd.sqlite`、`server/dnd.sqlite-wal`、`server/.dnd-ai-credential-key` 全部 size+sha256 MATCH；root `.dnd-ai-credential-key` 保持 absent。
- `server/dnd.sqlite-shm` 与 baseline（33307709…）不同，但其 mtime 1786545607（14:40:07Z）与本轮运行之前的外部 watcher 打开默认 DB 的时刻一致；本轮测试仅使用 :memory:/mkdtemp/临时端口，未打开默认 DB。
- `server/.dnd-instance.lock` 内容未变；watcher pid 27148 alive。

## 残余风险

1. `state-change-materializer.test.ts` 的 pre-existing 时间戳排序 flake（未触碰该文件；本轮 root 全量 0 failed）。
2. `server/.dnd-instance.lock` 与既有 dev watcher 属于环境态，仍待用户/运维在确认进程后人工处理（不属代码缺陷）。
3. `defaultListen` 现在被导出供测试；`PlatformListener` 增加可选 `server` 观测属性——均为测试/观测 seam，coordinator 不使用。
