# DND AI-DM 平台重构：总路线图与计划索引

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已完成的 Task 1-3 基线上，分五个阶段重建账号/战役之外的完整能力：角色、世界、回合与行动、事务性 outbox、存档、AI 运行时、SSE 实时、结构化战斗、前端工作区、规则/Provider 与旧数据迁移，最终交付一条端到端可恢复的多人 AI-DM 垂直流程。本文件是**权威总路线图与计划索引**，只描述阶段边界、依赖、验收门与硬约束，不再承载逐任务伪代码。

**Architecture:** 本总路线图取代 `docs/superpowers/plans/2026-08-01-dnd-ai-dm-rearchitecture.md` 自 Task 4 起的全部执行内容；Task 1-3 视为已完成基线，不重做、不回滚。实现顺序遵循“先服务端可运行垂直切片，再实时与战斗，最后前端”的铁律：每个阶段结束时都有一条可运行的垂直流程作为验收门。所有新平台表统一 `platform_` 前缀，迁移编号连续；AI 只消费经可见性投影的上下文，SSE 只发布经投影的领域事件；前端在服务端 AI 垂直流程通过后才开始。

**Tech Stack:** Node.js 22.12.0（阶段一已写入 `.nvmrc` 并约束 `engines.node >=22.12.0 <23`）、TypeScript、Express、React、Vite、SQLite（`better-sqlite3`，阶段一已固定 12.10.0）、PostgreSQL（`pg`）、Zod、React Query、SSE、Vitest、Testing Library、Playwright、jsdom（阶段一已固定 28.1.0）。

---

## 取代声明

- 本总路线图**取代** `2026-08-01-dnd-ai-dm-rearchitecture.md` 自 **Task 4 起**的全部内容。原 Task 4-14 不再作为执行来源，仅作历史参考（复审依据见 `docs/superpowers/reviews/2026-08-02-plan-and-baseline-review.md`）。
- **Task 1-3 视为已完成基线**，不重做、不回滚，对应提交：
  - `5fa0606` 共享 contracts（含独立 dist build）
  - `e886580` 数据库端口与 001/002 迁移
  - `ef2c1e3` Identity / Campaign / 成员权限
- 先前 4081 行修订版草稿（Task A-P 伪代码）不再作为执行来源；其任务范围被重新划分到 Phase 1-5，其中阶段一已重写为可执行的详细计划（见下文）。

## 执行前约束

- 不 `git stash pop` 任何归档 stash；不恢复、不删除 `archive/pre-refactor/*` 归档 tag。
- 不使用 `git add .`；每次只暂存任务列出的具体路径。
- 不修改、不删除 `server/dnd.sqlite` 及其它运行数据（日志、规则资料等），除非某个迁移任务明确创建备份并通过测试。
- 不复制 SillyTavern、agnai、Dungeoneer、Fari 或其他 GPL/AGPL 项目的代码和素材；只实现设计文档中的独立方案。
- 规则内容在获得明确许可证和署名信息前，只实现来源/版本/许可证元数据和导入边界，不把第三方完整规则文本写入仓库。
- 所有外部 CLI 命令使用 `rtk` 前缀。
- 每个任务完成后运行该任务列出的测试并提交一个只包含该任务文件的 commit；commit trailer 一律为 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 为任务临时创建的验证脚本/测试数据不得提交；确需保留的写入 `.gitignore`（窄范围条目）。

## 基线（2026-08-02 实测；Phase 1 完成后，所有后续阶段的起点）

### 版本与提交基线

- 当前 HEAD：`6e11c7a`（`test: verify character HTTP vertical flow with three actors`）；分支 `main` 相对 `origin/codex/upload-initial-code` 领先 30 个提交。
- 工作树干净；阶段一已由最终审查判定 READY_FOR_PHASE_2（见 [`2026-08-02-phase-1-access-characters-review.md`](../reviews/2026-08-02-phase-1-access-characters-review.md)）。
- 阶段一提交范围：`62c40df`（Node/better-sqlite3/jsdom 28.1/DB contract）→ `ddf149f`（campaign access/visibility）→ `aa8bf8b`（character + 003 + SQLite async transaction queue）→ `6e11c7a`（HTTP vertical）。

### 测试与构建基线

- 全量测试：`rtk npm test` → **43 files passed / 1 skipped，453 tests passed / 4 skipped**（457 总；Postgres contract 套件因 `POSTGRES_TEST_URL` 未配置被 `describe.skipIf` 门控跳过）。
- 类型检查：`rtk npm run typecheck`（server + client）通过。
- 构建：`rtk npm run build` 通过；`@dnd/contracts` 产出 `dist`（含 `.d.ts`）；server 经 `tsc -p tsconfig.build.json` 后由 `server/scripts/copy-migrations.mjs` 把迁移 SQL 复制进 `dist`（已含 `001/002/003` 三份）；client `vite build` 通过。

### 版本固定

- Node `22.12.0`（`.nvmrc` + 根 `engines.node >=22.12.0 <23`）；`jsdom` `28.1.0`（根 devDependency）；`better-sqlite3` `12.10.0`（`server/package.json` + `package-lock.json` 同步）。

### 迁移基线

- `001_initial_platform.sql`：`users`、`sessions`、`campaigns`、`campaign_members`。
- `002_campaign_invites.sql`：`campaigns.invite_code_hash`（可空，仅存 SHA-256 摘要，不存邀请码明文）。
- `003_characters.sql`：`platform_characters` + `platform_character_audits`（Phase 1 已完成）。
- `MigrationRunner` 使用独立跟踪表 `platform_migrations`（与旧 `schema_migrations` 隔离）；迁移按文件名排序、幂等执行、整批失败回滚。

### 错误码基线（13 个）

`AUTH_REQUIRED FORBIDDEN CAMPAIGN_NOT_FOUND TURN_NOT_ACTIVE TURN_LOCKED CHARACTER_NOT_APPROVED AI_PROVIDER_FAILED AI_OUTPUT_INVALID STATE_CONFLICT REALTIME_DISCONNECTED VALIDATION_ERROR INTERNAL_ERROR NOT_FOUND`，定义于 `packages/contracts/src/errors.ts`，HTTP 状态映射于 `server/src/platform/http/AppError.ts`。

### 平台 API 基线

- `/api/auth/register|login|logout|me`、`/api/campaigns`（列表/创建/详情/join/settings）。
- 统一错误响应 `{ "error": { code, message } }` 由 `errorMiddleware` 处理，前缀 `['/api/auth', '/api/campaigns']`。
- `AuthContext`（contract）含可选 `userId/role/playerId/campaignId`；`sessionMiddleware` 只填 `userId`；campaign-scoped ctx 的生成方式由 Phase 1 定义并成为全局约定。

### 全局命名约定（后续所有详细计划必须一致引用）

- 迁移文件：`001/002`（基线）→ `003_characters.sql`（Phase 1）→ `004_world_state.sql`、`005_events_outbox.sql`、`006_turns_actions.sql`（Phase 2A）→ `007_archives.sql`、`008_ai_runtime.sql`（Phase 2B）→ `009_combat.sql`（Phase 3）→ `010_rules_providers.sql`（Phase 5）。
- 新平台表统一 `platform_` 前缀；沿用 001/002 的 `users`、`sessions`、`campaigns`、`campaign_members` 不重命名。
- 新平台路由统一挂在 `/api/campaigns/:campaignId/*`，均经 campaign middleware（`Router({ mergeParams: true })`）。
- 错误码：Phase 5 新增 `INVALID_RULE_SOURCE`、`PROVIDER_NOT_CONFIGURED` 并同步 `appErrorCodes`；其余阶段只使用既有码。
- 端口名：`DatabasePort`/`QueryExecutor`（已存在）、`EventPublisherPort`、`AiProviderPort`（后续阶段定义）。
- 领域事件：`campaignEventSchema` 每个 variant 带 `campaignId`；outbox 层为每战役自增 `sequence`（并发安全）；事件受众 `public`/`owner_only`/`player_private`（`eventDefaultAudience` + `canReadEvent`），`ai.preview.*` 与 `ai.preview.failed` 对 player 可见。
- 任务排序铁律：前端任务在服务端 AI 垂直流程通过前不开始；结构化战斗固定放在 AI runtime 之后。

## 计划拆分决定

整体系统跨账号、战役、角色、世界、回合、AI、实时、战斗与前端多个子系统，单一巨型计划无法同时保证正确性与可执行性。因此：

- `2026-08-02-dnd-ai-dm-rearchitecture-revised.md`（本文件）只保留权威总路线图。
- **阶段一详细计划** [`2026-08-02-dnd-ai-dm-phase-1-access-characters.md`](./2026-08-02-dnd-ai-dm-phase-1-access-characters.md) 已执行完毕并通过最终审查（READY_FOR_PHASE_2，见 [`2026-08-02-phase-1-access-characters-review.md`](../reviews/2026-08-02-phase-1-access-characters-review.md)），不再作为待执行计划。
- 后续阶段在前一阶段通过验收与两级 review 后再写详细计划，避免过早生成未经实现验证的伪代码漂移。
- **Phase 2 按两个可执行计划推进**：**Phase 2A**（world facts + 事务性 outbox + turn/actions，迁移 `004_world_state` → `005_events_outbox` → `006_turns_actions`，详细计划 [`2026-08-02-dnd-ai-dm-phase-2a-world-outbox-turns.md`](./2026-08-02-dnd-ai-dm-phase-2a-world-outbox-turns.md) **已执行完毕并通过最终审查 READY_FOR_PHASE_2B**，见 [`2026-08-02-phase-2a-world-outbox-turns-review.md`](../reviews/2026-08-02-phase-2a-world-outbox-turns-review.md)，不再作为待执行计划）与 **Phase 2B**（archives + AI runtime + 服务端 AI 垂直流程，迁移 `007_archives` → `008_ai_runtime`，详细计划 [`2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md`](./2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md) **已编写，待执行，尚未实现**）。

## 阶段总览（依赖关系）

| 阶段 | 内容 | 迁移 | 依赖 | 状态 / 详细计划 |
| --- | --- | --- | --- | --- |
| Phase 1 | 基线硬化、campaign-scoped access/visibility、角色后端、HTTP 垂直验收 | `003_characters.sql` | 无（基于 Task 1-3） | ✅ 已完成（提交 `62c40df`–`6e11c7a`）；复审 [READY_FOR_PHASE_2](../reviews/2026-08-02-phase-1-access-characters-review.md) |
| Phase 2 | world facts、事务性 outbox、turn/actions、archives、AI runtime、服务端 AI 垂直流程 | `004`–`008` | Phase 1 | 🟡 拆分为 **Phase 2A（world + outbox + turn，`004`–`006`）** 与 **Phase 2B（archive + AI，`007`–`008`）**；Phase 2A ✅ 已完成（提交 `b12059c`–`4d57bd7`，复审 [READY_FOR_PHASE_2B](../reviews/2026-08-02-phase-2a-world-outbox-turns-review.md)），Phase 2B 详细计划 ✅ 已编写（[`2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md`](./2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md)），**⏭ 待执行，尚未实现** |
| Phase 3 | SSE 实时投递与结构化战斗 | `009_combat.sql` | Phase 2 | Phase 2 通过复审后编写 |
| Phase 4 | 前端 App Shell、认证、战役列表、owner/player 工作区 | 无 | Phase 2/3 | Phase 3 通过复审后编写 |
| Phase 5 | 规则/Provider、真实加密、legacy adapter、多上下文 E2E、cutover | `010_rules_providers.sql` | Phase 1-4 | Phase 4 通过复审后编写 |

依赖概览：`Phase1 → Phase2 → Phase3 → Phase4`；Phase 5 依赖 Phase 1-4 的服务端结果与前端壳。Phase 4 前端只有在服务端 AI 垂直流程（Phase 2 验收门）通过后才开始。

---

## Phase 1：基线硬化、战役访问控制、角色后端与 HTTP 垂直验收 — ✅ 已完成

**状态：** 已完成。commit 范围 `62c40df` → `6e11c7a`（4 个 commit）；最终审查结论 READY_FOR_PHASE_2，见 [`2026-08-02-phase-1-access-characters-review.md`](../reviews/2026-08-02-phase-1-access-characters-review.md)。

**定位：** 产出可复现的开发基线、campaign-scoped 权限体系、可见性策略与角色审核后端，并用一条真实 HTTP 垂直流程锁定正确性。以下范围全部落地（验收门已全绿）。

### 范围

1. **可复现基线（Node/Postgres 硬化）**
   - 根目录新增 `.nvmrc`，固定已验证的 Node `22.12.0`。
   - 根 `package.json` 声明 `engines.node` 为 `>=22.12.0 <23`；测试只验证配置文件/engines 静态一致，不因当前进程版本（可能是 24.x）失败。
   - `server/package.json` 把 `better-sqlite3` 从 `latest` 固定为 lockfile 中已解析的具体版本 `12.10.0`，并同步 `package-lock.json`（`rtk npm install`）。
   - 抽取 SQLite/PostgreSQL 共用的 `DatabasePort` contract suite（事务回滚/提交、参数化查询与 execute、迁移幂等）；Postgres 用 `POSTGRES_TEST_URL` 门控，未配置时跳过；`COUNT()` 一律 `Number()`；测试资源/用户 ID 唯一并在结尾清理。
2. **Campaign-scoped access**
   - 定义独立 `CampaignAuthContext { userId, campaignId, role, playerId }`（不 `extends` 可选/null 的 `AuthContext`）。
   - `resolveCampaignContext(executor, sessionCtx, campaignId)`：非成员按 `CAMPAIGN_NOT_FOUND` 隐藏存在性；`requireOwner` 拒绝 player。
   - `campaignMiddleware`（`requireCampaignMember`/`getCampaignContext`）：**只用于未来 feature routers**，不全局挂载到现有 `/api/campaigns` router，不阻塞 list/create/join；feature router 必须 `Router({ mergeParams: true })`。
3. **VisibilityPolicy**
   - 唯一规则：owner 全量；player 只见 `public` + 自己 `knownBy` 的 `player_private`；`owner_only` 永不因 `knownBy` 越权。
4. **角色后端与 `003_characters.sql`**
   - `platform_characters`：`sheet_json`、`derived_json`、状态、时间戳。
   - `platform_character_audits`：actor/action/before/after，派生值与审核可审计。
   - 服务：create/update own draft、submit own draft/rejected、owner approve/reject pending only；派生值实际写 `derived_json`；每次状态/内容变更写 audit；任何操作校验 `campaign_id`。
   - 投影：玩家不能读他人 draft/pending/rejected，owner 可读全部，玩家可读自己的完整角色 + 其他已批准角色的安全 summary。
   - 路由：`/api/campaigns/:campaignId/characters`，`Router({ mergeParams: true })` + campaign middleware；`POST /:id/submit` 只玩家；`POST /:id/review` 直接 approve/reject（owner 不得调用 submit）。
5. **HTTP 垂直验收**
   - 真实 `app.listen(0)` + `fetch`，owner/player 双 cookie jar（并加 playerB 做隐私断言）。
   - 完整流程：register → login → owner create campaign → player join → player create/update/submit character → owner list pending/approve → player sees approved。
   - 断言：playerB 的 draft 不被 playerA 看到；player 不能 approve；DTO 不含 `password_hash`/`invite_code_hash`/audit 内部 JSON。
   - 不使用真实 `server/dnd.sqlite`，一律内存 SQLite。

### 本阶段不做什么

- 不建立任何前端文件。
- 不建立 world/turn/outbox/archive/AI/SSE/combat。
- 不新增错误码（只使用 `FORBIDDEN`/`CAMPAIGN_NOT_FOUND`/`STATE_CONFLICT`/`VALIDATION_ERROR`/`NOT_FOUND` 等既有码）。

### 详细计划

[`2026-08-02-dnd-ai-dm-phase-1-access-characters.md`](./2026-08-02-dnd-ai-dm-phase-1-access-characters.md)，共 4 个小任务，均已含 TDD 步骤、真实可编译测试代码、运行命令与指定路径 commit。**已执行完毕**，历史代码片段不再改动。

### 验收门（均已通过）

- [x] 既有相关测试（`authCampaignRoutes`、`database`、`contracts`）不回归，新增角色测试全绿。
- [x] server typecheck 通过；server build 通过（`003_characters.sql` 被复制进 `dist`）。
- [x] HTTP 垂直流程通过；两级 review（详细计划 review + 实现 review）通过（结论 READY_FOR_PHASE_2）。

---

## Phase 2：world facts、事务性 outbox、turn/actions、存档、AI 运行时与服务端 AI 垂直流程 — ✅ Phase 2A 已完成，⏭ Phase 2B 待执行

**定位：** 构建核心跑团数据平面与 AI 结算，交付服务端 AI 垂直流程 `create → join → approve → submit → lock → resolve → archive → project`，这是后续前端与实时能力的服务端前提。Phase 1 已通过复审，本阶段按两个可执行计划推进：**Phase 2A（world + outbox + turn，迁移 `004`–`006`）** 与 **Phase 2B（archive + AI，迁移 `007`–`008`）**；**Phase 2A 已完成并通过复审（READY_FOR_PHASE_2B，见 [`2026-08-02-phase-2a-world-outbox-turns-review.md`](../reviews/2026-08-02-phase-2a-world-outbox-turns-review.md)）**，**Phase 2B 详细计划已编写（[`2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md`](./2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md)，⏭ 待执行，尚未实现）**。Phase 2 总体验收（服务端 AI 垂直流程 + 两级 review）**仍未完成**。

### 范围

1. **World facts（`004_world_state.sql`）**
   - `platform_world_facts`：kind/title/content/visibility/`known_by_json`/时间戳。
   - 只有 owner 可写；player 只读经 `VisibilityPolicy` 投影后的 facts。
   - 事实可存在于完整世界状态中，但只对 owner 或指定玩家可见（`knownBy`）；AI context 只消费投影结果。
2. **事务性事件与 outbox（`005_events_outbox.sql`）**
   - `platform_outbox_sequences` + `platform_outbox_events`：`campaign_id`/`sequence`/`event_type`/`visibility`/`target_player_id`/`payload_json`/`published_at`（可空，新事件未发布）/`created_at`，`UNIQUE(campaign_id, sequence)`。
   - 领域事务内写 outbox；每战役 sequence 通过每 campaign 原子 upsert 计数器 + `RETURNING` 在写事务内取得（SQLite 与 Postgres 通用），**绝不用“读取后 MAX+1”**；`UNIQUE(campaign_id, sequence)` 仅作不变量兜底，不作为分配机制。
   - `campaignEventSchema` 每个 variant 带 `campaignId`；事件受众 `public`/`owner_only`/`player_private`；SSE 帧与重放共用同一 outbox 数据源与同一投影。
3. **回合与行动锁定（`006_turns_actions.sql`）**
   - `platform_turns` + `platform_actions` + `platform_turn_requirements`；回合状态机 `waiting_for_actions → locked → resolving → completed`，失败进入 `needs_owner_attention`。
   - 最后一名必需玩家提交后自动锁定；锁定后不可修改；回合含 `locked_at`/`completed_at`。
   - 未批准角色不能提交行动（`CHARACTER_NOT_APPROVED`）。
   - 每个行动可追溯提交/更新时间；每回合通过 `platform_turn_requirements` 规范化记录必需玩家与已提交玩家。
4. **存档（`007_archives.sql`）**
   - `platform_archives`：kind（automatic/manual）、turn_id、label、version、`state_json`、superseded、创建者。
   - 自动存档与手动命名存档；恢复后该版本成为当前状态，后续历史标记 `superseded`，不物理删除。
   - 恢复动作写入 `archive.restored` 系统事件。
5. **AI 运行时（`008_ai_runtime.sql`）**
   - `platform_ai_runs`（status/provider/model/error_code/时间戳）+ `platform_turn_entries`（narrative/private_update/dice_result，各带 visibility 与 player_id）。
   - Provider 端口 + 结构化输出解析（`turnResolutionSchema` 校验，失败 `AI_OUTPUT_INVALID`）。
   - 失败进入 `needs_owner_attention`；不写半截正式日志、不重复应用。
6. **服务端 AI 垂直流程**
   - 完整 `create → join → approve → submit → lock → resolve → archive → project`，用 mock provider 跑通。
   - 结构化战斗在此阶段以能力门禁拒绝 `combat` stateChange（`STATE_CONFLICT`），Phase 3 移除。

### 迁移连续性

`004_world_state`、`005_events_outbox`、`006_turns_actions`（Phase 2A）、`007_archives`、`008_ai_runtime`（Phase 2B），编号连续、无跳号。

### 关键不可变约束（Phase 2 详细计划必须满足）

- **事务**：一次结算的所有写（world facts、turn entries、状态变更、自动存档、outbox 事件）在同一个 `DatabasePort.transaction` 内；任一失败整体回滚，不产生半截结果。
- **visibility**：AI 输出与所有查询必须经同一 VisibilityPolicy 投影；`owner_only`/`player_private` 不得通过任何路径泄漏到其它玩家。
- **idempotency**：同一结算结果不能应用两次（同 turn 只生成一份正式日志与一个自动存档）。
- **preview**：公开流式预览与正式提交分离；预览失败时丢弃未完成预览，回合保持锁定并可重试，不写半截正式日志。

### 本阶段不做什么

- 不建立 SSE 投递（Phase 3）、结构化战斗完整 mutation（Phase 3）、前端（Phase 4）。
- 不新增错误码。

### 详细计划编写时机

**Phase 1 已完成并通过复审（READY_FOR_PHASE_2）**。本阶段按 **Phase 2A（world + outbox + turn）** 与 **Phase 2B（archive + AI）** 两个可执行计划先后推进：**Phase 2A 详细计划已执行完毕并通过最终审查（READY_FOR_PHASE_2B，见 [`2026-08-02-phase-2a-world-outbox-turns-review.md`](../reviews/2026-08-02-phase-2a-world-outbox-turns-review.md)）**（[`2026-08-02-dnd-ai-dm-phase-2a-world-outbox-turns.md`](./2026-08-02-dnd-ai-dm-phase-2a-world-outbox-turns.md)，迁移 `004_world_state` → `005_events_outbox` → `006_turns_actions`，含共享 HTTP harness 重构与三 actor HTTP 垂直验收），不再作为待执行计划；**Phase 2B 详细计划已编写（迁移 `007_archives` → `008_ai_runtime`，见 [`2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md`](./2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md)，⏭ 待执行，尚未实现）**；Phase 2B 实现与 Phase 2 总体验收尚未完成。

### 验收门

- 服务端 AI 垂直流程测试通过；回合锁定/outbox/存档/世界/可见性测试通过。
- server typecheck/build 通过；两级 review 通过。

---

## Phase 3：SSE 实时投递与结构化战斗

**定位：** 在 Phase 2 数据平面之上加入实时通道与战斗能力。

### 范围

1. **SSE 投递与断线重连**
   - `GET /api/campaigns/:campaignId/events?after=<sequence>`，`Authorization: session cookie`。
   - 基于 outbox 重放 + live 推送；断线携带最后 event id 重连，先补发 outbox 再接收 live。
   - SSE 帧：`event: campaign` + `id: <sequence>` + `data`。
   - 连接必须经过 campaign middleware 鉴权；非成员不能订阅。
2. **结构化战斗（`009_combat.sql`）**
   - `platform_encounters` + `platform_combatants`：先攻、HP/AC/状态效果、活跃战斗员。
   - 白名单命令（`combatCommandKindSchema` 已有枚举：start/roll_initiative/advance_turn/apply_attack/apply_saving_throw/apply_damage/apply_healing/add_condition/remove_condition/end_encounter），禁止任意 JSON patch。
   - 非活跃战斗员不能执行伤害等动作（`STATE_CONFLICT`）。
   - 移除 Phase 2 AI materializer 对 `combat` stateChange 的能力门禁，由 `CombatAiAdapter` 把 `kind: 'combat'` 的 stateChange 映射为白名单命令并注入启用。

### 事件可见性（固定决策，Phase 3 详细计划必须满足）

- 公开 AI 预览（`ai.preview.started`/`ai.preview.delta`）对 player **可见**。
- AI 失败事件通知（`ai.preview.failed`）对 player **可见**：客户端收到后丢弃临时预览并显示可恢复错误；该事件本身不是 owner-only。
- owner-only debug 内容（AI 上下文、输入输出原始记录等）走**独立事件**，绝不在玩家流中出现。
- live 投递与重放（replay）使用**同一投影**（同一 `projectEvent` 函数），保证重连前后一致。
- 玩家不会因为订阅实时通道而获得拥有者事件。

### 本阶段不做什么

- 不建立前端页面。
- 不新增错误码。

### 详细计划编写时机

**只有在 Phase 2 完成并通过复审后才编写 Phase 3 详细计划。**

### 验收门

- SSE 投影/重放测试通过；战斗测试与 AI 适配测试通过；server typecheck/build 通过；两级 review 通过。

---

## Phase 4：前端 App Shell、认证与 owner/player 工作区

**定位：** 提供统一 Web 应用，按身份进入 owner/player 工作区，消费 Phase 1-3 已定的 HTTP API 与 SSE 事件名。

### 范围

1. **App Shell 与路由**
   - 登录/注册、战役列表/创建向导、路由守卫（未登录 → `/login`；无战役 → `/campaigns`；owner → `/campaigns/:id/owner`；player → `/campaigns/:id/player`）。
   - Query Client、Provider 分层；`RealtimeSession` 只在有 `campaignId` 时建立连接。
   - 错误边界与异步状态（loading/ready/empty/error/retrying/realtime-disconnected 等）。
2. **玩家工作区**
   - 公开剧情、自己的私密结果、自己的角色与背包、行动编辑与锁定状态、实时提交进度。
   - 不挂载 owner Prompt、其它玩家行动、完整 AI 上下文与隐藏世界事实。
3. **拥有者工作区**
   - 只做 Phase 1-3 已存在 API 的页面：回合进度与 AI 运行、角色审核、世界、战斗、存档。
   - 三栏布局（Header/Sidebar/MainPanel/Inspector），各页面只加载自身 feature 查询，不共享巨型全局 Store。
   - 规则与 Provider 管理 UI 不在本阶段（Phase 5 与对应 HTTP API 一并实现）。

### 前置约束（固定决策）

- 前端任务**只能在服务端 AI 垂直流程（Phase 2 的验收门）通过后开始**。
- 不提前建立无法挂载的孤立页面（原计划问题 2/9 的修复）；CharacterBuilder 在玩家工作区挂载、CharacterReviewPanel 在 owner 工作区挂载。
- 实时状态与本地表单草稿分离；不使用巨型全局 Store。

### 本阶段不做什么

- 不实现规则内容库/Provider 密钥管理页面（规则/Provider UI 与对应 HTTP API 一并放 Phase 5）。
- 不引入旧 legacy 页面依赖（Phase 5 提供 adapter）。

### 详细计划编写时机

**只有在 Phase 3 完成并通过复审后才编写 Phase 4 详细计划。**

### 验收门

- 前端路由/组件测试通过；client typecheck/build 通过；owner/player 工作区渲染测试通过；两级 review 通过。

---

## Phase 5：规则/Provider、真实加密、legacy adapter、多上下文 E2E 与 cutover

**定位：** 补齐规则与 Provider 边界、真实加密、旧数据迁移与完整验收，完成发布前清理。

### 范围

1. **规则资料与 AI Provider 管理（`010_rules_providers.sql`）**
   - `platform_rule_sources`：来源/版本/许可证/署名/内容哈希/scope（platform/campaign/user），不落第三方规则正文。
   - 新增 `INVALID_RULE_SOURCE`、`PROVIDER_NOT_CONFIGURED` 错误码并同步 `errors.ts` + `AppError.DEFAULT_HTTP_STATUS`。
   - `platform_provider_credentials`：provider/base_url/model/`api_key_encrypted`/configured，`UNIQUE(campaign_id)`。
2. **真实加密 Provider Key**
   - 真实 AES-256-GCM；**禁止 base64 伪装加密、禁止默认密钥**；密钥必须来自强制配置的环境变量，缺失时拒绝保存/读取。
   - API Key 只在服务端保存并加密；前端只见脱敏 DTO（provider/baseUrl/model/configured）。
3. **Legacy adapter**
   - 只读旧数据映射到新 contract；新写入一律走新模块仓储；不删除旧表。
   - `legacyToken` 等敏感字段永不进入 DTO。
4. **多上下文完整 E2E**
   - 真实 owner + playerA + playerB 三个隔离浏览器 context（各自独立登录/会话），跑完整战役流程：注册 → 创建战役 → 加入 → 创建/审核角色 → 提交行动 → 锁定 → 结算 → 存档 → 查看各自可见结果。
   - 覆盖隐私隔离：玩家 A 看不到玩家 B 私密内容，玩家看不到 owner 调试内容。
5. **Cutover**
   - 旧入口清理（仅当 `git grep`/测试/构建证明无引用时删除）、README 更新、发布前审查。
   - 发布前检查：`rtk npm test`、`rtk npm run typecheck`、`rtk npm run build`、`rtk git status --short --branch`；遗留失败写入 cutover 文档并阻止发布。

### 本阶段不做什么

- 不把第三方完整规则文本写入仓库；不删除归档 tag/stash/外部备份（审查通过前）。

### 详细计划编写时机

**只有在 Phase 4 完成并通过复审后才编写 Phase 5 详细计划。**

### 验收门

- provider 脱敏/加密测试、rules 许可证测试通过；多上下文 E2E（owner + 2 players）通过。
- `rtk npm test`、`rtk npm run typecheck`、`rtk npm run build` 全绿；两级 review 通过。

---

## 详细计划模板（writing-plans 标准）

阶段一与阶段二 A 详细计划是已按此标准写成的计划；后续阶段详细计划必须沿用同一结构。每个任务必须包含：

- **Files**：Create/Modify 的精确路径列表。
- **依赖**：该任务依赖的前置任务/已有能力。
- **Step 1 失败测试**：给出真实可编译的测试核心代码（vitest + 真实内存 SQLite + 现有 service）。**仅 TDD 任务要求先红**：集成/验收测试（如 Phase 1 Task 4）验证已实现整合，不要求先红，其 Step 1/2 改为“写验收测试 + 运行确认通过”。
- **Step 2 运行确认失败**：具体运行命令与预期失败原因（不能是“以后补”）。
- **Step 3 实现**：完整接口与核心算法；机械 CRUD 可保留为明确方法签名，但不能留“同构/以后补”占位。
- **Step 4 运行确认通过**：具体运行命令与预期结果。
- **Step 5 指定路径 commit**：只 `git add` 该任务列出的路径，commit message 含精确 trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

详细计划还必须：

- 只使用契约内既有错误码；确需新增码时 Files 必须同时包含 `packages/contracts/src/errors.ts` 与 `server/src/platform/http/AppError.ts` 的同步项。
- 明确每个阶段的验收门（测试/typecheck/build/垂直流程/两级 review）。
- 不在计划里给出已知错误代码（如 middleware 全局挂载、owner 调用 submit、玩家 review 泄漏、非事务 audit、derived 不落库、缺 mergeParams 等）。
- 不含任何占位符与未经实现验证的伪代码。

## 每阶段通用验收门

每个阶段结束都必须通过以下门后，才能编写下一阶段的详细计划：

1. **测试**：本阶段新增测试 + 既有相关测试全绿（`rtk npm test`）。
2. **typecheck**：`rtk npm run typecheck`（server + client 相关）通过。
3. **build**：相关 workspace 构建通过（`rtk npm run build`）。
4. **垂直流程**：本阶段定义的可运行垂直流程通过（Phase 1 为角色 HTTP 垂直；Phase 2 为服务端 AI 垂直；Phase 3 为 SSE + 战斗；Phase 4 为前端工作区渲染；Phase 5 为多上下文 E2E）。
5. **两级 review**：先 review 详细计划本身，再 review 实现结果；未通过前不进入下一阶段。

## 后续详细计划必须满足的硬约束

任何后续阶段的详细计划必须满足以下约束，违反任一条即视为缺陷：

- **Repository 与事务**：所有 repository 写操作可接收同一个 `QueryExecutor`/tx；服务需要多写操作时必须用 `DatabasePort.transaction`，repository 不得持有外部 executor 后在 tx 中绕开。
- **上下文来源**：不得硬编码 `campaignId` 或 owner ctx；所有领域服务只消费 `resolveCampaignContext` 生成的 `CampaignAuthContext`。
- **Outbox sequence**：每战役 sequence 通过每 campaign 原子分配（SQLite 与 Postgres 均支持的 `INSERT ... RETURNING` / upsert 计数器，二者取其一）在写事务内取得，不得用“读取后 MAX+1”的竞态写法；`UNIQUE(campaign_id, sequence)` 仅作不变量，不作为分配机制。
- **Archive 快照**：存档保存**真实快照**并支持**真实恢复**，不得存空 `{}` 或只存元数据；恢复后后续历史标记 `superseded`。
- **AI 状态机**：`locked → resolving → completed` 或 `→ needs_owner_attention`；失败不得自动进入下一回合、不得写半截正式日志、不得重复应用。
- **预览与投影**：公开 preview 与 player-private 投影分离；失败事件通知（`ai.preview.failed`）对 player 可见，客户端丢弃临时预览并显示可恢复错误；owner-only debug 使用独立事件；live 与 replay 用同一投影。
- **Provider 加密**：禁止 base64 或默认密钥；API Key 只服务端保存并加密，前端只见脱敏 DTO。
- **E2E 真实性**：垂直/E2E 验收使用多上下文（真实 owner + playerA + playerB 三个隔离浏览器 context），覆盖隐私隔离，而不是单角色模拟。
- **错误码同步**：每个新错误码必须同步 `packages/contracts/src/errors.ts` 的 `appErrorCodes` 与 `server/src/platform/http/AppError.ts` 的 `DEFAULT_HTTP_STATUS`；未同步前不得在测试/实现中引用。
- **迁移与表名**：新表统一 `platform_` 前缀；迁移编号连续不跳号；迁移 SQL 可移植（TEXT 键、`DEFAULT CURRENT_TIMESTAMP`，无 SQLite-only 函数）。
- **Commit 规范**：每个任务一个只含该任务文件的 commit，trailer 精确为 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 阶段验收门检查清单

实施者以阶段为单位推进；每个阶段通过下方全部勾选后，才进入下一阶段编写详细计划。

### Phase 1（角色后端与 HTTP 垂直）— ✅ 已完成（commit `62c40df`–`6e11c7a`；复审 READY_FOR_PHASE_2）

- [x] 根 `.nvmrc` 固定 `22.12.0`；根 `package.json` engines `>=22.12.0 <23`；配置一致性测试通过
- [x] `better-sqlite3` 固定为 12.10.0，`package-lock.json` 同步
- [x] SQLite/Postgres `DatabasePort` contract suite 抽取完成；无 `POSTGRES_TEST_URL` 时 Postgres 套件跳过
- [x] `resolveCampaignContext`/`requireOwner`/`campaignMiddleware` 实现并有测试；非成员隐藏存在性
- [x] `VisibilityPolicy`：owner 全量、player 只见 public + 自己 knownBy 的 player_private、owner_only 不越权
- [x] `003_characters.sql`（platform_characters + platform_character_audits）经迁移创建；server build 复制进 dist
- [x] 角色服务（create/update/submit/approve/reject/audit/投影）实现并有测试
- [x] 角色路由挂 `/api/campaigns/:campaignId/characters`（mergeParams + campaign middleware）
- [x] HTTP 垂直流程（owner/player/playerB 三 cookie jar）通过，DTO 无敏感字段
- [x] 既有 authCampaignRoutes/database/contracts 测试不回归；typecheck/build 通过
- [x] 两级 review（计划 review + 实现 review）通过

### Phase 2（核心跑团与 AI 垂直）— ✅ Phase 2A（迁移 `004`–`006`）已完成；⏭ Phase 2B（迁移 `007`–`008`）详细计划已编写，待执行

- [x] **Phase 2A**：共享 HTTP harness 抽取（纯 refactor）；`004_world_state.sql` 创建；world fact contract/service/route 测试通过（owner 写、player 只读投影、knownBy 收敛 `[]`/自己）
- [x] **Phase 2A**：`005_events_outbox.sql` 创建；`campaignEventSchema` 每 variant 带 `campaignId`、`owner.debug` 定义未 emit、`eventDefaultAudience`/`canReadEvent` 就绪；outbox 每战役 sequence 并发安全（原子 upsert + `RETURNING`）、回滚无残留、`published_at` 可空
- [x] **Phase 2A**：`006_turns_actions.sql` 创建；最后一名玩家提交后自动锁定；锁定后不可修改；未批准角色不能提交；A 编辑不重复发事件；并发 A/B 只发一次 `turn.locked`；`sequence=[1,2,3]`；locked 也阻挡新回合（`f6d5eb2` 修复）
- [x] **Phase 2A**：HTTP 垂直验收（world + outbox + turns，owner/playerA/playerB）通过；world 投影隔离、outbox 顺序/内容/未发布、turn 视图隐私、DTO 无 `*_json`/内部字段；typecheck/build 通过；两级 review 通过（结论 READY_FOR_PHASE_2B，见 [`2026-08-02-phase-2a-world-outbox-turns-review.md`](../reviews/2026-08-02-phase-2a-world-outbox-turns-review.md)）
- [ ] **Phase 2B**：`007_archives.sql` 创建；存档保存真实快照并支持真实恢复；恢复后后续历史标记 superseded；manual label trimmed / automatic label=null；per-campaign version 原子分配（绝不 MAX+1）
- [ ] **Phase 2B**：`008_ai_runtime.sql` 创建；AI 状态机 locked→resolving→completed / needs_owner_attention；失败不写半截日志、不重复应用（同 key 幂等返回既有 run）
- [ ] **Phase 2B**：服务端 AI 垂直流程（create→join→approve→submit→lock→resolve→archive→project）通过；`combat` stateChange 以 `STATE_CONFLICT` 门禁拒绝；生产默认 `UnavailableAiProvider`（绝不默认 Mock）
- [ ] **Phase 2B**：typecheck/build 通过；两级 review 通过
- [ ] **Phase 2B**：详细计划（[`2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md`](./2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md)）已编写（⏭ 待执行），实现尚未开始

### Phase 3（SSE 与结构化战斗）

- [ ] SSE 连接经 campaign middleware 鉴权；`?after=<sequence>` 重放 + live 推送同一投影
- [ ] 公开预览对 player 可见；`ai.preview.failed` 对 player 可见（客户端丢弃临时预览并显示可恢复错误）；owner 调试走独立事件
- [ ] `009_combat.sql` 创建；白名单命令生效，非活跃战斗员 `STATE_CONFLICT`
- [ ] `CombatAiAdapter` 注入 `AiResolutionService`，移除 Phase 2 combat 门禁
- [ ] SSE/战斗/AI 适配测试通过；typecheck/build 通过；两级 review 通过

### Phase 4（前端工作区）

- [ ] App Shell 与路由守卫（/login、/register、/campaigns、owner/player 路由）实现
- [ ] Query Client/Provider/RealtimeSession 分层；异步状态与错误边界
- [ ] 玩家工作区（剧情/私密结果/角色/行动/实时）与 owner 工作区（回合/审核/AI/世界/战斗/存档，仅已有 API 页面）渲染测试通过
- [ ] 前端在服务端 AI 垂直流程通过后才开始（本清单依赖 Phase 2 验收）
- [ ] client typecheck/build 通过；两级 review 通过

### Phase 5（规则/Provider/加密/E2E/cutover）

- [ ] `010_rules_providers.sql` 创建；`INVALID_RULE_SOURCE`/`PROVIDER_NOT_CONFIGURED` 同步 errors.ts + AppError map
- [ ] Provider Key 真实 AES-256-GCM、强制环境密钥、无默认密钥、无 base64 伪装；前端只见脱敏 DTO
- [ ] legacy adapter 只读映射，敏感字段不进入 DTO
- [ ] 多上下文 E2E（真实 owner + playerA + playerB 三个隔离浏览器 context）通过，隐私隔离断言成立
- [ ] 发布前检查（test/typecheck/build/status）通过；cutover 文档记录遗留失败
- [ ] 两级 review 通过

## 迁移连续性总表

| 迁移 | 阶段 | 内容 |
| --- | --- | --- |
| 001_initial_platform.sql | 基线（已完成） | users/sessions/campaigns/campaign_members |
| 002_campaign_invites.sql | 基线（已完成） | campaigns.invite_code_hash |
| 003_characters.sql | Phase 1（已完成） | platform_characters + platform_character_audits |
| 004_world_state.sql | Phase 2A | platform_world_facts |
| 005_events_outbox.sql | Phase 2A | platform_outbox_sequences + platform_outbox_events |
| 006_turns_actions.sql | Phase 2A | platform_turns + platform_actions + platform_turn_requirements |
| 007_archives.sql | Phase 2B | platform_archives |
| 008_ai_runtime.sql | Phase 2B | platform_ai_runs + platform_turn_entries |
| 009_combat.sql | Phase 3 | platform_encounters + platform_combatants |
| 010_rules_providers.sql | Phase 5 | platform_rule_sources + platform_provider_credentials |

## 错误码同步

- 基线 13 个码保持不变。
- Phase 1-4 只引用既有码（`FORBIDDEN`/`CAMPAIGN_NOT_FOUND`/`TURN_LOCKED`/`TURN_NOT_ACTIVE`/`CHARACTER_NOT_APPROVED`/`AI_OUTPUT_INVALID`/`AI_PROVIDER_FAILED`/`STATE_CONFLICT`/`VALIDATION_ERROR`/`NOT_FOUND` 等）。
- Phase 5 新增 `INVALID_RULE_SOURCE`、`PROVIDER_NOT_CONFIGURED`，必须同步 `errors.ts` + `AppError.DEFAULT_HTTP_STATUS`。

## 风险记录

以下风险在复审文档 `docs/superpowers/reviews/2026-08-02-plan-and-baseline-review.md` 中记录，各阶段实施时必须持续关注：

1. **PostgreSQL 契约测试需真实运行**：当前 `database.test.ts` 只真实运行 SQLite；Postgres 仅测试占位符重写。Phase 1 已用 `POSTGRES_TEST_URL` 门控补上同一组契约测试（4 个用例在未配置 URL 时跳过），**仍建议在部署 Postgres 环境后实际跑一次**。
2. **Node / better-sqlite3 ABI**：`better-sqlite3` 是原生模块，Node 主版本升级可能导致 ABI 不匹配。Phase 1 已固定 `.nvmrc`（22.12.0）/engines（`>=22.12.0 <23`）、固定 `better-sqlite3` 12.10.0，并额外固定 `jsdom` 28.1.0 以消除 EBADENGINE；后续阶段禁止随意升级这些版本。
3. **表名冲突**：平台迁移与旧 schema 共用同一 `dnd.sqlite`；新表统一 `platform_` 前缀规避 `CREATE TABLE IF NOT EXISTS` 静默跳过的风险。
4. **AI 预览与正式提交分离**：公开预览失败时丢弃，不得把半截结果写入正式日志（Phase 2 硬约束）。

## 规格覆盖对照

设计文档（`2026-08-01-dnd-ai-dm-rearchitecture-design.md`）的成功标准与阶段映射：

| 设计成功标准 | 对应阶段 |
| --- | --- |
| 注册和登录 | 基线（Task 3，已完成） |
| 创建长期战役 | 基线（Task 3，已完成） |
| 配置用户自己的 AI Provider | Phase 5 |
| 邀请玩家加入 | 基线（Task 3，已完成） |
| 玩家创建角色 | Phase 1（已完成） |
| 拥有者审核角色 | Phase 1（已完成） |
| 多名玩家提交本轮行动 | Phase 2 |
| 最后一名玩家提交后自动锁定 | Phase 2 |
| AI 流式生成公开叙事 | Phase 2（预览）+ Phase 3（SSE 投递） |
| 校验结构化 AI 结果 | Phase 2 |
| 应用角色、世界和战斗状态 | Phase 2（角色/世界）+ Phase 3（战斗） |
| 创建自动存档 | Phase 2 |
| 向不同玩家发布不同可见内容 | Phase 1（已完成，角色投影）+ Phase 2（turn entries）+ Phase 3（SSE 投影） |
| AI 失败时停在拥有者处理状态 | Phase 2 |
| 从存档恢复并继续战役 | Phase 2 |
| 在单个面板出错时保持整个工作区可用 | Phase 4（前端错误边界） |

## 计划自检

### 占位符检查

本总路线图只描述阶段边界、依赖、验收门与硬约束，不含任何未验证的实现伪代码；阶段一详细计划是唯一包含实现代码的文档。除“后续阶段通过复审后编写详细计划”这一明确的流程决定外，本文件不依赖未定义的占位内容。

### 类型与契约一致性

- `CampaignAuthContext` 在 Phase 1 定义并被所有后续阶段复用；`resolveCampaignContext`/`getCampaignContext` 是唯一 ctx 生成途径。
- `EventPublisherPort`/`AiProviderPort` 在后续阶段定义；`campaignEventSchema` 每个 variant 带 `campaignId`，outbox envelope 与 SSE 帧共用同一契约。
- 路由统一 `/api/campaigns/:campaignId/*`，均经 campaign middleware（`Router({ mergeParams: true })`）。

### 迁移连续性

`001 → 002 → 003 → 004 → 005 → 006 → 007 → 008 → 009 → 010`，编号连续、与阶段对应、新表 `platform_` 前缀、SQL 可移植。

### 临时脚本/测试数据政策

任务内为验证而临时创建的文件不提交；确需保留的写入 `.gitignore` 窄范围条目。运行数据（`server/dnd.sqlite` 等）不在任何阶段修改。
