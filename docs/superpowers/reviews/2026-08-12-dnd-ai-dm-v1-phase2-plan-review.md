# DND AI-DM v1 Phase 2 详细实施计划审查

审查日期：2026-08-12  
审查对象：[`2026-08-12-dnd-ai-dm-v1-phase2-security-foundation.md`](../plans/2026-08-12-dnd-ai-dm-v1-phase2-security-foundation.md)  
实施基准：`main` @ `641709e`（当前脏工作树上增量规划）  
权威来源：

- [`2026-08-12-dnd-ai-dm-v1-decisions.md`](../specs/2026-08-12-dnd-ai-dm-v1-decisions.md)
- [`2026-08-12-dnd-ai-dm-v1-hardening-cutover.md`](../plans/2026-08-12-dnd-ai-dm-v1-hardening-cutover.md) Phase 2 切片 2.0–2.6
- Phase 1 已验收边界：[`2026-08-12-dnd-ai-dm-v1-phase1-implementation-review.md`](./2026-08-12-dnd-ai-dm-v1-phase1-implementation-review.md)

## 最终结论

> **PASS / 0 Blocker / 0 Major**

Phase 2 详细实施计划已达到实施授权门槛。该结论只批准计划，不代表 Phase 2 已实现；在用户下一次明确授权前不得创建迁移 012–014、修改业务代码或运行默认 server/DB/key。

## 审查方式

使用 fresh-context、只读 subagents 分别进行：

1. correctness / architecture / migration/TDD sequencing；
2. security / enrollment/key/backup/session/CSRF/admin/audit；
3. operability / startup/lock/cutover crash recovery/maintenance；
4. client / endpoint inventory/middleware/browser/cookie/SSE；
5. 对审查中出现的 operability 与 security Major 做定向 post-fix signoff。

审查过程中只读取计划、权威文档和必要的当前代码。未执行迁移、未启动默认 server、未触碰默认 `dnd.sqlite*` 或 credential key、未执行 Git 暂存/提交。

## 已通过的核心范围

### 1. 迁移与 enrollment

- 固定 `012_platform_foundation.sql`、`013_secure_sessions.sql`、`014_security_audit.sql`；001–011 hash 不变。
- 012 只创建 schema；database ID、key fingerprint 与 `generated|preexisting` provenance 由显式 CLI 写入。
- 公开 fresh init 只有最终 001–014 secure-ready 模式；existing 001–011 只由 enroll 应用 012。
- ordinary startup 只接受精确批准的 applied set，不再无过滤 auto-migrate，不跨越 session security transition。

### 2. 敏感备份与 security cutover

- every existing DB（即使旧 session 数为 0）在 013 前创建并完整验证 sensitive backup。
- backup 已发布时只允许按 database ID、key fingerprint、migration/file hash 完整 verify-and-reuse，绝不覆盖。
- pending/partial/cleaning crash states 均有 fail-closed resume contract。
- normal 与 cleaning-restart 两条路径都从 re-verified pre-cutover backup 的 legacy `sessions.id` 提取 old-token 集合，再做 byte/auth/integrity verification。
- `secure_delete`、checkpoint、`VACUUM`、二次 checkpoint 与 `cleaning -> ready` 顺序固定。

### 3. Session、Cookie、CSRF 与 SSE

- browser auth 改为 Cookie-only digest session；无 Bearer fallback、无 raw token DTO/DB authority。
- `__Host-dnd_session` 与 `__Host-dnd_csrf` 始终 Secure/SameSite=Lax/Path=/，expiry 对齐。
- session cookie 存活但 CSRF cookie 丢失时，authenticated `/me` 条件旋转当前 session CSRF digest并恢复 cookie；旧 token 立即失效。
- SSE 在 flush 前绑定 session/revision/epoch，replay/live 每批重验；logout/revoke/disable 后关闭并清队列，reconnect重新认证。

### 4. HTTP 安全基线

- 精确 `PUBLIC_ORIGIN`、可信 proxy CIDR、可信 HTTPS、Host/proto/Origin一致性。
- 删除 wildcard CORS 与全局 10 MB parser；session/role/CSRF 在 endpoint parser 前。
- 静态 inventory 覆盖 preauth、auth、read-only GET、campaign mutation、Provider/AI、SSE、admin、maintenance 与 health。
- per-route body budget、strict DTO、bounded limiter、固定 security headers 与统一错误 envelope 均有 TDD gate。

### 5. 私有注册、平台主管与审计

- bootstrap 显式部署开关 + canonical secret + expected database ID + single transaction；只创建唯一 admin，不创建 session。
- registration invite digest-only、一次性、7 天、并发单消费；create response只显示 raw code一次。
- 平台 admin 模块不注入 campaign repositories；non-member 仍得到 campaign 404。
- offline admin password recovery 使用 hidden prompt，同事务 password hash、auth revision、session revoke 与 typed audit。
- audit table由 SQLite trigger强制 append-only；metadata使用 discriminated strict schemas与递归 secret sentinel，并含正负样本。

### 6. Maintenance

- `active -> draining -> quiescent`、epoch、AsyncLocalStorage lease、commit-time recheck 与 Provider `AbortSignal` 已冻结。
- drain timeout保持 draining；persisted draining restart不自动 active，由唯一 admin在明确operator judgment后 `resume-drain`。
- quiescent route/write allowlist精确。为避免唯一 admin因CSRF cookie单独丢失而无法 maintenance-off，计划显式记录 `/me` 当前 session CSRF digest旋转为 decisions §10.1 的 narrow security clarification。

### 7. Client 与 Chromium

- 最小 `/setup`、invite-required `/register` 与独立 platform-admin console；不加载 campaign query/cache。
- Phase 2 browser gate使用 temp self-signed cert、frontend/backend direct ephemeral HTTPS；不降低 Secure cookie属性。
- gate覆盖 bootstrap并发、invite create/consume/reject、cookie/CSRF recovery、revoke/SSE reconnect 与 admin campaign isolation。
- 明确不冒充 Phase 7/8 production artifact/certificate-chain gate。

## 审查中闭合的 Major

1. **quiescent login deadlock：**加入仅 `purpose=login` 的 preauth issuance。
2. **Task 2 init 与 013/014 sequencing冲突：**Task 2只实现 test-only 012 fresh seam；Task 4才启用公开001–014 init。
3. **crash后key rollback provenance不可靠：**012持久化 `enrollment_key_origin`。
4. **cleaning restart无old-token验证来源：**统一从 re-verified pre-cutover backup读取 legacy token集合。
5. **persistent session 与CSRF cookie lifecycle错位：**两cookie expiry对齐，并提供authenticated `/me` digest rotation/recovery。

## Minor disposition

审查中的 bounded Minor 已写入计划，包括：

- published backup verify-and-reuse；
- POSIX required / Windows best-effort directory fsync；
- read-only GET静态inventory；
- Task 2 RED baseline裁决；
- persisted draining operator-judgment限制；
- invite index DDL具体化；
- audit sentinel正面allowlist tests；
- self-signed Chromium证据边界与Task内cert/script wiring；
- normal/cleaning old-token source统一；
- decisions §10.1 narrow clarification显式记录。

这些 disposition 不留下计划级 Blocker 或 Major。

## 计划级验证状态

- 计划文档 `git diff --check`：PASS。
- staging：空。
- migration 012/013/014：均不存在。
- `server/.dnd-instance.lock`：不存在。
- 本轮未运行实施测试、typecheck、build或browser gate，因为 Phase 2 尚未获实施授权且业务代码尚未改变；这些命令已冻结在 Task 16。

## 批准边界

- **批准：**在用户明确授权后，按该计划严格 TDD 实施 Phase 2。
- **未批准：**当前直接实施、创建 012–014、修改业务代码、触碰默认 DB/key、Git 暂存/提交。

> **PHASE 2 PLAN APPROVED — IMPLEMENTATION NOT STARTED**
