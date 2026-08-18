# Actor Foundation Integration Seam Follow-up

## 背景

`716b289` 已完成 Actor-aware context、V3 archive、Combat runtime seed、multi-Actor read/API 和 022 adjudication identity，但 production integration 仍有三个冻结前缺口：

1. production narrative worker / lease sweeper 没有复用 composition root 创建的 actor-aware `NarrativeRoundService`，自动关闭第一轮后会为下一轮创建 legacy player participant，导致多 Actor 用户的下一轮 readiness 永远无法完成；
2. 真正的 pre-Actor V1/V2 archive 可能没有 `actorId`，当前 restore 会留下 actorless Combatant/runtime，后续 Combat projection 与 Actor runtime 分叉；
3. Narrative/Adjudication 的 `MechanicalResolutionService` 调用 runtime mutation 时没有传 `mechanicsMaxHp`，healing 可以突破 authoritative runtime 的 max HP。

## 目标

只修复这三个 integration seam，不扩展 ActorKnowledge、Worldbook 或完整 D&D mechanics。

### P0-1 Production actor-aware worker wiring

- composition root 创建的 actor-aware `NarrativeRoundService` 必须成为以下模块的共享实例：
  - `TurnService`；
  - `NarrativeWorkCoordinator` / `NarrativeWorkRuntime`；
  - `NarrativeDecisionResolutionService`（通过 `AiResolutionService` 注入）；
  - lease sweeper 使用的 coordinator。
- production 不得再由 worker/coordinator/AI service 隐式 `new NarrativeRoundService(...)` 形成 actor-unaware seam。
- 自动完成第一轮并创建下一轮后，下一轮必须只包含 canonical Actor participants/Decisions。
- 同一用户控制多个 Actor 时，第二轮两个 Actor 都提交后必须能够 ready、resolve、close。

### P0-2 True V1/V2 archive actorization

- V1/V2 restore 继续可读，并为恢复后的 approved Character 确保 Character Actor、player binding 和 runtime baseline；Actor row 缺失时必须创建。
- V2 combatant：
  - 有 `actorId` 时校验并使用 campaign 内 Actor；
  - 无 `actorId` 且有 `characterId` 时解析/创建对应 Character Actor；
  - 无 `actorId` 且无 `characterId` 时创建 deterministic legacy NPC Actor，例如 `actor:combatant:<combatantId>`。
- 恢复的 Combatant 必须写入解析后的 canonical `actor_id`，不能因旧 JSON 缺少字段而恢复成 actorless projection。
- 旧 snapshot revision 不得写回 live StateRevision；恢复仍使用 restore mutation revision。

### P1 Narrative mechanical healing cap

- Combatant target 的 healing 必须传 `combatant.hp_max` 给 runtime mutation。
- direct Character/Actor target 能从 authoring sheet 推导 `hpMax` 时，必须传入该上限。
- 无法推导合法 max HP 时保持现有受控 fallback，不新增 runtime maxHp 持久字段。
- Combat projection 与 authoritative runtime 在 healing 后保持一致。

## 非目标

- 不新增 ActorKnowledge/Worldbook。
- 不重写 Actor identity 双身份模型。
- 不新增 runtime `maxHp` 持久字段。
- 不做 Player UI 重构。
- 不修改已发布迁移 020/021/022；本 follow-up 如无 schema 必要不新增 migration。

## 验收标准

1. two-round production composition vertical regression：同一用户控制 Actor A/B，Round 1 自动 resolve/close，Round 2 participants 恰为 A/B 且无 `actor_id IS NULL` required participant；Round 2 A/B 提交后仍可自动 resolve/close。
2. genuine pre-Actor V2 JSON regression：snapshot schemaVersion=2，combatant 对象不包含 `actorId`；恢复后 Character combatant 与 legacy NPC combatant 都有 canonical Actor，damage/healing 同时更新 Combatant projection 和 runtime。
3. V1 restore regression：approved Character 缺失 Actor row 时，restore 会创建 Character Actor、binding 和 runtime baseline。
4. Narrative mechanical healing regression：combatant target 和 direct Character Actor target 的 runtime HP 都不会超过各自 mechanics max HP。
5. 共享 wiring 不破坏既有 legacy compatibility fixtures；已有 server/contracts tests、typecheck、build 继续通过。
