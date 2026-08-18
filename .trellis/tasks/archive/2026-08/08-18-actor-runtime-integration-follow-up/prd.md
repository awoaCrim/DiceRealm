# Actor Runtime Integration Follow-up

## 背景

`bbc5d22 feat: add actor character runtime foundation` 建立了 CampaignActor、ActorControlBinding、CharacterRuntimeState，并完成了 Narrative/Turn/Combat 的首轮 Actor 接线。本 follow-up 不改变 Actor 的双身份模型，只修复 cutover 后的跨层 integration/correctness 问题。

## 目标

在冻结 Actor Foundation 前，确保：

1. Actor-scoped AI context 能把当前 Actor 的 action/private context 正确投影给 Provider，同时隔离 sibling Actor 数据。
2. Archive restore 能恢复 authoritative Actor/runtime state，并保持 live StateRevision 单调递增。
3. Combatant 创建以 Actor Runtime 为当前 HP/temporary HP/conditions 的 server-owned seed，不能被调用方的矛盾 runtime 输入覆盖。
4. Runtime healing 有 server-derived max HP 上界，普通 condition mutation 不会错误地重置 runtimeStatus。
5. Multi-Actor player read path 能读取 `actorId + myActions[]`，并提供最小 Actor read projection。
6. `npc + pc_build` 合法；characterType 与 mechanicsMode 保持正交。

## 非目标

- 不实现 ActorKnowledge/Worldbook。
- 不重写完整 D&D mechanics 或新增 runtime `maxHp` 持久字段。
- 不做完整 Player UI 重构；只补 shared DTO、server projection 和最小 Actor read route seam。
- 不重新解释历史 `player_id/actor_id` 字段，不回滚 020/021。

## 验收标准

### P0-1 Actor-aware AI Context

- live Decision 使用 `campaign_actor_id` 时，`AiContextBuilder` 通过明确的 Actor identity resolver 得到 `actorId`、controller user ids、`characterId`、legacy player id。
- 当前 action block 使用 Actor audience；Kayla 的 Provider context 必须包含 Kayla 当前 action，不得因 `player_id !== actorId` 被过滤。
- Kayla 的 character-private context/working facts/previous-round summary 可见； sibling Actor 的 raw action/private state 不可见。
- 至少有一次通过 `NarrativeDecisionResolutionService` + scripted Provider 的 vertical regression，而不是只调用 ContextBuilder。
- 历史 actorless/user-scoped rows 仍按 legacy player identity 可读。

### P0-2 Archive authoritative runtime restore

- 当前存档升级为 `ArchiveSnapshotV3`，包含 `actors`、`actorControlBindings`、`characterRuntimeStates`。
- V1/V2 snapshot 仍可 parse/restore；没有 runtime block 时执行明确的 legacy seed policy，不伪造 snapshot revision。
- V3 restore 精确恢复 Actor/runtime/binding 数据；snapshot 后发生的 runtime HP、temporary HP、conditions 不得残留。
- restore 分配新的 monotonic StateRevision；runtime rows 使用 restore 后 revision，不回退到 snapshot 中的旧 revision。
- snapshot 外的 future binding/runtime actor 不得继续作为 active live control/runtime source。

### P0-3 Combat runtime seed

- 已有 `actorId` 的 Combatant 创建从 ActorRuntimeState 读取 `currentHp`、`temporaryHp`、`conditions`；输入 `hpCurrent/conditions` 不能覆盖它们。
- `actorId + characterId` 不一致时拒绝；一致时 Combatant 保留正确 characterId。
- 未显式 actor 的 approved Character 和新 userless NPC 仍可创建并正确 bootstrap runtime。
- Combatant projection 与 runtime 后续 mutation 保持一致；Contradictory `hpCurrent` 不会造成首次 damage 时从输入值跳变。

### P1 hardening/projection

- healing 按调用方提供的 mechanics cap 限制在 max HP 内；runtime schema 不新增 maxHp 持久字段。
- add/remove condition 等不改变 HP 的 mutation 保留既有 runtimeStatus。
- Player turn DTO 增加 `myActions[]`，保留 `myAction` 兼容字段；多 Actor 用户可读到各自 action 和 actorId。
- 增加最小 campaign-scoped Actor read projection：player 返回 controlled Actors，owner 返回 campaign Actors。
- `npc + pc_build` contract/schema/service 测试通过。

## 关键回归

1. Kayla Actor submit exact action → background narrative Provider context 包含 exact action + Kayla private state，不含 sibling raw/private data。
2. Runtime HP=5/tempHP=3/poisoned → archive → mutate → restore → runtime 精确回到 5/3/poisoned，restore revision 仍高于 snapshot revision。
3. Runtime HP=4 → combat start supplied hpCurrent=20 → Combatant HP=4；damage 1 后 Runtime/Combatant 都为 3。
