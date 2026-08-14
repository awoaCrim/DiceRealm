# DND AI-DM 已完成架构审查

> **历史架构问题清单 / 非未来执行计划（2026-08-12 后续决策）：** 本报告中的代码事实和缺陷证据继续有效，但关于 PostgreSQL v1 发布支持、Owner 世界/战斗 HTTP 写面和 AI lease 形态的建议，已由 [`2026-08-12-dnd-ai-dm-v1-decisions.md`](../specs/2026-08-12-dnd-ai-dm-v1-decisions.md) 与 [`2026-08-12-dnd-ai-dm-v1-hardening-cutover.md`](../plans/2026-08-12-dnd-ai-dm-v1-hardening-cutover.md) 收敛：SQLite-only 单实例、删除 Owner 写面、启动时中断恢复。当前计划批准结论见 [`2026-08-12-v1-hardening-cutover-plan-review.md`](./2026-08-12-v1-hardening-cutover-plan-review.md)。本文只作为问题来源，不得覆盖新决策。

审查日期：2026-08-12  
审查范围：当前工作树中已实现的 Phase 1-4、Phase 5 Provider/Rules 切片，以及 AI-DM 世界创建与遭遇发起产品修正。  
审查方式：只读静态审查 contracts、routers、application services、repositories、数据库 adapters、001-011 迁移、AI runtime、SSE、combat、archives、client workspaces 和浏览器验收代码。本次未运行测试、构建或真实 PostgreSQL，因此“测试当前仍全绿”不属于本报告结论。

## 总体结论

新平台架构的主方向是正确的：campaign context、服务端授权、可见性投影、事务性 outbox、短事务 AI 生命周期、白名单 materializer、结构化战斗命令、真实存档快照、React Query 分层和三身份浏览器流程都已形成有价值的深模块。

但当前整体仍不应视为可安全发布，主要原因不是 Phase 1-4 的基本模块全部失效，而是若干跨模块 seam 尚未闭合：

1. legacy 管理面仍默认挂载且无鉴权，直接绕过新平台所有安全不变量；
2. AI run 没有 lease、启动恢复或管理员终止能力，进程崩溃可永久卡住战役；
3. claim 时捕获的 AI context 与 formal apply 之间没有 revision 检查，合法并发修改可能被陈旧结果覆盖；
4. archive restore 信任快照内嵌 campaign/member/reference，缺少恢复前完整性校验；
5. PostgreSQL adapter 没有进入生产组合根，当前仍是测试层 seam；
6. SSE 会话撤销和 client 战役切换生命周期存在缺口。

建议总体判定：

> **ARCHITECTURE CONDITIONALLY SOUND, NOT RELEASE READY**

## Blocker

### B1. Legacy 管理面默认无鉴权暴露，绕过新平台全部安全边界

**性质：确定问题。**

应用在新平台路由之后仍无条件挂载：

- `app.use('/api/admin', createAdminRouter(db))`
- `app.use('/api/player', createPlayerRouter(db))`
- `app.use('/events', createSseRouter(db))`

证据：

- `server/src/app.ts`
- `server/src/routes/adminRoutes.ts`
- `server/src/routes/adminConfigRoutes.ts`
- `server/src/routes/adminResourceRoutes.ts`

`/api/admin` 没有 session 或平台管理员授权，却能够：

- 枚举、创建、修改和删除 legacy room；
- 读取玩家 token、行动、私密日志和 AI generation；
- 读取和修改全局 Provider 配置；
- 写入规则正文、资源、世界书和其它全局配置；
- 触发 legacy AI 相关流程。

同时，legacy Provider 配置把 `apiKey` 明文保存在 `global_config.*_provider_config_json` 并通过 GET 原样返回；legacy Rules 仍保存和返回 `content_json`。

相关证据：

- `server/src/services/globalConfigService.ts`
- `server/src/services/aiProvider.ts`
- `server/src/services/rulesService.ts`
- `server/src/db/schema.ts`

**影响：**新平台的 campaign-scoped 权限、AES-GCM 凭证、write-only Key、metadata-only Rules 和默认 `UnavailableAiProvider` 都可以被同一进程中的 legacy 路径绕过。

**建议：**

1. legacy 路由默认不挂载，只能通过显式 migration feature flag 开启；
2. 若必须临时共存，整个 `/api/admin` 必须先经过强认证和受信任管理员授权；
3. 停止返回玩家 token 和 Provider Key；
4. 迁移或清除 legacy 明文 Provider 配置；
5. 将 legacy Rules 正文入口隔离为离线迁移工具或直接停用；
6. 已部署过的真实 Provider Key 和玩家 token 应视为可能暴露并安排轮换。

### B2. AI run 没有崩溃恢复，claim 后进程中断可永久锁死战役

**性质：确定架构缺口。**

`AiResolutionService.resolveTurn()` 先提交 claim：

- run=`running`；
- turn=`resolving`；
- 发布 `ai.preview.started`；
- 随后在事务外调用 Provider。

这是正确的短事务方向，但当前没有：

- lease owner；
- lease expiry；
- heartbeat；
- 启动 reconciler；
- stale run timeout；
- owner cancel/abort 命令。

证据：

- `server/src/modules/ai-runtime/AiResolutionService.ts`
- `server/src/modules/ai-runtime/AiRunRepository.ts`
- `packages/contracts/src/ai.ts`
- `server/src/modules/archives/ArchiveService.ts`

如果进程在 claim 提交后被杀死，catch/fail 永远不会执行。残留的 `running/resolving` 会阻止：

- 同回合新 key 重试；
- 开始下一回合；
- 手动存档；
- 恢复存档。

**建议：**引入持久化 lease 状态机，至少包含 `lease_owner/lease_expires_at/heartbeat_at`；启动时回收过期 run，将 turn 转入 `needs_owner_attention` 并发布脱敏失败事件；提供 owner-only 终止卡住结算的能力，并做 claim 后进程退出的恢复测试。

### B3. AI formal apply 未验证 context revision，可能静默覆盖 claim 后的并发修改

**性质：确定架构风险，当前保留的 Owner HTTP mutation 使其可触发。**

claim 在事务内捕获完整 prompt/context，Provider 在事务外运行。formal apply 只验证：

- run 仍是 `running`；
- turn 仍是 `resolving`。

它没有验证 claim 后 world、character、combat 或其它 AI 上下文是否变化。

证据：

- `server/src/modules/ai-runtime/AiResolutionService.ts`
- `server/src/modules/ai-runtime/AiContextBuilder.ts`
- `server/src/modules/ai-runtime/StateChangeMaterializer.ts`
- `server/src/modules/combat/CombatService.ts`

后续产品修正明确保留了 Owner HTTP mutation 作为进阶/兜底能力，因此这里不能假定 Provider 运行期间没有并发写入。

**影响：**AI 可基于旧状态生成结果，然后在 formal apply 中覆盖或错误叠加 Owner 的合法修改；自动存档会原子保存一个技术上完整但语义陈旧的结果。

**建议：**增加 campaign state revision：所有会影响 AI context 的 mutation 在同一事务内递增 revision；claim 固定 revision；formal apply 在任何正式写入前比较，变化时将 run 失败并把 turn 置 `needs_owner_attention`，不写正式 entries/archive。

## Major

### M1. Archive restore 缺少快照 campaign/member/reference 完整性校验

**性质：确定问题，当前远程利用面有限，但属于跨战役完整性缺口。**

restore 只确认 archive 行属于当前 campaign，并通过通用 Zod snapshot schema；没有验证：

- `snapshot.campaignId === ctx.campaignId`；
- 所有嵌套 character/world/encounter/combatant 的 campaignId 都一致；
- character.playerId、knownBy、targetPlayerId 属于当前战役；
- combatant.encounterId 指向当前快照 encounter；
- activeCombatantId 属于该 encounter。

随后恢复代码直接使用快照中的 `snapshotChar.campaignId`、`snapshotFact.campaignId`、`enc.campaignId` 和 `combatant.campaignId` 执行 upsert。

证据：

- `packages/contracts/src/archive.ts`
- `server/src/modules/archives/ArchiveService.ts`
- `server/src/modules/characters/CharacterRepository.ts`
- `server/src/modules/world/WorldFactRepository.ts`
- `server/src/modules/combat/CombatRepository.ts`

**建议：**在任何 supersede/write 前执行 `validateSnapshotForCampaign()`；恢复写入一律使用目标 `campaignId`，不信任内嵌 campaignId；若同 ID 已属于其它 campaign，直接冲突并整体回滚。

### M2. Archive 与领域写入没有统一 campaign mutation lock 协议

**性质：确定架构风险，PostgreSQL 多连接下更明显。**

restore 会锁 campaign 行，但手动存档没有先锁；character/world 等写入也不统一获取该锁。手动存档通过多次查询捕获跨表快照，在 PostgreSQL 默认 `READ COMMITTED` 下可能看到不同时间点的数据。

证据：

- `server/src/modules/archives/ArchiveService.ts`
- `server/src/modules/characters/CharacterService.ts`
- `server/src/modules/world/WorldFactService.ts`
- `server/src/modules/combat/CombatService.ts`

**建议：**建立统一 `CampaignMutationLock` seam；所有影响 AI context 或 archive snapshot 的 mutation 都遵循相同锁协议。手动存档应先锁 campaign，再检查 resolving/running，再捕获快照。

### M3. PostgreSQL adapter 没有进入生产组合根

**性质：确定问题。**

虽然多数新模块依赖 `DatabasePort/QueryExecutor`，但组合根仍定义：

```ts
platformDb?: SqliteDatabaseAdapter
```

生产启动无条件打开 legacy SQLite，再用同一 `better-sqlite3` 连接创建平台 adapter。配置中没有 PostgreSQL backend 选择。

证据：

- `server/src/app.ts`
- `server/src/index.ts`
- `server/src/db/connection.ts`
- `server/src/config.ts`
- `server/src/platform/database/PostgresDatabaseAdapter.ts`

**影响：**PostgreSQL 当前只是测试 adapter，不是生产可替换 seam；完整 HTTP、session、SSE、AI 和 archive 路径无法在 PostgreSQL 组合根中启动。

**建议：**让 `CreateAppOptions.platformDb` 依赖 `DatabasePort` 且成为平台 app 必需依赖；将 legacy SQLite 组合根拆开；由配置显式选择 SQLite/PostgreSQL，并增加真实 PostgreSQL 启动 smoke test。

### M4. 平台与 legacy 共用裸 SQLite 连接，事务 seam 可被绕开

**性质：架构风险。**

`getPlatformDb()` 把 `getDb()` 的 raw `better-sqlite3` 连接交给 `SqliteDatabaseAdapter` 复用；legacy 路由仍直接持有同一 raw connection。Legacy SQL 不参与 adapter 的 FIFO/transaction context。

证据：

- `server/src/db/connection.ts`
- `server/src/platform/database/SqliteDatabaseAdapter.ts`
- `server/src/app.ts`

如果平台事务 callback 真正让出事件循环，legacy 请求可能在同一物理连接上执行并观察或参与未提交事务。

**建议：**不要让 adapter 外代码继续持有同一 raw connection。理想方案是 legacy 和平台都通过统一调度 seam；过渡期至少使用独立连接并明确 WAL/锁语义。

### M5. Campaign create 不是原子操作，并发 join 错误语义不稳定

**性质：确定问题。**

`CampaignService.create()` 先插入 campaign，再插入 owner membership，没有事务。如果第二步失败，会留下 owner 无法访问的孤儿 campaign。

`join()` 使用 `findMember -> insertMember`，两个并发请求可同时通过查询，随后一个在唯一约束上失败并落入未知 500，而不是稳定的幂等返回或 `STATE_CONFLICT`。

证据：

- `server/src/modules/campaigns/CampaignService.ts`
- `server/src/modules/campaigns/CampaignRepository.ts`
- `server/src/platform/database/migrations/001_initial_platform.sql`

**建议：**CampaignService 接收 `DatabasePort` 并在事务中完成 campaign+owner member；join 改为唯一约束驱动的幂等插入或精确冲突映射。

### M6. 服务端权威战斗 RNG 与 AI 自报 diceResults 可能不一致

**性质：确定架构缺口。**

CombatService 使用服务端 RNG 决定攻击、伤害和豁免，但命令返回值只提供 encounter；AI resolution 同时允许 Provider 自报 `diceResults.total`，formal apply 原样写入 turn entries。

证据：

- `server/src/modules/combat/CombatService.ts`
- `packages/contracts/src/turn.ts`
- `server/src/modules/ai-runtime/TurnResolutionValidator.ts`
- `server/src/modules/ai-runtime/AiResolutionService.ts`

**影响：**战斗数据库状态可能显示未命中，而正式骰点日志和叙事记录 AI 自报命中。

**建议：**让 combat command 返回结构化权威结果，由 formal apply 从服务端 RNG 结果派生 dice entries；AI 只能请求掷骰及声明叙事意图，不能提供最终点数。

### M7. Character materializer 只有字段白名单，没有领域不变量

**性质：确定问题。**

当前白名单允许：

- 负 hp/hpMax/ac/gold/level/experience；
- hpCurrent 大于 hpMax；
- 无界 conditions/inventory；
- 修改同 campaign 中非 approved 角色。

证据：

- `server/src/modules/ai-runtime/StateChangeMaterializer.ts`
- `server/src/modules/ai-runtime/TurnResolutionValidator.ts`

**建议：**优先改为领域命令（伤害、治疗、获得物品、增加状态等）；短期至少增加数值范围、数组/文本预算和 approved/context membership 校验。

### M8. 幂等 replay 在查既有 run 前仍解析当前 Provider 配置

**性质：确定问题。**

`resolveTurn()` 先执行 `resolveForCampaign()`，然后 claim 内才查询 idempotency key。因此历史成功 run 的同 key replay 仍依赖当前密钥文件、当前 Provider 配置和解密成功。

证据：

- `server/src/modules/ai-runtime/AiResolutionService.ts`
- `server/src/modules/ai-runtime/AiProviderConfigService.ts`

**影响：**当前 Provider 配置损坏时，无法重放并返回已成功的历史 run，违背“replay 不触碰 Provider”的接口承诺。

**建议：**先做轻量幂等查询；只有确定需要创建新 run 时才解析 Provider；claim 内再次查重防止 TOCTOU。

### M9. SSE 授权只发生在建连时，注销/撤销不会终止既有连接

**性质：确定架构缺口。**

SSE route 在连接建立时解析 campaign context，之后 runtime 只持有静态 viewer；logout 只删除 session，没有通知 realtime runtime。

证据：

- `server/src/routes/eventRoutes.ts`
- `server/src/platform/realtime/EventStreamService.ts`
- `server/src/routes/authRoutes.ts`
- `server/src/modules/identity/IdentityService.ts`

**建议：**subscription 绑定 sessionId/userId；logout、session revoke 或 member removal 时关闭对应连接；或使用授权 revision 做周期性重验证。

### M10. Client 战役切换时，旧 EventSource 迟到消息可污染新战役 watermark

**性质：确定客户端竞态。**

`RealtimeSession.start()` 关闭旧 source 后切换 `this.campaignId`；旧 source listener 没有捕获 source/campaign generation。`handleMessage()` 在验证 payload campaignId 前先更新当前 watermark。

证据：

- `client/src/app/realtime/RealtimeSession.ts`

场景：c1 的 sequence=100 消息在切到 c2 后迟到执行，会先把 c2 watermark 写为 100，然后才因 campaignId 不匹配被丢弃；c2 下次 reconnect 使用 `after=100`，永久跳过自己的 1-100 号事件。

**建议：**每次连接生成 generation；listener 在推进 watermark 前验证 `this.source === capturedSource`、当前 campaign 与 captured campaign 一致且 generation 有效。

### M11. Session token 同时进入 HttpOnly Cookie、响应 JSON和数据库明文主键

**性质：确定安全设计问题。**

登录路由设置 HttpOnly Cookie 后，又返回 `{ sessionId, expiresAt }`；`sessions.id` 保存原始 bearer token。

证据：

- `server/src/routes/authRoutes.ts`
- `packages/contracts/src/auth.ts`
- `server/src/modules/identity/IdentityRepository.ts`
- `server/src/platform/database/migrations/001_initial_platform.sql`

**影响：**登录响应中的 token 可被同源脚本、前端监控或 XSS 获取；数据库只读泄漏可直接接管未过期会话。

**建议：**浏览器登录响应只返回用户/过期时间；原始 token 只进入 Cookie；数据库保存 token 摘要并按摘要查询。

### M12. Owner-only 授权没有统一发生在 payload 解析前

**性质：确定架构不一致。**

应用全局先执行 `express.json({ limit: '10mb' })`；部分 owner-only route 还先做 Zod parse，再由 service `requireOwner()`。Provider/Rules route 已实现“先 owner、后 parse”，但其它路由未统一。

证据：

- `server/src/app.ts`
- `server/src/routes/campaignRoutes.ts`
- `server/src/routes/characterRoutes.ts`
- `server/src/routes/worldRoutes.ts`
- `server/src/routes/archiveRoutes.ts`
- `server/src/routes/combatRoutes.ts`
- `server/src/routes/aiRoutes.ts`
- `server/src/routes/rulesRoutes.ts`

**建议：**平台 router 的顺序统一为 session -> campaign member -> role middleware -> endpoint body parser -> Zod -> service；普通 JSON 上限降到合理尺寸，service 保留纵深授权。

### M13. AI preview 当前不是真正流式，Provider 端口也无法强制公开增量安全

**性质：确定现状 + 未来高风险 seam。**

当前 OpenAI-compatible adapter 等待完整响应、解析整个 JSON，然后一次性把 `publicNarrative` 作为单个 delta 发布。底层请求使用 `stream:false`。

证据：

- `server/src/modules/ai-runtime/OpenAiCompatibleAiProvider.ts`
- `server/src/modules/ai-runtime/AiProviderPort.ts`
- `server/src/services/aiProvider.ts`

当前实现通过“不真正流式”避免了把 privateUpdates/raw JSON 流给玩家，但 `AiProviderPort.onDelta(text)` 本身不能约束未来 adapter 只发送公开文本。

**建议：**把 `publicNarrativeStream` 与 `finalStructuredResult` 分成不同通道；可以采用两次调用、typed upstream events 或只在明确位于 `publicNarrative` 字段时输出的增量 parser，并增加恶意 Provider delta 泄漏测试。

### M14. Migration runner 缺少多实例锁，构建复制也不清理旧迁移

**性质：确定部署风险。**

MigrationRunner 先读取 applied set，再逐个应用，没有跨进程锁。两个实例同时启动时可能都尝试执行非幂等 `ALTER TABLE`。

`copy-migrations.mjs` 只覆盖复制，不清理 dist 目标目录；已删除或重命名的 SQL 可能残留在增量构建产物。

证据：

- `server/src/platform/database/migrations/MigrationRunner.ts`
- `server/scripts/copy-migrations.mjs`

**建议：**PostgreSQL 使用 advisory lock，SQLite 明确单实例迁移锁；构建前清理 migration dist 目录并比较源/目标文件集合和 hash。

### M15. DatabasePort 的 `readCommitted` 跨 adapter 语义不一致

**性质：确定接口语义问题。**

SQLite FIFO 在 callback 期间提供稳定视图；PostgreSQL 的 `BEGIN READ ONLY` 仍是默认 `READ COMMITTED`，多条查询可看到不同提交点。

证据：

- `server/src/platform/database/DatabasePort.ts`
- `server/src/platform/database/SqliteDatabaseAdapter.ts`
- `server/src/platform/database/PostgresDatabaseAdapter.ts`

**建议：**若 interface 承诺稳定快照，PostgreSQL 使用 `REPEATABLE READ READ ONLY`；否则重命名并明确只保证不读未提交数据。

### M16. Contracts 默认 strip 未知字段，不能证明 HTTP 未泄漏敏感字段

**性质：确定测试/契约 seam 缺口。**

大量外部 schema 没有 `.strict()`。Zod 默认删除未知字段，因此服务端若误返回 `context/rawDebug/token`，客户端 parse 后可能看不到，但敏感内容已经经过网络和浏览器。

证据：

- `packages/contracts/src/auth.ts`
- `packages/contracts/src/campaign.ts`
- `packages/contracts/src/character.ts`
- `packages/contracts/src/world.ts`
- `packages/contracts/src/turn.ts`
- `packages/contracts/src/events.ts`
- `packages/contracts/src/ai.ts`
- `client/src/shared/lib/contractSchemas.ts`

**建议：**外部输入和敏感输出 DTO 使用 strict schema；服务端在测试或 serializer seam 验证响应；增加“额外敏感字段必须失败”的负面测试。

### M17. 生产 Web 拓扑和优雅关闭没有形成完整架构

**性质：确定交付缺口。**

当前 server 不托管 `client/dist`，仓库也没有正式反向代理/容器拓扑；client 使用同源相对 `/api`。浏览器验收通过 Vite dev proxy，而不是生产 artifact。

shutdown 只调用 `server.close()` 和 `closeAllConnections()`，没有显式关闭 realtime runtime、等待 active AI/formal apply、关闭 platform DB/legacy DB。

证据：

- 根 `package.json`
- `server/package.json`
- `server/src/index.ts`
- `client/src/shared/api/platformHttp.ts`
- `client/vite.config.ts`
- `scripts/phase4-browser-validation.ts`

**建议：**明确 server 托管 SPA 或正式反向代理二选一；增加生产构建 smoke test；shutdown 按停止接收请求、关闭 realtime、drain 请求、关闭数据库、超时强退的顺序执行。

## Minor 与重要测试缺口

### m1. 事件 contract 与生产 emitter 不完整

`player.joined` 已定义且 client 会消费，但 `CampaignService.join()` 没有发布事件。当前也缺少 `turn.started` 和角色提交/审核生命周期事件，浏览器流程通过 reload 规避角色实时同步。

相关文件：

- `packages/contracts/src/events.ts`
- `server/src/modules/campaigns/CampaignService.ts`
- `server/src/modules/turns/TurnService.ts`
- `server/src/modules/characters/CharacterService.ts`
- `client/src/app/realtime/RealtimeSession.ts`
- `client/src/tests/phase4-browser-flow.test.ts`

### m2. Action 顺序缺少稳定 tie-breaker

action 查询只按 `submitted_at` 排序；毫秒相同时 SQLite/PostgreSQL 顺序不确定，会影响 AI context 和 archive 可复现性。至少应按 `submitted_at, id`，更理想是 per-turn `submission_sequence`。

### m3. AI 输出和 context 没有统一预算

public narrative、private updates、state changes、world creations、encounter starts、Provider response body 和长期 context 均缺少明确数量/字节/token 上限，存在内存、存储、长事务和模型 context overflow 风险。

### m4. Frontend route-param 表单和 HTTP 取消需要加强

部分页面把 campaignId 或服务端初值复制到本地 state，但没有在 campaign/user epoch 变化时 reset；React Query queryFn 也没有向 `platformRequest` 传递取消 signal。应增加 c1 -> c2 快速切换和 pending operation 完成竞态测试。

### m5. ErrorBoundary 与 command error UX 不一致

Player 子路由有 `FeatureErrorBoundary`，Owner 没有同级边界；浏览器“feature error”测试实际覆盖 query 500，而不是 render crash。多个 mutation 失败后也没有可见错误提示。

### m6. 敏感 Query Cache 生命周期未定义

Owner AI run detail 的 `context/result/rawDebug` 会进入普通 Query Cache；离开详情或账户切换时没有主动清理。API Key 路径没有进入 Query mutation cache，这一点是正确的。

## 已确认的架构优点

### 1. CampaignAuthContext 是正确的权限 seam

- session 只提供 user identity；
- campaign middleware 从数据库成员关系构造完整 context；
- 非成员统一返回 `CAMPAIGN_NOT_FOUND`；
- role/playerId 不信任 body 或 header。

相关文件：

- `server/src/platform/http/sessionMiddleware.ts`
- `server/src/platform/http/campaignMiddleware.ts`
- `server/src/modules/campaigns/CampaignAccess.ts`

### 2. 可见性投影集中，玩家 DTO 总体安全

角色、世界、turn entries、combatants 和 SSE events 都有服务端投影；Owner 全量，Player 只见 public 和自己的 private，owner-only 不外泄。

### 3. Turn/action/outbox 的事务设计扎实

行动写入、requirement 更新、自动锁定和 outbox 事件处于同一事务；sequence 使用 per-campaign 原子 upsert，不使用 `MAX+1`。

### 4. AI formal apply 的原子范围设计良好

在不存在 crash/revision 问题时，以下正式写入被放在同一事务中：

- 白名单状态变更；
- 世界事实与遭遇创建；
- turn entries；
- interaction requests；
- run succeeded；
- turn completed；
- outbox；
- automatic archive；
- next turn。

这为失败回滚和幂等提供了良好基础。

### 5. Provider final output 保持 unknown

Provider adapter 不把外部输出伪装成可信类型，最终由 validator/schema 解析；Provider 原始错误不直接进入数据库和 HTTP。

### 6. Combat 使用白名单命令端口

AI 和 HTTP 复用同一结构化 command seam，拒绝任意 JSON patch；活跃战斗员、HP clamp、状态命令和服务端 RNG 已集中在 CombatService。

### 7. SSE replay/live 共用同一投影

EventStreamService 对 replay 与 live 使用相同 outbox tail 和 `projectEvent()`，并具备 single-flight polling、cursor 推进、backpressure 和 poison-row 处理。

### 8. Archive 是有价值的深模块

当前实现保存真实角色、世界、回合、行动、requirement 和战斗快照；历史通过 superseded 保留而不是物理删除；恢复和 `archive.restored` 同事务。主要问题是恢复前不变量和并发协议，而不是模块完全浅化。

### 9. 新 Provider 凭证路径设计正确

新平台路径具备：

- campaign scope；
- Owner-only；
- AES-256-GCM；
- Key write-only；
- URL credentials 拒绝；
- redirect manual；
- 默认 Unavailable；
- 固定脱敏错误。

Owner 可访问任意 HTTP(S) 私网目标是已接受的产品信任边界，本报告不把允许私网本身视为缺陷。

### 10. 新 Rules 路径确实 metadata-only

新 contract、数据库和路由均不接收规则正文；campaign HTTP 不能创建 platform scope；记录不可变且 scope/唯一性由数据库索引支持。

### 11. Client 的主要模块 seam 清晰

`platformRequest` 集中处理 credential、timeout、错误 envelope 和 runtime schema；React Query keys 多数按 campaign 隔离；RealtimeSession 把连接、退避、watermark、preview 和 cache invalidation 隐藏在小 interface 后。

### 12. 浏览器验收具有较高真实性

现有流程使用 Owner、playerA、playerB 三个隔离 context，经过真实 cookie、HTTP、SSE 和 UI；覆盖 Provider 保存、Rules 登记、AI 世界/遭遇创建、隐私投影、SSE reconnect 和 archive restore。它的主要不足是仍使用 Vite dev server/SQLite fixture，并未覆盖共享 cookie 多标签页和真实 PostgreSQL。

## 分阶段评价

| 范围 | 评价 | 主要剩余风险 |
| --- | --- | --- |
| Phase 1 Identity/Campaign/Characters | 基本分层正确 | session token 生命周期、campaign create 原子性、owner parse 顺序 |
| Phase 2A World/Turn/Outbox | 核心事务和投影良好 | campaign DB 约束、缺失生命周期事件、action 稳定顺序 |
| Phase 2B AI/Archive | formal apply 和真实快照方向正确 | crash recovery、stale context、archive 不变量/锁协议 |
| Phase 3 SSE/Combat | replay/live 和命令白名单良好 | session revoke、client campaign switch race、权威 dice result |
| Phase 4 Client | feature 分层和三身份流程良好 | 多标签页身份切换、表单 epoch、错误边界和敏感 cache 生命周期 |
| Phase 5 Provider | 新平台切片正确 | legacy 明文配置、key rotation/Windows ACL、env/WebUI URL policy 统一 |
| Phase 5 Rules | 新平台切片正确 | legacy 正文入口仍运行，系统级 metadata-only 尚未成立 |
| AI-managed world/combat 修正 | 当前 UI 与计划一致 | 服务端 Owner mutation 是明确保留的进阶能力，不应误报为缺陷；需靠 revision 防止与 AI 并发冲突 |

## 推荐修复顺序

### P0：发布阻断

1. 默认关闭或强认证 legacy `/api/admin`、legacy player token 和 legacy SSE。
2. 迁移/清除 legacy 明文 Provider Key，并关闭 legacy Rules 正文入口。
3. 为 AI run 增加 lease、timeout、启动 reconciler 和 owner cancel。
4. 增加 campaign state revision，阻止陈旧 AI formal apply。

### P1：数据一致性和生产 seam

5. 增加 archive snapshot campaign/member/reference 完整性校验。
6. 建立统一 campaign mutation lock 协议。
7. 让生产组合根真正支持 `DatabasePort` 和 PostgreSQL。
8. 修复 campaign create/join 的事务与并发语义。
9. 让 combat 返回权威 RNG 结果并派生正式 dice entries。
10. 收紧 character materializer 领域不变量。

### P2：会话、实时和部署

11. Session token 只通过 Cookie，数据库只存摘要。
12. SSE 绑定 session 并在 revoke/logout 时关闭。
13. 修复 RealtimeSession 跨 campaign 迟到 frame 竞态。
14. 加入迁移全局锁、dist 清理和生产 artifact smoke test。
15. 明确生产 Web 同源拓扑和优雅关闭。

### P3：契约和可维护性

16. 外部 contracts strict 化并由服务端验证响应。
17. 补齐 `player.joined`、`turn.started`、character lifecycle 事件。
18. 为 AI output/context/HTTP body 增加预算。
19. 统一 Owner/Player ErrorBoundary、mutation error 和 Query Cache 清理策略。
20. 增加真实 PostgreSQL、多标签页、第二战役切换和生产 build 浏览器验收。

## 最终判断

已完成架构不是需要推倒重来。核心领域模块、事务 outbox、正式 AI 应用、可见性与前端 feature 分层都已经形成可继续深化的基础。

当前最有效的策略不是扩展更多功能，而是先关闭跨阶段 seam：

> **legacy 暴露面 -> AI 崩溃恢复 -> context revision -> archive 隔离/锁 -> PostgreSQL 生产装配 -> session/SSE 生命周期。**

这些问题完成后，现有架构才具备进入 legacy adapter 和最终 cutover 的可靠基础。
