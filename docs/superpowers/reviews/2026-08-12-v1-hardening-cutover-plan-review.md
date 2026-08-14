# DND AI-DM v1 平台硬化与 Cutover 计划审查

审查日期：2026-08-12  
审查对象：

- [`2026-08-12-dnd-ai-dm-v1-decisions.md`](../specs/2026-08-12-dnd-ai-dm-v1-decisions.md)
- [`2026-08-12-dnd-ai-dm-v1-hardening-cutover.md`](../plans/2026-08-12-dnd-ai-dm-v1-hardening-cutover.md)
- [`2026-08-02-dnd-ai-dm-rearchitecture-revised.md`](../plans/2026-08-02-dnd-ai-dm-rearchitecture-revised.md) 的 superseded 状态
- 两份 2026-08-12 历史问题审查的非执行权威状态

审查方式：多轮独立只读计划级审查，重点核对阶段依赖、迁移连续性、fresh/existing SQLite 升级、不可逆操作、安全边界、AI/Archive 并发语义、生产验收和旧文档误执行风险。本审查只批准计划，不代表 Phase 1-9 业务代码已经实现或 v1 已可发布。

## 最终结论

> **PASS / 0 Blocker / 0 Major**

当前决策与路线图已经足以进入 **Phase 1 详细实施计划**。Phase 0 可标记完成。

当前代码仍存在 legacy runtime、Owner 世界/战斗 HTTP 写面和 dev-proxy 浏览器验证等既有发布阻断项；它们分别是 Phase 1、Phase 3 和 Phase 7-8 的明确实施目标，不是本计划审查的遗漏，也不得被表述为已经修复。

## 已闭合的计划级问题

### 1. 权威来源与 legacy 范围

- 2026-08-12 v1 决策是产品和架构最高约束来源。
- 2026-08-12 v1 路线图是唯一未来执行路线图。
- 2026-08-02 路线图已标记 `DO_NOT_EXECUTE / SUPERSEDED`，未完成 checkbox 已取消或转交。
- Legacy adapter、旧数据迁移、双读和 shadow mapping 已取消。
- Legacy runtime 先删除，旧表只在最终 maintenance cutover 中由显式 CLI 删除。
- PostgreSQL 仅保留实验 lane，不进入 SQLite v1 production factory 或发布门。

### 2. 阶段依赖与迁移

- InstanceLock 和 migration artifact 校验在 012 前建立。
- 012 建立 platform instance、enrollment、bootstrap、maintenance、global rules revision、key fingerprint 和 session cutover metadata。
- 013 只增加 digest session 与账号安全字段，不隐式删除旧 session。
- 014 建立 strict allowlisted append-only 安全审计。
- 015 建立 campaign state revision。
- 016 建立 AI interruption/recovery 与 claimed revisions。
- v1 冻结迁移集合为 001-016；017 未分配。
- Backup/rehearsal/drop plan 使用外部不可变 artifact，不创建 017 运维元数据表。

### 3. 平台初始化、bootstrap 与 credential key

- 普通 server 不会因生产数据库缺失而自动创建空库或开放 bootstrap。
- Fresh 与 existing database 都使用显式 enrollment CLI。
- Enrollment 采用 `initializing -> key publish -> ready` 可恢复两阶段状态。
- Existing Provider ciphertext 必须在绑定 fingerprint 前用候选 key 全量离线解密。
- Bootstrap 默认关闭，secret 使用 canonical 32-byte base64url contract，并与预期 database ID 绑定。
- 数据库级约束保证 bootstrap 和唯一平台管理员只能成功一次。
- 唯一管理员离线密码恢复撤销其全部 session，不能创建第二个管理员。

### 4. Session、CSRF 与 SSE

- Cookie-only、digest-only，不返回 session bearer token。
- Existing database 通过 Phase 2 自有 `OfflineBackupPrimitives` 和冻结的 012-014 allowlist 完成一次性 security cutover。
- 旧 session 在 014 可审计后原子失效，再执行 checkpoint/离线清理和旧 token 验证。
- Cookie、Origin、pre-auth/authenticated CSRF、body budget、CORS 和 rate limit 均有确定 contract。
- Session revoke 提交后推进 epoch、关闭 SSE、丢弃未发送 replay/live 队列；重连重新查询权威状态。

### 5. Campaign、AI、Rules 与 Provider revision

- Campaign mutation source 覆盖 Owner/player、AI formal apply、archive capture/restore、Campaign Rules、Campaign Provider 和 recovery。
- Platform Rules 使用独立 global revision。
- AI claim 同时保存 campaign revision 与 Platform Rules revision；formal apply 在任何正式写入前比较。
- Provider transport 每个 attempt 最多一次请求，不自动重试；Owner 使用新 attempt 手动 retry。
- AI 中断由启动恢复处理；v1 不提供运行中 Provider 请求的 Owner 强制终止命令。

### 6. Archive 与领域命令

- Archive 只恢复 gameplay state，不恢复成员、Provider、Rules、账号、session、审计或运维状态。
- Superseded archive 不可恢复。
- 所有嵌套 campaign/member/reference 在写入前验证，恢复写入使用目标 campaign ID。
- 既有安全审计不更新或删除，只允许追加一个 strict restore success/failure 事件。
- Owner 世界/战斗 HTTP 写面将在 Phase 3 删除；AI 继续通过内部 command ports 写入。
- 战斗 RNG 和正式 dice entries 由服务端结果权威生成。

### 7. Maintenance、备份与不可逆 drop

- Maintenance 由持锁 server 内管理 API/UI 执行 `active -> draining -> quiescent`。
- 离线 CLI 不执行 maintenance-on/off，避免与 InstanceLock 循环依赖。
- `quiescent` 只允许固定 operational writes；业务 mutation、AI claim 和 SSE 均关闭。
- Backup 使用 SQLite-safe 快照、DB/key/manifest 同单元、同文件系统临时目录和原子发布。
- Restore rehearsal 使用实际备份副本，验证 integrity/FK/schema/startup 和全部 Provider ciphertext 解密。
- Drop dry-run 生成 immutable plan；实际 drop 只接受该 plan，并绑定 database ID、migration/schema、精确表、DDL、行数和依赖。
- 014 append-only 审计新增行不会让 drop plan 自我失效，其它绑定状态变化会拒绝执行。

### 8. 生产验收

- Express 同源托管真实 `client/dist`，具有确定 TLS/proxy/header/static fallback contract。
- Phase 8 完整 Chromium E2E 使用生产构建和磁盘临时 SQLite，不使用 Vite proxy。
- 发布脚本由 Phase 7-8 创建；现有 `test:phase4-browser` 不得替代最终证据。
- Phase 9 生产数据库只运行非破坏 canary；写入型 E2E 只在临时数据库或 post-drop 备份隔离副本运行。

## 非阻断后续要求

这些项目不阻断 Phase 0，但对应详细计划必须冻结：

1. Phase 2 明确普通用户自助修改密码是否属于 v1；若提供，必须轮换 session 并递增 auth revision。
2. Phase 7 固定外部 artifact 根目录、ACL、保留期、中断目录清理和经审批销毁流程。
3. 每个 Phase 的详细计划必须列出精确文件、先失败的测试、实现步骤、命令、失败原因和二值验收门。
4. 本审查不批准直接修改业务代码；下一步先编写并审查 Phase 1 详细实施计划。

## Phase 0 判定

- 决策文档与新路线图：通过。
- 旧路线图 superseded 防误执行：通过。
- 历史 reviews 非执行权威标识：通过。
- 迁移、阶段依赖与不可逆操作：通过。
- 独立计划级审查：`PASS / 0 Blocker / 0 Major`。

> **PHASE 0 COMPLETE — READY TO PLAN PHASE 1**
