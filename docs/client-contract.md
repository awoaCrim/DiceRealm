# Unity / Server contract v1

> 内容导入改造：生产流程已取消内置剧本和默认提示词，新战役保持空白。下文涉及雾港、灯塔、巡守等固定内容的部分是旧版回归场景记录，不再是启动默认值。当前入口、数据格式和限制以 [剧本与提示词导入](content-import.md) 为准；检定、资源、存档和权限规则仍由服务端执行。


行动连续性增量协议见 [行动、裁定与剧情后果](adventure-continuity.md)：新增只读 `/activity` 与 `/activity/{sequence}`，主持专用 `/rulings/story-options`、`/rulings/story-preview`、`/rulings/story`。`GameEvent.origin`、`PendingRuling.originSequence/story/privateText` 均为可选兼容字段。`privateText`（裁定与事件各一）只给该行动者席位与主持，其他席位恒为空串，见 [契约](../.trellis/spec/contracts.md)。旧记录不补造输入与消耗，分页范围固定原事件，关联进展报告当前版本。

Current player roll lifecycle: [contextual rolls](contextual-rolls.md). Unity button actions use `/actions/propose`; **new natural-language main input** uses `/actions/input` (five `ActionRequest` fields, continuation, character review, world-memory and host corrections: [input-driven adventure](input-driven-adventure.md)). Older `/actions/interpret` + `/intents/respond` remain compatible with persisted requests and their original fingerprints; see [contextual action understanding](action-understanding.md). `snapshot.pendingIntent`, `Resolution.intentId`, `ActionOrigin.clarifications`, `snapshot.pendingRoll` and `Resolution.rollId` are optional additions. New host responses use `/rulings/respond`; original endpoints below remain compatible for persisted requests.

Implementation contract for the playable slice, visual asset authoring and node map. JSON properties are camelCase. The Unity client never rolls dice, changes inventory, or predicts authoritative state. Ordinary actions cannot supply DCs; the separate host-only DM endpoint accepts explicit bounded check parameters. Server default: `http://127.0.0.1:5180`. No editor or AI credentials belong in the client.

- `POST /api/v1/campaigns` body `{ "name":"我的战役" }` creates a host-only campaign and returns `{ "accessToken":"...", "snapshot": CampaignSnapshot }`. Workbench sends no character fields: `snapshot.character=null`, `party.isHost=true`, and `party.members=[]`. Optional adventure/prompts retain their existing contracts. The explicit `{name,characterName,build}` API remains compatible for a complete validated build, but has no new UI entry. A nonempty character name without `build`, a preset request or legacy `creation` is rejected; no preset fallback creates a player.
- `GET /api/v1/campaigns/{id}` returns `CampaignSnapshot`. Requires `Authorization: Bearer <accessToken>`.
- `POST /api/v1/campaigns/{id}/actions` body `{ "requestId":"UUID", "expectedVersion":1, "kind":"observe", "target":"", "text":"" }` returns `{ "snapshot": CampaignSnapshot, "resolution": Resolution, "replayed":false }`. The client retains the exact request and ID on transport failure; retries must not reroll. A 409 stale_version requires refresh and a new deliberate action. 409 idempotency_conflict means same ID with different payload. Duplicate identical requests return the original resolution and current snapshot.
- This `/actions` list is the **legacy/button execution contract**: `observe`, `investigate`, `talk`, `travel` (target scene ID), `natural` (text required). Buttons must come from snapshot.availableActions. New input may first clarify, safely narrate, offer/execute a server-owned candidate, or refer a genuine unknown to a DM; it does not turn all free text into an automatic ruling or grant arbitrary travel. The bounded encounter and rest commands below are supported; the verified spell subset is described below; broader combat still requires adjudication.
- `GET /api/v1/campaigns/{id}/events?after=0&limit=100` returns a root JSON array of events with sequence > after, ordered ascending (limit 1..200). Snapshot.events projects the visible portion of the most recent 100 events; unconfirmed intents belonging to other seats are omitted, and this legacy array endpoint scans past private events; this remains a compatible low-level endpoint. The current Unity journal uses the frozen-horizon page below.
- `GET /api/v1/campaigns/{id}/assets/{assetId}` is read-only legacy compatibility. New scenes return `removed / scene_generation_removed`; never poll or queue scene generation. Existing ready files keep their old public `/assets/<sha256>.png` addresses. New maps use authenticated private downloads instead.
- `snapshot.map` is the server projection of visited nodes plus currently legal travel targets. `nodes[]` contains `{id,title,state,canTravel,hint,x,y}` with `state=current|visited|discovered` and normalized layout coordinates. `edges[]` contains `{from,to}` for current legal routes only. The client must not infer hidden routes or teleport; map clicks first open a read-only review, and confirmation submits the same `travel` action with version/idempotency checks. **Approved guest seats** may use currently legal travel and combat-start options; permission is not host-only. A new `worldMemory` place with unknown scene or no image coordinates is read-only context, never a generated map node or newly legal route. Lock map buttons while any action is busy or pending.
- Scene authoring, retry and pregeneration POST routes are retired and return `410 scene_generation_removed` after authentication and host checks. Existing pre-upgrade pending requests can receive a definitive rejection without being converted into map requests.
- References: `GET /campaigns/{id}/references` returns an array of `{id,name,byteLength,createdAt}`. `POST` to the same route with raw `image/png` and optional `?name=` registers a PNG. `POST /campaigns/{id}/assets/{assetId}/reference` registers a ready, owned scene image. All require the authenticated host token. Reference IDs are owned SHA-256 content hashes, never paths or URLs. See [scene assets](scene-assets.md) for bounds and upload opt-in.
- Independent maps use `GET/POST /campaigns/{id}/maps` and map-specific `/generate`, `/publish`, `/grid`, `/scenes`, `/image` routes. Save does not generate. Mutations use request UUIDs and map versions, not campaign versions. Unity requests `/maps?publishedOnly=true`; private PNG downloads require the seat bearer and must not follow redirects. Full shapes and bounds: [maps](maps.md).
- Location bindings: host-only `POST /campaigns/{id}/maps/{mapId}/scenes` accepts `{requestId,expectedVersion,sceneIds}` from the activated adventure. This changes map metadata only. Player map projections include `currentScene` and library `currentSceneId`; omit private `sceneIds` and `sceneOptions`. Association changes never implicitly publish, unpublish or generate. Unity refreshes this independently of campaign versions while the library is open and idle.
- All handled API errors: `{ "code":"stale_version", "message":"..." }` and non-2xx status. Unknown request fields (including rolls, HP or resources; also DC on ordinary actions) are rejected. Ordinary JSON bodies are capped at 16 KiB; content import/create allow up to 1 MiB, map creation 128 KiB and raw reference PNG upload 10 MiB. Create strings are bounded, button actions cannot carry extra natural text, and travel targets must be currently available.
- Text calls have server-owned deadlines: 8 seconds each by default, configurable with `TextAi:TimeoutSeconds` within 1..45 seconds. The local configured-provider launcher uses 30 seconds each. Client action requests allow 120 seconds, covering both calls and transport overhead; ordinary queries still use 30 seconds. Disconnects do not cancel an action already inside its transaction.

The following payload is a historical bound-fixture illustration of the character and event fields. It is **not a complete current snapshot**: `party.members[].review`, `worldMemory[]` and `adventureCorrections[]` are specified in [input-driven adventure](input-driven-adventure.md). Its old `pending` scene asset is not a current generation workflow; current scene resources are `ready` legacy files or `removed`.

```json
{
  "id":"campaign-uuid",
  "name":"雾港余火",
  "ruleset":"dnd2024",
  "version":1,
  "chapter":1,
  "combat":null,
  "elapsedMinutes":0,
  "character":{
    "id":"character-uuid", "name":"Arden", "templateId":"human-fighter-soldier-2024",
    "species":"Human", "className":"Fighter", "background":"Soldier", "level":1,
    "hitPoints":12, "maxHitPoints":12, "armorClass":16, "proficiencyBonus":2,
    "abilities":[{"name":"strength","score":17,"modifier":3}],
    "skills":["Athletics","Intimidation","Perception","Survival","Investigation"],
    "inventory":[{"id":"greatsword","name":"Greatsword","quantity":1,"equipped":true}],
    "conditions":[], "features":["Great Weapon Fighting (Greatsword: damage dice 1/2 treated as 3)"],
    "resources":[{"name":"Second Wind","current":2,"maximum":2},{"name":"Hit Dice (d10)","current":1,"maximum":1}],
    "source":"XPHB"
  },
  "scene":{"id":"harbor","title":"雾港码头","summary":"...","assetId":"sha256","visited":true},
  "availableActions":[{"kind":"observe","target":"","label":"观察场景"}],
  "events":[{"id":"uuid","sequence":1,"kind":"arrival","text":"...","narrative":"...","narrativeSource":"offline","createdAt":"ISO8601","resolution":null}],
  "facts":[],
  "visitedScenes":["harbor"],
  "map": {
    "title":"雾海沿岸",
    "nodes":[{"id":"harbor","title":"雾港码头","state":"current","canTravel":false,"hint":"你在这里","x":0.12,"y":0.7}],
    "edges":[]
  },
  "pendingRulings":[{"id":"uuid","text":"...","status":"pending","reason":"...","privateText":""}],
  "sceneAsset":{
    "id":"sha256", "sceneId":"harbor", "campaignId":"uuid", "locationId":"harbor", "sceneType":"exploration",
    "title":"雾港码头", "summary":"...", "status":"pending", "promptBase":"...", "promptVariant":"",
    "referenceImages":[], "styleProfile":"mist-coast-v1", "visualConstraints":["..."],
    "imageUrl":"", "contentHash":"", "fallbackAssetId":"builtin:mist-coast", "version":1, "error":"",
    "attempts":0, "retryAfter":null, "failureId":""
  }
}
```

Resolution: `{ "status":"resolved|needs_adjudication", "kind":"investigate", "summary":"authoritative factual result", "check": Check|null, "changes":["..."], "rulingId":"", "combatLog":null }`. Check: `{ "ability":"wisdom", "skill":"Perception", "rolls":[14], "selected":14, "modifier":3, "total":17, "dc":12, "success":true, "mode":"normal", "ruleset":"dnd2024", "source":"XPHB" }`. Narrative is atmosphere only, separate from `resolution.summary`. Never use narrative text to update character/world state.

Legacy asset metadata may retain provider-identity, lease and failure diagnostics; they do not authorize writes or enable the retired scene retry route. Old ready scene PNG files remain public content-addressed assets. New map PNGs require the authenticated map image endpoint; reference-file bytes are not publicly exposed.

The Workbench creates campaigns; the HUD input dock holds only NaturalAction and Submit, and Unity provides invite/full-build join and resume (local campaign ID+token), scene background with built-in placeholder, status strip, scrolling narrative/event log, authoritative check receipt, natural-language input, character/inventory panels, scene transition and loading/error state. Cache images by contentHash and ignore stale image completions after a scene switch. All networking and image loading is asynchronous with finite timeouts. Preserve a pending request across a transient failure. Local session files contain bearer tokens and must not be logged or committed. Resume/refresh must retain a still-ambiguous request until it has been safely retried or explicitly resolved.


---

### Combat and rest extension

The same `/actions` endpoint accepts server-listed `combat.start`, `combat.move` (target exactly `x,y`), `combat.attack` (target `guardian`), `combat.dodge`, `combat.dash`, `combat.disengage`, `combat.second_wind`, `combat.end_turn`, `combat.retreat`, and `rest.recover`. New initiation of `rest.short/long/wait` through player endpoints is rejected with `rest_host_required`; accepted historical requests still replay their original receipt. Other commands require an empty target and text. Nothing accepts client damage, rolls, positions, action budgets or resource changes. Invalid/unavailable commands do not consume randomness or increment the campaign version.

`snapshot.combat` is nullable for old and not-yet-started campaigns. Its camelCase fields mirror [CombatModels](../server/DiceRealm.Server/Domain/CombatModels.cs): `id`, `title`, `status` (`active|victory|defeated|retreated`), `width`, `height`, `cellFeet`, `round`, `activeActorId`, `turnOrder`, `cells`, `units`, `log`, `logSequence`, `recoveryRestRequired`. Sparse cells have `x,y,terrain` (`blocked|difficult`); omitted cells are ordinary ground. Units include position, HP, AC, speed, initiative die/modifier/total, remaining movement and independent action/bonus/reaction availability, Dodge/Disengage flags. The UI highlights only server-provided move choices, not locally inferred distances.

`CombatEntry` has `sequence,round,kind,actorId,text,attack,spell,check` and optional `presentation`. The latter contains `combatId,text,activeActorId,units`; each involved unit moment has `id,x,y,hitPoints,temporaryHitPoints,conditions,dead,stable,withdrawn`. It captures this recorded event, is filtered with its frozen audience and visible actors, and is deep-copied on projection. Old entries omit it. Unity uses these moments only to pace the main story, map positions and own HP together; commands keep the latest authoritative snapshot and version. Initial reads/reconnects do not replay past combat, and pending choices open only after preceding recorded moments have been presented. Optional `AttackRoll` includes `rolls,selected,modifier,total,armorClass,mode,hit,critical,damageRolls,alternateRolls,effectiveDice,damageModifier,damage,graze,source,ruleset`. Effective dice are the chosen damage set after applicable GWF adjustments. Structured damage describes the roll result; final HP reflects limits and the guardian's nonlethal choice. `resolution.combatLog` contains this request's new entries; `combat.log` keeps the latest 200. Attack, healing and NPC consequences remain one gameplay version and one atomic receipt per player command.

`elapsedSeconds` is the authoritative adventure clock; `elapsedMinutes` is its whole-minute projection. Authored coastal travel advances 10 minutes, a full combat round 6 seconds, armor changes 5/10 minutes, and rests their declared duration. GET and real-time waiting do not advance it. A rest without a hit die does not heal HP. Nonlethal defeat locks exploration until explicit short rest and separate stand/retrieve steps finish. Combat and rest buttons produce `narrativeSource=system` without model calls; natural input during combat/recovery is deferred without AI interpretation or mechanical changes. An outcome never requires regenerating the scene image. [Encounter limits](combat.md) remain part of this contract.

Combat uses the existing scene map, with visible initiative portraits above and legal actions below. There is no separate combat board window. Other units show names and injury descriptions instead of precise HP/AC/coordinates; own statistics remain readable. Original-request recovery remains available while pending; normal commands are blocked during in-flight, pending, or recorded-action playback states. Closing a menu or roll window is presentation-only, not retreat or cancellation.

Unity JsonUtility may materialize an empty inline object for a JSON null. ApiJson normalizes nullable combat, attack, spell, spellcasting, check and event-resolution members at the response boundary. Engine-free DTO defaults alone do not prove this behavior; the real Unity tests cover it.


---

### World journal extension

`snapshot.world` contains `quests`, `npcs`, `factions`, and `branches`. The exact projections are [StoryEngine records](../server/DiceRealm.Server/Domain/StoryEngine.cs). They derive from saved facts; the client renders objectives, `met`, reputation, standing and recorded choices without predicting hidden content. Old/null world payloads are normalized by ApiJson.

Server-listed story commands are `story.talk` (known NPC ID), `story.accept` (`tide-ledger`), `story.search` (`cargo-case`), `story.recover` (`tide-ledger`), `story.rescue` (`toma`), `story.deliver` (`guild|wardens`), and `story.finish` (`coast-pact`). All require the matching current location and prerequisites. The delivery branch is immutable, rewards apply once, and an unsuccessful search exposes a fail-forward route rather than allowing a reroll. Unknown commands/extra fields stay rejected.

Unity's local campaign catalogue is not a public API or account system. Metadata excludes access tokens; selecting an entry verifies the target using its own saved credential before replacing the current session. Pending actions block switching until confirmed.


---

### Carried inventory weight

`GET /api/v1/campaigns/{id}/character/sheet` 的可空 `weight` 含 `totalPounds,unknownCount,unit:"lb",hasCapacity,capacityPounds,capacityNotice`。`totalPounds` 是单件已知磅数×正库存数量的十进制总和；`unknownCount` 是未计重件数，不是行数。装备不重复计，套装用来源总重、不展开内容，离包同调不计入。空库存合法为0，未知重量不等于0。

`InventoryWeight.Project` 拥有只读总重及容量；单件事实和总重共用 `ItemMetadata.Find`。库存显式 `RulesId` 优先于内容ID；包括空串在内的显式未知身份不回退显示名/误导性runtime ID。无显式ID才用既有精确runtime装备身份。`scripts/build_character_reference.py` 从相同固定dnd2024来源manifest/sourceHash核过的原始定义生成 `item-metadata.json`，仅嵌入身份、numeric重量/价格和封闭稀有度，不嵌商业全文。不以图标别名授权身份。金币/银币/铜币及对应 `equipment:xphb:` / `xphb:` 身份为每枚0.02磅、100/10/1cp。

容量使用当前 `Abilities[name=strength].score` 与 `BuildMechanics.size`，按XPHB362的T/S/M/L/H/G系数7.5/15/15/30/60/120。精确已获 `Powerful Build` 按大一级体型（S→M仍15，M→L为30）；缺有效力量/体型或超出已核表时 `hasCapacity=false`，原因在notice。不新增自动超重惩罚、拖拉/推举结算或游戏写入。

Unity背包底部显示 `X / 上限 磅`，部分为 `≥ X / 上限 磅 · N 件未计重`；未知容量分母 `—` 且不画百分比，超量保留真实数值。缺weight显示 `负重未记录`，stale显示 `负重待同步`。`ApiJson`仍以 `unit=lb` 标记归一weight，不以数值0判断缺失；旧响应未给hasCapacity等同未知。

`itemDetails` 保留 `id,name,text,notice`，追加 `hasWeight,weightPounds,hasPrice,priceCp,rarity`；两个布尔区分未知和已知0，价格为每库存单位cp（可含小数），不是整组数量总价或买卖报价。稀有度仅 `none/common/uncommon/rare/very rare/legendary/artifact`；空串表示无明确等级，不能假普通。魔法物品无numeric value保持未知，不按valueRarity估价。离包但仍同调的自有物品可读元信息；无/坏本地正文包仍返回已核元信息及真实notice，不伪造正文。

详情、hover/F1共用右下重量/金币图标数值及物品图的等级样式。仅在结构化值与独立生成header精确相等时隐藏重复重量/价格/等级行；正文、材料、条件和不一致事实保留。完整服务器正文不改写。读投影保持游戏/存储字节不变、零供应商调用；`InventoryWeightTests`、`CharacterRuleDetailsTests`、`InventoryMetadataTests`及`WearableUiTests`守护身份、容量、未知/零/stale和纯读HTTP合同。

### Character, spells and growth extension

The presets, bounded creation options and limits are in [characters and growth](characters-and-growth.md). `character` adds nullable `spellcasting:{ability,attackBonus,saveDc,spells}`, `effects:[{id,name,expiresAtSeconds}]`, `nextLongRestAtSeconds`, `expertise:[]`, and `shortRestDiceAvailable`. A spell has `id,name,level,prepared,automated,castingTime,summary,source`; known or prepared does not imply automated. The Unity panel renders server-authored action options, including unavailable options with reasons. Only the exact current `availableActions` pair can be confirmed; the panel does not synthesize casts from spell flags.

Additional server-listed commands on `/actions`:

- `equipment.equip`: supported carried weapon ID. `equipment.armor`: `don|doff`, Fighter Chain Mail only and out of combat.
- `character.cast`: `mage-armor:self`. `combat.cast`: `mage-armor:self`, `fire-bolt:guardian`, or `magic-missile:guardian` when action, range and resources permit.
- `rest.hit_die` and `rest.arcane` use the caller's window after a DM-initiated short rest, with no extra hour. Hit dice require that player's explicit roll confirmation. `rest.short/long/wait` are no longer player initiation commands; see the host-only party rest endpoint below. Pending historical initiation can be cancelled but not completed under the new policy.
- `growth.level2`: `fixed` for Fighter, or the exact eligible Scholar skill for Wizard; requires beacon milestone, harbor and level 1. No numeric growth input is accepted.
- `combat.action_surge`: consumes the class resource, adds a non-Magic action without resetting other turn budgets. `CombatUnit.surgeAction` records that restriction.
- `character.tactical_mind`: immediately corrects a supported failed check with a server d10; only success consumes Second Wind. It cannot create a second correction opportunity. Check DTO adds `bonusRolls` and `bonusSource`; `total` includes this addition while the original d20 and modifier remain unchanged.

`CombatEntry.spell` is nullable and contains `spellId,targetId,slotLevel,damageRolls,damage,damageType,source,ruleset`. Magic Missile has a spell record and no attack; Fire Bolt has both. Mage Armor has no damage rolls. Never fabricate a d20 for a null attack. All character/growth/combat/rest commands bypass text generation and retain the same transaction, version and request-receipt guarantees.


---

### Party and DM extension

The authoritative contracts and limits are in [party and rulings](party-and-rulings.md). `snapshot.character` belongs to the authenticated seat, not necessarily the leader. It is null for a new host-only seat; `party.isHost=true` distinguishes that valid management response from an invalid missing player character. Workbench supports the empty party. Unity normalizes the nullable character and rejects host-only import/switch/refresh before replacing any current player state, directing the user to invite/full-build join. Existing hosts with a real character remain compatible. `snapshot.party` supplies `selfActorId,isHost,members,invitations,canInvite`; snapshots contain no capability hashes or tokens. Actions and management receipts are scoped by actor ID; events carry `actorId`. Party members share the world/version but keep distinct characters.

Additional routes are `/invitations`, `/join`, `/seats/revoke`, `/invitations/revoke` and `/rulings/resolve`, with the payloads documented above. All mutations except joining require a host token and expectedVersion/requestId. Join uses a single-use invitation and a client-generated new capability, retained before first transmission. Replaying the exact accepted join restores the same seat; a consumed invite with different input is rejected.

Combat units add `withdrawn`, `recoveryRestRequired`, and `droppedWeaponId`. Use `party.selfActorId`, not the literal `player`, to identify the controlled unit. Only that actor's turn has available battle commands; retreat does not withdraw the entire party. Assets remain shared, but edit/retry/reference registration requires host permission.

Rulings retain the original `actorId,sceneId,combatId` and append `outcome,rationale,ruleSource,resolvedBy,resolvedAt,check`. Only explicit DM check outcomes roll server dice; no outcome supports numeric state patches. Management commands bypass text AI and use the same atomic commit/retry guarantees.

Client pending keys include the seat capability. Persist the management endpoint along with the exact request JSON; do not retry a ruling against `/actions`. Joining has its own durable pre-session request. Idle polling must reject lower versions, responses from replaced sessions, and responses received during busy/pending actions. Current Unity uses a 2.5-second idle poll rather than WebSocket broadcast.


---

### Player journal clock and equipment visibility

Player message timestamps use `origin.elapsedSecondsBefore`; original journal event cards use `elapsedSecondsAfter`, while recap cards use the action start. These are accumulated game times (`已过 …`), not real-world dates or a calendar invented by the client. Missing or invalid ranges show `游戏时间未记录` in journal; chat may omit the missing timestamp. Never replace an old event's absent origin with the latest snapshot clock.

Direct equipment controls are omitted by the player reading projection in both chat and journal; existing server events, receipts and audit remain intact. Natural-language roots and attunement/rest remain visible. Filtering does not alter after/through/nextAfter; an all-equipment page is a real empty reading page with its existing pagination.

### Long-term journal, archive and resource budget

`snapshot.archived` defaults to false. Archived snapshots have no normal actions; all members can still read. `POST /campaigns/{id}/archive` accepts `{requestId,expectedVersion,archived}` from the host, returns the standard ActionResponse, and stores a seat-scoped receipt. No archive/restore during active combat. New actions, joins, rulings and asset edits are blocked while archived; host revocation and restoring remain available. Already accepted requests replay before the archive guard. Previously queued images are not cancelled.

`GET /campaigns/{id}/journal?after=0&limit=50&through=123` returns `{campaignId,version,through,after,nextAfter,hasMore,events}`. `through` is optional on the first request and defaults to the saved version; retain it across pages. `after>=0`, `limit=1..100`, `1<=through<=currentVersion`, `after<=through`. The old full-history download loop is removed; Unity keeps one page of 50 events at a time. Current version and frozen horizon can differ when teammates continue playing.

`GET /campaigns/{id}/recap` returns `{campaignId,name,version,chapter,archived,sceneTitle,elapsedMinutes,party,quests,branches,pendingRulings,source,note}`. The three collections contain display strings from saved facts, with `source=server-facts`. No model is called. Host-only `GET /campaigns/{id}/journal/export` streams UTF-8 NDJSON: one public snapshot/recap header and event rows visible to the requesting seat (private unconfirmed/cancelled intents from other seats are omitted), under a fixed campaign lock and a 60-second deadline. Unity downloads to a temporary file and publishes a new local export only on success. This transcript omits credentials and private receipts; it is not a restorable backup.

`GET /campaigns/{id}/resources` returns `{usage,mainScenes,canPreGenerate,policy,historyNote}` without enqueueing new work. Each usage row has `kind,day,globalToday,globalDailyLimit,campaignToday,campaignDailyLimit,total,totalLimit,remainingToday,enabled`; counts are requests, not currency. `mainScenes` is now empty and `canPreGenerate=false`; the service no longer supplies a fixed list of opening scenes or scene-generation jobs.

The legacy pregenerate POST returns 410. ResourceStatus retains usage/history explanations with an empty `mainScenes` array and `canPreGenerate=false`. Maps share the same durable image budget, fail with `image_quota_exceeded` when exhausted, and never auto-retry. Text quota fallback remains unchanged. See [maps](maps.md).


### 内容导入接口变更

`POST /api/v1/campaigns` 默认创建空白战役，可显式携带 `adventure`、`prompts`、`startImmediately`。该接口及剧本、提示词导入请求上限为 1 MiB；其他普通行动仍为原有小请求上限。`CampaignSnapshot.content` 返回绑定状态、文档名称、版本及哈希，不返回完整剧本。完整文档只经队长授权的 `/content` 读取。详情见 [内容接口](content-import.md#http-接口)。

`CombatUnit.team` 为 `party` 或 `enemy`。遭遇单位来自导入的定义，客户端不能假设敌人只有固定 ID。`SceneAsset.status` 当前为历史 `ready` 或 `removed / scene_generation_removed`；旧 `unconfigured` 记录不应轮询或发起场景生成。

`CampaignSnapshot.content.offlineTrial` 标记永久离线的隔离试跑。旧行动接口的试跑自然语言直接进入待裁定；新理解接口使用有限的离线标签匹配，可确认已列候选或转裁定，均不请求意图或叙事模型；地图生成在入队前被服务端拒绝，资源投影也标为禁用。正式连接不能通过客户端布尔值变成试跑。队长使用 `POST /content/trial` 从草稿建立独立战役，原进度不变，创建回执可重放。

`GET /content/prompt-history` 是队长专用的不可覆盖版本库；`POST /content/prompts-bind` 使用保存的哈希明确切换后续调用版本，不回退历史与角色。事件可带 `promptCalls[]`，每项记录调用用途、绑定版本/哈希与结果，不包含提示词原文；旧事件可为空。`POST /content/preflight` 为只读静态检查。完整请求、权限和限制见 [内容工具协议](content-import.md)。


---

### Server-authored action review

`ActionChoice` may include `details:{targetLabel,cost,range,note,unavailableReason}`. `CampaignSnapshot.actionOptions` includes available choices plus a bounded set of publicly explainable unavailable choices, such as blocked movement, spent actions, insufficient spell slots or an unsafe rest location. It is display metadata, not permission. `availableActions` remains the sole execution whitelist; opening the review never sends an action. The client submits only kind/target on confirmation and rechecks the current whitelist after refreshed snapshots. Cancel leaves resources and version unchanged.

The server builds distances, movement cost, spell-slot requirements, action budgets and unavailable reasons in [ActionInformation](../server/DiceRealm.Server/Domain/ActionInformation.cs). It does not expose hidden story prerequisites. Older servers without metadata remain browsable and show an explicit missing-information notice. Natural-language input remains an interpretation/adjudication request and is not pre-priced as a known structured action.

---

### Bounded character creation

Retired for new use: `GET /api/v1/character-creation` and `POST /api/v1/character-creation/preview` now return HTTP 410 with `full_character_build_required`. New player creation, join and actual character replacement require a valid full `build`; existing `Character.creation` saves and exact accepted-request receipts remain compatible. Do not migrate, re-evaluate or rebuild old characters on reads.

The following describes the historical payload only, not available endpoints. Previously, `GET /api/v1/character-creation` returned `{ruleset,source,revision,abilities,standardArray,humanSkills,templates,scope}`. Each template supplies `{templateId,label,classSkills,equipment,defaults,limitation}`; each equipment choice has `{id,label,description}`. These are supported choices, not a complete rules catalogue.

`creation` has `{baseScores,backgroundBonuses,classSkills,humanSkill,equipmentId}`. Both score arrays follow the catalog's ability order: strength, dexterity, constitution, intelligence, wisdom, charisma. No HP, AC, modifiers, resources, feats, arbitrary inventory or class levels are accepted. The server rejects duplicate/unknown JSON fields and invalid combinations with `invalid_character_creation` (HTTP 400).

`POST /api/v1/character-creation/preview` accepts `{characterName,templateId,creation}` with an 8 KiB limit and returns the server-built `Character`, including the verified `creation`. It is read-only: no campaign, event, dice roll, provider request or credential is created. Preview is not an authorization token; the subsequent create/join validates all choices again. A failed request, cancellation or changed selection cannot enable acceptance of stale preview data.

These historical choices remain stored as nullable `Character.creation`, but are no longer an accepted input for a new player. Workbench has neither a preset nor a character builder; Unity's invite page uses only the full `build` flow below. Original accepted join/replacement requests replay before the new-build gate; unaccepted old requests fail without consuming an invitation, adding a seat or changing a character. Historical limits are in [characters and growth](characters-and-growth.md#受限建卡).

---

### Full level-one character build

`GET /api/v1/character-build/catalog` returns pinned `ruleset,source,revision,schemaVersion,level,abilities,standardArray,pointCosts,pointBudget,skills,classes,species,backgrounds,feats,languages,spells,equipment,alignments`. IDs are canonical acquisition IDs, not preset template IDs. `abilities` uses `str,dex,con,int,wis,cha`; score arrays follow that order. Equipment has nullable integer `price` in copper plus `hasPrice`. Unity must check `hasPrice`, because JsonUtility cannot represent a nullable integer and must not treat a missing price as a free item.

`POST /api/v1/character-build/evaluate` accepts `{build}` with a 64 KiB JSON limit. The shape is defined in [BuildModels](../server/DiceRealm.Server/Domain/Creation/BuildModels.cs):

```json
{
  "build": {
    "ruleset": "dnd2024",
    "revision": "e5f3e77b303a92df10487207857200245e71957c",
    "classId": "", "speciesId": "", "backgroundId": "",
    "abilityMethod": "standard",
    "baseScores": [], "backgroundBonuses": [],
    "classSkills": [], "expertise": [], "selections": [],
    "cantrips": [], "preparedSpells": [], "spellbook": [],
    "classEquipment": "", "backgroundEquipment": "",
    "purchases": [], "equipped": [],
    "identity": {"name":"", "pronouns":"", "appearance":"", "personality":"", "backstory":"", "alignment":"neutral"}
  }
}
```

Read the revision from the catalog rather than hardcoding the example. A selection is `{key,values:[id]}`; a purchase is `{id,quantity}`. The alternative ability method is `point-buy`. Derived statistics, arbitrary inventory, roll results and class levels are not accepted. Unknown fields, malformed/null collections or out-of-bound lengths fail with HTTP 400. A well-shaped incomplete draft returns HTTP 200 with issues, never an implicitly completed character.

Evaluation returns `{fingerprint,canCreate,issues,steps,groups,character,notices}`. An issue contains `{step,code,message,key}`. Steps are `class,origin,abilities,choices,spells,equipment,details,review` and contain `{id,complete,issueCount}`. Each group has `{key,step,label,count,options,selected,dependsOn,complete}`; each option has `{id,label,description}`. Source keys remain separate even if two sources grant the same spell. Special keys `$classSkills`, `$expertise`, `$cantrips`, `$spellbook`, `$preparedSpells` map to the corresponding top-level arrays; other groups map to `selections`. Never silently auto-select an option or copy all groups into `selections`.

`character` is null until all required choices are valid. Normalize this at the Unity transport boundary. `fingerprint` identifies the evaluated input but is not a permission token; use captured edit/window versions to reject late responses. Errors must invalidate acceptance instead of retaining an earlier successful preview. Evaluation is pure and performs no save, roll, provider call or credential creation.

`POST /campaigns` normally accepts the host-only `{name}` shape described above; explicit `{name,characterName,build}` remains an API compatibility path, not a Workbench builder. `POST /campaigns/{id}/join` requires `{requestId,inviteToken,accessToken,characterName,build}`; its strict JSON limit is 64 KiB. Do not send `creation` or a preset `templateId`. The historical DTO default Fighter ID remains internally for fingerprint compatibility; this is not permission to omit a build. Missing build returns `full_character_build_required`; mixed/invalid choices return `invalid_character_build`. `characterName` must match the build identity, and new create/join/replacement re-evaluate everything. Join retains the exact full request for idempotent recovery. A completed build uses `templateId=custom-level-one-2024` in the response; this is not an extra preset accepted through `templateId` input.

`Character.build` preserves acquisition choices, while nullable `Character.buildMechanics` exposes server-derived hit die, speed, size, proficiencies, tools, languages, feats, masteries, resistances, full skills, saving throws, initiative, passive perception, acquisition currency and automatic-combat eligibility. Per-source `spellGrants` include `id,ability,source,mode,freeUses,attackBonus,saveDc`; do not display a fabricated DC 0 when the aggregate spellcasting ability is `multiple`. Current inventory/effects remain runtime state, not an editable build. Both added character members are null on legacy presets and must be normalized after Unity deserialization.

A legal build is not a guarantee of complete gameplay automation. The server may expose an unavailable `combat.start` option with a DM explanation for unimplemented combinations, and full-build growth uses the separate `character/advancement*` routes ([character advancement](character-advancement.md)). UI behavior, source evidence and remaining limits are in [full character creation](full-character-creation.md).


---

### Wearables and attunement

`Item` adds null-omitted `rulesId`. The current wearable registry uses exact `magic_item:xdmg:<slug>` identities, independent quantity-1 physical instance IDs; names never grant mechanics. Old items are not migrated or split on read. `Character.playState.attunements` is a nullable array of `{itemId,rulesId}` bonds, independent of `Item.equipped`. Optional `Character.equipmentStatus:{armor,current,reserve,issues,armorClassSources}` is a read-only runtime projection in snapshot, authorized party Character and sheet; it is not persisted or accepted as input. AC sources come from the same calculation as AC, and displayed skills/saves use current modifiers without modifying acquisition history.

`CharacterSheetView.wearables` is nullable and contains `{slots,options,items,attunementOptions,attunementUsed,attunementLimit,notice}`. Slots/options reuse the loadout shapes below; items are `{itemId,rulesId,slot,label,equipped,requiresAttunement,attuned,effective,status,notice}`. Fixed slots are `head,cloak,hands,wrists,feet`; accessories use `<category>:<instanceId>` for worn items plus an empty `<category>` add slot (`ring,neck,waist,eyes,clothing`). No invented two-ring or clothing-layer cap. Unwear options have empty `itemId` and the occupied slot; attunement options always identify the physical item. Missing inventory may still have an attuned item projection and an ending option, never fabricated inventory. Unity normalizes missing/null/empty wearables using positive attunementLimit, and equipmentStatus using nonempty armor.

Use the original `/character/commands` with `operation=wear|attunement`, value=1, normal mode, empty choices and the complete server-provided key. Keys are `wear:<instanceId>`, `unwear:<instanceId>`, `attune:<instanceId>`, `unattune:<instanceId>`; IDs may contain colons, so clients must not reconstruct/split them. Ordinary wear costs zero seconds, does not silently replace conflicts and does not require a safe rest location or completed teammate pending actions. Attune and voluntary ending each cost a NEW 3600-second focused personal short rest, use current safety/pending/ability checks, restore only the caller's normal short-rest resources and open their hit-die/Arcane Recovery window. They do not consume an old rest, heal automatically, restore the party or require a new DM approval. The current simulation completes the rest atomically; no real-time interruption/distance tracker is claimed. Full supported items/effects and termination boundaries: [character use](character-play.md#完整穿戴与同调).

普通长袍复用 `wear`：精确 `equipment:xphb:robe` / `xphb:robe`，以及无显式RulesId的旧 `robe` 库存ID，投影为 `clothing` 衣着槽；显式未知RulesId与同名自定义物不回退。它仍是普通冒险装备，不属于护甲、无AC加值、无需同调，状态写“普通衣物”。不进入魔法物品获物注册表，不改变旧 `robe` 的普通堆叠/获物语义；原单件穿戴要求保持，读取不拆堆叠或改存档。Harness角色事实校验通过实际库存规则身份核对规范化的衣着资料，不要求旧库存凭空已有RulesId。

Original authorization, actor-scoped receipt, version and atomic-save order apply. Unoffered keys or extra fields fail with `invalid_character_command`; blocked offered choices fail with `wearable_unavailable` (409), with zero partial effects. New Harness v21 adds these facts/candidates and typed grants; v0..20 remain frozen.

### Equipment packs

`GET /api/v1/campaigns/{id}/character/sheet` 追加可空 `packs:[{key,itemId,contents:[{id,name,rulesId,quantity}],available,reason}]`。每项对应本人正数量库存中的一类已核套装；完整 key 不拆分。缺失/null 归一为空数组，不能按物品中文名或说明生成操作。当前仅支持 XPHB2024 的窃贼、外交官、地城探险者、艺人、探索者、祭司与学者七种装备套装；不扩展弹药捆或通用嵌套容器。

原 `/character/commands` 新增 `operation=unpack`，`value=1`、`mode=normal`、`choices` 为省略/null/空数组。服务端提供 `unpack:<actual item ID>`，执行时重新验证本人、当前版本和可用性，原子扣除一份套装并加入全部 typed 内容。同 runtime ID 且同规则身份的普通物品合并数量，保留已有名字、装备标记与来源；不同身份冲突、非法库存数量或最终超过400项/单项9999拒为 `pack_unavailable`（409）。未提供的 key、非1数量、非空choices/额外模式拒为 `invalid_character_command`；既有鉴权、`stale_version`、actor-scoped回执与保存事务不变。操作不推进时钟、不产生裁定、不调用模型。读取和升级不自动拆旧库存。

内容从同pin原始 `packContents` 精确导出，不解析中文散文。拆包后只对实际库存计重，不能同时保留包装总重；缺单件重量继续计入未计重数量，不从套装标重倒推出缺失值。例如窃贼套装标重47.5磅，拆开后已知内容42磅，铃铛与10支蜡烛缺重量，显示为至少42磅及11件未计重。Unity的“打开套装”只打开原详情，“取出全部”通过原pending/回执通道提交一次；重试同请求不再次扣包，成功后按返回快照刷新实际内容。直接按钮操作不进入故事正文，审计日志保留；带自然输入/intent的记录仍可见。

### Character rule references

`GET /api/v1/campaigns/{id}/characters/{actorId}/references` 返回 `{version,actorId,characterId,featureDetails,notice}`，供已授权席位查阅同战役当前未撤销角色的固定能力规则。无角色主持、未知或已撤销目标返回 `404 character_unavailable`；无效/撤销/跨战役凭证沿原授权拒绝。GET 不写游戏状态、不切换 ActingActorId、不调用供应商。响应不包含 Character、Build 私人设定、审核通信或其他席位的可执行选项。

`featureDetails:[{index,name,text,notice,group}]` 与本人 sheet 的同名字段复用 `CharacterRuleDetails`；index 对应原始 `Character.features` 数组位置，不是排序后位置。group 为已核来源的“物种能力 / 职业能力 / 专长”或空串，客户端缺来源归“其他能力”，不能从名字猜取得来源。正文只来自当前私有本地规则包及已取得的精确来源；缺包、未命中、超长均保留真实 notice，不用整本/整物种或截断片段冒充能力全文。旧 DTO 缺数组归空，缺 group 归空。

`itemDetails` 另追加 `category`，闭集 `weapon|armor|tool|gear|magic|""`。它沿原 ItemMetadata 精确身份及建卡装备类别取得，显式未知身份不能回退物品显示名；空串为未分类。筛选仅改变客户端库存网格，不改权威库存、金币或全背包负重。过渡快照的同一实物/规则身份可保留上一份 category 作分类显示；旧命令/可用性仍必须禁用并重新读取。装备带的详情不受网格筛选限制。

### DM party rest

`GET /api/v1/campaigns/{id}/party/rest` requires host permission and returns `{version,options:[{kind,label,seconds,available,reason}],participants:[<character name>]}` without writes. Zero approved players is a valid empty response: participants is empty and all three options are unavailable with nonempty reasons; it cannot advance time. Workbench must not classify that response as incomplete. Strict POST to the same route accepts only `{requestId,expectedVersion,kind}` (8192-byte limit, `short|long|wait`) and returns the usual ActionResponse. It advances the shared clock once and applies the existing recovery policy to approved, non-revoked members; short rest never spends their hit dice automatically. There is no client-selected actor, duration or recovery amount. Original receipts, personal choices, rejection conditions and required tests are owned by [party rest](../.trellis/spec/backend/party-rest.md). New package availability does not imply a running daily service has been upgraded.

### Character use and host adjustments

`GET /api/v1/character-play/catalog` is public, read-only metadata for the supported condition and equipment IDs. `GET /api/v1/campaigns/{id}/character/sheet` requires the caller's own capability and returns `{version,enabled,reason,character,checks,equipment,spells,preparation,notice,actionBlock,restChoices,effects}`. Optional `effects:[{key,label,itemId,spellSource,details}]` comes directly from NaturalActions; missing/null normalizes to an empty list. Item/source IDs are exact server identities, not names. Optional `itemDetails:[{id,name,text,notice,hasWeight,weightPounds,hasPrice,priceCp,rarity,category}]` supplies complete local rule properties by exact catalog identity; missing/null is an empty list, unknown names do not confer a rule identity. Optional `loadout:{activeSet,meleeGrip,slots,options,notice}` is the authoritative equipment projection when present. Slots are `{id,label,itemId,occupiedBy,active}` for `armor,melee-main,melee-off,ranged-main,ranged-off`; a two-handed ghost has empty itemId and the primary item in occupiedBy. Options are `{key,label,slot,itemId,seconds,available,reason}`. Disabled choices retain their reason. Missing/null loadout uses the legacy `equipment.isActive/canActivate/activateReason` projection; never combine both sets of weapon commands. Do not reuse old-version details or active-weapon labels after snapshot changes. It never persists initialization, rolls dice or invokes a provider. Selection IDs and server modifiers are opaque inputs to the client; read them again after version changes.

`POST /api/v1/campaigns/{id}/character/commands` accepts `{requestId,expectedVersion,operation,key,value,mode,choices}` with a 16 KiB strict JSON limit. Operations include `unpack,wear,attunement,loadout,equip,execute,prepare,rest-choice`, with legacy `check,spend,consume,spell,feature,use` retained for old clients and exact pending-request replay. Current Unity uses offered loadout/wearables/attunement options, effects (`execute` with the full key and value=1), original armor/legacy equipment commands and explicit personal preparation/source choices; it does not create generic use/spell/feature rulings or bookkeeping commands. Unsupported use returns to an unsent player draft. Legacy operations keep their original semantics and are never reinterpreted as effects. There is no actor, DC, modifier, HP or arbitrary-state field. The authenticated seat owns the operation. `check` uses `normal,advantage,disadvantage`; other operations require `normal`. `loadout` uses value=1, mode=normal, empty choices and a complete offered key: `assign:<slot>:<itemId>`, `clear:<slot>`, `set:melee|ranged`, or `grip:one|two`. The server validates ownership, quantity, training, two-handed/versatile grip and shields, then commits the whole loadout. Same-set duplicate IDs require two items; alternative sets may share an item. Switching sets preserves both configurations; shield don/doff consumes six seconds. Invalid/stale choices cause no partial save. `equip` remains 0/1 for armor and old commands, routed through the same loadout rules for weapons/shields; it must not bypass shield timing or silently choose a spare. `spend/consume` use a positive available quantity, and other operations use 1. `prepare` accepts a complete array of selected spell IDs; `rest-choice` accepts its exact server-offered source choice IDs (see [rest source contract](../.trellis/spec/backend/rest-source-choice.md)). Return type is the existing `ActionResponse`; the endpoint and exact request must survive client restart for idempotent retry.

`POST /api/v1/campaigns/{id}/characters/adjust-preview` and `/characters/adjust` accept the same host-only request: `{requestId,expectedVersion,actorId,rationale,ruleSource,changes,rulingId}`. A change is `{operation,key,value,name}`; `rulingId` and `name` default to empty strings. A request has 1..16 changes, a nonempty single-line rationale up to 1000 characters and a source up to 240 characters. Preview returns `{version,actorId,characterName,changes,warnings}`; each returned change has `{operation,key,label,before,after}`. Preview is pure, does not reserve a version, and is not authorization to apply a stale request. Apply revalidates all fields and atomically returns `ActionResponse` with an event and durable receipt.

| Operation | Key and value |
|---|---|
| `damage` / `heal` | Empty key; positive final amount up to 9999. Damage consumes temporary HP first; healing caps at maximum HP. |
| `hp` | Empty key; current HP from 0 to existing maximum. |
| `temporary-hp` | Empty key; replacement value 0..9999, not addition. |
| `exhaustion` | Empty key; integer 0..6. |
| `condition` | Listed condition name; 0 removes, 1 adds. |
| `resource` | Existing resource name; current value from 0 to its maximum. |
| `inventory` | Owned or catalog runtime item ID; quantity 0..9999. New items are not automatically equipped. |
| `resource.define` | Empty key, new `name` up to 60 characters, maximum 1..9999. Creates `DM: name` at zero with manual-only recovery. |
| `item.define` | Empty key, new `name` up to 60 characters, quantity 1..9999. Creates a non-equipment record with a server-generated ID. |

Names cannot rename existing items or resources. Duplicate field changes, unknown operations, invalid seats, stale versions, archived campaigns and active old automatic encounters are rejected. No build, attributes, level, maximum HP, ownership or narrative-fact patches are accepted. Linking a ruling requires the same valid actor and current scene, no old combat context, no rejection and no prior `effectsRequestId`. Existing check outcomes remain intact; `PendingRuling.effectsRequestId` and `effects[]` audit the separate application. Never automatically repeat a player's already-recorded spell/resource cost.

`Character` adds `temporaryHitPoints`, `exhaustion`, and nullable `playState:{schemaVersion,preparedSpells,preparationOpen,activeWeaponId?,loadout?,attunements?}`. Optional loadout is null-omitted and contains `{meleeMainHandId,meleeOffHandId,rangedMainHandId,rangedOffHandId,activeSet,meleeGrip}`; it is the sole authority when present, with activeWeaponId retained only as a synchronized legacy bridge. Null loadout derives the old explicit current weapon or unique equipped weapon plus shield without writing a migration; ambiguous legacy inventories never select the first item. Explicit empty hands differ from absent loadout. `BuildEquipment.versatileDamage` provides catalog dmg2. Standard dropped items may append null-omitted `slot` to preserve each actual hand; closed combat boards are historical and cannot block later equipment commands. `Resource` adds `recovery,description,source`; recovery is `short`, `short-one`, `long` or `manual`. Runtime preparation does not edit `Character.build`. Long rest clears temporary HP, reduces Exhaustion by one and opens supported preparation replacement. Legacy saves acquire missing known counters without resetting existing current values; a read does not write the migration.

`DiceCheck` adds `hasDc` and `testKind`. New unopposed character checks explicitly set `hasDc=false`, so clients must not render DC 0 as a failure. `testKind` is `ability` or `save`; older payloads lacking it normalize to the prior DC-based behavior. A status-driven automatic saving-throw failure has empty rolls and mode `automatic-failure`. Ruling resolution also accepts optional `checkType=ability|save`; saving throws do not accept a skill. The UI and rule coverage are in [character use](character-play.md).
