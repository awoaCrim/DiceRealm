# 服务端裁定与骰子权威 v0.1

## Goal

把 DiceRealm 从“Provider 不能伪造正式骰点”推进到“Provider 只能表达意图，服务端决定机械结果并提交，AI 只能描述已提交结果”。

本阶段建立一条最小、可审计、可幂等重试的纵向闭环：

```text
玩家自然语言
  → ActionIntent
  → 服务端 AdjudicationDecision
  → 不可变 RollPlan（如需要检定）
  → DiceService
  → RollRecord
  → ResolvedOutcome
  → 权威 Runtime mutation / StateRevision
  → NarrationOutput
```

不以完整 D&D 规则引擎或 Worldbook 为目标；先固定机械权威、状态版本和叙事边界。

## User value

- 玩家提交的自然语言不会直接变成攻击加值、DC、伤害公式、骰点或最终伤害。
- Owner 可以解释一次机械结果：为什么需要投骰、目标值和修正值来自哪里、掷出了什么、最终产生了什么状态变化。
- 网络重试、Provider 重放和叙事重试不会重新掷骰、重复扣血或重复推进状态。
- 不支持的开放式动作不会被主 Narrator 随意拍出 DC，而会明确进入 `GM_ADJUDICATION_REQUIRED`。
- Narrator 失败不会回滚已经提交的机械结果，也不会导致重新掷骰。

## Confirmed repository facts

- 上一阶段已经建立 `CampaignMutationCoordinator`、campaign state revision/CAS、AI stale-result rejection、`AiResolutionProposal → ResolvedOutcome → ValidatedStateChange` 边界。
- `packages/contracts/src/runtime.ts` 当前的 `ActionIntent` 仍只有 `actionId`、`campaignId`、`actorId` 和原始 `input`。
- `packages/contracts/src/runtime.ts` / `packages/contracts/src/combat.ts` 当前的 combat proposal 仍允许 `apply_attack` 携带 `attackBonus`、`damageDie`、`damageDice`、`damageBonus`，允许 `apply_saving_throw` 携带 `saveBonus`、`dc`、`damageOnFailure`，并允许直接 `apply_damage`、`apply_healing`、条件增删。
- `CombatService` 已在服务端使用注入的 `random()` 计算 d20、先攻和伤害，但目前结果只在事务内直接作用于 combatant，没有独立的 `RollPlan` / `RollRecord` 持久化和按 execution 复用机制。
- `CombatAiAdapter` 与 Owner HTTP combat command 复用同一 `CombatCommandPort`；下一阶段必须把 Provider-facing action contract 与 GM/debug 直接命令区分开，不能让 AI 继续提交机械数字。
- `platform_turn_entries` 仍支持旧的 `dice_result` entry 类型；本阶段的新正式机械结果应来自服务端 RollRecord/ResolvedOutcome，旧 entry 数据保持可读兼容。
- 角色 sheet 目前是可扩展 JSON，只有部分 derived values 有审计来源；仓库中没有完整的 action definition/equipment/ability registry。
- 当前普通迁移维护集合是 `001..010`、`012..015`；新增持久化结构必须遵守显式 migration/startup 边界，不得让普通启动猜测式应用任意 pending migration。
- 当前 `AiContextBuilder` 支持按 audience 构造 context，但正式 AI resolution 主路径仍使用单次 Provider 调用；玩家可见 Narration context 尚未成为独立的正式调用边界。

## Requirements

### ADJ-001：Provider 不得决定机械参数

Provider-facing proposal 不得包含或提交以下权威机械数据：

- `attackBonus`、`saveBonus`；
- `dc`、`AC` 或其他目标值；
- `damageDie`、`damageDice`、damage formula；
- 最终 damage/healing amount；
- raw dice、total、critical 判定；
- 直接 `apply_damage`、`apply_healing`、`add_condition` 等可绕过裁定的机械命令。

非法字段、旧数字型 combat command 和跨 campaign target 必须 fail closed，并返回受控的 `AI_OUTPUT_INVALID` 或等价错误；不得静默采用 Provider 数值。

### ADJ-002：ActionIntent 只表达语义选择

`ActionIntent` 至少能够表达：

- 稳定 id、campaign、actor、原始输入和 based-on revision；
- `mode`、`actionType`、可选 `actionRef`；
- `targetIds`；
- declared approach、desired outcome、resource choices 和 fallback policy（字段可按 MVP 取子集）。

第一阶段至少支持：

- `ability_check`；
- `attack`；
- `saving_throw`；
- `healing`；
- `use_action`；
- `improvised_action`。

`ActionIntent` 不得包含攻击加值、DC、伤害公式、最终伤害或骰点。

### ADJ-003：服务端决定裁定类型

建立可审计的 `AdjudicationDecision` 结果，至少包括：

- `automatic_success`；
- `automatic_failure`；
- `roll_required`；
- `player_choice_required`；
- `gm_adjudication_required`；
- `unsupported`。

MVP 只对拥有明确规则、角色数据和场景参数的动作自动裁定。无法安全确定的开放式动作必须返回 `GM_ADJUDICATION_REQUIRED`，不得由主 Narrator 临时生成 DC 或机械结果。

### ADJ-004：RollPlan 先锁定再掷骰

需要检定时，服务端必须在掷骰前创建并锁定 `RollPlan`，至少记录：

- plan/action/campaign/actor/target 标识；
- roll kind、骰子表达式和服务端 modifier breakdown；
- advantage/disadvantage；
- target type/value；
- success/failure stakes；
- ruleset identity/reference；
- based-on `StateRevision`；
- locked time 和可验证的 plan hash。

普通流程中 RollPlan 锁定后不能修改。GM 修改必须是独立、可审计的 override，不得覆盖原 plan 或伪装成普通 AI proposal。

### ADJ-005：DiceService 和 RollRecord 必须由服务端拥有

所有正式骰点必须由服务端 `DiceService` 生成并形成 `RollRecord`。至少覆盖 d20、advantage/disadvantage、基础 damage/formula 所需的确定性解析。

`RollRecord` 至少记录：

- rollPlan/action/execution/mutation 标识；
- raw dice、selected dice、modifier breakdown、total；
- target value 和 success/failure result；
- ruleset、state revision、rolledAt。

同一个 campaign + action intent + execution 的重试必须复用原 RollRecord，不得重新掷骰或生成第二条正式记录。

### ADJ-006：最小 Rules Slice

只实现足以验证机械权威的最小规则切片：

- ability check；
- saving throw；
- 单次 attack roll；
- advantage/disadvantage；
- AC 或固定 DC 比较；
- 基础 critical hit；
- 基础 damage roll；
- 基础 healing；
- HP 变化；
- 服务端 modifier breakdown。

规则身份继续使用稳定 `rulesetId/version`。规则实现可以先采用代码 fixture/内部定义，但不得重新引入规则资料登记表、外部规则来源 metadata registry 或 content hash 链路。

### ADJ-007：所有进入 ResolvedOutcome 的成员必须已验证

除 `stateChanges` 外，以下 proposal 也必须完成 schema、campaign ownership、visibility 和 domain validation 后才能进入正式 `ResolvedOutcome`：

- `worldFactCreations`；
- `encounterStarts`；
- `interactionRequests`；
- RollPlan、RollRecord 和机械 effect 引用。

建议形成对应的 proposed/validated 类型边界；shape parsing 不得伪造 validated brand。

### ADJ-008：机械提交与叙事提交分离

最终流程必须逻辑上区分：

1. Intent interpretation；
2. 服务端 adjudication；
3. RollPlan / Dice / ResolvedOutcome；
4. 权威机械事务提交；
5. NarrationOutput 生成与写入。

Interpretation 和 Narration 可以使用同一个 Provider/模型，但必须使用不同 contract 和 context。Narrator 不得返回 StateChange、DC、RollPlan、DiceResult 或额外机械效果。

### ADJ-009：Narration context 不得泄露 GM-only 内容

至少建立以下最小 audience 边界：

- Intent context：actor/party scoped；
- Adjudication context：只包含客观机械所需数据；
- Player Narration context：只包含玩家可观察的状态、已提交行为、服务端 ResolvedOutcome 和可公开表达信息。

Player Narration context 不得包含 GM-only block、其他玩家私密知识、Owner raw context 或未来剧情秘密。

### ADJ-010：叙事重试不能改变机械结果

机械 resolution 成功后，Narration 失败只能创建新的 narration attempt 或幂等 mutation：

- 不重新掷骰；
- 不重新计算 DC、modifier 或 damage；
- 不重复写入 StateChange；
- 不覆盖已提交的 ResolvedOutcome。

### ADJ-011：所有阶段绑定 StateRevision

至少以下对象需要携带或可追踪到状态版本：

- ActionIntent；
- RollPlan；
- RollRecord；
- ResolvedOutcome；
- Narration request/attempt。

Intent、RollPlan 或 formal resolution 变得 stale 时必须 fail closed。一次机械 resolution 无论写多少业务表只推进一次 revision；Narration 重试不能推进第二次机械 revision。

### ADJ-012：GM/debug 直接命令与 Provider-facing action 隔离

Owner/debug 可以保留直接 combat command，但必须：

- 使用独立权限和入口；
- 产生独立 audit/override 事件；
- 不复用 Provider proposal contract；
- 不允许 Provider 借用该入口绕过 adjudication。

### ADJ-013：保留现有运行时安全边界

不得回退：

- `CampaignMutationCoordinator` 的 CAS、ledger 和 mutation id 幂等；
- AI stale-result rejection；
- Player/Owner visibility projection；
- archive superseded 语义；
- Provider 单次调用的既有流程，直到本阶段明确引入解释调用与叙事调用；
- 旧 `dice_result` entry 和历史数据的读取兼容。

### ADJ-014：可观测性

Owner-safe API、测试或受控 trace 至少能够解释：

- 玩家原始输入；
- 解析出的 Intent；
- 服务端选择的 adjudication decision；
- RollPlan 的规则/目标/修正来源；
- raw dice、selected dice、total 和结果；
- ResolvedOutcome 产生的状态变化；
- Narration 使用的 Outcome 和重试次数。

不得向 Player 暴露 GM-only context、凭据、Provider 原文或其他玩家私密知识。

## Out of scope

- 完整 D&D 5.5e/2024 rules engine；
- 完整 spell、condition、reaction、opportunity attack、weapon mastery、multiattack、复杂 action economy、AoE、cover/line-of-sight 和 death save；
- TacticalScene/grid、完整 NPC tactical AI、NPC planning agent、WorldClock、Quest/Relationship 全量 runtime；
- Worldbook / KnowledgePack、FTS/vector/reranker、Embedding；
- 完整 GM Console、漂亮 Inspector UI、Prompt Preset UI；
- 完整 NarrativeRound / FactCompiler；
- 恢复已删除的 `platform_rule_sources`、content hash 或外部规则来源登记；
- 为了保留流程连续性而让 Narrator 或 Provider 猜测未支持的 DC、骰点或机械效果。

## Acceptance criteria

- [ ] Provider-facing contract 无法提交 attack/save modifier、DC、damage formula/amount 或正式骰点；旧数字型 combat proposal fail closed。
- [ ] `ActionIntent` 只包含语义选择，并能关联 actor、target、actionRef 和 based-on revision。
- [ ] 至少一个 ability check、saving throw、单次 attack/damage、healing 纵向 fixture 由服务端产生 RollPlan、RollRecord 和 ResolvedOutcome。
- [ ] RollPlan 在掷骰前锁定，RollRecord 能解释 modifier/target/result，且 plan hash 可验证。
- [ ] 同一 execution 重试返回同一 RollRecord，不重新掷骰、不重复扣血、不重复推进 turn/revision。
- [ ] 不明确或不支持的动作返回 `GM_ADJUDICATION_REQUIRED`，不由主 Narrator 猜 DC。
- [ ] `worldFactCreations`、`encounterStarts`、`interactionRequests` 和 state changes 在进入 ResolvedOutcome 前都有 validated boundary。
- [ ] 机械提交与 Narration 分离；Narrator 只能消费已提交 Outcome，不能返回机械状态变化。
- [ ] Narration 重试不重新掷骰、不重复应用机械 mutation，且 Player Narration context 不含 GM-only 内容。
- [ ] stale Intent/RollPlan/formal resolution fail closed，mechanical transaction 只推进一次 StateRevision。
- [ ] GM/debug 直接命令与 Provider-facing action contract、权限和审计路径隔离。
- [ ] 使用临时 SQLite fixture 覆盖 contracts、adjudication、dice、idempotency、stale、visibility 和 narration retry；不读取仓库根目录或配置开发数据库。
- [ ] `npm test -- --maxWorkers=1`、`npm run typecheck`、`npm run build`、`git diff --check` 通过。

## Confirmed planning decisions

- 保留现有多人回合模型，不把一个 turn 限制为单个 Intent。
- 每个已提交玩家 action 都生成一个 `ActionIntent`。
- 同一 turn 内按稳定顺序处理 Intent：`submitted_at ASC`，时间相同再按 action id 排序。
- 同一 turn 的机械 adjudication、RollPlan、RollRecord、ResolvedOutcome 和状态写入共享一个 authoritative transaction，并只推进一次 StateRevision。
- 同一 turn 内后续 Intent 读取前序 Intent 已提交到当前事务的状态；如果前序结果使后续 Intent 不再合法，后续 Intent fail closed 或进入 `GM_ADJUDICATION_REQUIRED`，不得使用过期状态继续写入。
- 该选择保留当前多人回合和剧情历史语义，代价是设计中必须明确同回合 Intent 的顺序、冲突、失败隔离和部分结果可见性。

## Planning status

本任务仍处于 Trellis planning。复杂任务必须先完成 `design.md`、`implement.md` 以及 sub-agent context manifests；在最终 planning summary 获得用户明确批准前，不运行 `task.py start`，不修改产品代码。
