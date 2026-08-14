# DND AI-DM 权威总路线图审查

> **历史问题清单 / 非执行权威（2026-08-12 后续决策）：** 本报告审查的是已被取代的 2026-08-02 路线图。关于 legacy adapter、PostgreSQL 发布门和保留 Owner 世界/战斗 HTTP 写面的建议，已被 [`2026-08-12-dnd-ai-dm-v1-decisions.md`](../specs/2026-08-12-dnd-ai-dm-v1-decisions.md) 与 [`2026-08-12-dnd-ai-dm-v1-hardening-cutover.md`](../plans/2026-08-12-dnd-ai-dm-v1-hardening-cutover.md) 取代。当前计划批准结论见 [`2026-08-12-v1-hardening-cutover-plan-review.md`](./2026-08-12-v1-hardening-cutover-plan-review.md)。本文仅用于追溯问题来源，不得作为未来实施计划。

审查日期：2026-08-12  
审查对象：`docs/superpowers/plans/2026-08-02-dnd-ai-dm-rearchitecture-revised.md`  
审查方式：只读核对路线图、相关详细计划、当前 contracts、服务端组合根、legacy 路由、前端工作区与测试配置；本次审查未运行测试或构建。

## 结论

该文档仍可作为 Phase 1-5 的历史路线图和计划索引，但当前不能直接作为 Phase 5 后半段的实施计划。

建议状态：

- Phase 1-4：历史完成状态可保留，但需要吸收后续产品修正并区分历史基线与当前状态。
- Phase 5 Provider 与规则来源：新平台切片已完成，但完成声明必须限定在新平台 campaign-scoped 路径，不能覆盖仍在运行的 legacy 路径。
- Phase 5 legacy adapter：`NOT READY`，必须先形成独立详细计划并通过计划审查。
- Phase 5 cutover：`NOT READY`，缺少数据对账、兼容窗口和回滚 runbook。

## Blocker

### B1. Legacy adapter 缺少实施所需的身份、范围与映射决策

路线图的 Legacy adapter 目前只规定：

- 旧数据只读映射到新 contract；
- 新写入一律走新模块仓储；
- 不删除旧表；
- `legacyToken` 等敏感字段不进入 DTO。

这些约束方向正确，但不足以开始编码。当前缺少：

1. 纳入适配的 legacy 表清单；
2. `rooms` 到 `campaigns` 的映射；
3. legacy `players.id/token` 到平台 `users.id` 的身份认领机制；
4. legacy room Owner 的确定方式；
5. 源表到目标 contract/DTO/新端点的映射矩阵；
6. 角色、回合、日志、战斗等状态枚举转换表；
7. 可见性与私密字段转换策略；
8. 缺失新 contract 必填字段时的处理方式；
9. legacy/platform 数据并存和 ID 冲突优先级；
10. 对只读 legacy 资源执行更新、提交、结算或恢复时的确定语义。

身份模型是当前最大阻塞：legacy 玩家通过 `players.token` 访问，新平台通过登录会话和 `campaign_members(campaign_id, user_id)` 建立 campaign context。相关证据见：

- `server/src/db/schema.ts`
- `server/src/routes/playerRoutes.ts`
- `server/src/modules/campaigns/CampaignAccess.ts`
- `packages/contracts/src/campaign.ts`

**要求：**实施前新增独立 legacy adapter 详细计划，至少包含身份认领模型、范围矩阵、状态转换、可见性、ID 稳定性、只读写入语义、异常数据策略和验收测试。

### B2. Cutover 缺少数据对账和可恢复发布方案

当前 cutover 只要求搜索旧引用、删除旧入口、更新 README 和运行基础门禁，未定义：

- 数据库、凭证密钥和配置备份；
- 备份校验和恢复演练；
- legacy/platform 行数、实体数、关联和可见性对账；
- feature flag、kill switch 或新旧读路径兼容窗口；
- 停止发布与回滚触发条件；
- 回滚后旧版本能否读取 cutover 后新写入；
- schema 前后版本兼容性；
- 备份保留期限和销毁审批。

保留旧表不等于具备回滚能力。新写入进入平台表后，旧版本不一定能够继续读取。

**要求：**将 cutover 拆成独立发布 runbook，明确选择“完整回滚”“只切回读路径”或“只能 forward-fix”中的一种，并给出对应恢复验证。

### B3. Provider 加密和规则 metadata-only 的完成声明范围过宽

新平台路径满足目标：

- `platform_ai_provider_configs` 使用加密凭证；
- 新 Provider DTO 不回显 API Key；
- `platform_rule_sources` 只保存元数据。

但 legacy 路由仍由 `server/src/app.ts` 挂载：

- `/api/admin` 的 Provider 配置仍接收和返回 `apiKey`；
- `global_config.ai_provider_config_json` 仍保存完整 Provider JSON；
- legacy Provider 默认配置仍支持 `mock`；
- legacy 规则入口仍接收任意 `content`，保存到 `rule_sources.content_json` 并通过列表接口返回正文。

证据：

- `server/src/app.ts`
- `server/src/routes/adminConfigRoutes.ts`
- `server/src/services/globalConfigService.ts`
- `server/src/services/aiProvider.ts`
- `server/src/routes/adminRoutes.ts`
- `server/src/services/rulesService.ts`

**要求：**路线图必须把完成声明限定为“新平台 campaign-scoped 路径”。Legacy Provider 明文配置和 legacy 规则正文入口必须成为 legacy/cutover 的显式阻塞项。

## Major

### M1. 路线图混合历史基线与当前状态

路线图仍将 Phase 1 快照描述为“当前 HEAD”“工作树干净”“453 tests”“构建只含迁移 001-003”，并继续把 Node `22.12.0`、`engines >=22.12.0 <23` 写成当前技术栈。

当前仓库实际为：

- `.nvmrc`：`24.11.1`
- 根 `package.json` engines：`>=24.11.1 <25`
- 平台迁移已到 `011_rule_sources.sql`

**建议：**把该章节重命名为“Phase 2 启动时的历史基线”，删除“当前”措辞；另建简短的 Phase 5 当前状态区。动态测试数字应绑定日期和 tree/commit，或链接 validation 文档。

### M2. 发布检查没有运行真实浏览器 E2E

根项目的真实浏览器入口是：

`npm run test:phase4-browser`

而 `vitest.config.ts` 明确将 `client/src/tests/phase4-browser-flow.test.ts` 排除在普通 `npm test` 外。因此仅执行路线图列出的 `npm test/typecheck/build/status`，可以在没有浏览器验收的情况下通过发布门。

**建议：**发布门显式加入真实浏览器脚本；最好新增语义清晰的 `test:phase5-e2e` 别名，并说明 Phase 5 checklist 指 legacy/cutover 完成后的最终重跑。

### M3. 已接受的 Provider URL 信任边界没有进入权威路线图

当前产品策略已经明确：

- Owner 可配置任意 HTTP(S) 目标；
- loopback、LAN、保留地址及代理 fake-IP 均允许；
- 禁止 URL credentials；
- Provider transport 不跟随重定向；
- 部署方必须把 Owner 视为受信任管理员。

该策略已记录在 `docs/superpowers/plans/2026-08-10-dnd-ai-dm-webui-provider-config.md`，但总路线图没有同步。

**建议：**将此信任边界加入总路线图硬约束，避免后续维护者无故恢复公网 IP 限制。另需明确环境变量 Provider 与 WebUI Provider 是否共享同一 URL shape policy；当前 env factory 未拒绝 URL credentials。

### M4. 后续 AI-managed 产品修正没有回写总路线图

Phase 4 历史描述仍把“完整 Owner 战斗命令”列为完成项；后续产品修正已经将普通 Owner 世界/战斗页面改为只读监督，由 AI-DM 创建世界事实并发起遭遇。

当前权威行为见：

- `docs/superpowers/plans/2026-08-09-dnd-ai-dm-ai-world-encounter-creation.md`
- `client/src/features/owner/world/OwnerWorldPage.tsx`
- `client/src/features/owner/combat/OwnerCombatPage.tsx`

**建议：**将原决定标记为历史记录，并明确当前普通 Owner UI 只读；服务端 mutation 仅作为授权的进阶或兜底能力保留。

### M5. PostgreSQL 真实测试不是发布强制门

PostgreSQL 是正式技术栈，但在没有 `POSTGRES_TEST_URL` 时 contract tests 可以跳过，且路线图仍可把发布门描述为全绿。

**建议：**本地开发允许 skip，但 release job 必须提供真实 PostgreSQL，至少覆盖 001-011 全迁移、迁移原子性、outbox/archive sequence、archive restore、Provider/Rules 表和关键 repository transaction。

### M6. 迁移索引与 schema 摘要发生漂移

路线图总表已列出 011，但末尾连续性自检仍只到 010；下一迁移编号没有明确为 012。

此外：

- `007_archives.sql` 不仅创建 `platform_archives`，还包含 sequence 表和 superseded 相关变更；
- `008_ai_runtime.sql` 不仅包含 `platform_ai_runs` 和 `platform_turn_entries`，还包含 sequence 和 interaction request 表。

**建议：**修正连续性自检并补全 schema 摘要，避免 cutover 对账漏表。

### M7. Phase 3 战斗命令名称与 contract 不一致

路线图写作 `start`，当前 contract 是 `start_encounter`：

- `packages/contracts/src/combat.ts`

**建议：**修正文档，并区分既有白名单命令和 AI 新增的 `encounterStarts` 创建字段。

### M8. Phase 5 详细计划治理状态已经过时

路线图仍使用“Phase 4 完成后才编写 Phase 5 详细计划”的未来式，但 Provider 和 Rules 两个 Phase 5 切片已经编写并实施。

**建议：**改为切片状态表，分别标记 Provider、Rules、Legacy、E2E/Cutover 的计划、实现、review 状态。

## Minor

### m1. Phase 5 高层状态遗漏剩余工作

阶段总览只写 legacy adapter 与 cutover 待续，但 checklist 还包括最终多上下文 E2E、发布检查和两级 review。

### m2. 错误码“基线”和“当前集合”表达不清

历史基线是 13 个错误码，Phase 5 又新增 3 个。建议明确区分历史基线与当前集合，并逐项列出 HTTP 状态映射，不要用单个尾随的“422”造成歧义。

### m3. “计划自检”中的唯一详细计划表述已过时

文档仍声称阶段一详细计划是唯一包含实现代码的文档，但 Phase 2-5 已存在多个详细实施计划，应删除或改为历史说明。

### m4. 发布检查 checkbox 语义不够二值

“检查通过”和“记录遗留失败”应拆开。若存在未豁免失败，发布门必须保持未完成；如允许豁免，应写明审批、期限和风险接受标准。

## Legacy 详细计划的最低验收要求

后续 legacy adapter 计划至少应包含以下验收面：

1. **范围矩阵：**逐表说明纳入、延后、不适配或仅 owner-only。
2. **身份鉴权：**Owner、playerA、playerB 的认领和跨战役隔离。
3. **Contract 有效性：**每个输出必须通过对应 Zod schema。
4. **字段 allowlist：**禁止直接展开 legacy row 或原样透传 raw JSON。
5. **敏感字段负面测试：**token、API Key、private notes、owner prompt/debug、隐藏骰子等递归不存在。
6. **只读不变量：**所有 legacy GET 前后旧表不变化；写命令返回确定错误或创建明确的平台 shadow，不得静默写回旧表。
7. **并存与冲突：**仅 legacy、仅 platform、两者并存、ID 冲突、重复来源、稳定排序和稳定公共 ID。
8. **异常数据：**malformed JSON、孤儿关联、未知状态和缺失字段的确定处理策略。
9. **Seam：**legacy SQL 仅存在于专用 read adapter/repository；router 不导入旧领域状态；service 继续负责授权和可见性；写模块不依赖 legacy adapter。
10. **后端范围：**明确 legacy adapter 是 SQLite-only、独立 legacy source，还是同时支持 PostgreSQL。

## 保留的正确架构约束

以下方向在本次审查中仍成立，应继续保留：

- 新平台表使用 `platform_` 前缀；
- 新写入只进入新模块；
- legacy 表不直接删除；
- campaign-scoped 权限在服务端执行；
- 非成员隐藏战役存在性；
- 可见性投影由领域服务集中执行；
- AI formal apply 保持事务性和幂等；
- 新平台 Provider 使用 AES-256-GCM，Key 不进入 DTO、日志和 AI run；
- 新平台规则来源保持不可变和 metadata-only；
- 三隔离浏览器 context 作为隐私验收方式；
- SSE live/replay 使用同一投影；
- 新平台 `createApp()` 默认 AI Provider 保持 `UnavailableAiProvider`。

## 推荐修订顺序

1. 修正路线图中的当前状态、Node 版本、迁移索引和命令名称。
2. 限定 Provider/Rules 完成声明的作用域，并列出 legacy 绕行路径。
3. 将已接受的 Provider URL 信任边界和 AI-managed Owner UI 修正写入总路线图。
4. 编写并审查 legacy adapter 独立详细计划。
5. 编写 cutover 发布与恢复 runbook。
6. 执行包括真实浏览器和真实 PostgreSQL 在内的最终发布门。
