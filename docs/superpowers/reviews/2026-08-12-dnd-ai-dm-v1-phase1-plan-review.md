# DND AI-DM v1 Phase 1 详细实施计划审查

审查日期：2026-08-12  
审查对象：[`2026-08-12-dnd-ai-dm-v1-phase1-legacy-removal.md`](../plans/2026-08-12-dnd-ai-dm-v1-phase1-legacy-removal.md)  
权威来源：

- [`2026-08-12-dnd-ai-dm-v1-decisions.md`](../specs/2026-08-12-dnd-ai-dm-v1-decisions.md)
- [`2026-08-12-dnd-ai-dm-v1-hardening-cutover.md`](../plans/2026-08-12-dnd-ai-dm-v1-hardening-cutover.md) Phase 1
- [`2026-08-12-v1-hardening-cutover-plan-review.md`](./2026-08-12-v1-hardening-cutover-plan-review.md)

## 最终结论

> **PASS / 0 Blocker / 0 Major / 0 Minor**

Phase 1 详细实施计划已经具备可执行性，可以作为后续实施的唯一 Phase 1 计划。该结论只批准计划，不代表 Phase 1 已实现；在下一次明确实施授权前不得修改业务代码。

## 审查方式

使用 fresh-context、只读 subagents 分别进行：

1. correctness / architecture / import graph / TDD 可执行性审查；
2. security / credential / Provider / 404 / 数据不变性审查；
3. operability / InstanceLock / migration artifact / build / shutdown 审查；
4. 修订后的 sequencing 与命令可执行性复审；
5. 最终 post-disposition signoff。

审查同时对照当前仓库文件核验了生产组合根、startup、legacy route/service/client inventory、test harness、MigrationRunner、Provider transport、credential key、Vitest/Playwright 收集方式及 package scripts。审查过程未修改业务文件、未运行默认数据库、未执行 Git 暂存或提交。

## 已通过的核心范围

### 1. Phase 1 边界

- 不创建或修改 migration 012；001-011 SQL 内容保持不变。
- 不实现 `platform_instance`、enrollment、fingerprint、bootstrap、secure session、CSRF、maintenance、backup/drop CLI 等 Phase 2+ 能力。
- 不删除、修改或迁移 legacy 表；只关闭 legacy runtime。
- PostgreSQL adapter 保留 experiment lane，不进入 production composition root。

### 2. Provider transport

- 从 `server/src/services/aiProvider.ts` 提取平台 OpenAI-compatible transport。
- 每个 AI attempt 至多一次 Provider 请求，删除 retry/backoff/`maxAttempts` 配置面。
- 保留 timeout/abort、`redirect:'manual'`、URL join、SSE-tolerant buffered response parse、错误正文 1000 字符预算、API Key 脱敏和 `fetchImpl` 测试 seam。
- Mock、tool-calling 和 legacy turn parser/validator 不进入平台 transport。

### 3. 平台唯一组合根

- `createPlatformApp` 只接收 `DatabasePort`，显式返回 `{ app, realtimeRuntime }`。
- production 不接受 raw `AppDatabase` 或 `reuseRaw` 双 seam。
- test harness 改为单一 `createSqliteDatabase(':memory:')`。
- Task 3 使用可编译的临时 platform-only `index.ts`，Task 4 再由最终 startup coordinator 完整替换，避免 factory rename 期间 production caller 断裂。

### 4. Legacy runtime/client 删除

- 删除 10 个 legacy routes、当前 37 个 `server/src/services/*.ts`、legacy DB/domain runtime 及对应 tests。
- `/api/admin*`、`/api/player*`、legacy `/events*` 返回 exact safe JSON 404；平台 campaign SSE 保持。
- Client 删除 legacy pages/components/root `api.ts`/`types.ts`/tests。
- `/admin/:roomId`、`/player/:token` 进入 `NotFoundPage`，不 redirect、不显示迁移提示、不调用 legacy API。

### 5. InstanceLock

- 在打开 SQLite 前，以数据目录 `.dnd-instance.lock` + `wx` 获取锁。
- token-verified release，锁持有到 DB close 后。
- Phase 1 对 live、stale、corrupt lock 一律 fail closed，不自动 break，避免 Windows unlink/PID reuse 导致双 owner。
- Phase 7 CLI 复用同一 `purpose:'server'|'cli'` 协议。

### 6. Migration artifact

- committed source manifest 是 source of truth。
- copy、verifier、MigrationRunner 使用一致的三位数字 canonical filename contract 与 deterministic order。
- SHA-256 对规范化 LF 的 UTF-8 migration 文本计算，避免 Windows `core.autocrlf` 假失败。
- build 固定为 contracts build → guarded `server/scripts/clean-dist.mjs` → tsc → copy/verify migrations。
- verifier 对 source/dist 做 exact set、missing/extra/tamper/hash 检查；dist 另做 legacy compiled artifact 负面扫描。

### 7. Credential fail-closed

- 001-011 migration 后查询全部 `platform_ai_provider_configs` ciphertext。
- 有密文时只 load 既有 key 并解密全部行；missing/corrupt/wrong key 或任意损坏 envelope 均在 listener 前失败，且不改 key/ciphertext。
- 零密文数据库允许 Phase 1 过渡性 load/create key；计划明确这不是显式 initialization，Phase 2 enrollment/fingerprint 将替换该代理。

### 8. 数据与默认文件保护

- Existing legacy-bearing temp DB：只比较 legacy objects 的 DDL 与按主键排序 rows，startup/migration 后必须完全相同；另行断言 platform 001-011 已创建。
- Fresh temp DB：不得创建 `schema_migrations` 或代表性 legacy tables。
- 测试前后记录默认 `dnd.sqlite*` 与真实 key 的 size/hash/mtime；不启动默认 server。

## 审查中发现并闭合的问题

### 已闭合的 Major sequencing 问题

1. **`MigrationRunner.runSync` 删除过早：**已改为 Task 1 暂留，Task 5 与 `db/schema.ts`、`SyncMigrationExecutor`、`database.test.ts` legacy describe 同时删除。
2. **`createPlatformApp` rename 使 legacy tests 断裂：**Task 3 同步提前删除三个仍 import `createApp` 的 legacy server tests。
3. **`index.ts` production caller 断裂：**Task 3 同步转换临时 platform-only entry，Task 4 再由最终 coordinator 替换。

### 已闭合的其它计划问题

- 测试 helper 与 production `startPlatformServer` 同名：测试 helper 冻结为 `startTestPlatformServer`。
- browser scenario 新文件会被 Vitest 收集且 runner 不自动加载：改为直接追加现有、已排除的 `phase4-browser-flow.test.ts`。
- legacy `/events` request matcher 会误报 platform SSE：冻结为 pathname exact/prefix matcher，不使用 `includes('/events')`。
- sentinel 可能误比较整个 `sqlite_master`：明确只比较 legacy objects。
- `database.test.ts` 删除 legacy modules 后 imports 悬空：冻结同 Task 删除 imports/describe，并转换剩余 setup。
- production import guard 排除 tests 可能漏掉 harness：增加 test-support guard。
- `tsc` 不清 dist：新增 exact-path guarded `clean-dist.mjs` 并固定 build 顺序。
- root typecheck 不覆盖 contracts：最终门显式增加 `npm run typecheck --workspace @dnd/contracts`。

## 最终验证命令 contract

实施完成后至少执行：

```bash
npm test -- --maxWorkers=1
npm run typecheck
npm run typecheck --workspace @dnd/contracts
npm run build
npm run test:phase4-browser
```

其中 Phase 1 Chromium 仍使用 Vite dev harness，只证明 legacy URL client 行为，不替代 Phase 7-8 的 production artifact Chromium gate。

## 剩余风险

无计划级 Blocker/Major/Minor。实施审查仍须重点复核：

- transient Provider failure 下 fetch count 必须恰为 1；
- lock 必须在 DB factory 前；
- sentinel fixture 不能只使用 fresh DB；
- credential ciphertext-present 分支绝不创建 key；
- build 必须实际清理 `server/dist` 并通过 artifact 负面扫描；
- 大量 legacy test 删除必须与 production 删除清单逐项对应。

## 批准边界

- **批准：**按详细计划实施 Phase 1。
- **未批准：**本轮直接实施、创建 migration 012、修改 legacy 表、执行 Phase 2+、运行 Git 暂存/提交。

> **PHASE 1 PLAN APPROVED — IMPLEMENTATION NOT STARTED**
