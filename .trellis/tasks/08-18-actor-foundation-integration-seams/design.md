# Design: Actor Foundation Integration Seam Follow-up

## 1. Composition root single wiring owner

`app.ts` 是 production composition root，先构造唯一的：

```text
mutations
actors
narrative (NarrativeRoundService(..., actors))
turns (..., narrative, actors)
archives (..., actors)
ai (..., shared narrative)
narrativeWorkCoordinator (..., shared narrative)
narrativeWorkRuntime (..., coordinator, ai)
```

### Seam

`NarrativeWorkCoordinator` 增加一个可注入的 `NarrativeRoundService` adapter/依赖。默认值仍可为 actor-unaware service，保留底层 compatibility tests；production composition 必须显式传入已有 `narrative`。

`AiResolutionService` 增加可选的共享 `NarrativeRoundService` 依赖，默认保持现有测试构造兼容。其内部 `NarrativeDecisionResolutionService` 使用该实例，避免 claim/apply/failure/legacy next-turn 路径另建 actor-unaware service。

`PlatformApp` 返回 worker coordinator，供 `startPlatformServer` 将同一 coordinator 注入 `NarrativeClaimLeaseSweeper`。这样 worker、sweeper、HTTP/AI 使用同一 actor-aware round lifecycle implementation，而不是只共享数据库。

## 2. V1/V2 restore actorization

在 `ArchiveService.restoreActorRuntimeStateIn` 内保持 restore transaction owner 不变：

1. `CharacterRepository` 已先恢复 snapshot Character rows；通过 tx 查询 approved Character。
2. 使用注入的 `ActorService`（测试未注入时以当前 DatabasePort + mutation coordinator 构造兼容 adapter）调用 `ensureCharacterActorIn(tx, character, stateRevision)`，确保 PC Actor、binding、runtime row 存在。
3. 对 V2 combatants 解析 canonical Actor：
   - `actorId` 存在：验证 Actor 属于当前 campaign，且与 `characterId` 不矛盾；
   - `actorId` 缺失 + `characterId` 存在：查询恢复后的 approved Character，调用 `ensureCharacterActorIn`；
   - 两者都缺失：调用一个 deterministic `ActorService.ensureLegacyCombatantActorIn` seam，创建 `actor:combatant:<combatantId>` 的 userless NPC Actor，重复 restore 时幂等复用。
4. 返回 `Map<combatantId, actorId>` 给 combat restore 阶段；V1/V2 combatant upsert 使用解析后的 actorId。
5. 用 combatant hp/conditions 覆盖 runtime baseline；runtime rows 使用 restore mutation 的新 revision。
6. 快照外旧 runtime 继续 inactive；不删除 Actor/FK parent。

V3 不改变当前保存/恢复语义，但 combat restore 同样优先使用 snapshot combatant 的 actorId；若存在不一致则 fail closed，而不是生成 actorless projection。

## 3. Mechanical healing cap

`MechanicalResolutionService.applyEffect` 是 Narrative/Adjudication runtime mutation 的唯一 effect seam：

- `combatant` 分支传 `combatant.hp_max`；
- direct Character/Actor 分支从 `loaded.actors.get(actorId)?.hpMax` 传入；只有非负整数才作为 `mechanicsMaxHp`，否则沿用不设上限的既有 fallback；
- `ActorRuntimeStateService` 继续负责真正 clamp，MechanicalResolutionService 只负责把 server-owned mechanics cap 正确带到 runtime。

`CombatService` 已有的 cap 传递保持不变，避免复制 clamp 逻辑。

## 4. Regression test shape

### Production two-round vertical

在 composition/vertical test 中使用 `createPlatformApp` 的 injected `ScriptedAiProvider` 与同一 SQLite DatabasePort：

- 手工建立一个用户控制两个 approved Character Actors 的 campaign/turn；
- 使用 actor-aware TurnService 提交两个 Actor action；
- 调用 composition root 返回的 `narrativeWorkRuntime.runOnce()` 直到 Round 1 closed / Round 2 created；
- 查询 Round 2 participant/decision，断言只含两个 canonical Actor；
- 提交 Round 2 两个 Actor action，再运行 worker，断言 Round 2 closed、没有 NULL actor required participant。

Provider 脚本只根据 DB 中当前 `processing` Decision 返回真实 actionId/canonical actorId，不解析 prompt 文本。

### Old archive shape

在 archive/combat tests 中手工构造 schemaVersion=2 JSON：

- 删除 `actors`、`actorControlBindings`、`characterRuntimeStates`；
- 对每个 combatant 使用 `delete combatant.actorId`，确保真正旧 shape；
- restore 后断言 PC/NPC Combatant 的 `actor_id` 非空、runtime 存在，后续 damage 后两者同步；
- 另测 V1 approved Character 缺失 Actor row 后 restore 会重新 actorize。

### Healing

在 narrative/adjudication vertical test 中分别覆盖：

- Actor-backed combatant target：runtime 9 + healing 6 / hpMax 10 -> runtime/projection 10；
- direct Character Actor target：sheet hpMax 10，runtime 9 + healing 6 -> runtime 10。

## 5. Compatibility and failure policy

- 底层 `new NarrativeWorkCoordinator(db, outbox)` 与未注入 ActorService 的旧 fixtures 仍可运行，但生产 composition 不允许走默认 adapter。
- archive actorization 遇到跨 campaign Actor、Actor/Character 不一致或无法解析的旧 combatant 时 fail closed，不静默写入 actorless runtime。
- 不添加 migration，除非实现证明 deterministic actorization 需要新的 persisted schema；现有 020/021/022 已提供所需表/列。
