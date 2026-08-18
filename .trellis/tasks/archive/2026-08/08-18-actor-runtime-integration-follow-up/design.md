# Design: Actor Runtime Integration Follow-up

## 1. Actor identity projection

新增一个只读的 `ActorContextIdentityResolver` seam（放在 `server/src/modules/actors/`），负责把 live `CampaignActor` 投影为：

```text
actorId
controllerUserIds[]
characterId?
legacyPlayerId?
```

它只依赖 `QueryExecutor`，不创建 transaction、不拥有 mutation。`AiContextBuilder` 使用该 seam；不在 ContextBuilder 内重复猜测 `actorId/playerId/characterId`。

规则：

- 新 Actor id 先查 `platform_campaign_actors`，controller users 从 active bindings 得到，PC 的 legacy player id 来自其 authoring Character/player binding。
- 找不到 Actor row 时保留旧兼容语义：把传入值当作 legacy player id，并寻找对应 approved Character。
- action 可见性：`action.actor_id === identity.actorId`；仅当 action.actor_id 为空时才用 `legacyPlayerId === action.player_id` fallback。
- Character private block、world fact knownBy、private combat target、Narrative projection 都同时使用 canonical actor id 与 legacy user id 的明确映射。
- Decision matching 同时支持 live `campaign_actor_id` 和 legacy `actor_id`，但不能把二者直接比较。

## 2. ArchiveSnapshotV3

在 contracts 中新增：

```text
archiveSnapshotActorSchema
archiveSnapshotBindingSchema
archiveSnapshotRuntimeStateSchema
archiveSnapshotV3Schema
```

V3 基于 V2 的 encounters/narrative/currentTurn/watermarks 字段，增加：

```text
actors[]
actorControlBindings[]
characterRuntimeStates[]
```

`archiveSnapshotSchema` 保持 V1/V2/V3 discriminated union。V1/V2 仍可读。

Capture：

- 捕获 campaign 当前 Actor rows、全部 bindings、全部 runtime rows。
- V3 为当前写入版本。

Restore：

- 进入 `CampaignMutationCoordinator.mutateIn` 后取得新的 `stateRevision`，传入 restore state。
- 先将 snapshot 外 binding deactivate、runtime 标记为 inactive，再 upsert snapshot actors/bindings/runtime；不删除历史 actor rows，避免破坏历史 FK。
- V3 runtime 使用 restore mutation 的新 revision；不使用 snapshot 的旧 `stateRevision`。
- V1/V2 legacy policy：根据已恢复 approved Character 的 `sheet.hpCurrent` 和 snapshot combatant projection 为缺少 runtime 的 Actor 建立基线；该 policy 不把旧 snapshot revision 写回 live head。
- V2/V3 combat/narrative 分支使用 `schemaVersion >= 2`，不能把 V3 当成 V1。

## 3. Combat seed and mechanics cap

`CombatService.createIn()` 先把每个 combatant input 解析成 server-owned seed：

- existing `actorId`：assert campaign ownership，若 `characterId` 存在必须等于 Actor.characterId；读取 runtime。
- `characterId` without actorId：resolve/ensure its Actor，读取 runtime。
- neither：创建 userless NPC Actor/runtime；只有此路径的 `hpCurrent/conditions` 是 runtime 初始化输入。

对 existing Actor：

```text
combatant.currentHp = runtime.currentHp
combatant.conditions = runtime.conditions
combatant.characterId = actor.characterId ?? input.characterId
```

`input.hpCurrent/conditions` 不作为 authoritative runtime。若 `runtime.currentHp > input.hpMax`，拒绝 contradictory mechanics cap，而不是静默制造 projection mismatch。

`ActorRuntimeStateService.applyEffectsIn()` 接受可选的调用方 mechanics cap（不持久化到 runtime schema）。Combat 传入 `target.hp_max`，healing 后 clamp 到 cap。无 HP 变化的 condition mutation 保留既有 runtimeStatus；HP mutation 只在确有规则性状态变化时更新 defeated/active。

## 4. Player read projection

`TurnPlayerView` additive 增加：

```text
myActions: TurnAction[]
myAction: TurnAction | null  // legacy first action
```

`TurnRepository` 增加 active actions by player list，按 `submitted_at ASC, id ASC` 稳定排序。player view 同时返回完整 `myActions` 与兼容 `myAction = myActions[0] ?? null`。

新增最小 `actors` GET route：

```text
GET /api/campaigns/:campaignId/actors
```

owner 读取 campaign actors；player 只读取 active controlled actors。route 只负责 campaign membership/DTO，授权和 projection 保留在 service。

## 5. Contract compatibility

- 删除 `campaignActorSchema` 对 `npc + pc_build` 的 cross-field rejection。
- `createNpcActorInputSchema.mechanicsMode` 接受完整 `actorMechanicsModeSchema`，默认仍为 `lightweight`。
- 共享 DTO 继续由 `@dnd/contracts` 导出，client 只消费 schema，不在 client 重新定义。
