# 共享电子棋盘与持久单位

玩家和 AI 使用同一张已发布底图、持久单位实例和权威位置。右侧地图保持常驻；查看、平移、缩放或换底图不改变叙事场景，实际前往仍通过原地点/旅行操作。普通探索拖动只保存摆位，不表示已验证墙体、地形或途中危险。

## 使用与当前边界

- 地图上的单击选中单位；战斗中选择目标，不自动打开资料大窗。探索时可读取实例详情；已放置的本人角色仍可拖动，松手时提交一次。Harness角色初始位置由AI DM决定，玩家端不再提供「放置本人」入口；新HTTP玩家首放被 `board_dm_placement_required` 拒绝。旧回执仍可重放，非Harness流程和主持本人纠错保留。
- 直接点地图头像选择单位，右上角不再常驻“单位”菜单。头像随地图缩放，缩小时仍保留可点击范围；密集时通过屏幕避让与原位锚线分开，不改真实坐标。视口容不下可点击头像时显示临时聚合入口，展开后分别选择；同模板多实例拥有不同 ID，名称相同也不会合并。吸附开关收在地图“工具”中，只适用于已标定方格，关闭时自由摆放。
- 玩家单位界面对其他单位只显示名称与伤势，不展示精确HP、AC和坐标；本人资料按实例取当前数值。未知属性不补成0，完整角色构筑的职业、等级、物种等只在确实存在时显示。明确规则字段通过 `RuleReference.Name` 本地化显示，不改人物名、说明正文或库存物品原名。查看权限与控制权限分别由服务端投影。
- 有已知移动限制时只保存移动意图，真实坐标不变；图上目标与连线是待结算预览。主持对原意图选「结算原棋盘移动」时仍重新检查限制、场景及原位置，不能借裁定选项清除状态或改 HP。单独的检定成功/叙事记录不自动解除状态。
- 契约39的AI DM可直接摆放、移动或移出获准席位的实际玩家角色，无位置同意步骤；多次移动、显式路径不再被旧的单次本人摆位条件拦截。地图/场景/版本、角色限制与战斗规则继续校验，工具不能修改角色数值或代确认骰子。契约≤38保留旧提议及精确确认，用于历史恢复。
- 战斗使用唯一地图：顶部按可见先攻顺序排列头像、突出当前行动者，底部提供服务器当前合法动作。地图或头像选择目标；原独立棋盘、战况窗与顶部战斗入口已移除。旧无棋盘存档也在同一区域保留合法动作及真实无图状态，不恢复第二张网格。本人新有效投掷自动弹出，结构化攻击产生的等待也可在重连后确认，不要求另建模型行动。
- 新战斗记录带可选 `presentation`：`combatId,text,activeActorId,units`，每个单位瞬间仅有本条涉及者的 `id,x,y,hitPoints,temporaryHitPoints,conditions,dead,stable,withdrawn`。受众与可见单位过滤和原日志一致；旧记录缺字段不补造。客户端按已保存动作分组呈现正文、位置及本人生命，前序动作读完才开放后续本人等待。重连首次只读当前状态，不重播整场；命令始终使用最新权威版本，显示队列不回滚存档、不提供撤销或代掷。
- 不做自动寻路、碰撞、光照、FOV或通用怪物规则引擎。显式多点路径可由命令/工具传入，当前客户端拖动只提交一个目标点。

## 持久化与身份

`Campaign.Board` 为可空追加字段，`SharedBoardState.SchemaVersion=1`；GET不为旧档生成棋盘或迁移位置。持久实体拥有独立 `Id`、`Kind`、`Source`、`Appearance` 与 `Placement`。`Placement` 保留最后操作的地图位置，可空 `MapPlacements` 只保存其他地图的位置；`PlacementOn/WithPlacement` 统一读取与更新，不为同图维护两份权威位置。跨图摆放须给新图实际X/Y，旧图位置保留；移出只将该图 `OnMap=false`，不删除实例、HP或历史。重现须引用 `existingId`，不能再次按模板造同名实体冒充原对象。

玩家实体以 `ActorId` 与 `CharacterId` 关联原角色，数值读取原 `Character`，不存第二份玩家 HP。普通 NPC/怪物使用可空 `BoardStatistics`，复用既有 Ability、Item、Resource、Spellcasting、TimedEffect 等小类型；物体无需伪造生物资料。`Source` 为来源标识，不是当前机械状态。模板仅初始化新实例。

主持可通过 `BoardSpawn.Build` 创建完整构筑 NPC：走原 `CharacterEngine.CreateComplete` 校验，保存独立 Character，不建立假账号、席位或角色审核。原始 `Character` 注入被拒绝；完整构筑 NPC 尚不能自动作为敌方参战，不能据此声称已支持 PC 全职业敌人 AI。

普通独立换装与非战斗、无待结算的直接棋盘命令只保存最新状态和防重复执行回执，不再写操作事件、棋盘前后快照或 `ActionReceipt.BoardHistory`。不再支持撤销；位置有误时直接重新移动。战斗/检定结果、未完成移动和当前自然语言行动的执行步骤仍保留，以维持本人确认及精确恢复，不能将这些机械结果当作冗余流水删除。

旧存档的 `RecentOperations` / `BoardHistory` 只读兼容，不删除或重写已有记录，也不发送到新的公开/模型棋盘投影。新棋盘不写 `RecentOperations`；`BoardView.recentOperations` 固定返回空数组以兼容既有客户端。版本仍随真实状态变化推进，但不要求普通摆位或换装生成一条剧情事件。

## 坐标、授权与请求

API 路径均以 `/api/v1` 为前缀：

| 路径 | 结果 |
|---|---|
| `GET /campaigns/{id}/maps/{mapId}/board` | `BoardView`，含地图元数据、当前可见单位和可见待结算目标；`recentOperations=[]` |
| `GET /campaigns/{id}/board/tokens/{entityId}` | 当前 `BoardTokenDetail`；非主持不含来源与角色 Build/Creation |
| `POST /campaigns/{id}/board/commands` | `{board,result,replayed}`；正文最多128 KiB |

坐标是实际底图左上原点、X向右/Y向下、0..1，位置锚点为棋子中心。缩放/平移/留白不属于坐标。`snap=true` 由服务端按当前已标定 square 网格吸附至格心；不按未标定图推断距离。

写命令带 `requestId`、`expectedVersion`、`expectedMapVersion`、`mapId`、`operation`：

- `spawn`：`spawns` 1..32项，来源或现存实例、公开外观、实际 X/Y；批量原子提交。
- `move`：`entityId`、`destination`，可选最多64个显式 `path` 点及 `snap`。
- `update`：仅外观名称/说明/图标/允许的可见性，不写HP、AC、属性、资源、条件、来源。
- `remove`：移出而不删除。战斗离场必须走原战斗规则。

新请求的 `undo` 或非空 `operationId` 不再接受；旧请求若已有同席位、同指纹回执，仍按原回执恢复，不重新执行。

同 ID 同请求返回原结果并投影**当前**可见棋盘；不会重新执行。同 ID 不同请求为 `idempotency_conflict`；新请求的战役/地图版本不匹配分别为 `stale_version` / `stale_board_map`。授权在回执读取前完成；回执与操作在同一持久事务提交。缺少必填 X/Y 不允许被 JSON 默认成0。

玩家只控制本人角色，不能通过 HTTP 自报 `canControl` 或 narrator。主持控制非玩家单位，不因此取得其他玩家本人授权。玩家可读取已授权地图，但写入受当前场景限制。AI只取得当前场景的已发布玩家底图和公开单位，不发送GM底图，不借“过滤隐藏棋子”绕过底图权限。这是公开棋盘能力，不是隐藏GM棋子管理；主持HTTP私有权限不会转交给模型。当前不可见实例不公开；隐藏后再公开也不补发旧隐藏位置或历史操作。

Unity将原请求 JSON、端点和 requestId 持久保存后才发送。断网/不确定响应保留同一请求用于重试；收到有效回执先清 pending，再尝试读取新快照，读取失败不能使已确认命令复活。棋盘/详情的迟到返回校验连接、席位、场景、地图版本/hash和战役版本。

## 初始位置与AI控制（契约39）

`controlPlayers` 只存在于服务端受信调用，必须同时是 narrator；HTTP/tool schema没有该字段。当前公开图的 `board.sources` 可包含获准全队角色，首放仍绑定真实 ActorId/CharacterId。跨席位外观修改不因此开放；战斗移动仍限原执行者的合法回合/预算/借机与反应路径，不允许越权代打。

自动开场只额外开放 `map_state_read/token_read/token_spawn`，仅可为本人在当前图首放一次；不能移动已放置角色或摆放其他席位。存在当前图但未首放时，`opening_commit` 返回可修正的 `opening_placement_required`；非法首放返回 `opening_placement_unavailable`。首放保存位置、版本及幂等回执，不虚构玩家行动或推进时间。无当前图可以完成开场，未知位置不补图心坐标。详细开场合同见[业务冒险](adventure-sessions.md)。

回归：`DmPositionTests` 覆盖直接全队摆位/多次路径移动、旧版本权限、HTTP拒绝、开场先摆位后提交、重复拒绝与重启零骰重放。

## 发现与地图同步（契约40）

新v40侦察请求保存 `WaitForNarrative=true`。Search照常更新 `KnownActors/Hidden`，只把本次首次发现的实例记入该席位 observation 的 `UnpresentedIds`；已可见单位不会因再次观察消失。玩家地图、单位详情与相关战斗投影使用 `PresentedTo`，不会在骰点确认后、故事提交前显示新伏兵；主持的完整视角和DM私有 `encounter_read` 仍能读取实际结果。

仅v40的 `world_record` 提交非空私人正文时，`CommitNarrative` 才在同一保存事务清除当前场景、本人的待交付列表。仅公共正文或普通模型结尾文字不会释放个人发现。新输入可以承接此前叙事失败留下的已结算发现，不要求再次搜索或重掷。失败/等待/重启不清除待交付状态，其他席位也不因本人的故事取得发现。攻击等公开Reveal沿原规则立即公开。旧请求缺省保持原呈现语义，不回写历史。

回归 `EncounterPresentationTests` 使用真实Pi在叙事供应商前暂停：投掷只结算一次、本人及同伴无新token/详情、主持可见；提交后只本人可见。覆盖重启、原请求重放、供应商unknown、普通模型结尾、仅公共正文及显式新输入承接。攻击候选、范围法术目标说明、飞弹分配同样隐藏待交付目标；机械视线和命中规则不变。撤销过的发现者保留在历史已知列表，后续攻击公开仍可合法保存。

### 契约43：只交付明确发现

新 `world_record.privateMessages[].discoveryIds` 指定本次叙事实际交付的实体。服务端逐收件人验证该实体当前场景的 `KnownTo`，提交时只清这些目标的 `UnpresentedIds`；未发现者不能借私信取得目标位置。普通privateMessages没有discoveryIds就不释放其他发现，玩家转述也不改变地图或单位详情。已公开Reveal沿原规则。旧40..42保留上节单人交付语义，既有待检定不回写。

`KnowledgeVisibilityTests.DiscoveryDeliveryIsExactAndRetellingDoesNotRevealMap`覆盖两个隐藏目标、两名实际发现者、一名失败者：交付第一个不释放第二个，普通私聊和转述不放出位置，未知收件目标原子拒绝，重启不重骰。

## AI 图像与工具27

每个新模型槽位捕获同一战役/地图版本的底图字节、当前可见单位摘要和控制范围，不携带棋盘操作流水，再由服务端渲染真实 JPEG。执行帧持久冻结后才外发，重试沿用冻结字节；工具修改状态后下一模型槽位重新捕获。`map_state_read`读取状态与可用来源，图像由父端自动注入，不把URL或文件路径当图片。

`BoardRenderer` 使用 SkiaSharp，从权威底图绘制实际棋子与短标签；总览最长边最多768像素，较大底图另附局部图并给出原图归一化范围。每张图最多96 KiB。OpenAI使用真实 `image_url` data URI，Gemini使用真实 `inlineData`；不破坏Gemini原生签名续接。图像失败/地图不可用明确记录为 `image_failed` / `unavailable`；不静默改模型，不发送秘密底图，不宣称“看到了”失败图片。

契约27新增 `map_state_read`、`token_read`、`token_spawn`、`token_move`、`token_update`、`token_remove`；旧0..26目录保持冻结。已知来源限当前公开人物、当前遭遇模板、本人角色及现存可见实例；也可创建没有机械数值的 custom 生物/物体，模型不能附任意机械资料。工具写入核对父端本轮冻结的地图版本；已经变化时先返回刷新要求，不按新网格执行旧坐标。

## 执行流程修正（契约28）

以下记录契约28引入时的流程；当前运行版本见 [Harness运行](harness-runtime.md)。旧0..27工具目录、版本分支输出与已存回执保持冻结，执行帧仍为contract15。Gemini新回复的工具名按本次 `request.Tools` 校验，不再用冻结的v15 `HarnessTools.All` 拒绝较新的棋盘工具；原生历史仍核对已存parts、签名、调用ID及回复身份，不拿当前工具表改写历史，也不补发旧unknown。

### 棋盘行动与剧情记录

同一 Harness 输入的第一次棋盘写入使用 `intent.request` 作为事件根，`Resolution.Kind` 仍保留实际 `board.*` 类型，后续步骤与最终正文归入同一轮。旧版已经保存为 `board.*` 的根只在活动读取中按持久意图 ID、席位、RootSequence、harness 来源及步骤识别；不把后续棋盘事件拆成新行动，不重写历史或重发工具，原可见性及私密正文过滤保持不变。

### 路线读取、检索与发现

`world_routes(offset,limit)` 在v28返回 `{version,scope:"current_scene_authored_and_dynamic",routes,nextOffset}`；`offset` 为0..2048，`limit` 为1..16。每行包含 `source,id,from,fromTitle,to,toTitle,seconds,open,bidirectional,canTravel,editable`：

- `source=authored` 只来自**当前场景条件已满足的作者出口**，`id=""`、`open=true`、`canTravel=true`、`editable=false`；`bidirectional=false` 表示这一行不承诺反向通行。锁定出口及其目标不因本次读取揭露，不能用动态路线提议覆盖作者出口。
- `source=dynamic` 沿用原 `WorldRoutes.View` 的公开、接到当前场景的动态路线范围，保留实际 `id/open/bidirectional`，`editable=true` 仅表示可作为原路线提议的维护目标。关闭或仅入向的路线也可列出，但 `canTravel=false`；能否从当前地点出发以实际出口为准。旧版本仍只读原动态路线输出，`View` 本身不变。

已知入口、已知终点、已完成旅行、已处理途中危险是不同事实；读取路线和局部棋盘摆位都不旅行。v28局部检索先用输入实际提到的合法公开已知地点/记录/当前人物名，再用“前往/走向/寻找/拜访/询问/查看”后的字面对象，最后兜底原片段，仍最多查询4个输入词。它只改善召回，不扫描私密知识，也不授予发现或执行权限。

发现须先通过完整符合玩家实际输入的合法作者动作结算，再叙述事实；观察不等于接近、搜索或接受任务。旧叙事与作者条件不一致时，走既有主持剧情后果/事实裁定，仍受原内容、场景与权限校验；不能从 `world_record`、memory或模型先前文字自动开facts，也不能把已经宣告完成的动作简单再要求玩家重复一遍。

### 仅限整句的本人摆位

`HarnessBoardIntent.cs` 中的 `DirectPlayerBoardIntent` 不是通用自然语言授权。只有v28把原始已认证输入、本人实例和准确目标绑定后，才能复用原 `ExecuteBoardCommand` 直接保存一次 `move` 或单个本人 `player` 来源 `spawn`：

- 输入须为完整的有限句式，例如“把我的棋子移到地图中央。”或“把我的棋子放到地图坐标(0.6,0.5)”；中心必须对应 `(0.5,0.5)`，显式坐标须在0..1且与命令目标匹配。复合行动、地标相对位置或模型猜出的坐标不属于此入口。
- 不得有吸附或非空路径、战斗/角色受限状态、已知移动限制、本人待投掷/待意图/待裁定；本输入已有 `board.move`、`board.spawn` 或 `travel` 步骤也不再次直行。同一运行的席位与原输入必须一致，原地图版本、权限、回执和领域校验照常执行。
- 不满足时仍走原精确提议/本人确认或领域拒绝；绝不信任AI自报consent，不允许控制其他玩家，不允许用该入口免除战斗、资源或受限移动规则。普通探索保存位置不证明途中安全或发现完成。

### 敌对事件入口，不是新增完整战斗

v28在私有执行帧 `workingContext.guidance` 追加 `EncounterGuidance`：已有战斗按 `CombatEngine.InCombat` 使用当前行动/等待；否则从本帧合法 `combat.start` 候选和当前遭遇出发，用只读 `BoardCombat.Prepare` 预检实际单位、标定与执行资料。可用时指出 `actions_propose` 的准确候选ID，仍保留原本人确认/投掷；缺候选或预检出现 `board_combat_*` 缺口时明确指向 `ruling_request`，不泄露隐藏参与者或私有准备详情。

NPC决定实际攻击后，应先进入已有战斗入口或请求主持裁定；没有权威结算回执前，不得叙述命中、射空、护甲挡下、闪避成功或成功撤离，零伤害也不是无须结算的结果。`ruling_request(question)` 的问题（最多240字符）在v28写入原 `PendingRuling.Reason`，以便双端读到具体事件和执行缺口；请求本身不完成攻击。`rules_scope` 只说明规则可读性与执行边界，不能代替上述流程，也不自动切换2014/2024规则。

## 同图战斗支持范围

`BoardCombat`将真实归一化位置与原战斗整数格建立明确映射，保存初始格内偏移；进入战斗不吸附、不复位、不补造单位。回合数据重新初始化，HP/状态来自持久实例。每次结算（包括反应等待、NPC行动和结束）立即回写，已关闭的战斗仅作历史。

当前复用原小型引擎的边界：已发布当前玩家图、内部每格5 feet、完整方格每边最多32格/总计1024格、2..7个参与单位。新v42必须使用已校准的 `tactical` 图；`MapScale.TacticalGrid` 从原比例派生逻辑格（100px/10ft → 50px/5ft），无格但有可靠尺度同样可用，不改原图尺度。旧已冻结标尺继续按旧合同恢复。参与者须已实际摆放，原遭遇的固定地形 Cells 暂不推测映射到任意图。重叠占格、边缘非完整格、未知机械资料或不支持的持续状态明确拒绝。

原引擎支持的自动敌方需要当前遭遇的 `enemy` 来源实例，并核对遭遇/内容版本/RulesId；同模板可以多个独立实例。NPC名字、外观、图标或随机实例ID不能替代模板规则身份。任意公开NPC、自定义棋子或完整构筑NPC的自动攻击结算仍未普遍支持，缺少合法遭遇/可执行资料时由主持裁定；v28没有新增通用怪物攻击或自动完整战斗。已死者不会重置复活；移出后再摆回沿用当前HP。

战斗移动复用原移动消耗、借机、反应与本人确认规则；多步路径必须逐格相邻，不自动寻路。中途等待、预算不足或条件变化时只保存已结算前缀，剩余步骤不排队。实际落点以返回棋盘为准，不能把请求目标画成已完成。

## 资产、验证与维护入口

BG3九张棋子素材由客户端与服务器共享，来源和私用边界见 玩家图标。已经通过可见性检查的地精战士、骷髅、僵尸按精确规则来源补图，显式外观图标优先；旧空图标只在投影中补齐，不用GET改库、不按名称子串猜身份。图标不授予规则；尚未揭示的单位仍不可见。玩家头像合同见[角色头像](character-portraits.md)。服务包会附 SkiaSharp 实际许可证与BG3来源说明；本地验收包不等于公开再分发授权。

回归入口：`SharedBoard*Tests.cs`（服务端HTTP、真实Pi/fake供应商、持久化/隐私/战斗/同版图片）；Unity `SharedBoardTests`（真实JsonUtility、拖动、待结算、列表与共享战斗布局）；工作台 `board-ruling.test.js`。实际执行结果与候选包位置归本任务验收记录，不将离线测试说成线上LLM质量或系统键鼠/中文IME验收。

源码所有者：Domain `BoardModels/SharedBoard*/BoardCombat`；Application `BoardService/BoardCombatService/HarnessBoard*`；Infrastructure `BoardRenderer/MapCatalog.Board`；Unity `BoardProtocol/BoardPresentation/AdventureBoard/CartographyTokens/MapViewportTokens/CombatPanelShared`。
