# Technical Design — Actor & Character Runtime Foundation

## 1. Boundary and ownership

本任务引入一个独立的 `actors` domain seam，作为 Campaign 内世界行动者的唯一 identity owner。现有系统的 `userId/playerId` 仍保留为认证和 action submitter identity，不在 migration 中被重新解释：

```text
userId       = 登录账号
playerId     = action submitter / legacy compatibility
actorId      = Campaign 内的世界行动者
characterId  = authoring/build 资料
combatantId  = encounter-local instance

CampaignActor
  ├── ActorControlBinding[]
  ├── optional Character authoring reference
  └── CharacterRuntimeState
```

现有代码的风险点是：Narrative `decision.actor_id`、Adjudication `ActorMechanics.id` 目前实际使用 `player_id`；Combatant 的 `id` 又是另一套 encounter instance identity；同一个 player 的多个 approved Character 还会被 `Map<player_id, CharacterRow>` 覆盖。Phase 4 必须让这些语义在 resolver 和持久化字段层面显式化。

推荐的 server module owner：

```text
server/src/modules/actors/
  ActorRepository.ts
  ActorControlBindingRepository.ts
  CharacterRuntimeStateRepository.ts
  ActorService.ts
  ActorRuntimeStateService.ts
  actor.test.ts
```

现有 `modules/characters` 继续负责 Character authoring、审核和构筑资料；它不再拥有 HP/conditions 等 live runtime mutation。现有 Narrative/Combat 模块通过 Actor service/port 解析 identity 和 runtime state，不直接查询 users 或改写 Character sheet。

`@dnd/contracts` 新增或扩展一个单一的 Actor contract owner（优先复用现有 runtime contract 文件，只有在现有模块无法表达 identity 时才新增 `actor.ts`），并从 `src/index.ts` 导出。不得在 Narrative、Combat、Character 三个模块各自定义 Actor enum 或 DTO。

## 2. Domain contracts

### CampaignActor view

```text
id: string
campaignId: string
displayName: string
characterType: player_character | npc
controlMode: player | ai | gm | shared | scripted
mechanicsMode: pc_build | npc_statblock | lightweight
characterId: string | null
createdAt: ISO string
updatedAt: ISO string
```

`characterId` 是 authoring reference，不是 runtime identity；NPC 可以为 null。

### ActorControlBinding view

```text
id: string
campaignId: string
actorId: string
userId: string | null
bindingRole: player | gm | operator
active: boolean
createdAt: ISO string
updatedAt: ISO string
```

实际枚举必须复用仓库已有角色/成员权限 vocabulary；如果现有模型无法表达 userless AI/GM/scripted control，则 `userId` 保持 nullable，控制来源由 Actor 的 `controlMode` 和服务端调用上下文决定。

### CharacterRuntimeState view

```text
campaignId: string
actorId: string
currentHp: integer
temporaryHp: integer
conditions: bounded condition list
runtimeStatus: minimal lifecycle enum
stateRevision: non-negative integer
updatedAt: ISO string
```

`runtimeStatus` 只表达 runtime lifecycle，不承载完整规则引擎。实施时优先复用现有 Combat/Character status contract；如果没有可复用值，采用最小、可扩展且不带职业规则语义的枚举，并在 contract test 中锁定。

所有 public DTO 使用 camelCase 和显式 nullable 字段；SQL row mapping 只存在于 server repository/service。

## 3. Persistence model and migration

新增 numbered migration（当前 approved set 下一编号），创建：

```sql
platform_campaign_actors
platform_actor_control_bindings
platform_character_runtime_states
```

采用 additive/dual-identity cutover：不把已存在的 `platform_actions.player_id`、旧 Narrative `actor_id`、旧 roll-plan FK 或 archive payload 直接改解释为 CampaignActor ID。新 live identity 通过新增 actor columns/映射进入；旧字段继续作为 submitter/legacy audit compatibility 保留，直到未来独立迁移任务明确清理。

基本约束：

- Actor 属于一个 Campaign；`(campaign_id, id)` scope 校验必须 fail closed；
- Actor 的 `character_id` 可为空，且不能跨 campaign 引用 authoring Character；
- Runtime state 以 Actor 为唯一 live row；同一 Actor 不允许多份 active runtime state；
- Binding 允许 userless Actor；同一 active binding 不重复；
- `state_revision` 记录最后一次应用该 runtime state 的 campaign StateRevision，不创建第二套 revision authority；
- JSON `conditions` 使用受限 payload，不能成为任意 JSON dump；本任务只定义最小边界，完整 Fact payload hardening 仍是后续任务。

### Existing data bootstrap

迁移必须提供确定性的 backfill：

1. 为每个现有 approved Player Character 创建一个 CampaignActor；
2. 用现有 Character owner/player 关系创建 active Player binding；
3. 创建对应 CharacterRuntimeState；
4. 为现有 Narrative participant/Decision、active Combatant 和需要进入新 live path 的 adjudication rows 建立 actor mapping；旧历史 rows 保留原字段和可读语义；
5. 从 legacy `sheet_json.hpCurrent` 读取初始 HP，但只在迁移/初始化阶段使用；缺失、类型错误或越界值必须采用显式安全策略并记录/测试，不能静默制造不受约束的 authoritative HP；
6. 保留原 Character row 和 sheet 内容不变。

新增/回填 actor columns 后：

- 新 live runtime 只使用 CampaignActor ID；
- `player_id` / legacy `actor_id` / `character_id` 仅作为 submitter、authoring 或 audit compatibility data；
- repository 的 active reads 必须显式按 Actor 解析，不能在新路径 fallback 到 `userId`；
- 同一 User 的多个 Actor 必须独立解析，禁止 `Map<player_id, CharacterRow>` 覆盖；
- SQLite 需要重建表时，必须保留现有 FK、审计行和索引语义。

## 4. Runtime mutation flow

所有 runtime effect 走同一个 server-owned seam：

```text
Combat/Adjudication validated effect
  → ActorRuntimeStateService.applyIn(tx, actorId, effect, stateRevision)
  → validate campaign ownership + bounds + current state
  → update runtime row
  → record applied StateRevision
  → surrounding CampaignMutationCoordinator transaction commits
```

服务不得自行开启顶层 transaction；当调用方已经持有 `tx` 时只能使用 `*In` seam。需要独立 command 时，由 service 以 mutation id 调用现有 coordinator。

最小 effect 支持：

- damage：先扣 temporary HP，再扣 current HP；不得低于 0；
- healing：按当前任务既有规则/命令边界恢复 current HP，不在此任务扩展完整 5.5e 规则；
- condition add/remove：按稳定 condition id 去重/删除；
- runtime status 更新必须由 server-owned service 决定。

`CombatStateChangeApplier` 和任何旧 `MechanicalResolutionService` 路径必须改为调用 runtime service；`CharacterRepository.update` 不再用于 runtime HP mutation。Authoring sheet 只能由 Character authoring/review flow 修改。

## 5. Identity resolution and authorization

建立明确的解析顺序：

```text
request user / GM context
  → Campaign membership / control binding authorization
  → CampaignActor
  → optional Character authoring
  → CharacterRuntimeState
```

- User A 控制 Kayla 只能通过 active binding；不能把 `userId` 直接传给 Narrative/Combat 作为 actor identity；
- NPC/AI/scripted actor 不需要 User；调用方必须明确 control mode；
- 一个 User 可以有多个 active Actor binding；
- `shared` 只允许已授权的 campaign members 按 binding/policy 控制，不能隐式扩大权限；
- GM-controlled actor 使用 campaign GM authorization，不创建伪造的 player binding。

## 6. Narrative integration

- 新 live `platform_narrative_decisions.actor_id`/actor column 的 meaning 变为 CampaignActor ID；旧历史 `actor_id REFERENCES users(id)` rows 通过兼容映射读取，不直接改写历史语义；
- Narrative participant/Decision creation 通过 Actor service 从 User binding、Character relation 或 userless NPC 得到 actor；participant uniqueness 和 close boundary 按 Actor，而不是只按 player；
- `NarrativeDecision.actorId`、WorkingFact provenance、`audienceActorIds` 和 visibility projection 统一使用 Actor ID；
- `platform_actions.player_id` 继续表示 action submitter；一个 User 控制多个 Actor 时，actor selection/creation 必须显式记录；
- 当前冻结的 Presentation checkpoint、terminal scheduling、Round close 和 Fact authority 不变；
- 现有 `playerId` 只用于兼容输入/审计映射，不得进入新的 `Decision.actorId` 返回值。

验收路径：User A controls Kayla → Kayla Actor → Narrative Decision actorId=Kayla Actor ID；userless NPC Elena 可以创建 Actor 并被加入 Narrative round，而不要求 users row。

## 7. Combat integration

- `platform_combatants` 增加/回填 `actor_id`；PC 与 NPC 都必须可解析到 CampaignActor；
- `Combatant.actorId` 是 CampaignActor ID，`Combatant.id`/`combatantId` 仍是 encounter-local instance；`actorCombatantId` 命令继续表示 combatant instance，避免两种 ID 混淆；
- Combat start 以 CharacterRuntimeState 为 PC actor 的初始化/权威来源；Combatant 可保留当前 encounter projection，但 actor runtime mutation 与 combat projection 必须在同一个 coordinator-owned transaction 中保持一致；
- owner command / Provider semantic proposal 不能直接注入 `attackBonus`、DC、damage 等未验证数值；继续服从现有 adjudication authority；
- 最小 damage/healing/condition path 读取并更新 CharacterRuntimeState；
- 完整 action economy、typed statblock、rules derivation 留到后续阶段。

## 8. Composition and API compatibility

- `app.ts`/test composition root 创建 Actor service、runtime state service 并注入 Character/Narrative/Combat consumers；
- 不引入 generic DI container；
- 不新增完整 Actor management UI；如现有 HTTP vertical flow 需要暴露 actorId，只做 contract/response 的最小兼容更新；
- 新增错误码前先检查现有 `AppErrorCode`，只为无法复用的跨 campaign actor、binding、runtime conflict 增加稳定错误码；
- route 只做 parse/auth context/DTO，授权、事务和 mapping 留在 service。

## 9. Transaction, replay, and rollback

- Actor creation + binding + optional runtime state 初始化应在一个 coordinator-owned mutation 中完成；
- `CampaignMutationCoordinator` 是 Actor/runtime state 的唯一 revision authority；新增 actor columns 不得自行生成第二套 revision；
- HP/condition mutation 使用稳定 mutation id，重复 replay 返回既有结果而不重复应用；
- stale StateRevision、actor/campaign mismatch、deleted/inactive actor、非法 runtime payload 在业务写入前拒绝；
- migration failure 必须回滚全部新表/回填 rows；不能留下半个 Actor 或没有 runtime state 的 active Character；
- 现有 Narrative/Combat audit rows 不删除、不重写其历史 identity，只增加兼容映射。

## 10. Test strategy

测试 fixture 必须显式包含：

```text
User A -> Kayla Actor -> Character authoring
User A -> second Actor (no implicit overwrite)
NPC Elena -> Actor with no User and no Character authoring
```

并分别断言 `userId/playerId/actorId/characterId/combatantId` 的 ID 空间，不允许用相等值偶然通过测试。

- Contract tests：合法/非法 enum、nullability、bounds、conditions cardinality、cross-field rules、barrel export；
- Repository/service tests：Actor CRUD、binding resolution、userless NPC、multi-actor user、campaign isolation、runtime mutation/replay/stale；
- Migration tests：fresh DB、existing DB backfill、malformed legacy HP、failure rollback、manifest admission；
- Narrative vertical test：User → bound Actor → Decision.actorId，NPC without User；
- Combat vertical test：Combatant.actorId、damage modifies runtime state、authoring sheet unchanged；
- Composition test：production/test app actually wires the services；
- Regression tests：Narrative Runtime frozen invariant and existing Character/Combat/Adjudication tests remain green。
