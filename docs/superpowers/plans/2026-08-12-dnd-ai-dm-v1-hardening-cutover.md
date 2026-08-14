# DND AI-DM v1：平台硬化与 Forward-only Cutover 总路线图

状态：✅ Phase 0 已完成；权威未来工作路线图，下一步编写 Phase 1 详细计划  
制定日期：2026-08-12  
决策来源：[`2026-08-12-dnd-ai-dm-v1-decisions.md`](../specs/2026-08-12-dnd-ai-dm-v1-decisions.md)  
计划审查：[`2026-08-12-v1-hardening-cutover-plan-review.md`](../reviews/2026-08-12-v1-hardening-cutover-plan-review.md) — **PASS / 0 Blocker / 0 Major**  
历史问题来源（其中被后续产品决策取代的建议不再具有执行权威）：

- [`2026-08-12-rearchitecture-roadmap-review.md`](../reviews/2026-08-12-rearchitecture-roadmap-review.md)
- [`2026-08-12-completed-architecture-review.md`](../reviews/2026-08-12-completed-architecture-review.md)

## 1. 取代范围

本文件取代 [`2026-08-02-dnd-ai-dm-rearchitecture-revised.md`](./2026-08-02-dnd-ai-dm-rearchitecture-revised.md) 中所有尚未完成的未来工作，尤其包括原 Phase 5 的 legacy adapter、旧数据映射和旧式 cutover。

旧路线图继续保留以下历史价值：

- Phase 1-4 的已完成范围、提交记录、复审与验证索引；
- 已完成的 Provider WebUI/AES-256-GCM 切片；
- 已完成的 Rules metadata-only 切片；
- 历史迁移 001-011 的来源说明。

以下内容不再执行：

- legacy adapter；
- legacy 身份认领、旧数据迁移、双读或 shadow mapping；
- PostgreSQL 作为 v1 正式生产后端；
- Owner 世界/战斗 HTTP 写端点；
- 真 Provider token streaming；
- User Rules scope；
- 自动 migration 删除 legacy 表。

## 2. 目标

将当前已经具备完整游戏垂直流程的新平台，收敛成一个可发布、可恢复、私有受邀、SQLite-only 的 v1：

```text
Browser
  -> Express 同源 SPA/API/SSE
  -> 平台身份与 CampaignAuthContext
  -> Campaign mutation/revision seam
  -> 领域模块 + transactional outbox
  -> 单一 SqliteDatabaseAdapter
  -> SQLite WAL + credential key
```

最终系统必须具备：

- 无 legacy 运行时入口；
- 注册邀请码和平台管理员；
- Cookie-only digest session；
- Origin/CSRF/限速/安全错误边界；
- AI 崩溃恢复和陈旧上下文拒绝；
- gameplay-only 安全存档恢复；
- 服务端权威角色/战斗领域命令；
- session revoke 与 SSE 生命周期闭环；
- Platform/Campaign Rules 与加密 Provider；
- 生产 SPA、维护模式、备份恢复和显式 cutover CLI；
- 基于生产构建的三身份 Chromium 验收。

## 3. 不可变约束

### 3.1 执行约束

- 所有业务变更继续采用 TDD：先写失败测试并确认预期失败，再实现最小代码。
- 每个 Phase 必须先编写独立详细计划并通过计划审查，才允许修改业务代码。
- 不修改默认 `dnd.sqlite`；开发和测试使用临时或内存 SQLite。
- 不删除或覆盖现有未提交改动。
- 不暂存、commit 或 amend，除非用户明确要求。
- 前端变更必须通过真实 Chromium 验收。
- 外部错误码必须同步 contracts 与 `AppError.DEFAULT_HTTP_STATUS`。

### 3.2 安全约束

- 权限由服务端执行；前端隐藏只提供 UX，不是权限控制。
- 非成员继续使用 `CAMPAIGN_NOT_FOUND` 隐藏战役存在性。
- 平台管理员不自动读取战役内容。
- Provider Key、session token、CSRF token、邀请码明文、credential ciphertext、AI raw debug 和 archive snapshot 不得进入不应出现的 DTO、日志或安全审计。
- Owner 可配置任意 HTTP(S) 目标；不得恢复公网 IP 限制。
- URL credentials、非 HTTP(S) 协议和 3xx redirect 继续拒绝。

### 3.3 数据与 cutover 约束

- 下一平台迁移编号是 `012`。
- v1 正式生产仅支持 SQLite 单实例。
- legacy 表在最终 cutover 前不删除、不写入、不迁移。
- legacy 表只能由显式 CLI 在已验证备份之后删除。
- gameplay archive restore 与数据库灾难恢复是两种不同能力，不得共用含糊接口。

## 4. 目标深模块与接口

详细计划必须围绕以下 seam 组织，禁止把复杂策略散落到 router 或 repository caller：

### 4.1 平台组合根

```ts
createPlatformApp({
  database: DatabasePort,
  aiProvider: AiProviderPort,
  credentialCipher: CredentialCipher,
  realtimeRuntime: EventStreamRuntime,
  security: PlatformSecurityDependencies,
})
```

- 平台 database 为必需依赖。
- 生产组合根不接受 legacy `AppDatabase` 或 raw SQLite connection。
- PostgreSQL adapter 不进入 v1 production factory。

### 4.2 Campaign mutation seam

```ts
runCampaignMutation(campaignId, source, work)
```

该模块集中负责：

- maintenance 检查；
- campaign lock；
- resolving 写入策略；
- mutation source；
- state revision；
- transaction；
- outbox 与必要审计。

### 4.3 内部领域命令

- `CharacterCommandPort`
- `WorldFactCommandPort`
- `EncounterCommandPort`
- `CombatCommandPort`

外部 Owner 世界/战斗 HTTP 写面删除后，AI formal apply 继续通过这些内部 seam 写入。

### 4.4 AI 恢复

- `AiRunRecoveryService`
- `AiRetryService`
- `FormalApplyRevisionGate`

SQLite v1 采用单实例启动恢复，不实现多节点 heartbeat/lease takeover。

### 4.5 Archive

- `ArchiveSnapshotValidator`
- `GameplayRestorePlan`
- active-only、gameplay-only restore interface

### 4.6 运维

- `MaintenanceManager`
- `InstanceLock`
- `BackupService`
- `BackupManifestVerifier`
- `LegacyTableDropper`

## 5. 依赖图

```text
Phase 0 计划重置与接口冻结
   ↓
Phase 1 删除 legacy 运行时并建立平台唯一组合根
   ↓
Phase 2 私有注册、平台主管和完整 Web 安全
   ↓
Phase 3 Campaign mutation、revision 与内部 command ports
   ↓
Phase 4 AI 恢复、手动重试和领域命令
   ↓
Phase 5 Archive gameplay-only 安全恢复
   ↓
Phase 6 Rules、Provider、平台管理与安全审计闭环
   ↓
Phase 7 生产 SPA、维护模式、备份恢复与 cutover CLI
   ↓
Phase 8 生产构建 Chromium 发布门
   ↓
Phase 9 Forward-only maintenance cutover
```

任一 Phase 未通过验收门，不进入下一 Phase。

---

## Phase 0：计划重置与接口冻结

**状态：**✅ 已完成；独立计划级审查 `PASS / 0 Blocker / 0 Major`。  
**迁移：**无。  
**业务代码：**不修改。

### 范围

1. 发布 v1 决策记录和本路线图。
2. 将旧总路线图标记为未来工作已被取代。
3. 冻结：
   - 平台管理员权限；
   - bootstrap 和平台注册邀请；
   - session 摘要与撤销；
   - Campaign mutation source；
   - AI revision/recovery；
   - Archive gameplay-only/active-only；
   - Platform/Campaign Rules；
   - buffered preview；
   - maintenance、backup、drop CLI。
4. 明确 PostgreSQL experiment lane 不阻断 SQLite v1。

### 验收门

- [x] 决策文档、路线图、历史问题审查和 v1 计划审查互相引用。
- [x] 文档中不再把 legacy adapter 列为未来任务。
- [x] 迁移下一编号明确为 012；v1 冻结到 016，017 未分配。
- [x] 详细计划模板要求 TDD、精确文件、命令、失败原因和验收门。
- [x] 独立计划审查无 Blocker/Major。

---

## Phase 1：删除 legacy 运行时，建立平台唯一组合根

**迁移：**无。Legacy 表保持原样。  
**目标：**先关闭会绕过新平台安全边界的运行时入口，并消除平台对 legacy raw database 的依赖。

### 切片 1.1：提取平台 Provider transport

- 将新平台仍依赖的 OpenAI-compatible HTTP transport 从 legacy `server/src/services/aiProvider.ts` 提取到平台模块。
- transport 继续封装 timeout、取消、响应预算、URL 拼接、`redirect: 'manual'` 和脱敏错误。
- 每个 AI attempt 最多发起一次 Provider 请求；生产 transport 不执行自动重试。失败后的再次调用只能由 Owner 在 Phase 4 创建新 attempt。
- Mock 只保留在测试或明确的历史代码中，不进入生产平台 transport。

### 切片 1.2：删除 legacy 服务端运行面

- 从组合根删除 `/api/admin`、`/api/player` 和旧 `/events`。
- 删除 legacy routers、只被它们调用的 services、旧 event bus 和旧 HTTP tests。
- 生产启动不再调用 legacy `migrate()` 或 `seedBuiltinRules()`。
- 不执行任何 legacy 表 DROP、UPDATE 或映射。

### 切片 1.3：删除 legacy client

- 删除 legacy Admin/Player 页面、token URL 流程、旧 API client、旧 types 和只服务于旧页面的测试。
- 新 AppRouter 不保留会误导用户继续使用旧入口的页面。

### 切片 1.4：平台唯一数据库所有权

- `createPlatformApp()` 只接收 `DatabasePort`。
- 生产只打开一个 `SqliteDatabaseAdapter`；不再把 raw connection 同时交给 legacy 代码。
- PostgreSQL adapter 保留实验定位，但不接入生产配置。

### 切片 1.5：SQLite 单实例与迁移 artifact 完整性

- 在执行 012 及后续迁移前，生产启动必须先获取 SQLite 数据目录单实例锁。
- 第二个 server 或危险 CLI 无法获取锁时必须拒绝启动，不允许依赖 SQLite busy error 被动发现冲突。
- 构建时先清理 dist migration 目录，再复制迁移；启动前校验 source/dist 文件集合与 SHA-256。
- MigrationRunner 只执行平台迁移，并继续使用独立 `platform_migrations`；不得读取 legacy `schema_migrations`。
- InstanceLock 在本 Phase 建立，Phase 7 的 backup/cutover CLI 复用同一锁协议。

### 切片 1.6：Credential key 失效关闭

- 已有 Provider 密文时，credential key 缺失、格式错误或无法解密必须在 HTTP listener 前拒绝启动；不再自动生成替代 key。
- 只有显式初始化的全新数据库且不存在 Provider 密文时才允许创建 key。
- Phase 2 的 `platform_instance` 建立后，将 database ID 与 key fingerprint 绑定；Phase 7 复用该绑定执行备份恢复验证。

### TDD seam

- 组合根路由存在/缺失测试；
- legacy import graph 负面检查；
- Provider transport contract；
- 含 legacy sentinel 表的 SQLite 启动测试；
- 双实例启动与 source/dist migration manifest 测试。

### 验收门

- [ ] 所有 legacy HTTP/SSE 入口返回统一安全 404。
- [ ] 生产代码不导入 legacy router/domain/service。
- [ ] 新平台 Provider test/run 行为不回归。
- [ ] 生产启动只持有平台 SQLite adapter。
- [ ] 第二个进程无法同时启动或执行迁移。
- [ ] Source/dist migration 文件集合与 hash 完全一致。
- [ ] 已有 Provider 密文时缺 key、错 key 和损坏密文均 fail closed。
- [ ] Legacy sentinel 表在启动、测试和迁移后完全不变。
- [ ] test/typecheck/build 通过。

---

## Phase 2：私有注册、平台主管与完整安全基线

### 建议迁移

| 编号 | 名称 | 主要内容 |
| --- | --- | --- |
| 012 | `012_platform_foundation.sql` | `platform_instance` 单例（database ID、`initializing/ready` enrollment 状态、bootstrap、maintenance/epoch、Platform Rules revision、key fingerprint、`session_security_cutover_at`）、唯一平台主管、注册邀请 |
| 013 | `013_secure_sessions.sql` | digest session 存储、用户 auth revision/账号状态 |
| 014 | `014_security_audit.sql` | append-only `platform_security_audit_events` |

具体 DDL 由 Phase 2 详细计划冻结；禁止在迁移中记录 secret/token 明文。

### 切片 2.0：显式平台实例初始化

- 新部署禁止 server 因数据库文件缺失而静默创建生产实例。
- 012 静态 SQL 只创建 `platform_instance` 等 schema，不插入或猜测外部 key fingerprint。
- Fresh DB：本地初始化命令应用 001-012 schema，生成 database ID 和临时 credential key，事务写入 `initializing` ID/fingerprint，原子发布 key 文件，再事务切换为 `ready`；命令输出 database ID，不创建管理员。
- Existing 001-011 DB：专用 enrollment CLI 应用 012；有 Provider 密文时先用候选现有 key 离线解密全部密文，无密文且无 key 时允许 CLI 生成新 key；随后执行同一 `initializing -> key publish -> ready` 两阶段绑定。
- 任一步失败时 listener fail closed；CLI 只能用同 fingerprint 恢复完成或显式回滚 initialization，普通 server 不把空 fingerprint 自动解释为信任当前 key。
- 部署者通过本地只读命令获取并核对 ready 状态的 database ID 后，才能显式启用浏览器 bootstrap mode。
- 初始化或读取 ID 的 CLI 使用绝对路径、拒绝 symlink 并复用 InstanceLock。

### 切片 2.1：浏览器首次设置

- 首次设置默认关闭；只有显式 bootstrap mode、canonical 无 padding base64url 43 字符（解码恰好 32 bytes）的 secret、预期 database ID、管理员为零且 `bootstrap_completed_at IS NULL` 时提供页面。
- 缺失/错误数据库路径、错误 instance ID 或空库误创建必须 fail closed，不能自动开放设置页。
- 提交 bootstrap secret、登录名和密码。
- 精确 Origin、pre-auth CSRF、严格限速、小 body、constant-time secret comparison、`Cache-Control: no-store`。
- 数据库约束保证最多一个平台管理员；并发 bootstrap 只能一个成功。
- 创建 user + platform administrator + 不可逆 bootstrap completion + audit 同事务。
- 成功后当前进程立即关闭设置面；发布前关闭 bootstrap mode 并移除 secret；响应不返回 session token。

### 切片 2.2：平台注册邀请码

- 平台管理员 WebUI 创建、列出状态和撤销邀请码。
- CSPRNG、digest-only、明文一次显示、一次使用、7 天有效。
- 注册消费和用户创建同事务，并处理并发单次消费。

### 切片 2.3：Cookie-only digest session

- 登录 JSON 不再返回 `sessionId`。
- 数据库只存 token digest；浏览器 session 不接受 Bearer fallback。
- 现有数据库若仍有原始 token session，普通 startup 拒绝自动跨越安全切换；专用 security-cutover CLI 只允许执行冻结的 012-014 migration allowlist，不执行任意未来 pending migration。
- Phase 2 直接实现可复用 `OfflineBackupPrimitives`：SQLite backup API 或关闭后的完整文件集、credential key、同文件系统临时目录、逐文件 hash/fsync 和原子发布。Phase 7 的完整 BackupService 组合并扩展这些原语，而不是反向依赖 Phase 7。
- Existing DB 固定顺序：停止 server/独占锁 → 012 enrollment ready → 敏感备份 → 013 仅新增 digest/revoke/auth-revision 字段和索引 → 014 建审计 → 单一事务删除全部旧 session、记录 cutover audit、写 `session_security_cutover_at` → checkpoint/离线清理 → 旧 token 失效验证。
- Fresh DB 没有旧 session 时，初始化流程应用 012-014 并直接写入 `session_security_cutover_at`；不执行破坏性清理。
- 任一步失败都不得启动 listener；敏感备份失败时不得应用 013 或删除旧 session。
- 全新数据库或没有旧 session 行的数据库可正常迁移；不保留明文与摘要双读取兼容窗口。
- 切换前备份包含历史原始 token，必须按敏感材料限制访问；旧 token 在新版本中永远不能恢复有效。
- Cookie 使用 `__Host-dnd_session`、`Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`、无 `Domain`；绝对有效期 7 天、空闲有效期 12 小时，注销使用完全相同属性清除。
- 支持多设备、注销当前、注销全部、管理员撤销。
- Session revoke/expire/account disable 提交后推进 auth/revoke epoch，关闭 SSE 并丢弃未发送 replay/live 队列；dispatch 与 reconnect 重新校验权威状态。

### 切片 2.4：HTTP 安全边界

- 精确 Origin + 与 session 绑定的 synchronizer CSRF；bootstrap/register/login 使用 pre-auth CSRF nonce；
- 生产不使用通配 CORS；
- role middleware 先于 endpoint body parse；
- 移除全局 10 MB JSON parser；
- bootstrap/register/login/invite/Provider/AI/SSE reconnect 限速；
- 外部敏感 DTO strict；
- 统一安全错误 envelope。

### 切片 2.5：平台管理员边界

- 平台管理员 API 仅能管理账号、邀请、session、Platform Rules、运行状态和安全审计。
- 不读取战役内容 repository；非成员访问战役继续 `CAMPAIGN_NOT_FOUND`。
- v1 只允许首次设置创建的一个平台管理员；不提供管理员提升/撤销 API。
- 唯一管理员不能被停用、删除或降级。
- 忘记管理员密码时，停止服务器并使用本地恢复 CLI 重设密码；CLI 要求数据库中恰有一个管理员、绝对路径、database ID、独占锁和关闭回显的交互式密码输入，且不能创建第二个管理员。
- 密码恢复同事务递增 auth revision、撤销管理员全部 session 并写 allowlisted audit；旧 Cookie/SSE 全部失效。

### 切片 2.6：Maintenance 基础与线性化状态

- 012 提供 `active -> draining -> quiescent` 持久化状态和 maintenance epoch；Phase 2 实现 `MaintenanceManager` 与统一 admission check，平台主管 UI 到 Phase 6 补齐。
- `draining` 关闭新写 admission，并等待活动写事务、AI/formal apply 和 Provider 调用完成或取消；超时保持 draining，不允许 backup/drop。
- 所有写入在取得事务/协调锁后、提交前再次校验 maintenance epoch。
- `quiescent` 只允许 health、静态维护页、login/me 和平台主管 maintenance status/off；login session、固定 schema audit 和 maintenance off 状态/epoch 是唯一 operational write 特例，不能开放 SSE 或其它 session 管理；其余写入全部拒绝。

### 验收门

- [ ] 首次设置只能成功一次。
- [ ] 新生产实例只能通过显式初始化创建；数据库缺失时普通 server fail closed。
- [ ] 并发 bootstrap 只能一个成功；错数据库路径、空库和恢复到 bootstrap 前备份都不会自动开放设置页。
- [ ] 无邀请不能注册；邀请只能消费一次且 7 天到期。
- [ ] 登录响应和数据库均无原始 session token。
- [ ] 旧 Cookie/Bearer 全部失效。
- [ ] Session 切换后当前数据库/WAL 完成规定的离线清理，旧 token 仍不能认证。
- [ ] logout/revoke 后既有 SSE 立即关闭。
- [ ] CSRF/Origin/CORS/body/rate-limit 负面测试通过。
- [ ] 平台管理员不是成员时无法读取任何战役内容。
- [ ] 无法创建第二个平台管理员，且不能停用/删除唯一管理员。
- [ ] 本地管理员密码恢复 CLI 不改变管理员数量或战役权限。
- [ ] 密码恢复撤销管理员全部现有 session。
- [ ] Maintenance admission/drain/epoch 竞态测试通过。
- [ ] 安全审计递归敏感字段检查通过。
- [ ] 真实 Chromium 覆盖首次设置和注册邀请。

---

## Phase 3：Campaign mutation、revision 与内部 command ports

### 建议迁移

- `015_campaign_state_revision.sql`
  - `campaigns.state_revision INTEGER NOT NULL DEFAULT 0`
  - 详细计划确认必要索引和 SQLite 兼容写法。

### 切片 3.1：CampaignMutationCoordinator

定义明确 mutation source：

- `owner_command`
- `player_command`
- `ai_formal_apply`
- `archive_capture`
- `archive_restore`
- `campaign_rule_change`
- `campaign_provider_change`
- `system_recovery`

模块统一执行 maintenance、campaign lock、resolving 围栏、transaction、revision 和 outbox。

- Campaign Rules、Campaign Provider 和 archive capture 必须通过该 seam；前两者在 resolving 时拒绝。
- Platform Rules 使用 `platform_instance.platform_rules_revision`，不伪装成逐战役 mutation。

### 切片 3.2：Campaign 原子性

- campaign + owner membership 同事务。
- 并发 join 以唯一约束裁决，不返回未知 500。
- `player.joined` 与 membership 同事务。
- 补齐 `turn.started` 和角色生命周期事件。
- Action 增加稳定排序；至少使用确定 tie-breaker，是否增加 sequence 由详细计划决定。

### 切片 3.3：内部世界与战斗命令

- 冻结 World/Encounter/Combat 内部 command ports。
- AI formal apply 只调用内部 port，不依赖 HTTP route。
- port 集中 campaign、visibility、revision、RNG 和 outbox 不变量。

### 切片 3.4：删除 Owner 世界/战斗写面

- 删除 Owner 世界 create/update/delete HTTP 端点。
- 删除 Owner 创建遭遇和执行战斗命令 HTTP 端点。
- 删除对应 client API/mutation hooks。
- Owner UI 继续只读监督。

### 切片 3.5：Realtime client generation

- EventSource listener 捕获 source、campaign 和 generation。
- 只有确认仍为当前连接后才推进 watermark。
- 身份变化清 Query Cache、停止 realtime 并重建 session epoch。

### 验收门

- [ ] 所有 AI context/gameplay mutation 都递增 revision。
- [ ] Campaign Rules、Campaign Provider 和 archive capture 均走统一 seam；Platform Rules revision 可独立使旧 claim 失效。
- [ ] resolving 时外部上下文写入拒绝且无部分写入。
- [ ] AI 内部世界/战斗命令继续成功。
- [ ] Owner 世界/战斗写端点不存在。
- [ ] Campaign create 失败不留下孤儿行。
- [ ] 并发 join 不产生 500 或重复事件。
- [ ] c1 迟到 SSE frame 不能污染 c2 watermark。
- [ ] 生命周期事件经 outbox/SSE 真实投递。

---

## Phase 4：AI 恢复、手动重试与领域命令

### 建议迁移

- `016_ai_runtime_recovery.sql`
  - `platform_ai_runs.claimed_revision`
  - `platform_ai_runs.claimed_platform_rules_revision`
  - 中断/恢复原因和时间元数据
  - 必要 active-running 查询索引

v1 不增加多节点 heartbeat/lease owner；单实例由 InstanceLock 保证。

### 切片 4.1：Provider timeout 与启动恢复

- Provider 调用可取消且有总 timeout。
- 开始监听前扫描所有 active `running` run。
- 同事务标记 run 中断失败、turn `needs_owner_attention`、发布失败事件、写安全审计。
- 恢复流程不调用 Provider。

### 切片 4.2：Owner 手动 retry

- Retry 创建新 attempt、新 run、新 idempotency key。
- 旧失败 run 保持不可变。
- 重复 retry 具备确定幂等/冲突语义。

### 切片 4.3：Revision gate

- claim 持久化 campaign revision 和 Platform Rules revision。
- formal apply 在任何正式写入前同时比较两种 revision。
- 冲突时 entries/state/archive/next turn 全部零写入，run failed，turn owner attention。

### 切片 4.4：角色领域命令

至少覆盖：

- 伤害与治疗；
- 增加/移除状态；
- 增加/移除物品；
- 调整金币；
- 授予经验。

命令集中 approved/context membership、HP clamp、非负数值、数组/文本预算和角色 audit。

### 切片 4.5：服务端权威骰点

- Combat command 返回结构化 RNG 结果。
- 正式 dice entries 从该结果生成。
- AI contract 不再接受 combat 最终骰点作为权威输入。

### 切片 4.6：Idempotency 与 buffered preview

- 幂等历史查询先于 Provider 配置解密。
- Provider 损坏时仍可 replay 已成功 run。
- UI/contract 文案改为 buffered preview。
- Provider response、context 和输出数组全部设定明确预算。

### 验收门

- [ ] claim 后模拟进程退出，重启自动恢复到 owner attention。
- [ ] 自动恢复不调用 Provider，Owner retry 可成功创建下一 attempt。
- [ ] Revision 变化后 formal apply 零正式写入。
- [ ] Provider key 损坏时历史 replay 仍成功。
- [ ] AI 无法修改非 approved/非 context 角色。
- [ ] HP、金币、经验和集合预算不变量通过。
- [ ] 正式 dice entry 与服务端 RNG 完全一致。
- [ ] 产品不再宣称 token streaming。

---

## Phase 5：Archive gameplay-only 安全恢复

**迁移：**优先无迁移；如新增 snapshot schemaVersion，只修改 contract 和 application code。不得创建空迁移。

### 切片 5.1：Snapshot 归一化

- 新 snapshot 只表达 gameplay state。
- 旧 schemaVersion 先归一化为 restore plan，再应用新不变量。
- Ruleset、Provider、members 等配置不作为可恢复状态。

### 切片 5.2：ArchiveSnapshotValidator

在任何 supersede/write 前验证：

- 根和嵌套 campaignId；
- character player membership；
- knownBy/targetPlayer membership；
- encounter/combatant/active combatant 引用；
- ID 不属于其它 campaign；
- resolving/running/maintenance 状态；
- snapshot 预算。

恢复写入一律使用目标 campaignId。

### 切片 5.3：Active-only restore

- Superseded archive 可以审计查看，但 restore 确定性拒绝。
- 删除“恢复 superseded archive 并重新激活”的语义。
- 不实现时间线分支切换。

### 切片 5.4：Gameplay-only 不变量

Restore 前后必须证明以下数据不变：

- users/platform admins/sessions；
- campaign members/invites；
- Provider config/ciphertext；
- Platform/Campaign Rules；
- operational state；
- 既有 security audit 行不得更新、删除或恢复，只允许追加一个预期的 strict allowlisted restore success/failure 事件。

### 验收门

- [ ] 所有跨 campaign 和孤儿引用 fixture 整体失败。
- [ ] 验证失败不写 supersede、outbox 或部分 gameplay 状态。
- [ ] Superseded archive 不可恢复。
- [ ] Members、Provider 和 Rules 在 restore 前后 byte/row 级不变。
- [ ] 既有安全审计行不变，且只追加一个不含 gameplay 数据的预期 restore 事件。
- [ ] Capture/restore 都通过统一 mutation seam。
- [ ] 当前完整 archive 恢复浏览器流程不回归。

---

## Phase 6：Rules、Provider、平台管理与安全审计闭环

**迁移：**默认无；复用 011 和 014。若详细计划发现必要 schema，只能使用下一个连续编号并更新本路线图。
**迁移冻结：**v1 Phase 6 不新增迁移；所有必需字段必须已在 012-016 中定义。若审查证明确实需要 schema 变更，必须先更新权威决策和本路线图，再从下一个可用编号 017 开始，并把所有“最终迁移”引用改为冻结 manifest。

### 切片 6.1：Rules scope 收敛

- `/api/platform/rules/*`：platform admin-only Platform Rules。
- Campaign Rules 保持 campaign Owner-only。
- v1 UI/HTTP 不创建 User Rules。
- 单一 RuleResolver 合并 Platform + 当前 Campaign metadata，明确优先级和稳定排序。
- Platform Rules 变更递增全局 Platform Rules revision；Campaign Rules 变更通过 CampaignMutationCoordinator 递增 campaign revision。
- 不导入、保存或返回规则正文。

### 切片 6.2：Provider 边界统一

- WebUI 与 env Provider 共用 `ProviderUrlPolicy`。
- 继续允许私网/loopback/保留地址。
- 继续拒绝 URL credentials、非 HTTP(S) 和 redirect。
- Provider save/test/run 审计不保存 Key、密文、完整 query 或上游正文。
- v1 不做主密钥轮换，但备份恢复必须验证所有密文可解密。
- Campaign Provider 变更通过 CampaignMutationCoordinator，在 resolving 时拒绝并递增 campaign revision。
- 已初始化数据库的 key 缺失、错配或 fingerprint 不匹配在 listener 前 fail closed；禁止生成替代 key。

### 切片 6.3：平台管理 UI

- 首次设置；
- 注册邀请码；
- 账号状态与会话撤销；
- Platform Rules；
- 安全审计；
- maintenance 状态。

所有页面不得加载战役内容 repository 或敏感 Query Cache。

### 切片 6.4：审计覆盖

完成决策文档第 9 节所列事件。每种事件使用独立 strict metadata allowlist schema；writer 不接受任意 exception/request/header/URL/query 对象，并覆盖全部失败路径的递归敏感字段负面测试。

### 验收门

- [ ] Platform admin 可管理 Platform Rules，但不能读取非成员战役。
- [ ] Campaign Owner 不能创建 Platform/User Rules。
- [ ] HTTP 无法创建 User Rules。
- [ ] Provider 私网 URL 继续通过。
- [ ] env/WebUI URL credentials 和 redirect 都拒绝。
- [ ] Platform/Campaign Rules 与 Campaign Provider 的 revision 行为使陈旧 AI claim 失效。
- [ ] 缺 key、错 key、混用其它备份 key和部分密文损坏均 fail closed。
- [ ] 审计无 token、Key、ciphertext、AI debug、snapshot 或游戏正文。
- [ ] 平台管理 Chromium 流程通过。

---

## Phase 7：生产 SPA、维护模式、备份恢复与 cutover CLI

**迁移：**无。Database instance ID、bootstrap/maintenance 状态、Platform Rules revision 和 credential key fingerprint 已由 012 建立。Backup verification、restore rehearsal 和 drop plan 使用 hash-bound immutable 外部 artifact，详细结果不写入生产数据库；只通过 014 追加 coarse 安全审计。因此 v1 当前冻结迁移集合为 001-016，017 保持未分配。

### 切片 7.1：生产静态托管

- Express 托管 `client/dist`。
- `/api/*` 404 返回 JSON，不 fallback HTML。
- 非 API GET deep link 返回 SPA。
- hashed assets 长缓存，`index.html` no-cache。
- 生产缺少 client artifact 时 fail loudly。
- 仅 direct TLS 或配置中精确 IP/CIDR 的可信反向代理；忽略非可信 forwarded headers，禁止 `trust proxy: true`。
- 固定 CSP 最低 directive、`Referrer-Policy: no-referrer`、明确 denylist Permissions Policy、`nosniff` 和 `HSTS max-age=31536000`；测试具体值和阻断行为，不只检查 header 存在。
- 拒绝 dotfiles、目录列表、source maps 和构建清单外文件；SPA fallback 只用于接受 HTML 的非 API/非 asset GET/HEAD。
- Auth/bootstrap/admin API `Cache-Control: no-store`；构建扫描禁止 secret/key/server env 进入 client bundle。

### 切片 7.2：运维锁协议与迁移清单复核

- 复用 Phase 1 已建立的 InstanceLock，禁止 backup、restore、password recovery 和 legacy drop 各自发明不同的锁文件或所有权规则。
- Cutover CLI 启动时再次校验构建内迁移 manifest、数据库已应用版本和 source hash。
- MigrationRunner 和任何普通启动路径继续证明永不自动删除 legacy 表。

### 切片 7.3：Maintenance 与优雅关闭

- 持锁 server 内平台主管 API/UI 执行 `active -> draining -> quiescent`；离线 CLI 不负责 maintenance-on/off。
- `draining` 关闭新 admission，等待活动事务、AI/formal apply 和 Provider 调用有界完成或取消；提交前复检 maintenance epoch。
- Drain 超时保持 draining，禁止 backup/drop；达到 quiescent 后关闭 SSE 并停止 server，再由本地 CLI 获取独占锁。
- 维护 smoke 后通过持锁 server 的管理端点退出 maintenance。
- Shutdown 顺序：停止接收 → realtime close → request/AI drain → DB close → release lock。

### 切片 7.4：BackupService

备份单元包括：

- SQLite 一致性快照；
- credential key 备份；
- manifest 和 SHA-256；
- migration/schema/table inventory；
- database ID、row counts、key fingerprint。

- Cutover 备份只在 quiescent、server 停止、adapter 关闭和 CLI 独占锁下执行；使用 SQLite backup API，或 checkpoint 后关闭并复制完整文件集，禁止裸复制活动主库。
- DB、key 和 manifest 先写临时目录，逐文件 hash/fsync 后原子 rename；中断目录不能 verify。
- `backup restore/rehearse` 在空的隔离绝对路径使用真实备份副本执行 integrity/FK、平台 smoke 和全部 Provider 密文离线解密；绝不调用真实 Provider。
- Rehearsal 生成 immutable verification record，绑定 manifest、database ID、迁移/schema 和全部检查结果。
- Phase 7 详细计划必须冻结 artifact 根目录、同文件系统临时目录、最小 ACL、保留期、中断目录清理和经审批的销毁流程。

### 切片 7.5：显式 cutover CLI

最低命令：

```text
cutover status
backup create
backup verify
backup restore --manifest ... --target <empty-absolute-dir>
backup rehearse --manifest ... --target <empty-absolute-dir>
cutover legacy-drop-plan --verified-rehearsal ...
cutover legacy-drop --plan ... --confirm ...
```

Maintenance on/off 由运行中的受认证平台主管 API/UI 执行。离线 drop plan 固定 canonical path、database ID、verified manifest/rehearsal、数据库/schema fingerprint、精确表与 DDL hash/行数、FK/trigger/view 依赖；实际 drop 只接受该不可变 plan。确认短语包含 database ID、plan hash 和表数量。普通 SQL migration 不得包含 legacy DROP。

- Plan 不绑定整个 SQLite 物理文件 hash；它绑定 database ID、冻结 migration/schema hash、目标 legacy 表 DDL/行数/依赖和受保护平台表 schema。014 append-only 审计新增行不会使 plan 自我失效，任何其它绑定状态变化都会拒绝 drop。

### 验收门

- [ ] 第二个实例无法同时启动。
- [ ] Maintenance 下所有非 allowlisted mutation、AI claim 和 SSE 均关闭；login/maintenance-off 特例不能开放其它能力。
- [ ] Maintenance 切换前后卡点、formal apply 卡点和 drain timeout 竞态测试通过。
- [ ] `backup create` 缺 DB/key/quiescent/独占锁/原子目标时失败；`backup verify` 缺 manifest/hash/ID/key 匹配时失败；`rehearse` 拒绝未 verify 备份；drop 拒绝无当前 verified rehearsal。
- [ ] 正确备份可在隔离目录完整恢复并解密 Provider 配置。
- [ ] Drop CLI 默认 dry-run；任何前置条件缺失都不能修改 DB。
- [ ] Dry-run 后数据库/schema/依赖变化会使 plan 失效并拒绝 drop。
- [ ] Drop allowlist 不包含任何平台业务表或 `platform_migrations`。
- [ ] 生产启动/关闭和 SPA deep link smoke 通过。

---

## Phase 8：生产构建 Chromium 发布门

**迁移：**无。  
**目标：**用最终 artifact 验证全部 v1 不变量。

### 运行方式

1. `npm run build`；
2. 启动真实 server dist；
3. Express 托管真实 client dist；
4. 使用磁盘临时 SQLite 和临时 credential key；
5. Chromium Owner/playerA/playerB 三个隔离 context；
6. 不启动 Vite、不访问真实 Provider。

### 必测场景

1. 浏览器首次设置首个平台管理员；
2. 创建、撤销、过期、消费 7 天一次性注册邀请；
3. Cookie-only、CSRF/Origin、限速、CORS 负面测试；
4. 多设备 session 撤销与 SSE 关闭；
5. 创建战役、加入、角色审核、行动、AI、archive；
6. Player A/B 和 Owner debug 隐私；
7. Owner 世界/战斗 HTTP 写端点不可用，AI 内部创建仍成功；
8. claim 后重启自动失败，Owner retry 成功；
9. revision 冲突正式零写入；
10. c1/c2 快速切换无 watermark 污染；
11. Archive gameplay-only，members/Provider/Rules 不变；
12. Superseded archive 不可恢复；
13. Platform admin 无法读取战役内容；
14. Provider 私网 URL 可接受，URL credentials/redirect 拒绝；
15. Buffered preview 文案真实；
16. Production static/deep-link/404；
17. Maintenance 阻断；
18. Backup restore 与 cutover dry-run。
19. Cookie 属性、旧 CSRF、跨端口 Origin、SSE revoke/replay 竞态；
20. 安全响应头、dotfile/source-map、未知 asset、API fallback 和 client bundle secret scan；
21. 错 key、DB/key 交叉配对、WAL 未 checkpoint、备份中断与 drop-plan 失效。

### 发布门命令

最终详细计划必须提供单一聚合命令，至少等价于：

```text
npm test -- --maxWorkers=1
npm run typecheck
npm run build
npm run test:browser:chromium
npm run test:backup-restore
npm run test:cutover-dry-run
```

上述 `test:browser:chromium`、`test:backup-restore` 和 `test:cutover-dry-run` 是 Phase 7/8 必须新增并冻结语义的未来脚本，当前仓库尚不存在；不得用现有 `test:phase4-browser` 的 Vite/dev-proxy 流程替代最终发布证据。

PostgreSQL 实验测试单独记录，不影响 SQLite v1 发布结论，也不得被表述为生产已支持。

### 验收门

- [ ] 所有命令全绿且无未豁免失败。
- [ ] Chromium 场景使用真实生产 artifact。
- [ ] 默认数据库未修改。
- [ ] 安全审查无 Critical/Blocker/Major。
- [ ] Cutover runbook 经独立只读审查批准。

---

## Phase 9：Forward-only maintenance cutover

**迁移：**无；只使用显式 CLI。  
**前置：**Phase 0-8 全部完成并审查通过。

### 固定顺序

1. 构建最终 production artifact。
2. 进入 maintenance，停止新 mutation/AI，关闭 SSE 并 drain。
3. 停止 server，CLI 获取独占锁。
4. 创建最终 SQLite + credential key 备份和 manifest。
5. 在隔离目录完成恢复演练并记录 immutable verified rehearsal。
6. 生成 legacy drop plan artifact 并人工复核表、DDL hash、行数及全部依赖。
7. 再次验证目标数据库/schema 与 plan fingerprint 完全一致。
8. 输入含 database ID、plan hash 和表数量的确认短语执行固定 allowlist DROP。
9. 执行 SQLite integrity/FK/schema allowlist。
10. 启动新平台，maintenance 下运行 production smoke。
11. 再次停止 server、关闭 adapter并释放 server 锁。
12. 离线 CLI 获取独占锁，创建并验证 drop 后新备份，然后释放 CLI 锁。
13. 再次启动持锁 server，确认状态仍为 `quiescent`。
14. 通过平台主管 API/UI 退出 maintenance。
15. 只运行生产安全的非破坏 canary：health、静态资源、login/me、平台主管运行状态和必要 read-only 查询；不得创建邀请、账号、战役、角色、行动、AI run 或 archive，不调用真实 Provider。
16. 完整写入型 Chromium E2E 只在 Phase 8 的临时数据库或本次 post-drop 备份的隔离恢复副本上运行，绝不指向生产数据库。
17. 写入并导出 cutover 安全审计。

### 失败边界

- Drop 事务提交前：中止并保持原数据库。
- Drop 后、重新开放写入前：保持 maintenance，可从 verified backup 整库恢复。
- 重新开放写入后：正常缺陷 forward-fix；整库恢复只用于重大数据损坏。
- 任何失败不得启动旧应用重新处理新写入。

### 最终验收门

- [ ] Legacy 表只按固定 allowlist 删除。
- [ ] 所有平台表、冻结 migration manifest 与 `platform_migrations` 完整。
- [ ] 生产代码和构建产物不存在 legacy route/token/table runtime 依赖。
- [ ] Provider 密文可解密，Platform/Campaign Rules 可读取。
- [ ] AI recovery/retry、archive 和 SSE revoke 的写入型证据来自 Phase 8 临时数据库或 post-drop 备份隔离副本；production SPA 由非破坏 canary 证明。
- [ ] Cutover 后备份可验证。
- [ ] 最终独立 correctness/security review 通过。

## 6. 迁移连续性

| 迁移 | 状态 | 内容 |
| --- | --- | --- |
| 001-011 | 已存在 | 当前平台基线 |
| 012 | 计划 | Platform instance、唯一管理员、注册邀请、maintenance 与全局 Rules revision |
| 013 | 计划 | 安全 digest session 与账号安全状态 |
| 014 | 计划 | 平台安全审计 |
| 015 | 计划 | Campaign state revision |
| 016 | 计划 | AI interruption/recovery 元数据 |
| 017 | 未分配 | v1 当前不创建；未来 schema 需求须先更新权威文档 |

规则：

- 迁移编号连续、唯一、三位数字。
- Source/dist 迁移文件集合和 hash 必须一致。
- Legacy 表 DROP 不占用迁移编号，也不进入 migrations 目录。
- Backup/rehearsal/drop plan artifact 不占用迁移编号，也不写入专用生产元数据表。
- 如某 Phase 详细计划发现新 schema 必需项，必须先更新本表，再使用下一个连续编号。

## 7. v1 延期清单

以下内容不阻塞 v1，但必须保留明确 backlog：

- PostgreSQL 正式生产组合根与发布门；
- 真正安全的 Provider token streaming；
- Provider keyring、keyId 和在线主密钥轮换；
- User Rules scope；
- 多实例部署、分布式 lease 和横向扩容；
- Firefox/WebKit 发布阻断；
- 高级时间线分支 archive；
- 平台管理员紧急内容访问机制；
- 旧应用完整向后兼容回滚。

## 8. 每个详细计划的必备结构

每个 Phase 的详细计划必须包含：

1. **范围与非目标**；
2. **精确 Files 列表**；
3. **依赖的接口和迁移**；
4. **逐切片 TDD Red/Green/Refactor**；
5. **每个失败测试的预期失败原因**；
6. **安全与隐私负面测试**；
7. **SQLite 文件、临时目录和默认数据库保护**；
8. **定向测试、完整串行测试、typecheck、build、Chromium 命令**；
9. **迁移 source/dist 验证**；
10. **完成后独立 correctness/security review**；
11. **不得自动 commit，除非用户明确要求**。

## 9. 当前下一步

本路线图通过计划级审查后，下一项不是 legacy adapter，也不是继续扩展业务页面，而是：

> **编写 Phase 1“删除 legacy 运行时并建立平台唯一组合根”的详细实施计划。**

在 Phase 1 详细计划通过审查前，不修改业务代码。
