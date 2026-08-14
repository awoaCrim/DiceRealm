# Phase 2 Implementation Ledger — DND AI-DM v1

> 实施依据：`docs/superpowers/plans/2026-08-12-dnd-ai-dm-v1-phase2-security-foundation.md`（计划审查 PASS / 0 Blocker / 0 Major）
> 用户已通过「继续」明确授权实施 Phase 2。
> 实施基准：`main` @ `641709e`；工作树既有脏状态全部保留；staging 保持为空；不执行 git add/commit/amend/stash/reset/clean/checkout。

## Baseline（Task 0 前记录）

- HEAD: `641709e`
- staging: 空
- 默认 artifacts：
  - `server/dnd.sqlite` sha256 `b0b74c555515fc328e8d2908335e35af2fb4af3ed28f2f2752c3bcf1f0b27f96`
  - `server/dnd.sqlite-wal` sha256 `0849cfbe850859d8f68a170e37ec24e07cf9fe97aa52023dd6ce84ab3eb5577b`
  - `server/dnd.sqlite-shm` sha256 `1b2c5181027e6df211419a70e0cbaa45e297b853e8ac1cfb91d21dd64810d381`
  - `server/.dnd-ai-credential-key` sha256 `63412f0702525078b826dcecf9ae9dadd2e593fe21dc9faaea5beb1aabf5f776`
  - 根目录 `.dnd-ai-credential-key`：absent
  - `server/.dnd-instance.lock`：absent
- 001–011 source SHA-256：`71309a66`/`e0740d46`/`ea505844`/`ba54bc42`/`db6f4718`/`ee3fe97c`/`7a807a1f`(normalized-LF manifest hash)/`940bb738`/`67f13ee7`/`19614aa7`/`8900931e`。007 磁盘 raw hash `9aab16c5` 与 manifest `7a807a1f` 的差异经实测为 Windows CRLF → 规范化 LF 所致（`sha256OfMigrationText` 设计行为），非 tamper。

## Task 0：Phase 2 安全测试基线与路径保护

- RED command：`npx vitest run server/src/tests/phase2TempFixture.test.ts server/src/platform/ops/migrationManifest.test.ts server/src/tests/legacy-sentinel-startup.test.ts --maxWorkers=1`
- RED 观察：`phase2TempFixture.test.ts` 不存在（vitest 无法解析文件路径即 RED）；实际写入 fixture 后转 GREEN。
- GREEN 结果：3 files / 21 tests passed。
- 产物：`server/src/tests/phase2TempFixture.ts(+test)`、`server/src/tests/phase2LegacySentinel.ts`、`migrationManifest.test.ts` 改用 `APPROVED_MIGRATION_FILENAMES`、`legacy-sentinel-startup.test.ts` 改用共享 sentinel、`.env.example` 增加 Phase 2 变量。
- 门：只改测试基础设施/文档，未改生产行为。✓

## Task 1：012 schema + PlatformInstanceStore

- RED：`PlatformInstanceStore.test.ts` import 解析失败（store 不存在）。
- GREEN：`npx vitest run ...PlatformInstanceStore.test.ts database.test.ts migrationManifest.test.ts phase2TempFixture.test.ts legacy-sentinel-startup.test.ts` → 5 files / 56 tests passed。
- 产物：`012_platform_foundation.sql`（platform_instance/platform_administrators/platform_registration_invites + invite 索引，纯 schema）、manifest 加入 012（normalized-LF sha256 `3dab3ce7…`）、`PlatformInstanceStore.ts(+test)`（条件 transition `changes===1` winner）、`APPROVED_MIGRATION_FILENAMES` 加入 012。
- 门：001-011 raw hash 未变（007 差异为 CRLF→LF 规范化，已验证）；legacy sentinel 通过。✓

## Task 2：显式 init/enrollment CLI、key fingerprint 与 server missing-DB fail-closed

- RED（首轮）：旧 `startPlatformServer.test.ts` 12 项失败（普通 startup 会静默创建 DB 的旧行为）；EnrollmentCoordinator/CredentialKeyStore 新测试转 GREEN。
- GREEN：`npx vitest run EnrollmentCoordinator.test.ts CredentialKeyStore.test.ts startPlatformServer.test.ts config.test.ts legacy-sentinel-startup.test.ts` → 5 files / 32 tests passed；全量 `npx vitest run --maxWorkers=1` → 69 files / 549 passed / 22 skipped / 0 failed；`tsc -p server/tsconfig.json --noEmit` PASS。
- 产物：
  - `CredentialCipher.fingerprint()`/`serialized()`；`CredentialKeyStore` 改为 same-dir temp + fsync + atomic rename + dir fsync 的 durable publish，新增 `publishCredentialCipher`/`credentialKeyFileExists`；EEXIST 语义保持。
  - `platformPaths.ts`（canonical absolute / 普通文件非 symlink / 路径不存在）。
  - `EnrollmentCoordinator.ts(+test)`：enroll（只应用 012，且 key disposition 通过后才应用——wrong/missing key 不改 DB）、init（test-only 012 seam）、resume/rollback/status；generated/preexisting provenance；rollback 只删 generated 且指纹匹配的 key。
  - `StartupSecurityGate.ts`：applied set 分流（0→提示 enroll；<12→enroll；==12→cutover；exact set + enrollment ready + fingerprint + decrypt-all + session ready）。
  - `startPlatformServer.ts` 改为 path.verify → lock → manifest → open（不再 migrate）→ security.verify → app → listen。
  - `platformCli.ts`（enroll/enroll-resume/enroll-rollback/status + `platform:cli` script）。
- 已知 sequencing 偏差（记录）：
  1. 成功启动路径（close 顺序/idempotent/listener-failure 清理）依赖 session-security-ready，需 013/014 + cutover（Task 4）——相应测试在 Task 4 补回；Task 2 覆盖 fail-closed 矩阵。
  2. wrong-key 指纹测试同样依赖 001-014 已存在（§4.3 applied-set 检查先于指纹检查）→ Task 4 补。

## Task 3：013 secure session additive schema、014 append-only audit 与 typed writer

- RED：`security-audit.test.ts` import 解析失败（SecurityAuditEvent/SecurityAuditWriter 不存在）；`database.test.ts` 断言 migrations 数=14 失败（013/014 未入 manifest）。
- GREEN：`npx vitest run server/src/modules/security-audit/security-audit.test.ts server/src/platform/database/database.test.ts server/src/tests/phase2TempFixture.test.ts server/src/tests/legacy-sentinel-startup.test.ts --maxWorkers=1` → 4 files / 70 tests passed（security-audit 子集全绿）。
- 产物：
  - `013_secure_sessions.sql`：users 增 `status`/`auth_revision`；sessions 增 8 个 secure 列（token_digest/csrf_digest/captured_auth_revision/revoke_epoch/revoked_at/absolute_expires_at/idle_expires_at/last_seen_at）+ partial UNIQUE token_digest + 3 索引；纯 additive（legacy raw session 行保留）。
  - `014_security_audit.sql`：`platform_security_audit_events` + UPDATE/DELETE `RAISE(ABORT)` trigger（append-only）+ 3 索引；纯 additive。
  - manifest 加入 013（normalized-LF sha256 `f9fdabf1…`）/ 014（`f86b8d86…`）；`APPROVED_MIGRATION_FILENAMES` 加入 013/014。
  - `SecurityAuditEvent.ts`：21 种 discriminated event 类型 + strict bounded schemas（bounded 拒绝 list/record 溢出）。
  - `securityAuditSentinel.ts`：递归 sentinel（敏感字段名/值拒绝 + coarse id/count/enum allowlist）。
  - `SecurityAuditWriter.ts`：只暴露 `writeIn`；DB trigger + writer 双重 append-only，无 mutation/update 方法。
- 门：legacy raw session 在 013 后原样保留（sentinel 断言）；014 trigger 对 UPDATE/DELETE RAISE(ABORT)。✓
- 迁移 raw hash：013 `f9fdabf1a41f00502896f004162b9ec4dcfce8ee33ac5b73541bdd09e0bb68f6`、014 `f86b8d86853bbd9f61ced3416f971634393f738fea8a19fff7db245bcff2c7b8`（normalized-LF）。

## Task 4：离线敏感备份 + security-cutover 协调器 + 最终公开 init 语义 + 成功启动路径

- RED（首轮）：`OfflineBackupPrimitives.test.ts`/`SecurityCutoverCoordinator.test.ts` import 解析失败；补 startPlatformServer 成功路径后旧断言失败。
- 修复链（均记录）：
  1. 【root-cause，后于 serialize 撤销】createSensitiveSnapshot 曾为同步包装：launch `source.backup()` Promise 后未 await 就 close source 并立即发布 → 现象“promise resolve 但目标未落盘 + 迟发 connection is not open”。这是 backup() 生命周期 bug（floating promise），并非 backup() API 本身缺陷；曾以 serialize() 替代，见下方“官方 backup API 生命周期修复”一节撤销。最终修复：createSensitiveSnapshot 改为 async，`await source.backup(dbCopyPath)` 完成前 source 保持打开，close 只在 finally（await 之后）；发布前对 temp 实际副本全量复验通过后才原子 rename。
  2. `verifySensitiveSnapshot` 文件集合比较 bug（缺 `.sort()`）→ 修复。
  3. `SecurityCutoverCoordinator` integrity 检查反转（SQLite 3.53.1 `pragma_integrity_check` 返回 `[{integrity_check:'ok'}]`）→ 修复。
  4. unenrolled（001-011 无 platform_instance）cutover 崩溃（“no such table”）→ 加 `appliedVersions` + `hasFoundation` 早期 guard → `SecurityCutoverError`。
  5. WAL 源备份副本保留 WAL 格式 header（serialize/backup 均如此）→ verify 的 readonly open 在快照目录留下 `-wal/-shm` sidecar 导致文件集合校验失败 → 副本创建后 `PRAGMA journal_mode = DELETE` 规范化（backup API 路径在 backup() await 完成后、按源 journal_mode 需要时才规范化；并加 dir listing 诊断到错误消息）。
  6. 快照源 readonly open 在源目录遗留 `-wal/-shm`（readonly close 不清理；writable close 会清理）→ 备份源改为可写打开（cutover 持 InstanceLock，无并发写者），close 自动移除 sidecar。
  7. Windows EPERM：cleanup-failure 测试中 logical tx 未先 DELETE sessions 导致 UNIQUE 冲突与残留句柄 → 测试按 real cutover 语义补 DELETE。
- GREEN：`npx vitest run server/src/platform/ops/OfflineBackupPrimitives.test.ts server/src/platform/ops/SecurityCutoverCoordinator.test.ts --maxWorkers=1` → 2 files / 14 tests passed。
- 产物：
  - `OfflineBackupPrimitives.ts(+test)`：`createSensitiveSnapshot`（官方 backup() API（sqlite3_backup）一致副本 + key 副本 + `dnd-sensitive-snapshot-v1` manifest + 逐文件 fsync/hash + temp 原子 rename + POSIX dir fsync + 发布前 temp 实际副本全量复验）、`verifySensitiveSnapshot`（全量复验：databaseId/keyFingerprint/migrations/文件集合/hash）、`readLegacySessionTokensFromSnapshot`。
  - `SecurityCutoverCoordinator.ts(+test)`：`SECURITY_CUTOVER_ALLOWLIST`（012/013/014 hash-bound）；pending→backup→apply 013/014→logical tx（DELETE sessions + audit + cleaning）→secure_delete/checkpoint/VACUUM/checkpoint→byte scan（WAL/SHM 全扫，命中旧 token fail closed）→auth/integrity→ready；cleaning resume 从 re-verified backup 恢复 old-token 集合，backup 缺失/不匹配 fail closed；partial 只按 allowlist 补齐；verify-and-reuse 不覆盖已有 backup。
  - `EnrollmentCoordinator` init 语义更新：同一事务 `beginSessionCleaning` + `markSessionSecurityReady` → 公开 `init` 固定应用 001-014 并写 cutover_at + ready（无 old rows 不备份；crash 于两 transition 间由事务原子性保证不持久中间态）。
  - `startPlatformServer.test.ts`：`createEnrolledPendingDb`（enroll→001-012 pending）/`createReadyDb`（init→secure-ready）；wrong-key 指纹测试（`/指纹.*不匹配/`，位于 001-014 + session-ready 后，符合 §4.3 applied-set 先于指纹检查）；成功路径 close 顺序（close.server→close.realtime→close.connections→close.database→close.lock）、idempotent close、listener-failure 清理、realtime throw / destroyConnections throw 的销毁清理。
  - `legacy-sentinel-startup.test.ts` fresh 测试改为：init 仍证明无 legacy tables + 14 platform migrations，secure-ready 实例正常启动（自定义 listen 回调→close），lock 释放。
- 全量验证：`npx vitest run --maxWorkers=1` → 72 files / **576 passed / 22 skipped / 0 failed**；`tsc -p server/tsconfig.json --noEmit` PASS；`git diff --check` 干净（仅 LF→CRLF 提示）。
- 门：默认 `server/dnd.sqlite*`/`server/.dnd-ai-credential-key`/根 key 未触碰（hash `b0b74c55`/`0849cfbe`/`1b2c5181`/`63412f07`）；`server/.dnd-instance.lock` absent；staging 空；HEAD `641709e`。✓

## Task 0-4 Checkpoint Fix（两个 Major + bounded findings，TDD 修复）

> 依据：两份 checkpoint review（`093eff8e` / `01c1c32d`）。先写 RED 测试（11 个失败）→ 最小 GREEN。

### M1：enrollment crash 窗口（012 已应用但无 platform_instance 行）

- RED：`EnrollmentCoordinator.test.ts` 新增 crash-window 测试 4 项失败（enroll 拒绝 001-012）；`SecurityCutoverCoordinator.test.ts` crash-window 全恢复测试失败。
- 修复：`enroll` guard 接受精确 {001-011} **或** {001-012} 且无 singleton 行（crash 窗口），以 fresh enrollment 安全恢复；012 已应用时跳过重放（tracking 行 PRIMARY KEY 防重，012 DDL `IF NOT EXISTS` 幂等）；任何非空/矛盾的 singleton 状态与其它 applied set 一律 fail closed。key disposition（wrong/missing key 不改 DB、preexisting 不旋转）保持不变。resume/rollback/status 语义不变：crash 窗口下 status/resume/rollback 拒绝并提示先跑 enroll（此时 enroll 可恢复）。
- 测试：`enroll safely resumes a crash window…`、`enroll preserves key disposition rules on the crash window…`、`enroll fails closed on a contradictory applied set…`、`status/resume/rollback stay coherent…`、`full recovery: crash-window 001-012 DB enrolls as a fresh attempt and completes cutover to ready`。

### M2：cleaning 状态 backup 缺失/不匹配必须 fail closed，绝不重建快照

- RED：`SecurityCutoverCoordinator.test.ts` 新增 cleaning+缺失 backup 测试失败（旧代码从 post-delete live DB 重建 backup 并错误到达 ready）。
- 修复：`ensureVerifiedBackup` 增加 `sessionSecurityState` 参数；`cleaning` 分支要求 manifest 存在并完整复验，缺失抛 `SecurityCutoverError`（operator 诊断消息），绝不调用 `createSensitiveSnapshot`；只有 pending/partial 才允许新建。mismatched backup 由 `verifySensitiveSnapshot` 完整复验 fail closed（pin 测试证明不替换）。
- 测试：`M2: cleaning with a missing pre-cutover backup fails closed and NEVER creates a snapshot…`、`M2: cleaning with a mismatched published backup fails closed and does not replace it`。

### Bounded findings（均有测试）

1. **live vs backup 旧 session ID 集合精确比较（非仅 count）**：logical cutover 改为按完整 ID 集合排序逐项比较；测试 `logical cutover compares live vs backup session ID sets exactly (content parity, not count only)`（同 count 不同内容的集合必须 fail closed）。
2. **源 vs 快照 session parity（含 WAL-visible rows）pin**：`OfflineBackupPrimitives.test.ts` 新增 `snapshot captures WAL-visible committed session rows…`——保持写连接打开、行提交未 checkpoint（`-wal` 非空），快照必须包含相同 session 集合。官方 backup() API（sqlite3_backup）在可写单连接下捕获 committed WAL 帧，测试证明该确定性安全行为。
3. **启动/init 版本冻结为 literal 001-014**：新增 `approvedMigrations.ts`（`PHASE2_APPROVED_MIGRATION_FILENAMES`）；`startPlatformServer` 不再从 manifest 派生 approved 集合，`init` 改为只应用 frozen 001-014（不再 `MigrationRunner.run()` 全目录）。测试：startup 拒绝已应用 015 的 DB（`/批准集合不一致/`）、init 在含 015 的 manifest 下只应用 001-014。
4. **StartupSecurityGate membership 诊断**：<12 与 ==12 分支按 membership 判断；12 个非精确 001-012 得到 exact-set 错误而非 security-cutover 提示。测试 `gives an exact-set diagnostic (never a security-cutover hint)…`。
5. **platformPaths**：修正误导注释（不存在“拒绝仓库默认数据路径”逻辑，该 hard rejection 在测试 fixture）；`assertPathAbsent` 只有 ENOENT 视为 absent，其它 lstat 错误 fail closed。测试 `platformPaths.test.ts`（含 null-byte 非-ENOENT 样本）。
6. **backup parent 先于 mkdtemp**：`createSensitiveSnapshot` 先 `mkdirSync(parent, {recursive:true})` 再 `mkdtempSync`。测试 `creates missing backup parent directories (target under a non-existent nested parent)`。
7. **Ledger Task 3 陈旧 bullet 修正**：013 列名改为实际 SQL 的 token_digest/csrf_digest/captured_auth_revision/revoke_epoch/revoked_at/absolute_expires_at/idle_expires_at/last_seen_at；删除重复 Task 3 标题。

### 官方 backup API 生命周期修复（撤销 serialize() 替代，authority 合规回归）

> 背景：decisions.md §10.2 要求备份固定使用 SQLite 官方 backup API，或在受控 WAL checkpoint 并关闭数据库后复制完整文件集；禁止裸复制仍活动的单个 `.sqlite` 文件。`serialize()`（sqlite3_serialize）替代既不在 authority 允许路径内，也不可被本 ledger 批复——本段为原“serialize() 偏差的 ledger/plan 批复（ratification）”的撤销与替换。

- **root-cause（原 Task 4 记录）**：createSensitiveSnapshot 曾为同步包装：launch `source.backup()` Promise 后未 await 就 close source 并立即发布 → 官方 backup() 的 Promise 从未被等待/从未完成，发布副本缺失或为空（manifest 缺 database.sqlite），并伴随迟发 unhandled rejection “The database connection is not open”。此前误判为“backup() 在本机不可靠”并改用 serialize()；实测为**异步生命周期 bug**（floating promise + 提前 close + 提前发布），非 backup() API 缺陷。
- **修复（本 fix，TDD）**：
  - `createSensitiveSnapshot` 改为 `async`，内部 `await source.backup(dbCopyPath)`（官方 backup API，sqlite3_backup），await 完成前 source 保持打开；`source.close()` 只发生在 finally（await 之后，成功或失败皆然）。不再使用 `serialize()`，不对活动单文件做 raw copy。
  - 归档 journal mode 规范化只在 backup() 完成后、按源 journal_mode（非 delete）需要时进行（WAL 源备份副本 header 保留 WAL 格式字节）。
  - 发布前复验（decisions.md §10.2 发布前 rehearsal）：原子 rename 前对 temp 实际副本执行 `verifySensitiveSnapshot` 全量复验（integrity/fk/migrations/逐文件 hash/key decrypt-all），通过后才原子发布；失败则 temp 清理、target 不创建。coordinator 的 verify-and-reuse 行为保持不变。
  - 所有 caller/coordinator/测试改为 `await createSensitiveSnapshot(...)`；`ensureVerifiedBackup` 改为 async（coordinator 内 `await`）。
- **RED 证据（broken 模式 = 原同步包装 + floating backup + 提前 close + 提前发布）**：`OfflineBackupPrimitives.test.ts` **8 tests | 7 failed**（`creates a consistent snapshot…`/WAL parity/新 pin 测试等全部 RED）+ **6 个 unhandled rejection “TypeError: The database connection is not open”（backup.js:33）**——与历史失败现象逐字一致。新测试 `publishes only after the official backup() Promise completes (never a partial copy; source closes only after the await)` 在 await 返回后断言：发布副本非空、可完整复验、含全部 WAL-visible 已提交行；broken 模式下这些断言全部失败。
- **GREEN 证据**：`npx vitest run server/src/platform/ops/OfflineBackupPrimitives.test.ts server/src/platform/ops/SecurityCutoverCoordinator.test.ts --maxWorkers=1` → **2 files / 21 tests passed**（含 WAL-visible 行 parity、verify-and-reuse、temp 清理、M2 cleaning fail-closed、exact live/backup token-set 全部保留）。
- **保留**：M1（enrollment crash 窗口安全恢复）与 M2（cleaning 状态 backup 缺失/不匹配 fail closed，绝不重建快照）修复与测试；approved migration freeze（`approvedMigrations.ts` literal 001-014，015 拒绝）。

### 验证结果（本 fix）

- RED：5 files / 11 failed（见上）；GREEN：聚焦 enrollment/cutover/backup/startup/manifest 套件 **53 passed**；关联套件（migrationManifest/phase2TempFixture/legacy-sentinel/database/CredentialKeyStore/config/PlatformInstanceStore）**68 passed**。
- 全量 `npx vitest run --maxWorkers=1`：见下方最终结果（72+ files / 全绿）。
- `tsc -p server/tsconfig.json --noEmit` PASS；`git diff --check` 干净。
- 门：默认 `server/dnd.sqlite*`/`server/.dnd-ai-credential-key`/根 key hash 不变（`b0b74c55`/`0849cfbe`/`1b2c5181`/`63412f07`）；`server/.dnd-instance.lock` absent；staging 空；HEAD `641709e`；未 git add/commit/stash/reset/clean/checkout。

### 验证结果（官方 backup API 生命周期修复）

- RED：broken 模式（同步包装 + floating backup() Promise + 提前 close + 提前发布）下 `OfflineBackupPrimitives.test.ts` **7 failed / 1 passed**，含新 pin 测试与 WAL parity 断言失败；6 个 unhandled rejection “The database connection is not open”（backup.js:33）。
- GREEN：聚焦套件 `OfflineBackupPrimitives + SecurityCutoverCoordinator` **2 files / 21 passed**；扩展聚焦（backup/cutover/enrollment/startup/manifest）8 files / **79 passed**。
- 全量 `npx vitest run --maxWorkers=1`：见下方最终结果（72+ files / 全绿）。
- `tsc -p server/tsconfig.json --noEmit` PASS；`git diff --check` 干净。
- 门：默认 `server/dnd.sqlite*`/`server/.dnd-ai-credential-key`/根 key hash 不变（`b0b74c55`/`0849cfbe`/`1b2c5181`/`63412f07`）；`server/.dnd-instance.lock` absent；staging 空；HEAD `641709e`；未 git add/commit/stash/reset/clean/checkout。

## Next seam（Task 5）
digest session service + cookie-only HTTP + auth contract/client 基础：
`server/src/modules/identity/sessionTokens.ts`（token/digest/csrf 生成）、`IdentityRepository/Service` 改 secure session（token_digest 落库，raw 仅经响应 cookie）、`__Host-dnd_session` cookie-only（移除 Bearer/sessionId）、contracts `sessionSchema` 仅 public `{expiresAt}`、harness HTTPS + cookie jar、negative 矩阵（Bearer /me 401 / login 响应无 raw / DB 无 raw）。

## Task 5：digest session service、cookie-only HTTP 与 authenticated CSRF recovery base

- 初始 exact RED command：`npx vitest run server/src/modules/identity/sessionTokens.test.ts server/src/modules/identity/identity.test.ts server/src/tests/authCampaignRoutes.test.ts server/src/tests/platform-composition.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1`。因 `sessionTokens.test.ts` 尚不存在，Vitest 只收集既有 4 files / 40 tests 并全绿；随后按 vertical TDD 新建最小 `sessionTokens.test.ts`，单测因 `./sessionTokens.js` 不存在明确 RED，再实现最小 token seam 转 GREEN。
- `sessionTokens.ts`：internal ID、raw session token、raw CSRF 各独立 32-byte random，canonical unpadded base64url；仅 SHA-256 lowercase hex digest 持久化/查询；clock/random 可注入。
- `IdentityRepository/IdentityService`：secure row 精确写 013 columns；`sessions.id` 为内部 opaque ID，legacy `expires_at` 与 `absolute_expires_at` 同值；absolute 7d / idle 12h；按 token digest resolve，拒绝 disabled/revision mismatch/revoked/absolute/idle/legacy-null rows，无 dual-read；current/logout-all revoke；CSRF conditional digest rotation（并发 exactly-one winner）。
- HTTP：只读 `__Host-dnd_session`，Bearer 完全忽略；login public JSON 仅 `{session:{expiresAt}}`；集中 exact set/clear 两 cookie（Secure/SameSite=Lax/Path=/、7d Max-Age、session HttpOnly、CSRF readable、无 Domain）；`/logout-all`；`/me` no-store missing-CSRF recovery；authenticated logout CSRF synchronizer revalidates current DB digest，旧 token 在 recovery 后立即 403。
- harness：ephemeral self-signed HTTPS + per-actor black-box cookie jar；未降低 Secure cookie contract。测试专用 undici dispatcher 信任 harness cert，不改 production TLS 行为。
- contracts/client：public session schema 移除 `sessionId` 并 strict；platform fetch 使用 `credentials:'include'`，mutation 从 readable CSRF cookie注入 header；无 localStorage/sessionStorage/Bearer。
- negative/contract tests：DB/body 无 raw；legacy row不能认证；disabled/revision/revoked/absolute/idle；Bearer `/me` 401；exact cookies/clear；CSRF recovery + old/new token；conditional concurrency；current logout。
- focused GREEN：5 files / 48 tests passed。wider HTTP affected：7 files / 29 tests passed。full `npx vitest run --maxWorkers=1`：74 files passed / 2 skipped，601 passed / 22 skipped / 0 failed（第一次 full run 出现既有 state-change-materializer nondeterministic ordering 单项失败，单项重跑和第二次 full run均通过；该测试/代码未由 Task 5 修改）。server/contracts/client typechecks PASS；`git diff --check` 无 whitespace error（仅 Windows LF→CRLF warnings）。
- 门：默认 DB/key hashes保持 `b0b74c55`/`0849cfbe`/`1b2c5181`/`63412f07`；root key absent；instance lock absent；staging empty。未开始 Task 6。

## Task 5 Independent Review Fix (REVISE checkpoint)

- Review verdict entering fix: **REVISE**. Original Task 5 historical process was not strict TDD and remains recorded as such; this fix does not fabricate or retroactively claim earlier RED evidence.
- Strict fix RED: `npx vitest run server/src/modules/identity/identity.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1` → **12 failed / 30 passed**. Failures covered missing transactional audit/rollback, epoch/revision authority, deterministic login-vs-logout-all race, and unified maintenance-aware invalid cleanup.
- Implemented Task 5-only fixes: transaction-time login authority re-read/recheck; atomic session create/current logout/logout-all/invalid cleanup with typed audit; `auth_revision` and affected `revoke_epoch` advancement; active/draining cleanup versus quiescent zero-write behavior; strict client session envelope; removal of freely materialized `TestActor.cookieHeader`; suite-scoped fixture-CA HTTPS adapter with restoration. Task 6/SSE authority was not started.
- Focused GREEN: **5 files / 65 passed**. Wider HTTP/realtime: **8 files / 32 passed**. Server/contracts/client typechecks PASS. Touched-scope diff check PASS.
- Full run: **617 passed / 22 skipped / 1 failed** (73 files passed / 2 skipped / 1 failed file). The sole failure is the pre-existing order-sensitive `state-change-materializer.test.ts`; isolated rerun PASS 10/10, second full run reproduced the same unrelated assertion.
- Safety: staging empty; lock/root key absent; default DB/WAL/SHM/key hashes unchanged (`b0b74c55…` / `0849cfbe…` / `1b2c5181…` / `63412f07…`).

## Task 5 Final Resolution Fix (remaining session-authority Major)

- Strict focused RED: service/HTTP/race tests added before production edits; `npx vitest run server/src/modules/identity/identity.test.ts server/src/tests/authCampaignRoutes.test.ts --maxWorkers=1` → **5 failed / 47 passed**. Three production failures proved quiescent valid resolve and both `/me` CSRF cases incorrectly refreshed idle fields. Two initial pausing-wrapper failures were corrected as test-only naming defects before production changes.
- Authoritative resolve: valid/invalid/unknown handling now linearizes in one `DatabasePort.transaction`; active/draining refresh is authority-conditional and returns unauthenticated if it loses; quiescent valid returns with zero session/audit writes. Invalid cleanup/audit stays in the same transaction without nesting.
- `resolveSessionForCsrf` now uses side-effect-free `readCommitted`. Test-only pausing DatabasePort covers logout-current and logout-all serialization plus CSRF read serialization; no production timing hook.
- HTTP quiescent `/me`: existing CSRF is zero-write; missing CSRF changes only `csrf_digest`; no-store/conditional recovery unchanged.
- Unrelated order test diagnosed: tight-loop ISO timestamps tie, and `ORDER BY created_at` has no tie ordering/product insertion-order contract. Pre-fix isolated loop failed **4/30**; assertion changed to stable title-keyed lookup; post-fix loop passed **30/30**. No production ordering change.
- Final GREEN: focused **5 files / 73 passed**; wider HTTP/realtime **8 files / 34 passed**; full **74 files passed / 2 skipped, 626 passed / 22 skipped / 0 failed**. Server/contracts/client typechecks and touched-scope diff check PASS.
- Safety: staging empty; default DB/WAL/SHM/key hashes unchanged (`b0b74c55…` / `0849cfbe…` / `1b2c5181…` / `63412f07…`); root key/instance locks absent. Task 6 not started. Detailed handoff in `phase2-task5-final-resolution-fix.md`; independent review required.

## Final platform-composition HTTPS/cookie-jar boundary fix

Independent acceptance found the remaining Task 5 Major in `platform-composition.test.ts`: its local helper still used plain HTTP and replayed a regex-extracted raw session cookie. This narrow test-only pass removed that helper and converted only the HTTP tests to `startTestPlatformServer` + `registerAndLogin`/`TestCookieJar`, with suite-scoped `installHarnessFetch()` restoration. The first two pure `createPlatformApp` composition tests remain direct and unchanged in purpose. No production behavior changed; Task 6 was not started.

- Strict RED: focused boundary assertion first; `npx vitest run server/src/tests/platform-composition.test.ts --maxWorkers=1` → **1 file; 1 failed / 9 passed**. The focused test observed `http://127.0.0.1:57272` and raw `__Host-dnd_session=...` instead of HTTPS plus an opaque cookie-jar actor.
- GREEN: platform composition → **1 file / 10 passed**.
- Final focused Task 5 five-file command → **5 files / 74 passed**.
- Full suite → **74 files passed / 2 skipped; 627 passed / 22 skipped / 0 failed**.
- Server/contracts/client typechecks PASS; forbidden boundary scan and touched-file no-index diff check PASS.
- Safety: staging empty; default DB/WAL/SHM/key hashes unchanged; root key and instance locks absent; HEAD `641709e`.
- Detailed handoff: `docs/superpowers/validation/phase2-task5-platform-composition-fix.md`.
- Final fresh-context reviewer `aeb89548`: **PASS / 0 Blocker / 0 Major / 0 Minor**. It confirmed the HTTPS/pinned-CA/scoped-fetch/`TestCookieJar` boundary and rechecked that revision/epoch/audit/quiescent semantics remained intact.
- Task 5 is accepted complete. Next seam: Task 6 `SessionAuthority`, SSE epoch revoke, commit notifications, and multi-device flows.

## Task 6：SessionAuthority、SSE epoch revoke 与 multi-device flows

- Required pre-edit baseline was honestly GREEN: exact approved command → **4 files / 28 passed**.
- Strict RED→GREEN began with a structural/import RED at the public `SessionAuthority` seam (missing module RED → 1/1 GREEN), then a deterministic event-stream checker race behavioral RED timed out because pre-fix production never revalidated (1 failed / 12 passed) → GREEN after before-batch and per-frame checks. Client generation regressions were added at the existing `RealtimeSession` seam.
- Added side-effect-free authoritative `SessionAuthority`; SSE request binding/final pre-header check; before-batch and immediately-before-frame revalidation; runtime `revokeSession`/`revokeUser`/`closeAllForMaintenance` with close/drop-before-response-destroy ordering; preserved `closeViewer`.
- Identity notifications occur only after successful transaction commit. Current logout closes one internal session; logout-all closes the user; active/draining invalid cleanup closes that session; audit rollback and quiescent cleanup remain silent.
- HTTPS cookie-jar tests prove current-vs-all two-device stream closure and reconnect 401 without exposing raw cookie values outside jar operations. Client generation pin prevents stale source/campaign callbacks from advancing the current watermark, preview state, or reconnect timer.
- Final focused Task 6: **7 files / 98 passed**. Wider affected auth/composition/HTTP: **7 files / 38 passed**. Full suite: **75 files passed / 2 skipped; 639 passed / 22 skipped / 0 failed**. Server/contracts/client typechecks PASS; diff-check PASS (line-ending warnings only).
- Safety: staging empty; default DB/WAL/SHM/key hashes unchanged (`b0b74c55…` / `0849cfbe…` / `1b2c5181…` / `63412f07…`); root key and instance locks absent. Task 7+ not started. Detailed ledger: `phase2-task6-ledger.md`. Independent review required; no review PASS claim.

## Task 6 Independent Review Fix

- Review verdict entering fix: **REVISE / 0 Blocker / accepted Majors**. No Task 7+ code or admin revoke/disable API was added.
- Pre-header binding now registers provisionally before the final authority await. A commit notification during that await tombstones the request; the route requires both a current authority result and a non-invalidated registration before synchronously flushing SSE headers. Pre-header destroy never destroys the response, allowing the error middleware to emit 401.
- Deterministic real-commit HTTPS tests prove: logout-current committed during final authority await yields 401/non-SSE; logout committed during a paused per-frame check sends zero replay frames and reconnect returns 401.
- Durable revocation outcomes are isolated from notifier failure. `IdentityService` swallows post-commit notifier exceptions; runtime invalidation removes all matches first and isolates every close/destroy callback, still attempting all clients. Cookie deletion and logout counts remain correct.
- HTTPS harness now pins the fixture CA with `rejectUnauthorized:true`; a wrong-CA negative test rejects despite the machine `NODE_TLS_REJECT_UNAUTHORIZED=0` setting. Common login helper no longer peeks at the raw session cookie.
- Coverage completed for exactly-once expiry cleanup notification, rollback/quiescent notification silence, abort-only SSE helper suppression, live SSE shutdown, c1→c2→c1 watermarks, and backoff progression/cap.
- Strict review-fix RED evidence: real final-check/logout race returned **200 instead of 401**; notifier unit rejected with `forced notifier failure`; notifier HTTP logout returned **500 instead of 200**. These became GREEN after minimal production fixes. Original Task 6 is still not represented as wholly strict TDD.
- Final focused: **8 files / 106 passed**. Wider auth/composition/startup/HTTP: **8 files / 50 passed**. Full suite: **76 passed files / 2 skipped; 647 passed / 22 skipped / 0 failed**. Server/contracts/client typechecks PASS; `git diff --check` PASS except line-ending warnings.
- Safety: staging empty; default DB/WAL/SHM/key hashes exactly unchanged; server/root locks and root credential key absent. Detailed review-fix artifact: `phase2-task6-review-fixes.md`. Independent re-review found remaining test-evidence Majors; see the final test-hardening section below.

## Task 6 Final Test Hardening

- Final re-review production verdict: SSE authority/revocation linearization was correct, but validation remained REVISE because the TLS negative test used a separate dispatcher and malformed PEM, abort cleanup could pass before SSE readiness, and race/shutdown waits could hang on regressions.
- TLS hardening uses a checked-in well-formed unrelated self-signed test certificate/key and an isolated child process with `NODE_TLS_REJECT_UNAUTHORIZED=0`. Both the trusted fixture and untrusted server are requested through the actual shared `testFetch` dispatcher. Removing `rejectUnauthorized:true` from the shared agent produced a real RED (the untrusted request was accepted); restoring it returned GREEN.
- `readSseFrames` exposes a readiness latch only after 200 + `text/event-stream` + cache headers are verified. Timeout paths abort and await request cleanup. Client-abort coverage now opens a live SSE, awaits readiness, aborts, awaits closure, then confirms the server remains usable.
- Added bounded diagnostics for final-authority phase, per-frame phase, response closure, heartbeat reads, shutdown reads, live-frame delivery and abort cleanup. Finally blocks release barriers, abort stream controllers and close ephemeral servers. The ordinal checker is isolated and named as the prepared replay frame phase, with an explicit phase assertion.
- `EventStreamRuntime.registerClient` is now required and called directly because provisional pre-header registration is a Task 6 security invariant.
- Client tests restore all mocks after each test. Invalid-session cleanup resolves the same invalid token twice and proves the notification/audit remains exactly once.
- Documentation now calls the missing `SessionAuthority` module result a structural/import RED, not a behavioral RED. Original Task 6 is still not claimed as wholly strict TDD.
- Final validation counts and safety gates are recorded in the present canonical repository file `docs/superpowers/validation/phase2-task6-final-test-hardening.md`.
- A subsequent operability review found that tracked-stream closure could still swallow arbitrary failures, some cleanup paths remained incompletely bounded, and the canonical file was absent. The final bounded operability pass added settled outcomes with explicit server-close arming, unexpected-error propagation, controller-aborting read deadlines, bounded shutdown/response cleanup, and restored the canonical evidence file.
- The last active Minor—initial tracked-SSE response timeout not aborting its controller—was closed by retaining the fetch promise, aborting on timeout/error, and boundedly observing its settled outcome before rethrowing the original failure. Targeted closeout review `44f790e6`: **PASS / 0 Blocker / 0 Major / 0 Minor**.
- Final aggregate independent acceptance: **PASS / 0 Blocker / 0 Major / 1 dispositioned Minor**. The dispositioned Minor is the bounded, named third-authority-check phase coupling in the replay race test. Task 6 is accepted complete; next seam is Task 7 HTTP front door security policy.

## Task 7：HTTP front-door origin/TLS/proxy/CORS/headers/body/error（independently accepted）

- Required focused RED command was first run against the current worktree before adding the missing matrix: existing config/composition tests passed (16 tests); `http-security-negative-matrix.test.ts` was absent, so no behavioral RED was claimed for that file.
- Added `server/src/tests/http-security-negative-matrix.test.ts` covering strict origin/CIDR/dev-origin/bootstrap parsing, direct/trusted/untrusted TLS forwarding, exact origin/CORS, fixed headers/HSTS, auth-before-parser, 413/validation envelopes, SSE pre-header behavior, and error-map completeness.
- Concrete RED evidence after initial test addition: 26 tests / 2 failures: partial bootstrap was accepted by the old parser; the plain HTTP test initially incorrectly expected a response although TLS correctly closed the connection. Both were corrected minimally (bootstrap validation; test now asserts no HTTP fallback).
- GREEN focused: `npx vitest run server/src/tests/config.test.ts server/src/tests/http-security-negative-matrix.test.ts server/src/tests/platform-composition.test.ts --maxWorkers=1` → 3 files / 42 passed.
- Composition now requires explicit validated `securityConfig`; all current callers pass policy, including HTTPS harness and Phase4 fixture (test-only pinned local TLS). No permissive production-call fallback remains.
- Body parsers remain route-local; campaign membership and explicit owner checks now run before parsers on owner-only character/world/archive/combat/rules/AI writes. Existing malformed unauthenticated rules expectation was updated from 400 to 401 auth-before-parser.
- Wider focused GREEN: security matrix + auth + AI + rules + realtime/SSE suites → 6 files / 65 passed. Server typecheck passed. Full contracts/client typechecks, startup suites, safety hashes, and full suite remain required before independent acceptance. Task 7 is not independently accepted.

## Task 7 final review fix
- Narrow front-door correction: `/api/auth` no-store is installed before security policy, invariant headers no longer resolve request state, and one policy middleware owns resolve/HSTS/CORS/enforcement. Direct TLS rejection retains HSTS; authoritative trusted-forwarded HTTP does not.
- Evidence: `server/src/tests/http-security-negative-matrix.test.ts` covers front-door auth rejection, malformed forwarding, isolated forwarded HTTP, normalized lowercase `forwarded`, direct IPv4/IPv6 validation, exact CORS, auth 404/parser failures, duplicate-resolve prevention, wrong-role authorization-before-parser, and allowed-role AI/Provider budgets with no Provider network call.
- Final current-tree validation after the first narrow pass: matrix **49 passed**; focused **3 files / 65 passed**; affected **7 files / 100 passed**; full suite **77 files passed / 2 skipped, 697 passed / 22 skipped**; server/contracts/client typechecks and diff/safety/hash gates passed.
- The next fresh workflow returned REVISE for premature rejected-response CORS, trusted mixed `Forwarded`/`X-Forwarded-*` ambiguity, and absent 64/256 KiB runtime evidence. A new valid RED produced **2 failed / 47 passed** before production edits. Minimum GREEN now rejects any trusted standardized `Forwarded`, emits CORS only after complete front-door acceptance, proves no CORS on rejection, and proves character 256 KiB plus world/turn/archive/combat/rules 64 KiB allowed-role 413 behavior. Post-fix matrix/focused/affected/full counts returned to **49 / 65 / 100 / 697** with all safety gates green.
- Process note: the earlier final writer edited tests before production but did not execute the new tests in between, so no RED is claimed for that preceding no-store/HSTS/single-resolve pass. This historical chronology gap remains explicit; the new CORS/forwarding changes have independent RED→GREEN evidence.
- Final fresh read-only closeout mission `72f04257-1fd1-4106-9815-ad1de1481a95` returned unanimous PASS from security run `0a5e6a89` and authorization/budget/process run `74da2939`: **0 Blocker / 0 Major / 0 active Minor / 1 dispositioned process Minor**. Reviewers classified the historical chronology gap as non-blocking and confirmed no remaining implementation/evidence defect.
- Task 7 is independently accepted complete. Task 8 may begin, but Task 8/9 work was not started by this closeout; Task 9 parser inventory remains intentionally deferred.
