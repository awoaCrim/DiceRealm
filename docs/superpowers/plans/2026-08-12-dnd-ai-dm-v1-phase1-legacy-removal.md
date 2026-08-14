# DND AI-DM v1 Phase 1：删除 legacy 运行时并建立平台唯一组合根——详细实施计划

> **For agentic workers:** 实施时优先采用 subagent-driven TDD；每个 Task 必须先写/修改测试并确认预期 RED，再做最小 GREEN。本文只批准 Phase 1，不批准 Phase 2+。

**状态：** ✅ 已实施并通过独立实施审查（PASS / 0 Blocker / 0 Major；3 个 Minor 已 disposition）  
**实施审查：** [`2026-08-12-dnd-ai-dm-v1-phase1-implementation-review.md`](../reviews/2026-08-12-dnd-ai-dm-v1-phase1-implementation-review.md)  
**制定日期：** 2026-08-12  
**权威来源：**

- [`2026-08-12-dnd-ai-dm-v1-decisions.md`](../specs/2026-08-12-dnd-ai-dm-v1-decisions.md)
- [`2026-08-12-dnd-ai-dm-v1-hardening-cutover.md`](./2026-08-12-dnd-ai-dm-v1-hardening-cutover.md) Phase 1
- 独立计划审查：[`2026-08-12-dnd-ai-dm-v1-phase1-plan-review.md`](../reviews/2026-08-12-dnd-ai-dm-v1-phase1-plan-review.md) — **PASS / 0 Blocker / 0 Major / 0 Minor**。

## 1. Goal 与完成定义

本 Phase 关闭全部 legacy 生产运行面，建立只依赖 `DatabasePort` 的唯一平台组合根，并在任何未来 012+ migration 之前落地 SQLite 单实例锁、migration artifact 完整性校验和 Provider credential fail-closed 启动门。

完成后必须同时成立：

1. 生产不再挂载 `/api/admin`、`/api/player`、legacy `/events`，这些 URL 返回统一安全 JSON 404；平台 `/api/campaigns/:campaignId/events` 保留。
2. 生产代码不再导入 legacy router、`server/src/services/*`、`server/src/domain/types.ts`、`server/src/db/connection.ts`、`server/src/db/schema.ts` 或 `server/src/db/seedRules.ts`。
3. `createPlatformApp()` 只接收 `DatabasePort`，生产只打开一个 `SqliteDatabaseAdapter`；PostgreSQL adapter 保留实验 lane，但不进入生产 factory。
4. 每个 AI attempt 至多一次 Provider HTTP 请求；无自动 retry；timeout/abort、URL join、`redirect:'manual'`、SSE-tolerant buffered response parsing、错误正文脱敏和 `fetchImpl` 注入保留。
5. 进程在打开 SQLite 前取得数据目录锁；第二个 live server/未来 CLI 无法取得锁时拒绝运行。
6. 启动在迁移前验证 committed migration manifest 的精确文件集合和 SHA-256；构建先删除 dist 中旧 `.sql`/旧 manifest，再复制并验证。
7. 若 `platform_ai_provider_configs` 已有密文，missing/corrupt/wrong key 或任意损坏密文均在 listener 前失败，且绝不生成替代 key；没有密文的 001-011 数据库可过渡性创建 key。
8. Existing legacy-bearing DB 的 legacy schema/rows 在 Phase 1 startup/migration 后完全不变；fresh DB 不再创建任何 legacy 表或 `schema_migrations`。
9. legacy client tree 删除；`/admin/:roomId`、`/player/:token` 由现有 `NotFoundPage` 处理，不 redirect、不显示迁移提示、不发 legacy 请求。
10. 定向测试、完整串行测试、typecheck、build 与 Phase 1 Chromium URL 验收通过；默认 `dnd.sqlite` 未被打开或修改。

## 2. 不可变范围与非目标

### 2.1 执行约束

- 严格 TDD：每个 Task 先 RED、记录预期失败原因，再 GREEN/refactor。
- 不创建 migration `012`，不修改 001-011 SQL 内容，不创建 `platform_instance`。
- 不对 legacy 表执行 DROP、ALTER、UPDATE、DELETE、INSERT 或数据映射；legacy fixture 只能由测试自行创建在临时 DB。
- 不修改默认 `dnd.sqlite`、`server/dnd.sqlite` 或真实 `.dnd-ai-credential-key`；磁盘测试使用 `mkdtemp` 下的绝对临时路径，纯模块测试优先 `:memory:`。
- 不删除、覆盖或回滚已有未提交修改；不执行 `git add`、commit、amend、stash、reset、clean。
- 若新增对外错误码，必须同一 Task 同步 `@dnd/contracts` 与 `server/src/platform/http/AppError.ts` 的 `DEFAULT_HTTP_STATUS`；本计划优先使用内部 typed Error，不新增 HTTP 错误码。
- 每个 Task 完成后先跑定向验证；最后再跑串行全量门。

### 2.2 明确不做

- 无 Phase 2 bootstrap/enrollment/fingerprint/database ID/session digest/CSRF/Origin/CORS/body-budget/rate-limit/security audit/maintenance 实现。
- 普通 server 对缺失 `DATABASE_PATH` 的自动创建行为本 Phase 暂不改变；Phase 2 才建立显式初始化与 missing-DB fail-closed。
- 无 AI recovery、Owner retry、campaign revision、archive hardening、领域命令、Provider response 总体积预算或真 token streaming。
- 无生产 SPA 静态托管、安全响应头、backup/restore/drop CLI；Phase 1 Chromium 只验证 client legacy URL 行为，最终 production artifact gate 留 Phase 7-8。
- 不删除或生产接入 `PostgresDatabaseAdapter`；Postgres 门控测试不阻塞 SQLite v1。
- 不清理 `client/src/styles.css` 中 legacy CSS；共享 class 风险高，留独立后续审计。
- 不顺手删除无关依赖；`marked` 因唯一 consumer 被删除而移除，`lucide-react` 即使当前无引用也留存。

## 3. 本计划冻结的二值接口与策略

### 3.1 `createPlatformApp` 与生命周期

在 `server/src/app.ts` 原地把 `createApp(raw, { platformDb })` 收敛为平台唯一 factory，避免额外转发层：

```ts
export interface CreatePlatformAppOptions {
  database: DatabasePort;
  aiProvider?: AiProviderPort;
  credentialCipher?: CredentialCipher;
  providerFetch?: typeof fetch;
  configuredAiProviderFactory?: (
    config: AiProviderEnvConfig,
    fetchImpl?: typeof fetch,
  ) => AiProviderPort;
  realtimePollIntervalMs?: number;
  realtimeHeartbeatIntervalMs?: number;
}

export interface PlatformApp {
  app: Express;
  realtimeRuntime: EventStreamRuntime;
}

export function createPlatformApp(options: CreatePlatformAppOptions): PlatformApp;
```

冻结点：

- `database` 必填且类型仅为 `DatabasePort`；不接受 raw `better-sqlite3` 或可选 `platformDb`。
- `EventStreamRuntime` 由 factory 创建并显式返回；移除 `(app as any).realtimeRuntime`。
- 本 Phase 不添加未使用的 `security` placeholder；Phase 2 在真实依赖出现时扩展 options。路线图 4.1 的 `security` 是目标接口槽位，不要求 Phase 1 制造空抽象。
- Factory 不关闭 DB、不持有 InstanceLock、不监听端口；启动 coordinator 负责 acquire/open/migrate/key/listen/shutdown。
- 当前 `cors()` 与全局 `express.json({limit:'10mb'})` 保持不变，直到 Phase 2。

### 3.2 可测试启动 coordinator

新增 `server/src/platform/startup/startPlatformServer.ts`，把 `index.ts` 降为薄入口：

```ts
export interface StartPlatformServerOptions {
  config: AppConfig;
  env: Record<string, string | undefined>;
  // tests inject factory/listen/keyPath/migrationsDir only; production uses defaults
}

export interface RunningPlatformServer {
  close(): Promise<void>;
}

export async function startPlatformServer(
  options: StartPlatformServerOptions,
): Promise<RunningPlatformServer>;
```

生产顺序固定为：

```text
load config / canonicalize DB path
→ acquire InstanceLock（在 new Database 前）
→ verify current runtime migration directory manifest
→ open one SqliteDatabaseAdapter
→ db.migrate()（platform_migrations only）
→ credential startup gate（scan ciphertext → load/create → decrypt-all）
→ create env fallback provider
→ createPlatformApp({ database, ... })
→ listen
```

任一步失败：已打开的 DB 必须 close，锁最后 release，listener 不得留下。正常 shutdown 固定：

```text
server.close（停止新连接）
→ realtimeRuntime.closeAll()
→ server.closeAllConnections()（当前 Phase 无 request/AI drain manager）
→ database.close()
→ InstanceLock.release()
```

SIGINT/SIGTERM 只调用幂等 `RunningPlatformServer.close()`；顶层再设置退出码。Phase 7 会在同一 close seam 中插入 request/AI drain，不改锁协议。

### 3.3 InstanceLock 协议

文件：`server/src/platform/ops/InstanceLock.ts`。

- 真实 DB 锁路径：canonical DB 所在目录的 `.dnd-instance.lock`；`:memory:` 跳过锁。
- 内容：一行 JSON `{ format:1, token, pid, hostname, purpose:'server'|'cli', startedAt }`；token 用 `randomUUID()`。
- 获取：`openSync(path, 'wx', 0o600)`，写完 fsync/close；`EEXIST` 读取 owner metadata 并失败。
- **Phase 1 不自动破 stale lock。** 无论 PID 看似死亡、metadata 损坏或文件陈旧，都 fail closed 并给出稳定、无敏感数据的人工处理提示。原因：Windows 允许 unlink live holder 且 PID reuse/并发 break 会产生双 owner；自动 stale recovery 不在已批准范围。测试把 dead-PID 文件也冻结为拒绝。
- release 仅在文件 token 等于本实例 token 时 unlink；不同 token、已删除、double release 均不删除其它 owner 文件。
- lock held for the whole server lifecycle；Phase 7 CLI 直接复用同一 `acquireInstanceLock({purpose:'cli'})`。
- v1 声明本地文件系统；不声称 SMB/NFS 上的 `O_EXCL` 语义。

### 3.4 Migration manifest 与 EOL

文件：

- `server/src/platform/database/migrations/migrations.manifest.json`（committed source of truth）
- `server/src/platform/ops/migrationManifest.ts`
- `server/scripts/copy-migrations.mjs`

冻结 contract：

```json
{
  "format": 1,
  "files": [
    { "name": "001_initial_platform.sql", "sha256": "<64 lowercase hex>" }
  ]
}
```

- Canonical file regex：`/^\d{3}_[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/`；copy、verifier、MigrationRunner 共用同一语义（script 可复制同一常量值并由测试锁定）。当前集合必须精确为 001-011，按 ASCII code-unit filename 排序；禁止 `localeCompare`。
- Hash 输入统一为**规范化 LF 文本的 UTF-8 bytes**：读取原 bytes，UTF-8 decode，`\r\n`/孤立 `\r` → `\n` 后 SHA-256。这样不要求在脏 Windows working tree 中执行 renormalize，也避免 `core.autocrlf` 造成跨平台假失败；manifest 证明 migration 语义文本一致，build 另逐文件复制原 bytes。
- Verifier 要求 manifest 存在/格式 strict、精确 set equality（missing/extra 均失败）、顺序规范、每个 hash 匹配、version/name 唯一；只检查 canonical `.sql`，但任何其它 `.sql` 也视为 extra。
- Dev (`tsx`) 验证 src runtime dir；dist (`node dist`) 验证 dist runtime dir。`MigrationRunner` 与 verifier 都从各自 `import.meta.url` 所在目录工作，不做脆弱的 `NODE_ENV` 分支。
- Build script 先删除 dist migration 目录中的全部 `.sql` 与旧 `migrations.manifest.json`，保留同目录编译出的 `.js/.d.ts/.map`；再复制 canonical SQL 与 committed manifest，调用同一 hash/set contract 验证 src 和 dist，失败 exit non-zero。

### 3.5 Provider transport

新增 `server/src/modules/ai-runtime/OpenAiCompatibleTransport.ts`，移动平台所需 transport，不复制 legacy domain helpers。

```ts
export interface OpenAiCompatibleRequestSettings {
  timeoutMs: number;
  temperature: number;
}

export async function requestOpenAiCompatibleMessage(
  config: OpenAiCompatibleConfig,
  messages: AiPrompt['messages'],
  settings: OpenAiCompatibleRequestSettings,
  fetchImpl?: typeof fetch,
): Promise<string>;
```

保留：统一 `ProviderUrlPolicy` 的 URL shape check；`chat/completions` join；Bearer header；`stream:false`；AbortController timeout；`redirect:'manual'` 和 3xx rejection；API key redaction；错误正文最多 1000 chars；OpenAI JSON 和上游错误发送 `data:` SSE 时的容错解析；`fetchImpl` seam。  
删除：retry loop/backoff/429 与 5xx transient 分类、`maxAttempts`、Mock、tool-calling、legacy turn parser/validator。

同时：

- 从 `AiProviderEnvConfig`、`parseAiProviderEnv`、`OpenAiCompatibleRuntimeSettings`、`createAiProviderFromConfig`、`AiProviderConfigService.resolve/test` 删除 `maxAttempts`。
- 删除 `DEFAULT_AI_PROVIDER_MAX_ATTEMPTS`、`AI_PROVIDER_MAX_ATTEMPTS` 测试与 `.env.example` 文档。
- `AiProviderConfigService.test()` 保持固定 15s、temperature 0，但仍只发一次请求。
- 不新增总 response-body budget；1000 chars 只冻结为**错误正文预算**。总 Provider output budget 属于 Phase 4。

### 3.6 Credential startup gate

新增 `server/src/platform/startup/CredentialStartupGate.ts`；`CredentialKeyStore` 保持 DB-free，并拆出显式 `loadCredentialCipher()` 与 `createCredentialCipher()`，`loadOrCreateCredentialCipher()` 可删除以防 production caller 绕过 policy。

固定算法（在 001-011 migration 完成后、listener 前）：

1. 查询 `platform_ai_provider_configs` 的 `campaign_id, encrypted_api_key`，稳定按 `campaign_id` 排序。
2. 有至少一行密文：只允许 load 已存在 key；missing/非 regular/symlink/格式错误直接失败；使用该 key 解密**每一行**，任一 envelope 损坏或 wrong key 失败；不写 key 文件、不改密文。
3. 零密文：若 key 存在则 load；若 key 缺失则用既有 `wx` + 0o600 逻辑创建。这是 012 前唯一可判定的 Phase 1 过渡代理，不宣称“显式 initialized”；Phase 2 enrollment 会替换此分支并加入 database ID/fingerprint。
4. Gate 返回 `CredentialCipher` 给 `createPlatformApp`；错误只含 coarse reason/key path 或 campaign count，不含密文、API key、base URL。

### 3.7 Legacy URL、fresh/existing DB 与 sentinel

- Server：`/api/admin`、`/api/admin/*`、`/api/player`、`/api/player/*`、`/events`、`/events/*` 均精确返回 status 404 + `{"error":{"code":"NOT_FOUND","message":"接口不存在。"}}`；不得 redirect/HTML。
- Client：移除 `LegacyMigratePage` 和两条特殊 route；catch-all 渲染 `NotFoundPage`，无 session/network 依赖。
- Existing DB sentinel：测试先在临时磁盘 SQLite 中手工创建一组代表性 legacy tables、index/trigger、`schema_migrations` 和 rows；只保存并比较这些 **legacy objects** 的 `sqlite_master(type,name,tbl_name,sql)` canonical snapshot + 每表按主键排序的 row JSON。运行真实 Phase 1 pre-listen startup sequence 后，legacy snapshot 逐项相等，同时另行断言新增的 platform objects/001-011 正常存在；不得拿整个 `sqlite_master` 做相等比较。
- Fresh DB：只出现 platform tables、`platform_migrations` 与 SQLite internal objects；明确断言不存在 `schema_migrations` 及代表性 legacy tables。
- Sentinel fixture 不 import legacy `db/schema.ts`，否则删除 legacy schema 后测试会继续把生产遗留代码当依赖。

## 4. 精确文件清单

> 实施前先重新运行 import-graph scan；若当前脏工作树在这些路径有与本计划冲突的新增引用，停止并升级，不覆盖它。下列删除清单按 2026-08-12 当前树冻结。

### 4.1 新增

- `server/src/modules/ai-runtime/OpenAiCompatibleTransport.ts`
- `server/src/modules/ai-runtime/open-ai-compatible-transport.test.ts`
- `server/src/platform/ops/InstanceLock.ts`
- `server/src/platform/ops/InstanceLock.test.ts`
- `server/src/platform/ops/migrationManifest.ts`
- `server/src/platform/ops/migrationManifest.test.ts`
- `server/src/platform/startup/CredentialStartupGate.ts`
- `server/src/platform/startup/CredentialStartupGate.test.ts`
- `server/src/platform/startup/startPlatformServer.ts`
- `server/src/platform/startup/startPlatformServer.test.ts`
- `server/src/platform/database/migrations/migrations.manifest.json`
- `server/src/tests/platform-composition.test.ts`
- `server/src/tests/legacy-sentinel-startup.test.ts`
- `server/scripts/clean-dist.mjs` — 生成目录专用清理脚本；只允许删除解析后精确等于 `server/dist` 的路径。

### 4.2 修改

- `.env.example` — 移除自动 key 文案中的无条件承诺，说明有密文时 fail closed；移除 `AI_PROVIDER_MAX_ATTEMPTS`。
- `.gitignore` — 添加 `.dnd-instance.lock`。
- `server/src/app.ts` — 改为 `createPlatformApp`/显式返回 runtime；删除 legacy imports/mounts/error handler。
- Modify: `server/src/index.ts` — Task 3 先做可编译的临时平台-only entry（单一 `createSqliteDatabase(config.databasePath)` → migrate/key → `createPlatformApp`，不再 import `createApp`）；Task 4 再把该逻辑收进 `startPlatformServer` coordinator，最终 `index.ts` 只调用 `loadConfig` + coordinator 并注册幂等 signal close。这个临时步骤只用于维持 Task 3 typecheck，不是最终启动顺序验收，且不得恢复 legacy migrate/seed。
- `server/src/config.ts`, `server/src/tests/config.test.ts` — 删除 `maxAttempts` 配置面/断言。
- `server/src/modules/ai-runtime/OpenAiCompatibleAiProvider.ts`
- `server/src/modules/ai-runtime/AiProviderConfigService.ts`
- `server/src/modules/ai-runtime/createAiProvider.ts`
- `server/src/modules/ai-runtime/create-ai-provider.test.ts`
- `server/src/modules/ai-runtime/open-ai-compatible-provider.test.ts`
- `server/src/modules/ai-runtime/ai-provider-config-service.test.ts`
- `server/src/modules/ai-runtime/CredentialKeyStore.ts`
- `server/src/modules/ai-runtime/CredentialKeyStore.test.ts`
- `server/src/platform/database/DatabasePort.ts` — 删除 legacy-only `SyncMigrationExecutor`。
- `server/src/platform/database/SqliteDatabaseAdapter.ts` — local raw type；移除 `reuseRaw`；保留现有测试可用的 `raw` accessor，但 production composition 不暴露它。
- `server/src/platform/database/migrations/MigrationRunner.ts` — Task 1 只改 canonical regex/sort 与 manifest 对齐；legacy `runSync` 暂留到 Task 5，与最后的 `db/schema.ts` caller 同时删除，避免中间 build/typecheck 断裂。
- `server/src/platform/database/database.test.ts` — 删除 `createMemoryDb`/`createLegacySyncAdapter`/`migrate`/`migratePlatform` imports 与整个 legacy sync/schema describe；其余 platform tests 统一使用 `createSqliteDatabase(':memory:')`，保留 platform migration contract/atomicity。
- `server/src/platform/http/errorMiddleware.ts` — 删除 legacy prefix forwarding，成为所有已挂载 route 的统一 error boundary。
- `server/src/tests/httpTestHarness.ts` — 单一 `createSqliteDatabase(':memory:')` + 新 factory return shape；测试 helper 重命名为 `startTestPlatformServer`，并更新所有保留的 HTTP/vertical test imports/callers，避免与生产 coordinator 同名。
- `server/src/tests/fixtures/phase4BrowserServer.ts` — 同上。
- `server/scripts/copy-migrations.mjs`
- `server/package.json` — build 在 `tsc` 前显式运行 `node scripts/clean-dist.mjs`。
- `client/src/app/router/AppRouter.tsx`, `client/src/app/router/router.test.tsx`
- `client/package.json`, repository lockfile（移除 `marked` 直接依赖）
- `client/src/tests/phase4-browser-flow.test.ts` — 追加 Phase 1 legacy URL 场景（该文件已在 `vitest.config.ts` 排除，并由 browser runner 显式加载）。
- `scripts/phase4-browser-validation.ts` — 维持显式导入同一 flow 文件；不新增第二个 browser test 入口。

### 4.3 删除：server production

**Routes（10）：**

- `server/src/routes/adminRoutes.ts`
- `server/src/routes/adminAiTurnRoutes.ts`
- `server/src/routes/adminCharacterResourceRoutes.ts`
- `server/src/routes/adminCombatRoutes.ts`
- `server/src/routes/adminConfigRoutes.ts`
- `server/src/routes/adminDbRoutes.ts`
- `server/src/routes/adminMemoryRoutes.ts`
- `server/src/routes/adminResourceRoutes.ts`
- `server/src/routes/playerRoutes.ts`
- `server/src/routes/sseRoutes.ts`

**Legacy services（当前 `server/src/services/*.ts` 全部 37 个；transport 先移入平台模块）：**

- `aiContextBuilder.ts`, `aiProvider.ts`, `aiTurnWorkflowService.ts`, `campaignMemoryService.ts`
- `characterAuditService.ts`, `characterBuilderService.ts`, `characterResourceService.ts`, `characterService.ts`
- `combatService.ts`, `combatStateSyncService.ts`, `diceService.ts`, `dmPresetService.ts`
- `embeddingService.ts`, `eventBus.ts`, `explorationService.ts`, `fiveERulesService.ts`
- `gameEventService.ts`, `globalConfigService.ts`, `personalOpeningIntroService.ts`, `playerTurnSuggestionService.ts`
- `presetConfigService.ts`, `promptPreviewService.ts`, `remoteDbImportService.ts`, `remoteDbRuntimeService.ts`
- `resourceLibrary.ts`, `resourceReviewService.ts`, `ruleRetrievalService.ts`, `rulesService.ts`
- `sillyTavernImport.ts`, `sillyTavernPromptBuilder.ts`, `socialService.ts`, `turnEngine.ts`
- `turnMaterializationService.ts`, `turnReadinessService.ts`, `turnResolutionService.ts`, `visibilityService.ts`, `worldBookService.ts`

**Legacy DB/domain：**

- `server/src/db/connection.ts`
- `server/src/db/schema.ts`
- `server/src/db/seedRules.ts`
- `server/src/domain/types.ts`

### 4.4 删除：server legacy tests

删除下列 `server/src/tests` 文件；它们仅覆盖被删除的 legacy route/service：

- `aiContextBuilderScene.test.ts`, `aiPromptStability.test.ts`, `aiProvider.test.ts`, `aiTurnWorkflowService.test.ts`
- `campaignMemoryService.test.ts`, `characterAuditService.test.ts`, `characterBuilderService.test.ts`, `characterResourceService.test.ts`
- `combatService.test.ts`, `diceService.test.ts`, `dmPresetService.test.ts`, `embeddingService.test.ts`
- `explorationService.test.ts`, `fiveERulesService.test.ts`, `integration.test.ts`, `personalOpeningIntroService.test.ts`
- `playerTurnSuggestionService.test.ts`, `remoteDbImportService.test.ts`, `remoteDbRuntimeService.test.ts`
- `resourceLibrary.test.ts`, `resourceReviewService.test.ts`, `ruleRetrievalService.test.ts`
- `sillyTavernImport.test.ts`, `sillyTavernPromptBuilder.test.ts`, `socialService.test.ts`
- `turnEngine.test.ts`, `turnMaterializationService.test.ts`, `turnResolutionService.test.ts`, `visibilityService.test.ts`

保留：`config.test.ts`、`wait-for-dev-server.test.ts`、所有 platform/module tests，以及 `ai-routes-http`、`authCampaignRoutes`、`open-ai-compatible-resolution`、`realtime-events-http`、`rules-routes-http`、全部 `vertical-*`。

### 4.5 删除：client legacy island

**Source：**

- `client/src/api.ts`, `client/src/types.ts`, `client/src/displayLabels.ts`
- `client/src/pages/HomePage.tsx`, `AdminPage.tsx`, `PlayerPage.tsx`, `pages/admin/adminPageUtils.tsx`
- `client/src/components/CharacterBuilder.tsx`, `CharacterCard.tsx`, `LogList.tsx`, `PromptPreviewPanel.tsx`
- `client/src/components/ResourceImportPanel.tsx`, `ResourceReviewPanel.tsx`, `RoomResourceBindingsPanel.tsx`, `TurnPanel.tsx`

**Tests：**

- `client/src/api.test.tsx`
- `client/src/ui-copy.test.tsx`
- `client/src/character-builder.test.tsx`
- `client/src/resource-review-panel.test.tsx`

明确保留 `client/src/api/**`（目录）、`app/**`、`features/**`、`entities/**`、`shared/**`、`styles.css`。

## 5. 依赖图与实施顺序

```text
Task 1 migration manifest + InstanceLock foundations ─────────────┐
Task 2 single-request Provider transport ────────────────────────┤
Task 3 createPlatformApp + harness conversion ───────────────────┼─→ Task 4 startup coordinator + credential gate
                                                                  │
Task 4 proves startup ordering/sentinels ─────────────────────────┤
                                                                  └─→ Task 5 legacy server deletion
Task 5 server removal + 404/import graph ─────────────────────────────→ Task 6 legacy client deletion + Chromium
Task 1-6 ─────────────────────────────────────────────────────────────→ Task 7 aggregate gate + independent review
```

先建立可独立测试的 lock/manifest 与 transport；随后切换 factory/harness；再集中冻结启动顺序和 credential gate。只有平台 callers 全部脱离 legacy 后才删除 legacy tree。客户端最后删除，避免中途把 server/client legacy 404 耦合混在一个无法定位的 RED 中。

---

## Task 1：InstanceLock 与 migration artifact contract

### Files

- Add: `server/src/platform/ops/InstanceLock.ts`, `InstanceLock.test.ts`
- Add: `server/src/platform/ops/migrationManifest.ts`, `migrationManifest.test.ts`
- Add: `server/src/platform/database/migrations/migrations.manifest.json`
- Modify: `server/src/platform/database/migrations/MigrationRunner.ts`
- Modify: `server/scripts/copy-migrations.mjs`
- Modify: `.gitignore`

### Step 1 — RED：锁协议

测试至少覆盖：

1. 第一次 acquire 成功并写入 format/token/pid/hostname/purpose/startedAt；权限在非 Windows 为 0600。
2. 同一 data dir 第二次 acquire 拒绝，错误不含任意 DB 内容；即使 fixture PID 为 dead、时间很旧也不自动 break。
3. release 后可重新 acquire；double release 幂等。
4. lock file token 被替换时，旧 owner release 不 unlink 新文件。
5. `:memory:` 返回 no-op lock，不创建 cwd 文件。
6. metadata 损坏时 fail closed，不覆盖文件。

运行：

```bash
npx vitest run server/src/platform/ops/InstanceLock.test.ts
```

预期 RED：模块不存在；当前无 lock primitive，第二次 acquire 无法被拒绝。

### Step 2 — GREEN：最小锁实现

实现 `acquireInstanceLock({ databasePath, purpose })`、token-verified `release()` 和 stable `InstanceLockError`。不实现 stale auto-break、heartbeat 或 native flock。把 `.dnd-instance.lock` 加入 `.gitignore`。

重跑 Step 1，必须 GREEN。

### Step 3 — RED：manifest exact-set/hash/EOL

测试临时目录：

- valid LF 与 CRLF 内容计算同一规范 hash；
- missing、extra、tampered SQL 分别失败；
- malformed manifest、重复 name/version、非三位 filename 失败；
- sort 为 ASCII deterministic；
- committed source migration dir（001-011）验证通过；
- canonical filename predicate/sort 行为有直接测试；legacy `runSync` 暂留并继续由既有测试覆盖，直到 Task 5 与 caller 一并删除。

运行：

```bash
npx vitest run server/src/platform/ops/migrationManifest.test.ts server/src/platform/database/database.test.ts
```

预期 RED：manifest/verifier 不存在；runner 仍用宽 regex 与 `localeCompare`。`runSync` 的存在本 Task 不作为 RED，因为其 caller 要到 Task 5 才一起删除。

### Step 4 — GREEN：manifest、runner 与 build copy

- 生成并人工核对 committed `migrations.manifest.json`（001-011，无 timestamp）。
- 实现 strict parser/normalised-LF SHA-256/exact-set verifier。
- `MigrationRunner` 改用 canonical filename predicate 与 code-unit sort；`runSync` 在 Task 1 暂留，因为 legacy `db/schema.ts` 与 `database.test.ts` 仍有 caller，统一到 Task 5 删除。
- copy script 删除 dist 中旧 `.sql`/manifest，复制源文件和 manifest，验证 source + dist；保留 `MigrationRunner.js`。

定向验证：

```bash
npx vitest run server/src/platform/ops/migrationManifest.test.ts server/src/platform/database/database.test.ts
npm run build --workspace server
```

预期：tests GREEN；build 输出恰好 copied 11 migrations；dist manifest 与 source manifest 等价；人工放入的 stale `.sql` 在重建后消失。

### Step 5 — Refactor/guard

把 filename predicate/hash/manifest schema 保持为一个 production module；copy script 若不能直接 import TS，则用 build-independent `.mjs` helper 或 contract fixture test 防止正则漂移，不能留下三份未测试常量。

---

## Task 2：提取单请求 Provider transport，删除 retry 配置面

### Files

- Add: `server/src/modules/ai-runtime/OpenAiCompatibleTransport.ts`
- Add: `server/src/modules/ai-runtime/open-ai-compatible-transport.test.ts`
- Modify: `OpenAiCompatibleAiProvider.ts`, `AiProviderConfigService.ts`, `createAiProvider.ts`
- Modify: `config.ts`, `.env.example`
- Modify: `config.test.ts`, `create-ai-provider.test.ts`, `open-ai-compatible-provider.test.ts`, `ai-provider-config-service.test.ts`, `open-ai-compatible-resolution.test.ts`

### Step 1 — RED：transport contract

写 table-driven fetch stub 测试：

- 429、500、含 `EOF` body、fetch rejection 各自 reject 且 call count 恰为 1；
- timeout 会 abort，错误不含 key/base URL；
- 302 被拒绝、不 follow，count=1；
- trailing slash/no slash 都只拼成一个 `/chat/completions`；
- JSON chat-completions response 正常提取 content；上游误发 `data:` SSE 仍能拼出 content；
- upstream error body 中 key 被替换，输出最多 1000 chars；
- module 不导出 Mock、retry/backoff 或 tool-calling API。

运行：

```bash
npx vitest run server/src/modules/ai-runtime/open-ai-compatible-transport.test.ts
```

预期 RED：模块不存在；复用现 transport 时 429/500/network 会调用多次。

### Step 2 — GREEN：移动平台 transport

只移动平台需要的 URL join、request/response parse、timeout、redirect、redaction；调用 `assertSafeProviderUrl`，不恢复公网/IP 限制。删除 transient classifiers/delay/retry loop。

### Step 3 — RED：删除 `maxAttempts`

先改测试断言：

- `parseAiProviderEnv` 输出不含 `maxAttempts`，`AI_PROVIDER_MAX_ATTEMPTS` 被忽略；
- `OpenAiCompatibleRuntimeSettings` 构造不再接受该字段；
- env factory 与 saved-provider resolve 仍使用 timeout/temperature；
- `AiProviderConfigService.test()` request count=1。

运行：

```bash
npx vitest run server/src/tests/config.test.ts server/src/modules/ai-runtime/create-ai-provider.test.ts server/src/modules/ai-runtime/ai-provider-config-service.test.ts
```

预期 RED：当前 config/runtime type 仍包含 `maxAttempts`，默认 3。

### Step 4 — GREEN：切 callers

- 两个 platform caller 改 import 新 transport。
- 删除 config constant/env parsing/runtime field 和 `.env.example` 项。
- 保留 `createConfiguredAiProvider` 安全回落；生产仍不可能构造 Mock。

### Step 5 — Provider 回归

```bash
npx vitest run \
  server/src/modules/ai-runtime/open-ai-compatible-transport.test.ts \
  server/src/modules/ai-runtime/open-ai-compatible-provider.test.ts \
  server/src/modules/ai-runtime/ai-provider-config-service.test.ts \
  server/src/modules/ai-runtime/create-ai-provider.test.ts \
  server/src/modules/ai-runtime/provider-url-policy.test.ts \
  server/src/tests/open-ai-compatible-resolution.test.ts \
  server/src/tests/ai-routes-http.test.ts
npm run typecheck --workspace server
```

预期全部 GREEN；静态 grep 只允许 legacy `services/aiProvider.ts` 暂时自包含，platform production 不再 import 它。

---

## Task 3：建立 `createPlatformApp(DatabasePort)` 并转换 harness

### Files

- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`（临时平台-only entry，避免 factory rename 后生产 caller 断裂）
- Add: `server/src/tests/platform-composition.test.ts`
- Modify: `server/src/platform/http/errorMiddleware.ts`
- Modify: `server/src/tests/httpTestHarness.ts`
- Modify: `server/src/tests/fixtures/phase4BrowserServer.ts`
- Delete early (factory callers): `server/src/tests/integration.test.ts`, `server/src/tests/embeddingService.test.ts`, `server/src/tests/playerTurnSuggestionService.test.ts`。它们只覆盖 legacy runtime，且当前直接 import `createApp`；必须在移除该 export 的同一 Task 删除，避免 Task 3/4 typecheck 断裂。
- Modify: `server/src/platform/database/SqliteDatabaseAdapter.ts`

### Step 1 — RED：factory 形状与 route contract

在 `platform-composition.test.ts`：

1. 只传 `database: DatabasePort` 可构造；raw `better-sqlite3` 使用 `// @ts-expect-error` 被 typecheck 拒绝。
2. return 显式含 `{app,realtimeRuntime}`；不依赖 app property cast。
3. 平台 auth/campaign route 存在。
4. legacy `/api/admin/x`、`/api/player/x`、`/events/x` 返回 exact JSON 404。
5. 一个抛 `AppError`/Zod/unknown 的测试 route 经统一 `errorMiddleware` 安全收敛；无 legacy prefix forwarding。

运行：

```bash
npx vitest run server/src/tests/platform-composition.test.ts
```

预期 RED：只有 `createApp(raw,{platformDb})`，legacy routes 实际挂载，runtime 依赖 cast。

### Step 2 — GREEN：原地收敛 app factory

- `app.ts` 导出本计划 3.1 的接口。
- `index.ts` 同 Task 改为临时平台-only entry：只打开一个 `SqliteDatabaseAdapter`、运行 platform migrations、使用现有 key load/create 路径、调用 `createPlatformApp`；删除 `createApp`、raw dual seam、legacy `migrate()`/`seedBuiltinRules()` imports/calls。Task 4 必须用最终 coordinator 替换此临时流程，并补 lock/manifest/credential fail-closed ordering。
- database block 改为 unconditional；删除 legacy imports/mounts/Zod legacy handler。
- `errorMiddleware` 注册在所有 platform routes 后、404 前，并对所有传入 error 统一处理。
- 保留当前路由与 service wiring，不做 Phase 2/3 refactor。

### Step 3 — RED：test harness/fixture 只用一个 adapter

修改 `server/src/tests/httpTestHarness.ts`、`phase4BrowserServer.ts` 及现有 callers；同时把测试 helper 从 `startPlatformServer` 重命名为 `startTestPlatformServer`，避免与 Task 4 的生产 `startPlatformServer` 混淆。目标：

- 不 import `createMemoryDb`、legacy `migrate`、`reuseRaw` 或 `createApp`；
- 只 `createSqliteDatabase(':memory:')`、`migrate()`、`createPlatformApp`；
- close 顺序 runtime → HTTP server → DB；无 timer/handle 泄漏。

预期 RED：当前 imports 与 factory shape 不匹配。

### Step 4 — GREEN：转换 harness/adapter seam

- `SqliteDatabaseAdapter` 本地使用 `Database.Database` type；`createSqliteDatabase(path?:string)` 删除 `reuseRaw` option。
- harness 保留 `platformDb` 测试 accessor；production factory 不暴露 raw。
- Phase 4 browser fixture 同步转换。

### Step 5 — 平台垂直回归

```bash
npx vitest run \
  server/src/tests/authCampaignRoutes.test.ts \
  server/src/tests/ai-routes-http.test.ts \
  server/src/tests/realtime-events-http.test.ts \
  server/src/tests/rules-routes-http.test.ts \
  server/src/tests/vertical-ai-resolution-http.test.ts \
  server/src/tests/vertical-characters-http.test.ts \
  server/src/tests/vertical-sse-combat-http.test.ts \
  server/src/tests/vertical-world-outbox-turns-http.test.ts
npm run typecheck --workspace server
```

预期全部 GREEN，SSE tests 结束后无 hanging process。

---

## Task 4：启动 coordinator、credential fail-closed 与 legacy sentinel

### Files

- Add: `server/src/platform/startup/CredentialStartupGate.ts`, `.test.ts`
- Add: `server/src/platform/startup/startPlatformServer.ts`, `.test.ts`
- Add: `server/src/tests/legacy-sentinel-startup.test.ts`
- Modify: `server/src/modules/ai-runtime/CredentialKeyStore.ts`, `.test.ts`
- Modify: `server/src/index.ts`

### Step 1 — RED：CredentialStartupGate 四类失败/成功

在 temp DB + explicit temp keyPath 上测试：

1. ciphertext + missing key：reject；key file 仍不存在。
2. ciphertext + corrupt key format：reject；原 file bytes 不变。
3. ciphertext + valid but wrong key：decrypt-all reject；密文行不变。
4. valid key + 一行 corrupted envelope：reject，即使其它行可解密。
5. 多 campaign ciphertext + correct key：全部离线解密后返回 cipher。
6. zero ciphertext + missing key：允许 `wx` 创建；restart load 同一 key。
7. zero ciphertext + existing valid key：load，不轮换。

运行：

```bash
npx vitest run server/src/platform/startup/CredentialStartupGate.test.ts server/src/modules/ai-runtime/CredentialKeyStore.test.ts
```

预期 RED：当前 `loadOrCreateCredentialCipher` 在 case 1 静默生成替代 key，且没有全量 decrypt scan。

### Step 2 — GREEN：显式 load/create + DB-free policy

- KeyStore 导出 `loadCredentialCipher`/`createCredentialCipher`，保留 regular-file/symlink/permission/canonical 32-byte checks 与 `wx` race handling。
- Gate 查询稳定排序并执行上述 branch；不 catch-and-log raw error。

### Step 3 — RED：startup ordering 与 cleanup

对 `startPlatformServer` 注入 spies/fakes 或真实 temp DB，断言事件顺序：

```text
lock.acquire < manifest.verify < database.open < migrate < credential.verify < app.create < listen
```

失败点分别注入在 manifest、migrate、credential、listen：

- listener 未打开或被关闭；
- DB 若已打开则关闭一次；
- lock 最后释放一次；
- 第二个 lock holder 拒绝且 DB factory 调用次数为 0；
- graceful close 幂等并遵守 server → realtime → DB → lock。

运行：

```bash
npx vitest run server/src/platform/startup/startPlatformServer.test.ts
```

预期 RED：当前 `index.ts` 顶层先开 raw DB、无 lock/manifest、失败 cleanup 不可测试。

### Step 4 — GREEN：coordinator 与薄入口

实现 dependency-injected coordinator；生产 defaults 使用当前 runtime migrations dir、`createSqliteDatabase(config.databasePath)`、credential path、`createConfiguredAiProvider` 与 `createPlatformApp`。用 coordinator 完整替换 Task 3 的临时 `index.ts` 直连流程；最终 `index.ts` 不再直接 open/migrate/load key，也不再 import legacy DB/schema/seed/app factory。

### Step 5 — RED：fresh/existing sentinel

`legacy-sentinel-startup.test.ts` 使用 temp on-disk DB：

- 手工建 representative legacy objects：`schema_migrations`、`rooms`、`players`、`characters`、`rule_sources`，至少一个 index、一个 trigger 和含 Unicode/BLOB/null 的 rows；记录 DDL+row snapshot。
- 运行 coordinator 的 pre-listen path（listen 注入 no-op/ephemeral）；关闭。
- assert 所有 legacy DDL、row value/type/order 完全相等；没有 seed row；平台 001-011 正常应用。
- fresh temp path 启动后 assert `schema_migrations`/legacy table 不存在。
- manifest/key/lock 文件放同一 temp dir；关闭后 lock 消失。

预期 RED：当前 startup 调用 legacy `migrate`/`seedBuiltinRules`，会改变 fixture，并在 fresh DB 建 legacy tables。

### Step 6 — GREEN：只跑平台 migration

确保 coordinator 无任何 legacy call；不要为 sentinel 保留 `db/schema.ts`。定向验证：

```bash
npx vitest run \
  server/src/platform/startup/CredentialStartupGate.test.ts \
  server/src/platform/startup/startPlatformServer.test.ts \
  server/src/tests/legacy-sentinel-startup.test.ts
```

预期全部 GREEN；测试结束后检查 repo root/server 下 `dnd.sqlite*` 与真实 key 没有 mtime 变化。

---

## Task 5：删除 legacy server tree 与 legacy tests

### Files

- Delete: 4.3、4.4 中的全部文件
- Modify: `server/src/platform/database/DatabasePort.ts`
- Modify: `server/src/platform/database/database.test.ts`
- Modify: `server/src/platform/database/SqliteDatabaseAdapter.ts`
- Modify/Add: `server/src/tests/platform-composition.test.ts` import-graph guard
- Add: `server/scripts/clean-dist.mjs`
- Modify: `server/package.json`

### Step 1 — RED：生产 import graph 负面门

静态 production guard 扫描 `server/src/**/*.ts`，排除 `**/*.test.ts` 与 `server/src/tests/**`，解析相对 static import/export/dynamic import specifier，拒绝：

- 任意 `/services/`、legacy route 文件；
- `/domain/types`；
- `/db/connection`、`/db/schema`、`/db/seedRules`；
- `createApp`、`AppDatabase`、`createMemoryDb`、`getDb`、`getPlatformDb`、`migratePlatform`、`SyncMigrationExecutor` tokens。

另加一个 test-support guard 扫描保留的 `server/src/tests/httpTestHarness.ts` 与 `server/src/tests/fixtures/**`，拒绝 `services/*`、legacy routes、`db/connection`、`db/schema`、`db/seedRules`、`domain/types`；这样 production guard 的排除范围不会掩盖 harness 回归。先写测试时预期 RED：legacy tree 尚存在且 `app/index/adapter` 仍可能有引用。

运行：

```bash
npx vitest run server/src/tests/platform-composition.test.ts
```

### Step 2 — GREEN：按冻结清单删除

- `server/src/tests/integration.test.ts`, `embeddingService.test.ts`, `playerTurnSuggestionService.test.ts` 在 Task 3 已提前删除；Task 5 删除 4.4 中其余 legacy tests，不重复处理。
- 从 `DatabasePort` 删除 `SyncMigrationExecutor`；从 `MigrationRunner` 删除 `runSync`；从 `database.test.ts` 删除 `createMemoryDb`/legacy schema imports、整个 legacy schema/sync runner describe，并把任何剩余 setup 明确转换为 `createSqliteDatabase(':memory:')`。这些删除必须与 `db/schema.ts` 同一 Task 落地，避免中间 caller 断裂。
- 不移动 legacy validator/helper 到平台；只有 Task 2 已明确提取的 transport survive。
- 若 TypeScript 报某删除文件仍被 platform caller 引用，先判断是否漏提取真正平台 seam；不得用空 shim 或 compatibility layer 糊住。

### Step 3 — 404 与平台回归

```bash
npx vitest run server/src/tests/platform-composition.test.ts server/src/tests/*-http.test.ts server/src/tests/vertical-*.test.ts
npm run typecheck --workspace server
npm run build --workspace server
```

预期：

- exact safe 404 table GREEN；
- production import graph GREEN；
- build 的 `server/dist` 不含 legacy routes/services/db/domain compiled modules。新增 `server/scripts/clean-dist.mjs`：用 `fileURLToPath(import.meta.url)` 求 `serverRoot`，只在 `resolve(target) === resolve(serverRoot, 'dist')` 时执行 `rmSync(target, { recursive:true, force:true })`，否则拒绝；`server/package.json` 的 build 固定为 contracts build → `node scripts/clean-dist.mjs` → tsc → copy migrations。只能清生成目录，不能触碰 src/working changes。

### Step 4 — 删除后的 artifact 负面检查

用 Node test（不依赖 git clean）递归检查 `server/dist`：禁止 `routes/admin*`、`playerRoutes`、`sseRoutes`、`services/*`、`db/schema`、`db/connection`、`domain/types`。这一步防止旧 dist JS 残留让生产仍可误执行 legacy runtime。

---

## Task 6：删除 legacy client，冻结旧 URL 为 NotFound

### Files

- Modify: `client/src/app/router/AppRouter.tsx`, `router.test.tsx`
- Delete: 4.5 全部 legacy source/tests
- Modify: `client/package.json`, lockfile
- Add/Modify: Phase 1 browser URL scenario

### Step 1 — RED：router exact behavior

把旧测试改为对 `/admin/room-1` 与 `/player/token-1` 分别断言：

- heading 为 `页面不存在`；
- 不出现 `旧入口迁移提示`、`创建本地多人跑团房间`；
- owner/guest session 都同样工作；
- router location 不 redirect 到 `/login` 或 `/campaigns`。

运行：

```bash
npx vitest run client/src/app/router/router.test.tsx
```

预期 RED：当前显式渲染 `LegacyMigratePage`。

### Step 2 — GREEN：移除特殊 route

删除 `LegacyMigratePage` 和 `/admin/:roomId`、`/player/:token` route；保留 catch-all `NotFoundPage`。

### Step 3 — 删除 legacy island

删除 4.5 文件；从 client dependency/lockfile 移除 `marked`。不改 `styles.css`，不删除 `lucide-react`。运行 TypeScript 证明新 tree 无 dangling legacy imports：

```bash
npm run typecheck --workspace client
npx vitest run client/src/app/router/router.test.tsx client/src/features client/src/app client/src/shared
npm run build --workspace client
```

### Step 4 — Chromium Phase 1 验收

复用现有 `scripts/phase4-browser-validation.ts` + Vite dev harness，直接在已被 Vitest 排除且由 runner 显式加载的 `client/src/tests/phase4-browser-flow.test.ts` 中增加隔离场景：

1. guest 打开 `/admin/room-1`、`/player/token-1`，可见 `页面不存在`；
2. logged-in context 重复，行为一致；
3. 监听 request，按 `new URL(request.url()).pathname` 精确匹配：拒绝 pathname 为 `/api/admin` 或以 `/api/admin/` 开头、为 `/api/player` 或以 `/api/player/` 开头、为 `/events` 或以 `/events/` 开头的请求；不得用 `includes('/events')`，否则会误报合法平台 `/api/campaigns/:campaignId/events`；
4. sanity：guest `/` → `/login`，登录用户 `/` → `/campaigns`。

运行：

```bash
npm run test:phase4-browser
```

预期 GREEN。验证记录必须明确：这是 Phase 1 client URL 证据，使用 Vite dev，不替代 Phase 7-8 production Chromium gate。

---

## Task 7：Phase 1 聚合验证、默认 DB 保护与独立审查

### Step 1 — 记录保护对象 baseline

在运行测试前只读记录下列存在文件的 size + SHA-256 + mtime（若不存在记录 absent）：

- `dnd.sqlite`, `dnd.sqlite-wal`, `dnd.sqlite-shm`
- `server/dnd.sqlite`, `server/dnd.sqlite-wal`, `server/dnd.sqlite-shm`
- `server/.dnd-ai-credential-key`, `.dnd-ai-credential-key`

测试后必须完全相等/仍 absent。不要通过启动默认 server 做 smoke；所有 startup tests 显式 temp `DATABASE_PATH`/key path/port 0。

### Step 2 — 定向静态检查

```bash
# 使用仓库现有 grep/find 或 Node 测试；以下模式必须无 production hit
rg "services/|db/connection|db/schema|db/seedRules|domain/types|createAdminRouter|createPlayerRouter|createSseRouter" server/src \
  -g '!**/*.test.ts' -g '!server/src/tests/**'
rg "AI_PROVIDER_MAX_ATTEMPTS|maxAttempts" server/src .env.example
rg "services/|db/connection|db/schema|db/seedRules|domain/types|createAdminRouter|createPlayerRouter|createSseRouter" server/src/tests/httpTestHarness.ts server/src/tests/fixtures
rg "LegacyMigratePage|旧入口迁移提示|from ['\"]\./api['\"]|from ['\"]\./types['\"]" client/src
```

预期：无命中；若 `rg` 未安装，用静态测试/仓库 grep 等价执行。不得把 grep 本身作为唯一 import-graph 证明。

### Step 3 — 完整验证

```bash
npm test -- --maxWorkers=1
npm run typecheck
npm run typecheck --workspace @dnd/contracts
npm run build
npm run test:phase4-browser
```

预期：

- Vitest 全部非门控测试通过；Postgres 门控可按既有规则 skip 并单独记录。
- server/client/contracts typecheck 通过（contracts 用显式 workspace command）；随后 root build 再构建 contracts/server/client。
- build 通过；migration source/dist exact set+hash 通过；dist 无 legacy compiled artifact。
- Chromium legacy URL 场景通过。
- baseline 中默认 DB/key 文件未改变。

### Step 4 — 独立 correctness/security/operability review

实现完成后必须由 fresh-context、只读 reviewer 至少覆盖：

- **Correctness/architecture：** factory signature、单 adapter、server/client 删除清单、route 404、platform tests、fresh/existing DB semantics。
- **Security/data safety：** single-request Provider、redirect/redaction、credential decrypt-all fail-closed、sentinel zero-write、default DB/key protection、error envelope。
- **Operability/build：** lock-before-open/release order、Windows fail-closed stale policy、manifest EOL/set/hash、dist clean、failure cleanup。

审查门：`PASS / 0 Blocker / 0 Major`。任何 Blocker/Major 必须先修复、重跑受影响 RED/GREEN 与聚合门，再复审；Minor 必须记录 disposition。不得以“tests pass”替代独立审查。

## 6. 风险与回退边界

1. **最大 silent regression：** transport 提取时保留 retry。唯一可靠门是 transient failure 下 fetch count 恰为 1。
2. **最大数据风险：** sentinel 写成 fresh DB 导致 vacuous pass。必须使用手工 legacy-bearing fixture，且同时测试 fresh DB 不建 legacy 表。
3. **最大 startup 风险：** lock 在 DB open 之后取得。ordering spy 与第二实例“DB factory 未调用”测试必须二值证明。
4. **Windows lock corpse：** Phase 1 故意 fail closed、不自动 break。部署者需人工核对进程后处理 lock；Phase 7 运维计划可在不改变双 owner 安全性的前提下补受审计 recovery UX。
5. **migration EOL：** 不对脏工作树执行 renormalize；统一 LF 后 hash，避免跨 OS 假失败。manifest 仍需审查文件名与 hash diff。
6. **dist stale JS：**只清 migration `.sql` 不足以删除已编译 legacy JS。server build 必须保证生成目录清洁或有 dist 负面扫描；清理对象只能是 `server/dist` 生成物。
7. **wide test deletion：** 删除 legacy tests 会显著减少测试数量；review 必须按“被删 production module → 被删 test”映射核对，不能误删 platform vertical tests。
8. **脏工作树冲突：** 若实施时被删文件包含用户新增且不属于 legacy island 的改动，停止并请求决定，不能强删。
9. **Phase 2 seam：** zero-ciphertext 自动建 key 只是 001-011 过渡行为；不得宣传为显式 initialization，也不得提前实现 012 fingerprint。

## 7. 最终二值验收表

- [x] 未创建或修改 migration 012；001-011 SQL 内容不变。
- [x] `/api/admin*`、`/api/player*`、legacy `/events*` exact safe JSON 404；平台 campaign events 正常。
- [x] 生产 source 与 dist 均无 legacy route/service/domain/db runtime artifact。
- [x] `createPlatformApp` 只收 `DatabasePort` 并显式返回 `EventStreamRuntime`。
- [x] 生产启动只打开一个 `SqliteDatabaseAdapter`。
- [x] Provider 429/5xx/network/timeout 每次 attempt 都只请求一次；redirect 与 secret leakage 负面测试通过。
- [x] `AI_PROVIDER_MAX_ATTEMPTS`/`maxAttempts` 不再属于平台配置面。
- [x] InstanceLock 在 DB open 前取得；第二实例/CLI-style acquire fail closed；close 最后释放。
- [x] Migration manifest 对 source 与 dist 执行 exact set + normalized-LF SHA-256；stale dist SQL 被清理。
- [x] ciphertext + missing/corrupt/wrong key 或 corrupted envelope 全在 listener 前失败且不改 key/ciphertext。
- [x] zero ciphertext 的 001-011 DB 可过渡性 load/create key；文档明确 Phase 2 会替换此代理。
- [x] Existing legacy sentinel DDL/rows 完全不变；fresh DB 不含 legacy objects。
- [x] Client legacy tree 删除；旧 URL 为 `NotFoundPage`，无 redirect/迁移提示/legacy request。
- [x] 默认 DB/key baseline 未被本 Phase 最终验证修改；实施中外部既有 watcher 曾重建可再生的 `server/dnd.sqlite-shm`，主 DB/WAL hash 未变，已在实施审查记录 disposition。
- [x] `npm test -- --maxWorkers=1`、`npm run typecheck`、`npm run typecheck --workspace @dnd/contracts`、`npm run build`、`npm run test:phase4-browser` 通过。
- [x] 独立审查达到 `PASS / 0 Blocker / 0 Major`。

> Phase 1 已实施并通过独立验收；Phase 2+ 仍须后续单独授权。
