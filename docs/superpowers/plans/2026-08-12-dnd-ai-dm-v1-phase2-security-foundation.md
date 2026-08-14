# DND AI-DM v1 Phase 2：私有注册、平台主管与完整安全基线实施计划

> 日期：2026-08-12  
> 状态：**计划审查 PASS（0 Blocker / 0 Major）；等待明确实施授权**  
> 计划审查：[`2026-08-12-dnd-ai-dm-v1-phase2-plan-review.md`](../reviews/2026-08-12-dnd-ai-dm-v1-phase2-plan-review.md)  
> 实施基准：`main` @ `641709e`，在当前脏工作树上增量实施  
> 上位约束：
> - `docs/superpowers/specs/2026-08-12-dnd-ai-dm-v1-decisions.md`
> - `docs/superpowers/plans/2026-08-12-dnd-ai-dm-v1-hardening-cutover.md`
> - Phase 1 已验收边界：`docs/superpowers/plans/2026-08-12-dnd-ai-dm-v1-phase1-legacy-removal.md`
>
> 本文冻结 Phase 2 切片 2.0–2.6、迁移 012–014、公共 TDD seams、existing-DB security cutover、安全测试与 Chromium 验收。**计划审查已通过；没有新的明确授权前，仍不创建迁移、不修改业务代码。**

---

## 1. 目标、完成定义与非目标

### 1.1 Phase 2 目标

在 Phase 1 唯一平台组合根、SQLite 单实例锁、迁移清单完整性和 credential fail-closed 的基础上完成：

1. 新生产实例只能通过显式本地 CLI 初始化；普通 server 不再静默创建数据库或 credential key。
2. 浏览器首次设置一次性创建唯一平台主管。
3. 平台注册改为 digest-only、一次性、7 天有效的邀请码。
4. 浏览器认证改为 Cookie-only digest session，无 Bearer fallback、无 raw token DTO/DB 存储。
5. 完成精确 Origin、CSRF、可信代理/TLS、per-route body budget、限速、strict DTO 和安全错误 envelope。
6. 提供最小平台主管安全管理面：邀请、账号状态、session revoke、审计、maintenance；不获得战役读取特权。
7. 建立 `active -> draining -> quiescent` 的线性化 maintenance admission/epoch 基础。
8. existing 001–011 数据库可通过持锁离线流程安全执行 enrollment、敏感备份和 session security cutover。

### 1.2 完成定义

Phase 2 只有在以下条件全部满足时才完成：

- 路线图 Phase 2 验收门全部通过；
- 012–014 DDL、manifest、source/dist copy 完整且 001–011 字节未变；
- fresh 与 existing temp-file DB 两条路径均通过；
- login HTTP body、client state、SQLite 当前文件/WAL 均无 raw session token；
- logout/revoke/disable/expiry 后相关 SSE 立即关闭且 reconnect 重新读权威状态；
- maintenance race/drain/epoch 测试通过；
- Chromium 真实浏览器完成 bootstrap 与邀请注册；
- root tests、workspace typecheck、build、Chromium gate 全 PASS；
- fresh-context correctness/security/operability/client review 达到 `PASS / 0 Blocker / 0 Major`；
- 默认 `dnd.sqlite*`、真实 key、staging 未被触碰。

### 1.3 非目标与明确延期

- 不实现 Phase 3 `campaign.state_revision`、统一 Campaign mutation source、resolving fence 或 Owner 写面删除。
- 不实现 Phase 4 AI startup recovery、manual retry 领域重构或 buffered-preview 重构。
- 不实现 Phase 6 Platform Rules CRUD/完整管理 UX；Phase 2 管理 API 不暴露 Platform Rules 占位 endpoint/control，能力留到 Phase 6。
- 不实现 Phase 7 Express production static hosting、正式 BackupService、backup verify/rehearse/restore、legacy drop CLI。
- 不实现 Phase 8 production-artifact E2E gate。
- ordinary user self-service password change 延后到 post-v1；Phase 2 只实现唯一管理员离线密码恢复。
- 不扩大 PostgreSQL production surface；SQLite 仍是 v1 唯一生产 adapter。

---

## 2. 不可破坏边界

1. 不修改 `001_initial_platform.sql` 到 `011_rule_sources.sql`；只新增 012–014 并更新 manifest。
2. 不读取、写入、迁移或删除 legacy 表；sentinel 的 DDL/rows 必须继续完全不变。
3. 不让普通 startup 自动跨越 enrollment/session-security transition。
4. 不把 SQLite backup/checkpoint/vacuum 加入业务 `DatabasePort`；离线原语依赖 SQLite ops seam。
5. 不把 raw session token、CSRF token、invite code、password、Provider key/ciphertext、campaign/AI/archive 内容写入安全审计。
6. 不允许平台主管因管理员身份读取任何非成员战役内容；`CAMPAIGN_NOT_FOUND` 存在性隐藏保持不变。
7. 不恢复 Browser Bearer fallback，不保留 raw/digest dual-read 兼容窗口。
8. 不执行 `git add/commit/amend/stash/reset/clean`；不覆盖用户现有修改。
9. 所有测试使用 `:memory:`、`mkdtemp` 绝对路径、ephemeral port；不启动默认 server。

---

## 3. 冻结的迁移 contract

### 3.1 `012_platform_foundation.sql`

012 只创建 schema，不插入 `platform_instance` 行，不生成 database ID，不猜测 credential fingerprint。

#### `platform_instance`

固定单例行：

| 列 | contract |
| --- | --- |
| `singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1)` | DB 单例约束 |
| `database_id TEXT NOT NULL UNIQUE` | CLI 生成的 opaque ID |
| `enrollment_state TEXT NOT NULL CHECK (... IN ('initializing','ready'))` | 无行即未 enrollment |
| `credential_key_fingerprint TEXT NOT NULL` | `sha256:<64 lowercase hex>` |
| `enrollment_key_origin TEXT NOT NULL CHECK (... IN ('generated','preexisting'))` | crash 后 rollback 的 durable provenance；不存 key 内容 |
| `bootstrap_completed_at TEXT NULL` | 只允许 `NULL -> timestamp` |
| `maintenance_state TEXT NOT NULL DEFAULT 'active' CHECK (... IN ('active','draining','quiescent'))` | persisted state |
| `maintenance_epoch INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_epoch >= 0)` | 每次状态 transition 单调递增 |
| `platform_rules_revision INTEGER NOT NULL DEFAULT 0 CHECK (platform_rules_revision >= 0)` | Phase 3/6 使用，Phase 2 不实现 Rules mutation |
| `session_security_state TEXT NOT NULL DEFAULT 'pending' CHECK (... IN ('pending','cleaning','ready'))` | 物理清理 crash recovery |
| `session_security_cutover_at TEXT NULL` | 逻辑 cutover commit 时间 |
| `created_at TEXT NOT NULL` | enrollment 首事务写入 |
| `updated_at TEXT NOT NULL` | transition 更新时间 |

不增加 bootstrap secret/digest 列。secret 只存在于部署配置和进程内固定长度 buffer。

#### `platform_administrators`

| 列 | contract |
| --- | --- |
| `singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1)` | DB 级最多一个管理员 |
| `user_id TEXT NOT NULL UNIQUE REFERENCES users(id)` | 与 user 关系 |
| `created_at TEXT NOT NULL` | bootstrap timestamp |

无 HTTP promotion/demotion API。

#### `platform_registration_invites`

| 列 | contract |
| --- | --- |
| `id TEXT PRIMARY KEY` | 非 bearer 内部 ID |
| `token_digest TEXT NOT NULL UNIQUE` | `sha256:<hex>`；不存 raw code |
| `created_by_user_id TEXT NOT NULL REFERENCES users(id)` | 唯一平台主管 |
| `expires_at TEXT NOT NULL` | 默认创建时间 + 7 天 |
| `revoked_at TEXT NULL` | 撤销 |
| `consumed_at TEXT NULL` | 消费时间 |
| `consumed_by_user_id TEXT NULL REFERENCES users(id)` | 新用户 |
| `created_at TEXT NOT NULL` | 创建时间 |

索引固定DDL contract：

- `CREATE INDEX ... ON platform_registration_invites(expires_at)`；
- `CREATE INDEX ... ON platform_registration_invites(created_at DESC)`；
- `CREATE INDEX ... ON platform_registration_invites(consumed_at, revoked_at)`，供bounded admin status list/filter。

012 不创建任何邀请码行。

### 3.2 `013_secure_sessions.sql`

013 是 forward-only additive migration：不删旧行、不改写历史 token、不重建 001。

#### `users` 新列

- `status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))`
- `auth_revision INTEGER NOT NULL DEFAULT 0 CHECK (auth_revision >= 0)`

不加入管理员布尔字段；管理员关系只在 `platform_administrators`。

#### `sessions` 新列

- `token_digest TEXT NULL`
- `csrf_digest TEXT NULL`
- `captured_auth_revision INTEGER NULL`
- `revoke_epoch INTEGER NOT NULL DEFAULT 0`
- `revoked_at TEXT NULL`
- `absolute_expires_at TEXT NULL`
- `idle_expires_at TEXT NULL`
- `last_seen_at TEXT NULL`

现有 `sessions.id` 保留，但 secure session 的 `id` 是内部 opaque ID，不是 bearer。新代码只创建上述 secure fields 全非空的行。索引：

- `UNIQUE(token_digest) WHERE token_digest IS NOT NULL`
- `(user_id, revoked_at)`
- `(absolute_expires_at)` 与 `(idle_expires_at)`

`expires_at` 作为 001 遗留 NOT NULL 列保留；secure row 写入与 `absolute_expires_at` 同值，不再作为认证 authority。旧行的 secure columns 为 NULL，供 cutover 识别并整体删除；应用无 dual-read。

### 3.3 `014_security_audit.sql`

#### `platform_security_audit_events`

| 列 | contract |
| --- | --- |
| `id TEXT PRIMARY KEY` | opaque event ID |
| `event_type TEXT NOT NULL` | typed writer 的 discriminant |
| `outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','rejected'))` | coarse result |
| `actor_user_id TEXT NULL REFERENCES users(id)` | 可选 actor metadata |
| `subject_user_id TEXT NULL REFERENCES users(id)` | 可选 target metadata |
| `metadata_json TEXT NOT NULL` | 只接收 per-event strict allowlist 输出 |
| `created_at TEXT NOT NULL` | timestamp |

索引：`created_at DESC`、`event_type + created_at`、`subject_user_id + created_at`。

SQLite 用 `BEFORE UPDATE`、`BEFORE DELETE` triggers `RAISE(ABORT, ...)` 强制 append-only。应用层不提供 update/delete repository。每个事件类型必须有独立 Zod schema；writer 不接受任意 object、request、headers、exception、URL/query、SQL params、upstream payload。

### 3.4 迁移编号与 manifest

- 文件名固定：
  - `012_platform_foundation.sql`
  - `013_secure_sessions.sql`
  - `014_security_audit.sql`
- `migrations.manifest.json` 与 SQL 同一 Task 更新，使用现有 normalized-LF SHA-256。
- 001–011 hash 必须逐个与 Phase 1 baseline 相同。
- security-cutover allowlist 常量固定为上述三个精确 filename/hash，不接受 `015+`。

---

## 4. 冻结的深模块与公共 seams

### 4.1 `PlatformInstanceStore`

职责集中于 singleton/status 读取和条件 transition：

- `read(reader): Promise<PlatformInstance | null>`
- `insertInitializing(tx, {databaseId, keyFingerprint, keyOrigin, now})`
- `markEnrollmentReady(tx, expectedFingerprint, now)`
- `rollbackInitializing(tx, expectedFingerprint)`
- `beginSessionCleaning(tx, now)`
- `markSessionSecurityReady(tx, now)`
- `transitionMaintenance(tx, expectedState, expectedEpoch, nextState, now)`

不得生成 ID/key、不得写文件、不得自动修复。

### 4.2 `EnrollmentCoordinator`

公开命令 contract：

```text
platform init --database <absolute-path>
platform enroll --database <absolute-path>
platform enroll-resume --database <absolute-path>
platform enroll-rollback --database <absolute-path>
platform status --database <absolute-path>
```

统一规则：绝对路径、拒绝 DB/key symlink、InstanceLock `purpose:'cli'`、manifest verify 在 DB open 前、coarse stderr、secret 不进入 argv/stdout。

- `init`：目标 DB 必须不存在；只允许显式创建 fresh DB。Task 2 先完成 explicit-create/path/key/enrollment 两阶段 seam，并通过 test-only 012 fixture 证明；公开 `platform init` 命令在 Task 4 组装 013/014 后才启用，最终 contract 固定创建完整 001–014 secure-ready instance。
- `enroll`：目标 DB 必须存在且精确为 001–011、无 `platform_instance` 行。
- 两者执行两阶段：生成/验证 candidate key → tx 插入 `initializing`（含 durable `enrollment_key_origin`）→ durable atomic key publish → tx `ready`。
- 有 Provider ciphertext 时必须使用已有 candidate key逐行离线解密成功；禁止生成替代 key。
- 无 ciphertext 且无 key 时 CLI 可生成 key；有合法 key时复用，不旋转。
- `resume` 只接受与 initializing fingerprint 相同的 key。若 crash 发生在 generated key 原子发布前、磁盘上没有匹配 key，则不能 resume，只允许 `rollback` 后重新 init/enroll。
- `rollback` 只清除尚未 ready 的 singleton 行；仅当 durable `enrollment_key_origin='generated'` 且磁盘文件 fingerprint匹配时才删除 attempt-created key，`preexisting` 永不删除。crash 后不依赖进程内记忆判断 provenance。
- `status` 只读并输出 enrollment/session/maintenance state、database ID、fingerprint；不输出 key。

Fingerprint 冻结为：canonical serialized key 严格解码为 32 bytes，对 raw bytes 做 SHA-256，编码 `sha256:<lowercase hex>`。

### 4.3 `StartupSecurityGate`

普通 server 的新顺序：

```text
canonicalize configured path
→ require existing regular non-symlink DB
→ InstanceLock
→ manifest verify
→ open one SQLite adapter
→ inspect applied migrations + platform_instance/cutover state
→ require exact Phase-approved applied set; ordinary startup never applies a pending migration
→ verify enrollment ready + DB/key fingerprint + decrypt-all
→ require session_security_state=ready and cutover_at non-null
→ validate bootstrap config/TLS/origin
→ compose app
→ listen
```

普通 startup 永不：创建 DB、创建 key、插 singleton、从 pending/cleaning 变 ready、删除旧 session、执行 sensitive backup。

Migration policy：

- 001–011 existing、无 012：拒绝，提示运行 enrollment CLI。
- 012-ready、013/014 pending：拒绝，提示运行 security-cutover CLI。
- 012–014 已应用但 `pending/cleaning`：拒绝。
- 012–014 ready：要求 applied migration精确为当前 Phase批准集合001–014。未来Phase如需ordinary-safe migration，必须在其详细计划中新增显式hash-bound apply命令/allowlist；不得继续调用无过滤的`db.migrate()`。

### 4.4 `OfflineBackupPrimitives`

SQLite-only operational seam，不修改 `DatabasePort`：

- `createSensitiveSnapshot({databasePath,keyPath,targetDirectory,databaseId,keyFingerprint})`
- 用独立 better-sqlite3 connection 的官方 `backup()` 生成一致 DB 副本；copy 同一 credential key。
- temp/final directory 必须同 parent filesystem；temp 新建、拒绝静默覆盖。若目标已存在，只允许通过`verifyExistingSensitiveSnapshot(...)`按expected database ID/key fingerprint/migration/file hashes完整复验后显式复用；否则要求新空目录。
- manifest 至少包含 format、sensitive flag、database ID、key fingerprint、migration list、每个文件 name/size/SHA-256。Phase 2 primitive故意不冻结Phase 7完整schema/table inventory、row counts与rehearsal artifact；Phase 7 BackupService必须扩展而非把该简化manifest当最终cutover证据。
- 文件和 manifest 逐个 fsync，然后 same-filesystem atomic rename。POSIX要求temp/final parent directory fsync；Windows目录fsync按现有CredentialKeyStore跨平台风格best-effort，文件fsync与rename仍必须成功，并在ledger记录durability caveat。
- 发布前重新打开备份 DB做 `integrity_check`、`foreign_key_check`、migration inventory、key fingerprint/decrypt-all；绝不调用 Provider。
- 本 Phase 只提供 security-cutover 使用的 create+verify primitives；Phase 7 扩展为完整 BackupService/restore/rehearse CLI。

### 4.5 `SecurityCutoverCoordinator`

公开命令：

```text
platform security-cutover --database <absolute-path> --backup <absolute-target-dir>
```

固定顺序：

1. 绝对路径/symlink guard；获取 CLI InstanceLock。若上次进程崩溃留下 fail-closed lock，operator必须先确认无owner再按Phase 1运维协议人工移除；CLI不自动break stale lock。
2. verify manifest；打开 existing DB；确认 012 enrollment `ready`，ID/fingerprint/key decrypt-all 成功。
3. 对所有 existing DB（即使旧session行数为0）先创建并 verify sensitive backup；失败即停止，013 不得应用。
4. 只按 hash-bound allowlist 应用 013、014；不得执行 015+。012已由enrollment预先应用，但allowlist constant仍绑定012–014三个filename/hash。
5. 单一 `BEGIN IMMEDIATE` 事务前，从刚完成完整verify的pre-cutover backup legacy `sessions.id`读取并固定old-token集合；事务内删除全部 session 行；写 `session.security_cutover` audit；写 `session_security_cutover_at`；state `pending -> cleaning`。
6. commit 后设置 `PRAGMA secure_delete=ON`，`wal_checkpoint(TRUNCATE)`，`VACUUM`，再 checkpoint。
7. 关闭并按 bytes 扫描当前 DB/WAL/SHM，验证预先捕获的全部 old tokens 不存在；重开 DB验证旧 token 无法认证、integrity/FK 正常。
8. 新事务把 `cleaning -> ready`；关闭 DB、释放锁。

重跑同一 `platform security-cutover` 命令就是唯一 resume 入口：

- enrollment ready + `pending`：若backup target为空则创建完整backup；若final backup已存在则先按§4.4完整复验后复用，绝不覆盖；验证后执行migration/logical cutover；
- `cleaning` 且 `session_security_cutover_at` 非空、013/014已应用：不得重新backup、重新删session或重写logical audit。先重新verify pre-cutover sensitive backup，并从该backup的legacy `sessions.id`读取完整old-token集合；再重做idempotent secure-delete/checkpoint/VACUUM/byte/auth/integrity验证，最后条件transition到ready。backup缺失/不匹配则fail closed；
- 其它partial inventory（如013有而014无）先重新verify已发布backup，再只按allowlist补齐后继续；状态/时间戳矛盾则fail closed，需要人工诊断。

Fresh `init` 在无旧 session 时应用 001–014，写 singleton enrollment，并在同一初始化流程直接写 `session_security_cutover_at` + `ready`，不做 destructive cleanup，也不写existing-DB `session.security_cutover` audit。

### 4.6 `SecurityAuditWriter`

```ts
writeIn(tx, event: SecurityAuditEvent): Promise<void>
```

`SecurityAuditEvent` 是 discriminated union；每种 metadata 独立 `.strict()`、bounded。Phase 2 首批覆盖：bootstrap success/failure、invite create/revoke/consume/reject、account create/disable/admin-protection/password recovery、session create/logout/logout-all/admin-revoke/expire、Provider save/test result、maintenance enter/exit、security cutover。后续 Phase 在同 writer 追加各自事件，不向通用 metadata object 退化。

增加递归 sentinel：字段名和值命中 `password|token|csrf|invite|authorization|api[_-]?key|cipher|context|result|snapshot|story|body` 等敏感语义时，除明确 coarse boolean/count/id allowlist 外拒绝。测试必须同时包含负面secret嵌套样本与每个event schema的正面coarse metadata样本，防止sentinel把合法`outcome`/count/id enum全部锁死。

### 4.7 `DigestSessionService`

- token：32-byte CSPRNG，canonical unpadded base64url；DB 存 SHA-256 digest。
- internal session ID：独立 random opaque ID。
- CSRF：独立 32-byte raw token，DB 存 digest。
- absolute TTL 7 天；idle TTL 12 小时；`last_seen_at` 与 `idle_expires_at` 可按注入 clock 更新。
- secure session row 捕获 `users.auth_revision` 和 `revoke_epoch`。
- `resolveCookie(rawToken)` 只按 digest 查询；验证 account active、未 revoked、auth revision 相等、absolute/idle expiry。active/draining中可经operational write删除/标记并审计；quiescent中不得为`me`触发expiry cleanup write，直接把expired/stale视为unauthenticated并留待恢复active后清理。有效session的CSRF digest恢复旋转是§4.10单独allowlisted write，不属于expiry cleanup。
- `logoutCurrent(internalSessionId)`、`logoutAll(userId)`、`adminRevokeUser(targetUserId)`；bulk revoke 在一个事务推进 auth revision/revoke epoch并撤销 rows。
- login HTTP JSON 固定只返回 `{ session: { expiresAt } }`；raw token 仅交给 cookie writer。

Cookie contract 固定：

- `__Host-dnd_session`: `Secure; HttpOnly; SameSite=Lax; Path=/`; no Domain；Max-Age 对应 7 天。
- `__Host-dnd_csrf`: `Secure; SameSite=Lax; Path=/`; no HttpOnly、no Domain；值为 raw CSRF token，session 只存 digest；Max-Age与session absolute TTL相同（7天），避免持久session cookie与session-scoped CSRF cookie生命周期错位。
- logout 使用完全一致 path/sameSite/secure/httpOnly 语义清除两枚 cookie。
- 任何环境都不改名、不取消 Secure；Node HTTP harness 改为 TLS 或 trusted TLS proxy，不设测试后门。

### 4.8 `SessionAuthority` 与 realtime runtime

SSE 在 flush headers 前绑定：

```ts
{ internalSessionId, userId, authRevision, revokeEpoch, campaignId, viewer }
```

- `SessionAuthority.isCurrent(binding)` 每个 replay/live batch 前重读权威 session/account state。
- runtime 新增 `revokeSession(id)`、`revokeUser(userId)`、`closeAllForMaintenance()`；事务 commit 后调用，关闭 socket并清空未发送队列。
- reconnect 从 cookie 重新解析，不能复用旧 binding/cache。
- 保留既有 `closeViewer` 测试/运维 seam，避免不必要破坏 Phase 1 browser fixture。

### 4.9 `RequestSecurityPolicy`

配置：

- `PUBLIC_ORIGIN`：唯一 canonical HTTPS origin，必须显式 scheme/host/port，无 path/query/hash。
- `TRUSTED_PROXY_CIDRS`：逗号分隔精确 IP/CIDR；默认空；禁止 `trust proxy: true`。
- `DEV_ALLOWED_ORIGINS`：仅非生产显式 allowlist；不得 `*`。
- bootstrap mode：`BOOTSTRAP_ENABLED=true`、`BOOTSTRAP_DATABASE_ID`、`BOOTSTRAP_SECRET`；三者缺一或非法均 fail closed。

基础 middleware 顺序：

```text
canonical host/proto/client-ip
→ trusted TLS / exact public origin policy
→ fixed API security headers
→ exact CORS policy
→ maintenance admission
→ session
→ campaign/platform role
→ CSRF
→ endpoint body parser
→ strict Zod
→ service
```

- 状态修改方法要求 exact `Origin === PUBLIC_ORIGIN`；missing/`null`/wrong scheme/host/port 拒绝。
- 非可信 remote address 的 `Forwarded`/`X-Forwarded-*` 全忽略；可信代理才允许推导 proto/client IP。
- 生产必须得到可信 HTTPS；否则 listener 前拒绝或请求 fail closed。
- 删除全局 `express.json({limit:'10mb'})`；每个 endpoint 显式 budget，默认无 parser。
- CORS：生产同源不发送 wildcard；dev 只回显 exact allowlist origin并允许 credentials。
- 使用 repo 内单实例 in-memory limiter（无 `express-rate-limit` 新依赖）；bucket keyed by trusted client IP + surface，注入 clock，bounded LRU/expiry cleanup。
- 复用 transitive `proxy-addr` 时必须提升为 server direct dependency并增加 `@types/proxy-addr`；不引入 `helmet`，固定 headers 由小型显式 middleware 实现，避免隐藏默认值漂移。

错误码新增并同步 contracts/status map：`BOOTSTRAP_UNAVAILABLE` 404、`INVITE_INVALID` 400、`ACCOUNT_DISABLED` 403、`CSRF_INVALID` 403、`RATE_LIMITED` 429、`PAYLOAD_TOO_LARGE` 413、`MAINTENANCE_MODE` 503。所有响应继续 `{error:{code,message}}`，不得泄漏 secret/state oracle。

### 4.10 CSRF 双轨

#### Pre-auth nonce

- `GET /api/security/preauth-csrf?purpose=bootstrap|register|login` 返回 raw nonce `{ csrfToken }`，同时设置 opaque HttpOnly Secure `__Host-dnd_preauth` handle cookie；全响应 `Cache-Control: no-store`。
- 内存记录 `{handleDigest, tokenDigest, purpose, expiresAt, used}`；5 分钟 TTL、one-time、bounded store。
- POST bootstrap/register/login 在 body parse 前读取 handle cookie + `X-CSRF-Token`，constant-time 比较并原子消费；wrong/expired/reused/purpose mismatch 同一 `CSRF_INVALID`。

#### Authenticated synchronizer

- client 从可读 `__Host-dnd_csrf` cookie取 token，为所有 state-changing same-origin requests加 `X-CSRF-Token`。
- server 在 body parse 前与当前 session `csrf_digest` 比较。
- login/session rotation 同时轮换 CSRF；两枚cookie Max-Age/expiry对齐。若CSRF cookie被单独删除但session仍有效，authenticated `GET /api/auth/me` 在通过request/session/maintenance/rate checks后重新生成raw CSRF、事务更新当前session digest并重设CSRF cookie；response仍`no-store`。并发旧token/new token窗口由条件update使旧digest立即失效。
- logout 后旧 token无效。
- GET/HEAD health/me/SSE 不要求入站 CSRF，但仍做基础 request policy、session、maintenance 和 rate-limit。

### 4.11 `BootstrapService`

eligibility 必须同时满足：配置显式 enabled、secret canonical 43 ASCII/32 bytes、expected DB ID match、instance enrollment/session security ready、admin count 0、`bootstrap_completed_at IS NULL`、可信 HTTPS/origin。

- GET availability/page metadata 与 POST 全部 `no-store`；不可用返回统一 `BOOTSTRAP_UNAVAILABLE`，不区分 secret wrong/disabled/completed。
- POST 接收 strict `{bootstrapSecret,login,password}`，小 body、pre-auth CSRF、strict limiter。
- secret 严格 decode 后用 `timingSafeEqual` 对固定 32-byte buffers 比较；输入不规范直接走同一失败面。
- 单事务：recheck eligibility → `assertPasswordPolicy` + `hashPassword` → insert user → singleton admin row → set completed timestamp → append success audit。
- 并发两个 POST 只能一个成功；成功 response 不建 session、不返回 token，client跳转 login。
- 当前进程以后每次请求从 DB state确认已关闭；残留 env secret不能再次打开。
- failure audit 只写 coarse reason enum，不写输入、login 或 secret。

### 4.12 `RegistrationInviteService` 与 `PlatformAdminService`

- invite raw code 32-byte base64url；create response唯一一次返回；list 永不返回 digest/raw。
- consume + user create + consumed fields + invite/account audit 在同一事务；条件 update/serialized tx确保双消费只一方成功。
- 无效/过期/撤销/已消费/不存在统一 `INVITE_INVALID`。
- admin API 只依赖 users/sessions/invites/audit/instance stores，不注入 campaign repositories。
- v1 endpoints：invite create/list/revoke；account list/disable/enable；target user session revoke；audit metadata list；runtime/maintenance status/on/off。
- 唯一 admin target 的 disable/delete/demotion 一律拒绝并审计；不提供 delete/demotion/promotion endpoint。
- Platform Rules endpoints 明确延期 Phase 6，不在 Phase 2 暴露占位 mutation。

### 4.13 `AdminPasswordRecoveryCoordinator`

命令：

```text
platform admin-password-recover --database <absolute-path> --database-id <id>
```

- server 必须停止；CLI InstanceLock；DB/key symlink拒绝；manifest、applied migration、ready states、database ID 精确校验。
- DB 中必须恰有一个 admin。
- password 通过 injected hidden interactive prompt 读取两次，不接受 argv/env；复用 password policy/hash。
- 单事务：更新 password hash → `auth_revision + 1` → revoke 全部 admin sessions → append allowlisted audit。
- 不改 `platform_administrators` 数量，不改 campaign membership；stdout 不输出 password/hash/session。

### 4.14 `MaintenanceManager` 与 maintenance-aware DB wrapper

生产组合根把唯一 SQLite adapter 包为 `MaintenanceAwareDatabasePort`；业务模块仍只见 `DatabasePort`。

- `MaintenanceManager.admit(kind)` 返回 AsyncLocalStorage-backed lease `{operationId, epoch, kind, admittedState}`。
- Platform admin API 为 persisted `draining` 提供 `resume-drain` action；不提供直接`draining -> active`跳转。
- 所有 HTTP mutation、login operational write、session expiry cleanup、AI claim/provider/formal apply、bootstrap/admin writes 必须显式在 lease 中执行。
- wrapper 的顶层 `execute`/`transaction` 在 production request context 中拒绝无 lease 写；read-only query不要求 lease。测试/CLI 使用原 adapter，不受 production admission wrapper影响。
- transaction 在 `BEGIN IMMEDIATE` 后读取 epoch/state；callback完成、COMMIT前再读并校验。普通 write 仅在 state=active 且 epoch未变时 commit；draining 前已 admitted 的 grandfathered lease可在 epoch匹配其 drain transition policy时完成，其余 rollback `MAINTENANCE_MODE`。
- entering draining：单事务 `active -> draining`、epoch+1、audit；随后关闭新普通 write admission，等待 active leases/provider ops。
- Provider port 增加 operation-scoped `AbortSignal` 传播；drain 先等待 bounded timeout，超时请求 cancel，可取消 Provider；仍未 settle则保持 draining并返回脱敏 operation IDs，不进入 quiescent。
- active count=0 后单事务 `draining -> quiescent`、epoch+1、audit。
- quiescent route allowlist：health、静态维护页 contract、login-purpose preauth issuance、login、me、admin maintenance status/off。唯一 writes：login session、`me`在CSRF cookie缺失时的当前session digest旋转、固定 audit、maintenance off state/epoch；SSE、register、bootstrap、invite、其它 session admin、campaign mutation全部拒绝。
- off 只能 unique admin 调用；`quiescent -> active`、epoch+1、audit。离线 CLI 不负责 maintenance on/off。
- restart读取persisted state：`active`正常；`quiescent`保持allowlist；`draining`不接受新普通write，进程内active lease集合为空，因此由唯一admin status接口显式选择`resume-drain`或保持draining诊断，绝不自动回active。Phase 2没有Phase 4的persisted AI startup recovery scan，`resume-drain`依据明确的operator判断（确认旧进程已停止且无可恢复provider operation）；该局限写入status response/runbook与audit。
- **决策§10.1 narrow clarification**：为避免7天session因CSRF cookie单独丢失而使unique admin无法执行maintenance off，Phase 2把`/me`当前session CSRF digest条件旋转列为第四个quiescent operational write。它不触碰领域数据、只在有效当前session且cookie缺失时发生；实施ledger与后续decisions维护需记录这一安全必要的窄扩展。
- Phase 2 不实现 polished maintenance UI；只提供 API 和最小 status/control 页面入口供测试/后续 Phase 6 复用。

---

## 5. TDD 实施任务

每个 Task 必须先运行列出的 RED，记录“因目标能力不存在/旧行为仍存在而失败”，再写最小 GREEN；禁止先实现后补测试。

### Task 0：建立 Phase 2 安全测试基线与路径保护

**修改/新增**
- `server/src/tests/phase2TempFixture.ts`（new）
- `server/src/tests/phase2TempFixture.test.ts`（new）
- `server/src/tests/httpTestHarness.ts`
- `server/src/platform/ops/migrationManifest.test.ts`
- `server/src/tests/legacy-sentinel-startup.test.ts`
- `.env.example`

**RED**

```bash
npx vitest run server/src/tests/phase2TempFixture.test.ts server/src/platform/ops/migrationManifest.test.ts server/src/tests/legacy-sentinel-startup.test.ts --maxWorkers=1
```

预期：fixture 与 012–014 expected-set assertions 尚不存在。

**GREEN**

1. 新 helper 统一创建 `mkdtemp` absolute DB/key/backup/migrations paths、ephemeral listener，cleanup 顺序固定。
2. helper 对 repo 默认 DB/key absolute paths 做 hard rejection。
3. manifest tests 从 11 更新为“当前 approved set”，但在 012 实际 Task 前先允许显式 expected count 注入，避免中间 Task 假绿。
4. sentinel helper扩展为可在 enrollment/cutover temp copy 前后捕获 legacy DDL/rows。
5. 记录实施前 001–011 hash、默认 DB/key hash 与 staging baseline。

**门**：只改测试基础设施/文档，不改变生产行为。

### Task 1：冻结并应用 012 schema；PlatformInstanceStore TDD

**新增/修改**
- `server/src/platform/database/migrations/012_platform_foundation.sql`
- `server/src/platform/database/migrations/migrations.manifest.json`
- `server/src/platform/ops/PlatformInstanceStore.ts`（new）
- `server/src/platform/ops/PlatformInstanceStore.test.ts`（new）
- `server/src/platform/database/database.test.ts`
- `server/src/platform/ops/migrationManifest.test.ts`

**RED**

```bash
npx vitest run server/src/platform/ops/PlatformInstanceStore.test.ts server/src/platform/database/database.test.ts server/src/platform/ops/migrationManifest.test.ts --maxWorkers=1
```

预期：012/table/store/singleton constraints 不存在。

**GREEN**

1. 实现 §3.1 DDL，保持012主体为SQLite/Postgres basic syntax；不插行。013/014的SQLite partial index与`RAISE` trigger属于明确SQLite生产线，PostgreSQL experiment tests在Phase 2标记为不执行012+并记录deferred parity，不为实验lane削弱SQLite append-only约束。
2. store 使用 `QueryExecutor/QueryReader`，条件 update 的 `changes===1` 作为 transition winner。
3. 测试：无行=unenrolled；第二 singleton/admin 被 DB拒绝；非法 state/negative epoch拒绝；bootstrap timestamp不能通过 store清空；012 rerun由 migration tracking保护。
4. 更新 manifest；验证 source hash 和 dist copy contract。

**门**：001–011 raw hash仍一致；legacy sentinel不变。

### Task 2：显式 init/enrollment CLI、key fingerprint 与 server missing-DB fail-closed

**新增/修改**
- `server/src/platform/ops/platformPaths.ts`（new）
- `server/src/platform/ops/EnrollmentCoordinator.ts`（new）
- `server/src/platform/ops/EnrollmentCoordinator.test.ts`（new）
- `server/src/modules/ai-runtime/CredentialKeyStore.ts`
- `server/src/modules/ai-runtime/CredentialKeyStore.test.ts`
- `server/src/platform/startup/StartupSecurityGate.ts`（new）
- `server/src/platform/startup/startPlatformServer.ts`
- `server/src/platform/startup/startPlatformServer.test.ts`
- `server/src/cli/platformCli.ts`（new）
- `server/package.json`
- `server/src/config.ts`
- `server/src/tests/config.test.ts`

**RED**

```bash
npx vitest run server/src/platform/ops/EnrollmentCoordinator.test.ts server/src/modules/ai-runtime/CredentialKeyStore.test.ts server/src/platform/startup/startPlatformServer.test.ts server/src/tests/config.test.ts --maxWorkers=1
```

预期：普通 server 会创建 missing DB；无 CLI/fingerprint/recovery。

**GREEN**

1. canonical absolute regular-path/symlink guards；CLI 与 server都在 open前使用。
2. key store增加 canonical serialization读取、fingerprint、same-dir temp + 0600 + file fsync + atomic rename + dir fsync。
3. EnrollmentCoordinator实现existing enrollment/resume/rollback/status，并实现fresh-init的test-only 012阶段orchestrator；manifest与lock顺序固定。公开 `platform init` 暂不挂到CLI，Task 4才在013/014存在后启用最终secure-ready命令。
4. existing 001–011 精确 inventory；enroll 只应用 012，不执行未来 migration。
5. server missing DB、无 singleton、initializing、wrong fingerprint均 listener前失败；RED首先在当前baseline明确断言missing DB行为：若现状仍由SQLite open隐式创建则测试因文件被创建而RED，若Phase 1已先行fail-closed则记录该assertion已GREEN，并以CLI/enrollment capability不存在作为本Task有效RED，不制造vacuous failure。
6. 移除 CredentialStartupGate 的普通 zero-ciphertext create branch；key生成只在 CLI。
7. CLI parser导出可注入 stdin/stdout/exit 的函数；本Task只挂`enroll`/`enroll-resume`/`enroll-rollback`/`status`，package script如 `platform:cli`，不增加第三方 parser。

**门**：temp fresh-init seam输出 database ID、不创建 admin且不可被普通server启动；公开`platform init`尚未启用。existing ciphertext wrong/missing key不改 DB/key；generated/preexisting key crash+rollback provenance tests通过。

### Task 3：013 secure session additive schema、014 append-only audit与 typed writer

**新增/修改**
- `server/src/platform/database/migrations/013_secure_sessions.sql`
- `server/src/platform/database/migrations/014_security_audit.sql`
- `server/src/platform/database/migrations/migrations.manifest.json`
- `server/src/modules/security-audit/SecurityAuditEvent.ts`（new）
- `server/src/modules/security-audit/SecurityAuditWriter.ts`（new）
- `server/src/modules/security-audit/security-audit.test.ts`（new）
- `server/src/platform/database/database.test.ts`
- `server/src/platform/ops/migrationManifest.test.ts`

**RED**

```bash
npx vitest run server/src/modules/security-audit/security-audit.test.ts server/src/platform/database/database.test.ts server/src/platform/ops/migrationManifest.test.ts --maxWorkers=1
```

预期：secure columns、audit table/triggers/writer不存在。

**GREEN**

1. 实现 §3.2/3.3 DDL；013 不删旧 session。
2. typed discriminated writer；每类 metadata独立 strict/bounded schema。
3. recursive secret sentinel覆盖 key/value/nested arrays；failure不 stringify raw payload。
4. DB trigger tests证明 UPDATE/DELETE拒绝，INSERT允许；writer无 mutation method。
5. 加 provider save/test、security cutover、maintenance等 Phase 2 event types，但不提前接 Phase 3+ callers。

**门**：旧 raw session fixture在只应用013/014后仍原样存在，证明 destructive step未混入 migration。

### Task 4：OfflineBackupPrimitives 与 security-cutover CLI

**新增/修改**
- `server/src/platform/ops/OfflineBackupPrimitives.ts`（new）
- `server/src/platform/ops/OfflineBackupPrimitives.test.ts`（new）
- `server/src/platform/ops/SecurityCutoverCoordinator.ts`（new）
- `server/src/platform/ops/SecurityCutoverCoordinator.test.ts`（new）
- `server/src/platform/startup/StartupSecurityGate.ts`
- `server/src/platform/startup/startPlatformServer.test.ts`
- `server/src/cli/platformCli.ts`

**RED**

```bash
npx vitest run server/src/platform/ops/OfflineBackupPrimitives.test.ts server/src/platform/ops/SecurityCutoverCoordinator.test.ts server/src/platform/startup/startPlatformServer.test.ts --maxWorkers=1
```

预期：backup/cutover/allowlist/cleanup/state gate不存在。

**GREEN**

1. 先实现 backup temp/hash/fsync/atomic publish及 verify/reuse；测试中断 temp、目标已存在但匹配时显式复用、目标已存在但不匹配时拒绝、wrong key/corrupt copy、cross-device rename failure、POSIX required dir-fsync与Windows best-effort branch。
2. cutover coordinator只接受 committed 012–014 hash allowlist；012须已应用，实际pending apply只可为013/014。
3. RED failure injection：backup在013前失败；assert migration inventory仍001–012、session rows不变。existing DB即使session count=0也必须先backup。
4. 实现单事务 delete+audit+cutover_at+cleaning。
5. 实现 secure_delete/checkpoint/VACUUM/byte scan/old-token auth failure，再 ready；normal与cleaning restart两条路径都从重新verify的sensitive backup提取old-token集合。
6. crash fixtures覆盖：
   - 013 applied/014 missing；
   - logical tx未提交；
   - cleaning状态；
   - cleanup验证失败。
   所有普通 startup均 fail closed；重跑同一`platform security-cutover`只按§4.5 resume branch完成，不重复logical cutover，并覆盖published backup verify/reuse及cleaning从backup恢复old-token集合。
7. 启用最终公开 `platform init`：固定应用001–014并直接进入secure-ready，无 old rows不备份；不存在仅应用001–012的公开模式。

**门**：敏感备份明确标记、权限最小；无真实 Provider call；default files untouched。

### Task 5：digest session service、cookie-only HTTP与 auth contract/client基础

**新增/修改**
- `server/src/modules/identity/sessionTokens.ts`（new）
- `server/src/modules/identity/sessionTokens.test.ts`（new）
- `server/src/modules/identity/IdentityRepository.ts`
- `server/src/modules/identity/IdentityService.ts`
- `server/src/modules/identity/identity.test.ts`
- `server/src/platform/http/sessionMiddleware.ts`
- `server/src/routes/authRoutes.ts`
- `packages/contracts/src/auth.ts`
- `packages/contracts/src/errors.ts`
- `server/src/platform/http/AppError.ts`
- `client/src/shared/lib/contractSchemas.ts`
- `client/src/api/auth/authApi.ts`
- `client/src/shared/api/platformHttp.ts`
- `server/src/tests/httpTestHarness.ts`
- `server/src/tests/authCampaignRoutes.test.ts`
- `server/src/tests/platform-composition.test.ts`

**RED**

```bash
npx vitest run server/src/modules/identity/sessionTokens.test.ts server/src/modules/identity/identity.test.ts server/src/tests/authCampaignRoutes.test.ts server/src/tests/platform-composition.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1
```

预期：DB仍存 raw token，login body含sessionId，Bearer positive test仍通过，cookie名/属性错误。

**GREEN**

1. token/digest/clock injectable；secure rows写 internal ID + digest + TTL/revision/epoch。
2. login返回内部 route-only cookie material与public `{expiresAt}` 分离类型；public contracts无 raw field。
3. middleware只读 `__Host-dnd_session`，删除 Authorization分支；request绑定internal session信息。
4. exact cookie helper集中定义 set/clear属性；Node harness改为 HTTPS。
5. expiry/disabled/revision mismatch走统一失效处理；记录 coarse audit。
6. 增加 `/logout-all`；当前 logout只撤销当前 internal ID。
7. 客户端不存 session token，不使用 local/sessionStorage。
8. CSRF lifecycle/recovery：两枚cookie Max-Age对齐；session cookie仍在但CSRF cookie缺失时，authenticated `/me`条件旋转digest并恢复CSRF cookie；旧token立即失败、新token可mutation；quiescent `/me`同样允许该受控session write。
9. 反向测试：Bearer `/me` 401；login body与serialized query cache不含 raw token；SQLite row不包含raw token。

**门**：所有既有 HTTP helpers机械转换后仍不向测试调用者暴露 raw session value，除专门黑盒 cookie jar；持久session不可因CSRF cookie单独丢失而永久锁死。

### Task 6：SessionAuthority、SSE epoch revoke与 multi-device flows

**新增/修改**
- `server/src/modules/identity/SessionAuthority.ts`（new）
- `server/src/platform/realtime/EventStreamService.ts`
- `server/src/platform/realtime/event-stream.test.ts`
- `server/src/routes/eventRoutes.ts`
- `server/src/app.ts`
- `server/src/tests/realtime-events-http.test.ts`
- `server/src/tests/vertical-sse-combat-http.test.ts`
- `client/src/app/realtime/RealtimeSession.ts`
- 对应 client tests

**RED**

```bash
npx vitest run server/src/platform/realtime/event-stream.test.ts server/src/tests/realtime-events-http.test.ts server/src/tests/vertical-sse-combat-http.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1
```

预期：subscription不绑定session/epoch，revoke后仍可dispatch/reconnect。

**GREEN**

1. Event subscription state加入 authority binding与 injected checker。
2. headers flush前做最终 authority check；每批读取前和每 frame dispatch前检查。
3. runtime commit notification按session/user关闭client，先drop队列再destroy response。
4. 两浏览器设备：logout-current只断当前；logout-all/admin revoke/disable断全部；reconnect 401。
5. expiry cleanup也触发 revoke notification。
6. `closeViewer` 保留并通过既有 fixture测试。

**门**：无 revoked frame在事务 commit后发送；authority checker failure fail closed并关闭连接。

### Task 7：HTTP front door——origin/TLS/proxy/CORS/headers/body/error

**新增/修改**
- `server/src/config.ts`
- `server/src/tests/config.test.ts`
- `.env.example`
- `server/package.json` / lockfile（`proxy-addr` direct + types）
- `server/src/platform/http/RequestSecurityPolicy.ts`（new）
- `server/src/platform/http/securityHeaders.ts`（new）
- `server/src/platform/http/jsonBodyBudget.ts`（new）
- `server/src/platform/http/errorMiddleware.ts`
- `server/src/platform/http/AppError.ts`
- `packages/contracts/src/errors.ts`
- `server/src/app.ts`
- `server/src/tests/http-security-negative-matrix.test.ts`（new）

**RED**

```bash
npx vitest run server/src/tests/config.test.ts server/src/tests/http-security-negative-matrix.test.ts server/src/tests/platform-composition.test.ts --maxWorkers=1
```

预期：wildcard CORS、10mb global parser、no origin/TLS/header/error codes。

**GREEN**

1. strict config parser：invalid origin/CIDR/bootstrap config listener前失败。
2. exact trust proxy predicate；单测可信/非可信 remote与spoofed forwarded headers。
3. 移除 `cors()` default和global parser；自定义 exact CORS或带显式 options的现有 `cors` dependency，永不 `* + credentials`。
4. fixed API headers：CSP literal、Referrer、Permissions、nosniff；可信HTTPS下HSTS `max-age=31536000`。不做static hosting。
5. per-endpoint parser helpers；body limit在role/CSRF后挂；413 envelope。
6. error map sync test覆盖所有 appErrorCodes。
7. auth/bootstrap/admin no-store。

**门**：恶意oversize未认证请求不能在role前被parse；SSE既有no-transform/X-Accel headers不回归。

### Task 8：pre-auth/session CSRF与 in-memory rate limiter

**新增/修改**
- `server/src/platform/http/csrf/PreAuthCsrfStore.ts`（new）
- `server/src/platform/http/csrf/SessionCsrfGuard.ts`（new）
- `server/src/platform/http/csrf/csrf.test.ts`（new）
- `server/src/platform/http/rateLimit/InMemoryRateLimiter.ts`（new）
- `server/src/platform/http/rateLimit/rate-limit.test.ts`（new）
- `server/src/routes/securityRoutes.ts`（new）
- 全部 mutation routers
- `client/src/shared/api/platformHttp.ts`
- `client/src/api/auth/authApi.ts`
- `server/src/tests/httpTestHarness.ts`
- `server/src/tests/http-security-negative-matrix.test.ts`

**RED**

```bash
npx vitest run server/src/platform/http/csrf/csrf.test.ts server/src/platform/http/rateLimit/rate-limit.test.ts server/src/tests/http-security-negative-matrix.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1
```

预期：mutation无CSRF；客户端不附header；目标surfaces无限速。

**GREEN**

1. 实现purpose-bound preauth issuance/consume，5分钟、一次性、bounded cleanup。
2. session CSRF guard与digest比较；所有state-changing route列出显式覆盖表。
3. client获取preauth token；platformHttp从cookie读取authenticated token并加header。
4. limiter surfaces固定：bootstrap、preauth/register/login/invite尝试、Provider test、AI resolve/retry、SSE reconnect。
5. limiter key只使用RequestSecurityPolicy输出的权威client IP；注入clock，window reset与bucket eviction测试。
6. 429 envelope和安全headers测试。

**门**：Origin/CSRF都在body parser之前；preauth failure不泄漏账号/邀请/bootstrap状态。

### Task 9：strict external DTO与 body budget inventory

**修改**
- `packages/contracts/src/auth.ts`
- `packages/contracts/src/campaign.ts`
- `packages/contracts/src/character.ts`
- `packages/contracts/src/world.ts`
- `packages/contracts/src/turn.ts`
- `packages/contracts/src/combat.ts`
- `packages/contracts/src/ai.ts`
- `packages/contracts/src/archive.ts`
- `packages/contracts/src/rules.ts`
- 对应 contract/server HTTP tests
- 全部 routers的显式 parser placement

**RED**

```bash
npx vitest run --passWithNoTests packages/contracts/src server/src/tests/http-security-negative-matrix.test.ts server/src/tests/ai-routes-http.test.ts --maxWorkers=1
```

预期：多数schema strip unknown/unbounded，route budget未inventory。

**GREEN**

1. 对所有外部input `.strict()`；string/array/record/nested payload有最大预算。
2. 不改变领域语义；预算值以现有最大正常fixtures为下界并记录在测试名。
3. response敏感DTO严格：login、bootstrap、invite create/list、admin account/session/audit。
4. server不能依赖client parse strip；unknown keys为400。
5. 建 endpoint budget table test，任何新增POST/PUT/PATCH无 parser配置则失败。

**门**：AI/context/character sheet合理现有fixtures仍通过；不是借安全Task做Phase 3领域重构。

### Task 10：浏览器 bootstrap（切片2.1）

**新增/修改**
- `server/src/modules/platform-admin/BootstrapSecret.ts`（new）
- `server/src/modules/platform-admin/BootstrapService.ts`（new）
- `server/src/modules/platform-admin/bootstrap.test.ts`（new）
- `server/src/routes/bootstrapRoutes.ts`（new）
- `server/src/app.ts`
- `packages/contracts/src/auth.ts`或新`platformAdmin.ts`
- `client/src/features/setup/SetupPage.tsx`（new）
- `client/src/api/platformAdmin/bootstrapApi.ts`（new）
- `client/src/app/router/AppRouter.tsx`
- router/component tests

**RED**

```bash
npx vitest run server/src/modules/platform-admin/bootstrap.test.ts server/src/tests/http-security-negative-matrix.test.ts client/src/app/router/router.test.tsx client/src/features/auth/auth.test.tsx --maxWorkers=1
```

预期：无setup route/service，secret parser/one-admin transaction不存在。

**GREEN**

1. canonical base64url parser与constant-time compare vector tests。
2. startup验证bootstrap env；enabled + wrong DB ID/unenrolled/not secure均fail closed。
3. availability/complete routes no-store、preauth CSRF、strict rate/body。
4. bootstrap事务包含user/admin/completed/audit；并发Promise.all只一成功。
5. success不设置session；client提示转login。
6. completed后当前进程立即统一不可用；恢复到已completed backup不重开。
7. `/setup` functional minimal page，不把secret写URL/storage/log。

**门**：错误 secret/closed/completed同外部错误和状态；audit无secret/login/password。

### Task 11：平台注册邀请与私有 register（切片2.2）

**新增/修改**
- `server/src/modules/platform-admin/RegistrationInviteService.ts`（new）
- `server/src/modules/platform-admin/RegistrationInviteRepository.ts`（new）
- `server/src/modules/platform-admin/registration-invite.test.ts`（new）
- `server/src/routes/authRoutes.ts`
- `server/src/routes/platformAdminRoutes.ts`（new）
- `packages/contracts/src/platformAdmin.ts`（new）
- `packages/contracts/src/index.ts`
- `client/src/features/auth/RegisterPage.tsx`
- `client/src/features/platform-admin/InvitesPanel.tsx`（new）
- APIs/tests

**RED**

```bash
npx vitest run server/src/modules/platform-admin/registration-invite.test.ts server/src/tests/authCampaignRoutes.test.ts client/src/features/auth/auth.test.tsx client/src/app/router/router.test.tsx --maxWorkers=1
```

预期：register仍开放、无admin invite CRUD。

**GREEN**

1. invite create/list/revoke：admin-only、CSRF、rate/body/no-store。
2. create raw只响应一次；list含status/expiry/createdAt，不含digest/raw。
3. register strict body加入inviteCode；consume+create user+audits同事务。
4. 并发同code只一个201；其它统一INVITE_INVALID；7d boundary用注入clock。
5. RegisterPage必须输入邀请；URL query可预填到内存form但提交后replace URL，不发送到日志；不在localStorage。

**门**：campaign invite与platform invite代码/表/route清晰分离。

### Task 12：PlatformAdmin API、账号/session管理与战役不可见性

**新增/修改**
- `server/src/modules/platform-admin/PlatformAdminService.ts`（new）
- `server/src/platform/http/platformAdminMiddleware.ts`（new）
- `server/src/routes/platformAdminRoutes.ts`
- `server/src/modules/platform-admin/platform-admin.test.ts`（new）
- `server/src/tests/platform-admin-http.test.ts`（new）
- `client/src/features/platform-admin/PlatformAdminPage.tsx`（new）
- `client/src/api/platformAdmin/platformAdminApi.ts`（new）
- router/client tests

**RED**

```bash
npx vitest run server/src/modules/platform-admin/platform-admin.test.ts server/src/tests/platform-admin-http.test.ts client/src/app/router/router.test.tsx --maxWorkers=1
```

预期：admin role/API/UI不存在。

**GREEN**

1. `/api/platform-admin`统一 requireAuth+requirePlatformAdmin；无campaign repo依赖。
2. 账号list/disable/enable、target session revoke、audit metadata list、runtime/maintenance status。
3. sole admin disable/delete/demote拒绝；不提供promotion/delete route。
4. disabling普通user同事务auth_revision/revoke/audit；commit后SSE close。
5. negative matrix：admin若不是member，campaign list不返回别人的campaign，所有已知campaign-scoped endpoints继续404；不能借admin route查campaign name/content/provider/archive/AI。
6. client最小console只加载platform queries；不挂campaign query cache。

**门**：不显示或调用 Platform Rules 能力；不调用rules repository。

### Task 13：唯一管理员离线密码恢复 CLI

**新增/修改**
- `server/src/platform/ops/AdminPasswordRecoveryCoordinator.ts`（new）
- `server/src/platform/ops/AdminPasswordRecoveryCoordinator.test.ts`（new）
- `server/src/cli/platformCli.ts`
- `server/src/modules/identity/passwords.ts`（仅导出可复用policy/hash，如需要）

**RED**

```bash
npx vitest run server/src/platform/ops/AdminPasswordRecoveryCoordinator.test.ts --maxWorkers=1
```

预期：无recovery command/hidden prompt seam。

**GREEN**

1. injectable hidden prompt；测试确认argv/env/stdout无password。
2. absolute/symlink/lock/manifest/database ID/ready state/exact-one-admin gates。
3. 同事务password hash更新、auth revision bump、all sessions revoke、audit。
4. 失败rollback；admin count与campaign memberships前后完全一致。
5. 重启后old cookie和SSE reconnect失败。

**门**：无second-admin创建能力，无generic `--force/--yes`。

### Task 14：MaintenanceManager、统一write admission与Provider cancel

**新增/修改**
- `server/src/platform/maintenance/MaintenanceManager.ts`（new）
- `server/src/platform/maintenance/MaintenanceAwareDatabasePort.ts`（new）
- `server/src/platform/maintenance/maintenance.test.ts`（new）
- `server/src/platform/maintenance/operationContext.ts`（new）
- `server/src/app.ts`
- `server/src/routes/platformAdminRoutes.ts`
- `server/src/modules/ai-runtime/AiProviderPort.ts`
- `server/src/modules/ai-runtime/CampaignScopedAiProvider.ts`
- `server/src/modules/ai-runtime/OpenAiCompatibleAiProvider.ts`
- `server/src/modules/ai-runtime/OpenAiCompatibleTransport.ts`
- `server/src/modules/ai-runtime/AiResolutionService.ts`
- affected services/tests where top-level writes need explicit operation kind

**RED**

```bash
npx vitest run server/src/platform/maintenance/maintenance.test.ts server/src/modules/ai-runtime/open-ai-compatible-transport.test.ts server/src/modules/ai-runtime/ai-resolution.test.ts server/src/tests/platform-admin-http.test.ts --maxWorkers=1
```

预期：无lease/commit recheck/drain/cancel/quiescent allowlist。

**GREEN**

1. 先实现pure state/lease manager和deterministic fake operations。
2. wrapper只在production composition启用；直接adapter tests/CLI不被破坏。
3. inventory production顶层 `.execute/.transaction` 写调用；route/service entrance分配operation kind。新增guard test扫描app-composed writes必须有lease。
4. adapter/wrapper在COMMIT前recheck state/epoch；竞态测试使用barrier：write admitted→drain transition→write callback完成→预期按grandfather规则commit或rollback，结果与operation admission timestamp一致。
5. AI operation跨claim/provider/formal/fail跟踪；Provider接AbortSignal，transport combine timeout+external abort，仍单请求。
6. drain timeout返回opaque IDs并保持draining；cancel后仍未settle不quiescent。
7. quiescent route matrix逐项测试：health/login/me/status/off通过；SSE/register/invite/session admin/campaign/AI均拒绝。login唯一session write审计固定schema。
8. off恢复active并epoch+1；restart按§4.14分别覆盖active/quiescent/draining，draining需admin `resume-drain`、记录operator judgment audit且永不自动active。

**门**：不添加campaign revision/mutation source，不改变Phase 3领域行为；shutdown仍按Phase 1顺序，并在DB close前等待maintenance tracked ops。

### Task 15：Phase 2 HTTPS Chromium——bootstrap、邀请注册、Cookie/CSRF/SSE

**新增/修改**
- `scripts/phase2-browser-validation.ts`（new）
- `server/src/tests/fixtures/phase2BrowserServer.ts`（new）
- `client/src/tests/phase2-browser-flow.test.ts`（new）
- `package.json`
- `client/src/features/setup/*`
- `client/src/features/platform-admin/*`
- relevant router/UI tests

**RED**

```bash
npm run test:phase2-browser
```

预期：script/HTTPS fixture/scenarios不存在。

**GREEN**

1. 每次运行生成测试期自签localhost cert于temp dir；Chromium context `ignoreHTTPSErrors:true`。该gate只验证HTTPS origin/cookie/CSRF/SSE应用行为，不声称验证公有CA证书链；production TLS/HSTS fail-closed由Task 7配置/HTTP tests覆盖，正式artifact证据延Phase 7/8。
2. frontend与backend都使用ephemeral direct HTTPS listener，浏览器可见origin与cookie origin始终为HTTPS；不保留plain-HTTP backend/trusted-proxy替代路径。所有DB/key/backup temp absolute paths。
3. 场景：
   - status CLI得到ID；bootstrap enabled；`/setup`一次成功，第二context并发/后续失败；
   - admin正常login，创建invite；raw code只在create UI一次可见；
   - guest用invite注册成功；同invite第二次失败；expired/revoked fixtures失败且文案一致；
   - login response network body无sessionId；cookies含exact `__Host-`/Secure/HttpOnly/SameSite/Path属性；document/localStorage无session token；
   - CSRF missing/wrong network request 403；删除CSRF cookie但保留session cookie后访问`/me`可恢复新token，旧token失败、正常UI mutation通过；
   - two-device revoke/logout-all导致existing SSE断开，reconnect登录失效；
   - platform admin非member不能看到campaign数据。
4. Task内完成cert generator、`test:phase2-browser` package wiring与standard-library-first dev-dependency裁决；不得延期到聚合任务。
5. teardown顺序：browser→vite/fixture listener→realtime/ops drain→DB close→lock/key/temp cleanup。

**门**：该 gate 是 Phase 2 浏览器证据；明确不冒充Phase 7/8 production static artifact gate。保留既有 `test:phase4-browser` 回归。

### Task 16：聚合验证、文档和独立实施审查

**修改/新增**
- `docs/superpowers/validation/phase2-implementation-ledger.md`
- `docs/superpowers/reviews/2026-08-12-dnd-ai-dm-v1-phase2-implementation-review.md`
- `task_plan.md`、`progress.md`、`findings.md`

**GREEN commands**

```bash
npm test -- --maxWorkers=1
npm run typecheck
npm run typecheck --workspace @dnd/contracts
npm run build
npm run test:phase4-browser
npm run test:phase2-browser
```

并执行：

- source/dist migration exact-set/hash验证；
- 001–011 raw hash复核；
- temp existing DB enrollment + sensitive backup + cutover + startup smoke；
- fresh init + bootstrap + invite smoke；
- legacy sentinel before/after；
- default DB/key/lock baseline before/after；
- `git diff --cached --quiet` 确认staging为空；
- source scan确认无 Bearer fallback、`dnd_session`旧cookie、public `sessionId`、wildcard CORS/global 10mb parser；
- audit recursive sentinel suite；
- fresh-context correctness/security/operability/client四lane审查和单writer修复，直到0 Blocker/0 Major。

---

## 6. 端点与 parser/admission contract

下表覆盖全部route classes（包含read-only GET），必须变成测试中的静态inventory，防止新增route绕过安全顺序。

| Surface | Session/role | CSRF | body上限 | rate limit | maintenance |
| --- | --- | --- | --- | --- | --- |
| preauth issuance | guest | no（GET） | none | IP/purpose | active；quiescent仅允许purpose=login；bootstrap availability仅active |
| bootstrap complete | guest eligible | preauth/bootstrap | 8 KiB | strict IP+handle | active only |
| register | guest | preauth/register | 8 KiB | IP+invite digest attempt | active only |
| login | guest | preauth/login | 8 KiB | IP+normalized login coarse key | active + quiescent operational write |
| read-only GET（`/me` + campaign/character/turn/world/combat/archive/AI query） | route-defined auth/role | no | none | surface bucket | active；quiescent只allow `/me` |
| logout/logout-all | auth | session | 1 KiB/empty | standard | active only；quiescent禁其它session管理 |
| campaign mutations | auth+campaign role | session | endpoint budget | standard/AI special | active only |
| Provider test | owner | session | 16 KiB | strict user+campaign | active only, tracked Provider op |
| AI resolve/retry | owner | session | 8 KiB | strict user+campaign | active only, tracked AI op |
| SSE | auth+campaign member | no custom header（GET） | none | IP+session reconnect | active only |
| admin invite/account/session/audit | platform admin | session | 8 KiB | admin bucket | active only |
| maintenance status | platform admin | no（GET） | none | admin bucket | all states |
| maintenance on/resume-drain/off | platform admin | session | 2 KiB | strict admin | on active；resume-drain draining；off quiescent |
| health | none | no | none | light | all states |

所有敏感 response均 `.strict()`；auth/bootstrap/admin `Cache-Control:no-store`。

---

## 7. Existing DB 与 Fresh DB 操作剧本

### 7.1 Existing 001–011 DB

```text
stop server
→ platform enroll --database ABS
→ platform status：核对 ready + database ID
→ platform security-cutover --database ABS --backup ABS
   → verified sensitive backup
   → 013
   → 014
   → delete old sessions + audit + cleaning
   → secure_delete/checkpoint/VACUUM/checkpoint
   → byte/auth/integrity verification
   → ready
→ 配置 PUBLIC_ORIGIN/TLS/bootstrap ID+secret（如仍无admin）
→ start server
→ browser bootstrap
→ remove bootstrap mode/secret and restart before release
```

任何一步失败：listener保持关闭；不得跳过backup/cleanup/ready验证。cutover重跑必须携带原`--backup` target：已发布且完整匹配则verify-and-reuse，不匹配则拒绝并要求operator诊断/选择新空target，绝不覆盖。若CLI crash留下`.dnd-instance.lock`，先确认owner进程不存在，再按Phase 1协议人工移除stale lock；CLI永不自动break。

### 7.2 Fresh DB

```text
platform init --database ABS
→ create 001–014
→ generate database ID + key
→ initializing
→ atomic key publish
→ enrollment ready + session security ready/cutover_at
→ platform status核对ID
→ 显式配置一次性bootstrap
→ start HTTPS server
→ browser bootstrap一次
→ remove bootstrap config/secret and restart
```

init不创建管理员、不创建invite、不调用Provider。

---

## 8. 测试与证据策略

### 8.1 测试隔离

- service/repository：`:memory:`；
- enrollment/cutover/backup/WAL：`mkdtemp` file DB；
- PostgreSQL experiment：Phase 2明确不应用SQLite-specific 012–014；相关环境门保持skipped并记录未来parity，不纳入v1生产验收；
- HTTP：ephemeral HTTPS；
- Chromium：ephemeral HTTPS origin、自签temp cert；
- Provider：injected fake fetch/provider，绝不真实网络；
- clock/random/fs/rename/abort均有injectable seams；
- parallel tests不得共享limiter/nonce/temp dir。

### 8.2 关键负面矩阵

- missing/relative/symlink/wrong DB；wrong ID/key/fingerprint；initializing/pending/cleaning startup；
- backup failure before 013；future migration in allowlist；raw token byte残留；
- byte scan命中预先捕获/从verified backup提取的exact old token时一律fail closed；理论随机碰撞由operator对backup token集合与命中文件offset做诊断，不能忽略或自动标ready；
- invalid bootstrap canonical encoding、wrong secret、parallel bootstrap；
- invite nonexistent/expired/revoked/consumed/concurrent；
- raw token in JSON/DB/audit/client storage；Bearer auth；cookie attribute drift；
- CSRF missing/wrong/replay/cross-session/purpose mismatch；session cookie survives while CSRF cookie missing（`/me` recovery + old digest invalidation）；Origin missing/null/cross-port；spoofed forwarded headers；
- oversized body before/after auth、unknown DTO keys、429 reset/isolation；
- unique admin disable/delete/demotion；admin campaign access；
- revoke during SSE replay/live；reconnect cache bypass；
- drain write race、provider cancel、timeout remains draining、quiescent route allowlist；
- audit update/delete与recursive sensitive values。

### 8.3 构建/依赖裁决

- `proxy-addr` 从transitive提升为direct dependency，固定与Express当前兼容版本；增加types。
- 不引入`helmet`：headers literal是冻结决策，显式实现更容易精确测试。
- 不引入`express-rate-limit`：SQLite v1单实例下自有小型bounded limiter足够，避免默认key/proxy语义隐式变化。
- 不引入cookie-parser/CLI框架；沿用小型手工解析与纯函数测试惯例。
- 自签测试证书优先由Node crypto/checked-in test-only generator生成；若标准库不足，任何新dev dependency必须单独在Task 15 RED后说明理由并审查，不能进入production dependency。

---

## 9. 风险与预置缓解

| 风险 | 缓解 |
| --- | --- |
| 013 additive schema无法消除001 NOT NULL旧列 | secure row明确同时写legacy `expires_at`；authority只看new fields；cutover清空old rows；无dual-read |
| 清理后raw token残留free pages/WAL | `secure_delete=ON` + checkpoint(TRUNCATE)+VACUUM+二次checkpoint+byte scan；state cleaning直到成功 |
| bootstrap备份回滚重新开放 | eligibility还绑定部署expected database ID和显式mode；发布前必须移除mode/secret；completed备份测试；不自动生成secret |
| `__Host-` cookie与HTTP tests不兼容 | 所有HTTP/browser security tests前后端均direct HTTPS，无测试降级属性 |
| enrollment rollback误删pre-existing key | 012持久化`enrollment_key_origin`；rollback只删`generated`且fingerprint匹配的key；crash双分支测试 |
| cleaning cutover被重复执行 | 同一security-cutover命令按state/time/inventory idempotent resume；cleaning只重做物理cleanup+verification |
| maintenance wrapper漏掉direct execute | production composition wrapper + source/integration inventory guard；CLI/tests原adapter分离 |
| quiescent登录因无preauth nonce死锁 | quiescent显式allow login-purpose issuance；expired `me`不执行cleanup write |
| drain不能取消Provider | external AbortSignal贯穿provider/transport；单请求timeout仍保留；timeout不quiescent |
| CLI crash留下stale InstanceLock | 继续Phase 1 fail-closed；runbook要求确认无owner后人工移除，不自动break |
| audit metadata演变成数据泄漏旁路 | discriminated schemas、recursive sentinel、DB append-only、admin只读metadata |
| 平台admin console误加载campaign数据 | 独立route/API/query keys；server module无campaign repo injection；negative HTTP/client cache tests |
| ordinary startup误跑未来migration | StartupSecurityGate根据state/applied set分流；security-cutover hash-bound 012–014 allowlist |
| dirty tree误覆盖用户改动 | 单writer、编辑前read、只增量、无git cleanup/stash/reset |

---

## 10. 实施与审查编排

1. 获得用户对本文及计划审查结论的明确实施授权。
2. 记录默认数据/staging/001–011 baseline。
3. 使用一个writer按Task 0–15串行TDD；同一工作树不并行writer。
4. 每Task在ledger记录RED命令/预期失败/GREEN命令/结果/文件。
5. Task 4、5、8、10、14后分别做focused security checkpoint，阻止错误边界向后扩散。
6. Task 16由主线程直接运行完整验证，不只依赖worker attestation。
7. fresh-context四lane独立implementation review；一个fix writer集中修复，再复验。
8. 不commit，除非用户另行明确要求。

---

## 11. 计划审查验收清单

独立 reviewers 必须确认：

- 012–014 DDL与路线图一致且无secret/raw token；
- existing/fresh migration状态机无ordinary-startup destructive crossing；
- backup-before-013、cleanup-before-ready、crash recovery完整；
- session/CSRF/cookie/SSE revoke contract无dual-read/cache窗口；
- request middleware顺序可实际在Express route composition实现；
- maintenance lease/commit recheck覆盖Provider与所有writes但未偷跑Phase 3；
- admin边界不注入campaign repos；client不加载campaign cache；
- Chromium HTTPS策略不靠生产属性test override；
- Task粒度可执行，RED/GREEN命令与文件真实存在或明确new；
- Phase 6/7/8与post-v1内容没有被提前混入。

计划只有达到 `PASS / 0 Blocker / 0 Major` 后才向用户请求实施授权。
