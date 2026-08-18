# Phase 4 — Actor & Character Runtime Foundation

## Goal

建立 Campaign 内稳定的世界内行动者身份与运行时状态边界，使 `actorId` 不再等同于登录用户 ID，并把 HP、conditions 等会随游戏推进变化的状态从 Character authoring sheet 中分离出来。

本任务只建立后续 Narrative、Combat、ActorKnowledge、World entity 和 D&D mechanics 共享的最小 runtime seam，不实现完整角色规则系统。

## Background / confirmed constraints

- `StateRevision`、`CampaignMutationCoordinator`、server-authoritative adjudication 和 Narrative Runtime 第一阶段已经冻结，不应重新设计。
- 当前 Character contract 的 `sheet` / `derived` 仍是开放 JSON；现有角色表承担创建、审核和构筑资料职责。
- 当前部分运行时效果仍直接读取/改写 `platform_characters.sheet_json.hpCurrent`。
- 当前多个路径仍使用 `userId` / `playerId` 作为 actor identity；Narrative Decision 和 Combat 需要迁移到 Campaign 内的 Actor identity。
- `Narration` 仍是 presentation-only checkpoint；本任务不得让 Narration 获得 authoritative mutation 权限。
- 本任务的 runtime state 写入必须继续通过现有 `CampaignMutationCoordinator` 和 StateRevision boundary。

## Repository evidence

- `platform_characters.player_id` 当前是 Character owner；没有 `CampaignActor` 表或 contract。
- `platform_narrative_round_participants` 以 `player_id` 为 participant identity，`platform_narrative_decisions.actor_id` 当前仍引用 `users(id)`。
- `platform_actions.player_id` 表示提交账号；它不能直接改名为 runtime actor identity，因为 action audit 需要保留 submitter。
- `platform_combatants.id` 是 encounter-local combat instance；当前没有 Campaign Actor reference，`character_id` 只是可选 authoring reference，NPC 通过 `character_id = null` 表示。
- `MechanicalResolutionService` 以 `player_id` 建立 ActorMechanics map，部分 effects 仍写入 `platform_characters.sheet_json.hpCurrent`；Combat 另有一套 `platform_combatants.hp_current` 状态。
- 现有数据库允许同一 player 拥有多个 approved Character，但多个 runtime path 使用 `Map<player_id, CharacterRow>`，会发生隐式覆盖。因此 Phase 4 必须显式表达“一位 User 可控制多个 Actor”，不能继续以 player map 推导角色。
- 旧 archive、action audit、adjudication rows 必须保持可读；新增 Actor identity 不能复用旧字段而改变历史 ID 的语义。

## Identity vocabulary

后续新路径必须明确区分：

```text
userId       = 登录账号身份
playerId     = action submitter / legacy participant compatibility identity
actorId      = Campaign 内的世界行动者
characterId  = Character authoring/build 资料
combatantId  = encounter 内的运行时实例
```

如果公共字段继续命名为 `actorId`，其含义必须明确为 `CampaignActor.id`，不能在不同模块中继续表示 User、Character 或 Combatant。

## Requirements

### R1. CampaignActor identity

新增稳定的 Campaign-scoped Actor 模型，至少支持：

- `characterType`: `player_character | npc`
- `controlMode`: `player | ai | gm | shared | scripted`
- `mechanicsMode`: `pc_build | npc_statblock | lightweight`
- 可选的 Character authoring reference
- 独立的 `actorId`，不复用 `userId`

Actor 必须可以在没有任何 User 的情况下存在，因此 NPC 不得依赖 `users` 外键才能创建或参与游戏。

### R2. ActorControlBinding

建立 User 与 Actor 的显式控制绑定：

- 一个 Actor 可以没有 User 绑定；
- 一个 User 可以控制多个 Actor；
- `controlMode` 决定默认控制语义，授权检查必须解析 Actor binding，而不是直接把 `userId` 当作 `actorId`；
- GM、AI、scripted 控制不得伪造 User binding；
- shared/player/NPC 场景必须有明确的服务端授权边界。

### R3. Character authoring 与 runtime state 分离

新增 `CharacterRuntimeState`，最小字段包括：

- `campaignId`
- `actorId`
- `currentHp`
- `temporaryHp`
- `conditions[]`
- `runtimeStatus`
- `stateRevision`
- `updatedAt`

`platform_characters` 继续保存角色创建、审核、构筑和 authoring 资料。正常机械效果不得再写回 `sheet_json`；Legacy sheet 中的 HP 只允许用于一次性迁移/初始化兼容。

### R4. Authoritative runtime mutation

所有 CharacterRuntimeState 的创建和修改必须：

- 由 server-owned service/repository 负责；
- 在 coordinator-owned transaction 中完成；
- 使用现有 StateRevision/CAS/idempotency 机制；
- 记录应用到 runtime row 的 `stateRevision`；
- 对旧 revision、跨 campaign actor、不存在的 actor 和非法数值 fail closed。

### R5. Narrative identity migration

Narrative Decision 的 live identity 必须使用 Campaign Actor：

- `NarrativeDecision.actorId` 返回 Campaign Actor ID；
- Kayla 的 Decision actor identity 不得再是控制 Kayla 的 User ID；
- participant/Decision 的 uniqueness、ordering、claim、visibility 和 context projection 必须通过 Actor identity 解析；
- 一位 User 可以控制多个 Actor，因此 round participant 不得继续只按 `player_id` 合并角色；
- NPC 可以作为无 User binding 的 Actor 进入允许的 Narrative flow；
- 现有 `playerId` 兼容字段若保留，只能表示提交者/历史审计身份，新的 live runtime 不得把它当作 Actor authority。

### R6. Combat identity and HP path

Combatant 必须能够引用 Campaign Actor，同时保留 encounter instance identity：

- `Combatant.actorId` 是 CampaignActor ID；
- `Combatant.id` / `combatantId` 仍是 encounter-local runtime instance，`actorCombatantId` 命令语义不因本任务改成 CampaignActor ID；
- 一个 Campaign Actor 可以拥有多个 Combatant instance；
- PC 与 NPC 都通过 Actor 进入 Combat，NPC 不再只是没有 `characterId` 的 encounter-only row；
- damage/healing/conditions 等最小 runtime effect 更新 `CharacterRuntimeState`；
- Character authoring sheet 不因 combat effect 被改写；
- 本任务不实现完整 D&D 2024 action economy 或完整 Combat rewrite。

### R7. Compatibility and migration

新增 numbered migration，不修改已应用 migration。推荐采用 additive/dual-identity 迁移，而不是重写旧字段语义：

- 支持 fresh SQLite database；
- 为现有 approved Character 和 userless NPC 建立确定性的 Actor/backfill 关系；
- 新 live rows 使用 `actorId`，旧 `playerId` / legacy `actor_id` 字段保留为 submitter/audit compatibility；
- 现有旧 archive、action、adjudication 和 Narrative rows 必须可读，不能把旧 User ID 伪装成新的 Actor ID；
- 明确旧 `playerId` / `characterId` 数据如何映射到 Actor；
- 更新 migration manifest 和 migration tests；
- 保留审计数据，不物理删除现有 Character、Action、Combat 或 Narrative rows；
- 任何需要 table rebuild 的 SQLite migration 都必须验证旧 FK、历史分支和 rollback。

### R8. Shared contracts and composition

- 新公共 DTO 先定义 Zod schema，再导出 inferred types；
- 新模块从 `@dnd/contracts` barrel export；
- server composition root 必须构造并注入 Actor、binding 和 runtime state services；
- 不引入通用 DI 容器；
- 不要求完整 Character UI 重写，客户端只做保持编译和现有响应兼容所必需的最小更新。

## Acceptance Criteria

- [ ] Contract tests 覆盖 Actor、ControlBinding、CharacterRuntimeState 的合法值、缺失/空值、非法 enum、负 HP/temporary HP、跨字段约束和 public barrel export。
- [ ] Fresh/temp SQLite migration 能创建 Actor、binding 和 runtime state 表；migration manifest、approved migration set 和 rollback/failure tests 同步更新。
- [ ] 现有 Player Character 能回填为 CampaignActor，并绑定原控制 User；迁移后角色 authoring sheet 内容保持不变。
- [ ] 同一 User 控制两个 Actor 时，两个 Actor 不会在 Character/Adjudication/Narrative state map 中互相覆盖。
- [ ] NPC Actor 可以在没有 User、没有 Character authoring row 的情况下创建、查询并进入 runtime。
- [ ] 一个 User 可以控制多个 Actor；Actor 可以没有 User；授权检查不会把 `userId` 直接当作 `actorId`。
- [ ] 新建/读取 Narrative Decision 时，`actorId` 是 CampaignActor ID；E2E 测试覆盖 User A controls Kayla Actor，以及 userless NPC Elena。
- [ ] Combatant 使用 Actor identity；Kayla 进入 Combat 后 `Combatant.actorId` 正确，`Combatant.id` 仍是 encounter instance；NPC 也可通过 Actor ID 参与。
- [ ] 机械 damage/healing 更新 `CharacterRuntimeState.currentHp` / `temporaryHp` / `conditions`，并记录正确的 StateRevision；`platform_characters.sheet_json` 不发生 runtime mutation。
- [ ] 重复 mutation/idempotency replay 不重复创建 Actor、binding、runtime state 或重复应用 HP effect；stale revision、跨 campaign actor 和非法 runtime patch 被拒绝。
- [ ] server composition 和至少一个 vertical/E2E 流程证明 Actor identity 在 Character、Narrative 和 Combat 之间保持一致。
- [ ] 现有 Narrative Runtime 第一阶段不变量保持不变：Decision → authoritative mechanics → WorkingFacts → presentation checkpoint → next Decision → Round close。
- [ ] 相关 server tests、contracts tests、typecheck、build 和 `git diff --check` 通过；已知的 root client `React.act` 测试环境问题须单独记录，不通过扩大本任务范围解决。

## Out of scope

- 完整 D&D 2024 Player Character build、职业、法术、物品和资源规则。
- 完整 NPC stat block、Monster manual 数据和 rules engine。
- ActorKnowledge、Relationship、Goals、Persona/Voice、RAG 或长期记忆 promotion。
- Worldbook、KnowledgeSync、Quest system。
- 完整 Combat rewrite、action economy、reaction/bonus action 等。
- Automatic archive recovery boundary、historical narration snapshot、Fact payload hardening 和独立 concurrency stress suite。
- Character Workspace UI 重写。

## Deferred / risks

- Existing `playerId`/`userId` compatibility may require a temporary adapter; it must not leak back into new Actor-owned paths.
- Legacy `sheet_json.hpCurrent` may be absent or malformed. Migration must define a deterministic safe initialization policy instead of silently inventing authoritative HP.
- SQLite foreign-key/table-rebuild constraints may require a compatibility column or explicit table recreation for Narrative/Combat rows.
- `runtimeStatus` should remain a minimal lifecycle enum and must not become a hidden full rules engine; reuse an existing status contract if one already exists.
- Multi-worker race coverage is deferred to the dedicated reliability task, but core writes must still use the existing coordinator/idempotency seams.

## Locked planning decisions

- 采用 **additive / dual-identity cutover**：新增 CampaignActor 与 actor columns；旧 `playerId`/legacy `actor_id` 保留为提交者和历史审计字段；新 live Narrative/Combat/Adjudication rows 使用 CampaignActor ID；旧 archive/history 只读兼容。
- 不直接重写旧 `actor_id`/`player_id` 的历史语义，避免破坏现有 FK、action audit 和 v1/v2 archive。
- Legacy `sheet_json.hpCurrent` 的读取只用于迁移/初始化；具体 malformed/missing 值策略在实现前以现有数据和测试约束锁定。
