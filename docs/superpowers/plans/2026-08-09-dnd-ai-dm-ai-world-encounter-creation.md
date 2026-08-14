# 产品修正：AI-DM 掌握世界创建与遭遇发起（Owner 工作区只读监督）

> 状态：✅ 已实施（2026-08-09）。TDD 六个公开缝（contracts → validator → materializer → combat seam → AI resolution → 真实浏览器场景）全部 green；服务端/客户端 typecheck、root build 与 `npm run test:phase4-browser` 通过。
>
> 背景：Phase 3/Phase 4 曾决定“AI 只能更新既有状态，遭遇由 Owner HTTP 显式创建、Owner 工作区保留世界/战斗命令表单”。本修正按用户批准的权威产品行为反转该分工：**AI-DM 拥有世界创建与遭遇发起；普通 Owner 世界/战斗页面变为只读监督**。Owner HTTP mutation 端点保留为服务端授权的进阶/兜底能力，但普通 Owner UI 不再暴露任何创建/战斗命令表单。
>
> 本修正不重写历史审查证据；Phase 3 详细计划中“Phase 3 的 AI stateChange 不允许 start encounter”作为历史范围陈述保留，并以链接标注本修正。

## 权威产品行为

- 玩家行动 → AI 结构化结算 → 校验 → 事务性世界/战斗变更（与既有 entries/archive/turn complete 同一 formal apply tx）。
- AI 可创建新的世界事实，并发起遭遇（战斗员含 HP/AC/先攻加值/状态/可见性/目标玩家）；遭遇/战斗员/事实 id 与时间戳全部由服务端生成。
- AI 发起的遭遇默认在同一 formal apply tx 内自动掷先攻（`rollInitiative` 默认 `true`）；所有骰子/RNG 保持服务端权威。
- `stateChanges` 保持 update-only（引用既有稳定 id）；新增创建字段是**加性**的 `worldFactCreations` / `encounterStarts`，不把 `targetId` 改可选。
- 正式 apply 原子性、错误分类（`AI_OUTPUT_INVALID` / `STATE_CONFLICT`）、可见性规则、同战役最多一个未完成遭遇、存档、outbox、幂等与服务端权限全部保持原样。

## Contract 变更（`packages/contracts/src`）

- 提取 `visibilitySchema` / `Visibility` 到独立 `visibility.ts`（避免 turn ↔ world/combat 循环 import），`turn/world/combat/archive/ai` 改从新模块导入并保持 re-export。
- `turnResolutionSchema` 增加默认化数组字段 `worldFactCreations`（复用 `worldFactInputSchema`）与 `encounterStarts`（复用 `startEncounterInputSchema` + `rollInitiative` 默认 `true`，见 `combat.ts` 的 `encounterStartSchema`）。
- 旧 provider 输出不含这两个字段时仍解析为空数组（`.default([])`）。

## 服务端行为

- `TurnResolutionValidator`：schema 失败 → `AI_OUTPUT_INVALID`；一次结算多于一个 `encounterStarts` → `AI_OUTPUT_INVALID`；创建项的成员/角色归属校验留在 formal apply 内（AI-facing 错误）；`stateChanges` 目标预校验保持 update-only。
- `StateChangeMaterializer.applyAll`：同一 formal apply tx 内先应用既有 `stateChanges`，再插入世界事实（nanoid/时间戳/knownBy 校验），再委托遭遇发起；未注入 combat applier 时创建与更新同样保持 `STATE_CONFLICT` 能力门禁。
- `CombatService`：抽出 tx 复用 `createIn` seam（owner `start()` 与 AI 共用，不嵌套事务）；`apply(command start_encounter)` 仍拒绝作为纵深防御。
- `CombatAiAdapter.startEncounter`：同 caller tx 内 `createIn` + `rollInitiative=true` 时经同一白名单命令端口 `applyIn(roll_initiative)`；AI 创建数据的 `VALIDATION_ERROR`（schema/非成员/跨战役角色）转 `AI_OUTPUT_INVALID`，`STATE_CONFLICT` 保持原码。
- `AiContextBuilder`：prompt 显式描述创建字段、成员/角色 id 规则、服务端生成 id、同一结算内禁止引用新 id、服务端权威掷骰/先攻。
- `AiResolutionService`：把新数组透传给 materializer；result/debug 自然持久化；formal apply 后自动存档必然包含创建的事实/遭遇（恢复可整体回滚）。

## 前端与浏览器场景

- Owner 世界页 `世界状态`、战斗页 `战斗状态` 为只读监督视图（`ai-managed-note/empty`、`section-heading` + `count-badge`、事实卡 + 可见性徽章、遭遇/战斗员摘要、HP 条、状态 chips、历史）。
- `phase4BrowserServer.ts` 按回合确定性分流：第一次结算保持 SSE 重连/公开/私密叙事行为；第二次结算（turn-2 玩家行动触发）返回 public + playerA-private + owner-only 世界事实与一个含三种可见性战斗员、`rollInitiative: true` 的遭遇。
- `phase4-browser-flow.test.ts` 不再有 Owner 手工世界/战斗创建；在第二次结算前手动存档，结算后证明恢复可移除 AI 创建的事实与遭遇；保留真实 SSE 断连重连、隐私、feature 错误恢复、响应式布局、会话/登出与 player 只读战斗投影断言。

## TDD 缝与验证门

1. `packages/contracts/src/contracts.test.ts`（解析/默认值/显式 `rollInitiative=false`）；
2. `server/src/modules/ai-runtime/turn-resolution-validator.test.ts`（单遭遇上限、创建项延迟到 formal apply）；
3. `server/src/modules/ai-runtime/state-change-materializer.test.ts`（世界事实插入/knownBy/门禁/委托）；
4. `server/src/modules/combat/combat-ai-adapter.test.ts` + `combat.test.ts`（createIn 复用、同 tx 掷先攻、错误转码、STATE_CONFLICT 保留）；
5. `server/src/modules/ai-runtime/ai-context-builder.test.ts` + `ai-resolution.test.ts`（prompt 规则、创建+自动存档垂直、不变量冲突、非成员 knownBy）；
6. `client/src/tests/phase4-browser-flow.test.ts` + `scripts/phase4-browser-validation.ts`（真实浏览器三 context）。

## 验证命令

```bash
npx vitest run packages/contracts/src/contracts.test.ts
npx vitest run server/src/modules/ai-runtime server/src/modules/combat
npx tsc --noEmit -p server/tsconfig.json
npm run typecheck --workspace client
npm run build
npm run test:phase4-browser
```

## 范围外（不修改）

- 生产默认 `UnavailableAiProvider`；默认 `DATABASE_PATH` 指向的仓库根 `dnd.sqlite`。
- Owner HTTP mutation 端点（`POST /combat`、world create/update/delete）作为服务端授权的进阶/兜底能力保留，不删除。
- 历史审查证据文件不改写；Phase 3/Phase 4 计划中的历史范围陈述以链接标注而非重写。
