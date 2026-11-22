# 冒险行动与内容设定：双端业务接口

工作台按 PC 桌面使用，不适配 H5／手机。用户看到战役、自己的行动或回答、明确确认、结果和内容准备；Pi/MCP、Run 和绑定哈希属于服务端执行内核，不是可选的产品模式；主持剧情页可只读查看模型/工具步骤，成功后保留在对应轮次下并默认折叠，展开后按需读取请求详情。以下描述**当前源码接口**；完整内核语义和旧 HTTP 兼容仍见 [运行协议](harness-runtime.md) 与 [工作区协议](harness-workspace.md)。源码所有者：[AdventureEndpoints](../server/DiceRealm.Server/Api/AdventureEndpoints.cs)、[AdventureSessionService](../server/DiceRealm.Server/Application/AdventureSessionService.cs) 与 [AdventureProtocol](../server/DiceRealm.Server/Application/AdventureProtocol.cs)。

## 战役与本人行动

使用 Bearer 席位凭证；工作台创建 `POST /api/v1/campaigns/from-content` 发送 `name,adventure,prompt,methods`，不发送角色字段，返回无玩家角色的主持连接（character=null、party.isHost=true）。需要使用者自己的剧本和提示词，没有默认故事。服务端显式characterName+完整build仍保留协议兼容并重验，但工作台没有建卡入口，不接受预设/简化creation新建玩家。创建**没有 requestId**：响应未知不可自动重复创建；收到凭证但本机保存失败，先明确导出已收到的私有连接文件。旧战役不会自动转换。Unity 现在可通过本人连接接入业务冒险；只有服务端明确确认是旧战役时才使用原输入链。

下表路径均以 `/api/v1/campaigns/{id}` 为前缀；`sessionId` 标识一条本人行动，不应作为产品界面中的运行管理入口。

| 方法与路径 | 业务含义 |
|---|---|
| `GET /adventure` | `{sessions:[AdventureSessionView]}`，只读本人未结束行动；本人仍需入场时也返回近期原开场运行（含失败），用于恢复而非自动重发。可能多条，读取和选择均不执行模型。另有可选 `othersActing:[actorId]`：主持此刻正在处理的其他座位行动（不含本人），只为让玩家页显示「主持正在回应 X…」；没有时不出现，`/harness/runs` 的形状不变 |
| `POST /adventure/actions` | `{requestId,expectedVersion,text}`，开始本人行动，接受后返回行动视图 |
| `GET /adventure/sessions/{sessionId}` | 读取已知行动，不生成或恢复 |
| `POST /adventure/sessions/{sessionId}/continue` | 同一请求形状，提交回答或接续原行动，不代替新的同意 |
| `POST /adventure/sessions/{sessionId}/stop` | **无正文**，停止后续生成，不撤销领域效果 |
| `GET /adventure/memory` | 本人近期已公开行动的有界只读摘要，不是当前角色数值或完整历史 |

`AdventureSessionView` 为 `sessionId,phase,question,confirmation,outcome,notice,actionText,replayed,actionId`；`confirmation` 可空，否则为 `{kind,waitId,prompt}`。阶段为 `working / needsAnswer / needsConfirmation / ready / unconfirmed / stopping / stopped / failed / done`。可选 `opening:true` 表示入场生成，其 `actionText/actionId` 为空，不伪造玩家发言或行动根。`needsAnswer` 可由本人明确回答、`ready` 可在安全前提下明确续接；Unity 在领域确认已有精确权威结果后自动发送接续命令，新的选择或投掷仍需本人同意。`unconfirmed`（含 started 但没有可靠回执的模型步骤）禁止补发。本人来源选择、放弃与投掷同意仍走领域端点 `/intents/respond`、`/rolls/respond`，用当前本人快照的精确等待 ID 和已展示版本；继续、停止、刷新均不自动同意或掷骰。取消后若仍有待确认领域请求，须在本人确认入口另行明确放弃；已提交效果、可能产生的费用不会回滚。请求发送前保留完整原端点、ID、版本和正文；丢响应原样重试，不换 ID/版本；GET 不执行模型。服务器仍逐次鉴权，主持不能旁读其他席位私有行动。

战斗代理首条交接继承父行动输入，用于执行与审计，不是玩家再次发言。服务端按持久`CombatFirstInput`将该条业务`actionText`和主持progress.input投影为空；原Run.Input不改。等待/重启/冷读一致，后续独立请求即使文字相同也正常展示，不能靠正文去重。

## 入场开场：共同一份、个人一次

新内容可在 `AdventureDocument.opening` 声明 `{mainSceneId,entrySceneIds}`：主线锚点和有序的可入场地点。启用时按**初始可通行作者出口的累计 Seconds**选择到主线最近的候选，同距离按作者候选顺序；不以坐标、地点名称或安全休息标记猜距离。候选必须可达且具有公开 Arrival。未声明时仍用旧 `startSceneId`；空字段省略以保留旧文档指纹。持久生成只在 Harness 战役启用；旧双提示词引擎可使用显式选址，但不建立无法完成的开场等待。已启用房间不迁移位置、不重置主线或重写旧开场。未接受主线的初始局面须由作者资料明确表达，入场生成不替玩家接取任务。源码：[选址与状态](../server/DiceRealm.Server/Domain/AdventureOpening.cs)、[内容启用](../server/DiceRealm.Server/Application/ContentService.cs)。

`POST /api/v1/campaigns/{id}/adventure/opening` 仅接 `{requestId,expectedVersion}`，返回 202 `AdventureSessionView`；没有玩家输入正文。已批准的本人通过原 Harness 队列、冻结 profile、预算与持久回执执行；可信 `Run.Opening` 在v38限制为 `opening_commit` 和只读 `context_read/skills_list/skills_read`；v39增加当前图只读与受限本人首放 `map_state_read/token_read/token_spawn`，普通行动不能冒用提交工具。38..42首次提交保存一份第三人称公共开场和本人可空的第二人称补充；43允许公共正文也为空，个人消息按实际收件人指定，细节见下节。以后入场的 `public` 必须为空，只补已经成立的**当前**相关处境，不重演共同现场。叙事提交本身增加事件与战役版本，不修改 facts、时间、位置、库存或主线状态；v39若存在当前图，先由AI DM保存一次本人初始位置，再提交与实际位置一致的开场（位置步骤不生成玩家行动根）。无图仍保留未知位置，不默认图心；原事件保留作审计和分享来源，但不作为 `/activity` 的玩家行动根，避免重复公共开场或伪造玩家发言。普通新行动在本人尚未完成入场时返回 `opening_required`。

快照 `opening` 独立保存共同正文/原序号、本人是否仍需入场及有权阅读的 `privateParts`，不依赖最近100条事件。公共部分交代共享背景、现场可见关系、公开言行与可回应局面；个人部分仅补已成立的来此原因、关系、已知信息和实际处境，无差异可为空。不编造动机、承诺、发现或反应，不免费揭露秘密，不把同队当作相识或信任。两部分描述同一时刻；后来加入以当前事实为准，已异地角色不能借公共叙事获知异地秘密。生成期排除工作情境中的主持专用证据。规则与边界见 [HarnessOpenings](../server/DiceRealm.Server/Application/AdventureOpeningService.cs)。

GET、刷新与重启均不生成。Unity 完成能力发现并进入可行动界面后自动发送一次明确的开场 POST，不自动提交草稿为行动；已知原运行先恢复。自动提交每连接范围只尝试一次，版本冲突或其他席位忙碌的明确拒绝也不在逐帧更新中连续重发，使用现有“重试开场”入口恢复。丢响应只重试原端点/ID/版本；原请求重放不再次调度。失败或结果未知不自动换 ID 再生成，须先读取原运行及已保存开场，必要的新生成由玩家明确发起。v39有图未摆位的提交返回 `opening_placement_required` 供模型修正；重复/越权首放为 `opening_placement_unavailable`。`opening_completed` 拒绝重复入场，`opening_context_changed` 拒绝首次现场已变化或战斗中的开场；最终自由文本不能绕过 `opening_commit`。实现：[HarnessRunService](../server/DiceRealm.Server/Application/HarnessRunService.cs)、Unity 入场。

## 私人剧情：按实际知情者交付与主动转述

新工具契约43的 `privateMessages` 按实际知情者指定 `recipientIds`，可以只给非行动者或同时给多位共同经历者。指定玩家与主持可读，其他席位收不到正文或“有人得知秘密”的占位提示。主持代读不授予转述权；主持自己的真实角色若明确是收件人，则可转述。公共现象与个人理解分别交付，私人、公有正文都可为空；未发现目标及未成立的前情不能任意作为私信发出。完整工具合同见[契约43](harness-runtime.md#当前契约43按实际知情范围交付)。

事件、裁定、活动及开场通过 `privateParts` 逐片段投影。来源 `PrivateStorySource` 为 `{kind,id,sequence,revision,partId?}`，kind 仅 `event/ruling`；revision 是源正文 UTF-8 的 SHA-256，partId 区分同一事件的多条消息。`PrivateStoryPart.canShare` 按当前阅读者是否为实际收件人给出，不按行动者猜。旧 `privateText` 与缺partId的来源继续按行动者合同兼容；无精确来源的旧正文只读。私人活动投影不能顺带泄露原行动输入、判定步骤或主持材料。同一次行动从私发继续到公共结果时，后续公开事件独立显示，`continuationOf` 指向原根；公共变化与该步机械记录保留，非行动者不收到原私人输入/标签/补充问答，原私文仍按各片段收件人过滤。此规则覆盖冷历史与重启，不因后来公开而追溯公开原根。完整类型归 [PrivateStories](../server/DiceRealm.Server/Domain/PrivateStories.cs)。

| 方法与路径（战役前缀） | 合同 |
|---|---|
| `POST /adventure/story/share` | 手写请求 `{requestId,source,text}`，text为1..1024字符正文；快速请求 `{requestId,source,quick:true}` 不传text。不接actorId或expectedVersion。返回 `ActionResponse.sharedStory`，两种转述均标记 `publication:"retelling"`。旧缺省quick且省略text的原请求仍按全文分享兼容 |
| `GET /adventure/story/shared?after=0&limit=50` | 按独立分享序号升序分页，after 排他、limit 1..100；返回 `after,nextAfter,hasMore,entries`，不调用模型 |

服务端在同一战役事务重新授权、读取原来源并核对实际收件资格及正文修订；旧事件从持久历史读取，不受快照尾部限制。伪造、非收件人、主持专用、不可见或已经变化且尚未公开的来源统一拒绝 `private_story_unavailable`；非法形状为 `invalid_story_source`。同requestId/原请求先回原回执，异文为 `idempotency_conflict`；转述按来源片段、分享者及正文去重，同源可以再次说不同的话。旧无text全文分享仍按原来源去重。公开记录与席位回执原子保存，使用独立序号，**不递增战役机械版本**，不使活跃Run或待投掷失效，不重基它们，也不续接冒险模型；只有明确的quick请求生成一次转述。实现：[PrivateStoryService](../server/DiceRealm.Server/Application/PrivateStoryService.cs)。

转述只公开所说文字及说话者，不携带源私文全文、其他片段、判定或主持资料，也不授予队友精确地图位置。双端“快速转述”直接冻结quick请求进入原pending，辅助文字模型单次生成后立即公开，不弹预览/确认窗；“手写转述”仍打开空编辑窗，不预填全文，关闭零提交。未知结果原样恢复，不换ID自动重发。转述后不将源消息标成“全文已公开”，仍可再次转述。旧全文记录保留“已公开”和原文中“你”的所属说明。

快速生成由 `PrivateStoryRetellings` 使用现有辅助模型配置和用量记录，只发送本人该条来源与角色名，无工具、无自动重试。外发前保存 `story-retellings/<campaign>/<hash(actor:requestId)>.json` 的issued回执，完整有效正文后保存generated；记录不随游戏读档回退。模型等待不持战役锁，提交前重新校验席位、来源与时间线；已成功发布的原回执优先。同ID并发/重启不会再次外发，generated只重试发布。

quick与text并存为400 `invalid_story_text`；未配置辅助模型/离线试跑为409 `story_retelling_disabled`；完整HTTP失败或无效/超大正文为409 `story_retelling_failed`，无公开；断连/取消保留issued并返回409 `story_retelling_unknown`，不把未知当未发送。跨时间线记录为 `story_retelling_timeline_changed`，来源/现场复核失败为 `private_story_unavailable`。原请求异文仍 `idempotency_conflict`。错误后可手写或明确发起新请求，刷新/重启不会替玩家重发。回归 `QuickRetellingTests` 覆盖一次外发、并发/重启、权限、时间线变化、完整失败/未知与Gemini；旧分享由 `PrivateStoryTests` 守护。

快照 `sharedStories` 仅带最近100条，完整分享历史由专用GET分页。已发布文字不可撤回，后续修改源私文不抹去旧公开版本；角色说法不自动成为机械事实。新v43模型槽位从原存储读取当前角色已知的相关消息正文，包含开场、普通事件及裁定，主持身份没有跨角色旁路；不另上传私人行动流水。旧0..42运行及已冻结帧不回填。v38已公开分享和本人开场的原合同仍见[工作区与记忆](harness-workspace.md#入场与主动公开上下文工具契约38)。

## 主持执行进度只读

1. **范围**：`GET /api/v1/campaigns/{id}/adventure/progress` 仅本战役主持；无参数观察已批准且未撤销玩家的近期步骤，成对传 `actorId,actionId` 精确读取某轮历史（允许本战役已撤销席位）。不改变原始Run/本人行动端点权限。
2. **签名**：响应 `{runs:[{id,actorId,actorName,status,succeeded,steps:[{number,kind,status,tool,version,waitKind}],actionId,version,input}]}`。`input`为已提交原文（首条战斗交接不重复投影继承输入），旧服务缺失兼容为空；先显示本轮玩家输入再显示过程，不能借上一轮补齐。`actionId` 是IntentId，不能与HTTP请求日志的runId混用。进度列表不含prompt、推理、原始工具参数/结果、错误原文或hash。单步详情由主持专用 `GET /adventure/progress/steps/{number}?actorId&actionId` 返回 `{runId,actionId,actorId,number,kind,status,tool,request,response}`；number从1开始，精确索引所属run。request为已存tool/final参数，model为null；response仅done时有值：model为公开text/toolCalls/inputTokens/outputTokens，tool/final为content/isError/stop，不含ProviderContinuation/thought。旧toolRequest缺失时仅凭此前模型调用与原callback完整fingerprint一致恢复参数，无法核对返回null，不猜测。主持用 `GET /model-requests?runId&before&limit` 查询该轮保留的HTTP摘要，再按需 `GET /model-requests/{requestId}?publicOnly=true` 读取安全正文；参数是战役路径下的查询，不增加跨战役权限。
3. **契约**：无参数仍为每席位有界热记录+最近一条冷终态；精确历史用派生 `harness-history.sqlite` 的 `(campaign,actor,action)→run` 索引，读取原run并再次核对身份。索引在启动回填未索引旧文件及新建run时维护，不复制回执/步骤；旧run字节不改，GET不写索引、不扫描解析全部历史、不恢复执行或推进version。坏旧文件按席位记为未完成索引并安全告警，不阻断健康战役启动；所属缺失关联读取不能假装空成功。`succeeded`代表已完成且有明确已提交结果，包含v43空公共叙事和可空开场；旧运行仍按原Text/开场合同判断，成功过程默认折叠，等待/失败仍可见；原根未载入时先画run.input玩家气泡及独立过程，原根到达后按actionId+actorId合并、不重复。历史折叠入口按需读取，不因最新运行替换而丢失；保留展开、内部滚动与焦点，迟到GET尊重用户已经收起的状态。HTTP日志仍只保留**全局最近300条**，过期可缺项；完整步骤不等于HTTP原文永久保存。`publicOnly`在服务端白名单投影OpenAI/Gemini消息、工具与公共回复，排除reasoning/thought/signature，不把未知格式原文透传；原始诊断入口与存储保持原授权。
4. **错误**：非主持403、外战役凭证401、旧战役409 `harness_campaign_required`；只传actor/action之一400，非本战役actor404，合法但不存在action返回空数组，身份不一致或损坏run返回409。单步缺actor/action或number越界形状400，不存在run/步骤404；损坏参数指纹409，不放宽本人Run端点。被淘汰HTTP详情404。近期每1.5秒串行读取，隐藏页跳过，失败暂停并显式重试；步骤和HTTP详情在独立宽窗口内读取，左侧导航、右侧参数/返回；请求与响应页签分开，正文不内联挤进聊天。刷新是只读且保持可用，追加HTTP分页保留所选详情与阅读位置。历史及详情读错在窗口内重试，dispose/失去主持权限丢弃迟到结果，均不调用模型。
5. **例子**：第三轮成功后刷新，展开第一轮仍读取第一轮完整步骤及尚保留的HTTP请求；旧无toolName显示通用步骤，无关联字段不猜姓名/输入。成功折叠不删除，失败不推断成功、不自动重试执行。
6. **回归**：`HarnessReadTests`覆盖三轮/重启/旧索引重建/坏冷记录隔离/撤销席位历史/GET字节不变和零模型，并验证末次工具参数/结果、旧fingerprint恢复、模型白名单、guest拒绝与step不存在；`ModelRequestLogTests`覆盖run过滤、跨战役/跨权限、分页、300条保留及HTTP公共投影不含推理；`story-progress.test.js`、`story-request-trace.test.js`覆盖精确关联、默认折叠、最新poll保留旧轮、迟到收起/焦点、按需详情、读错和dispose。真实浏览器以最终嵌入包验证原轮展开、请求内容、轮询和重启，不以DOM替身代替。
7. **正误**：不能放宽原私有Run端点、把latest1当历史、按姓名/文本匹配或只用CSS隐藏私密推理；使用host专用进度/步骤投影、精确actor/action索引和服务端公共请求投影。不得把已淘汰的HTTP记录伪称没有调用。

剧情首次进入在异步渲染完成且主视图已挂载后滚到feed底部；DOM未挂载时scrollHeight为零，不能把提前赋值当成功。字体加载后仅尚未交互时补定位，后续轮询和加载旧页保留阅读锚点。

## Unity 玩家端

初次游玩须使用主持的邀请，在 Unity 完整建卡并采用后加入，主持批准后行动。已有真实玩家席位可导入**本人私有连接文件**继续游玩；新无角色主持连接只能用于工作台，Unity会拒绝导入且不覆盖当前玩家。内容创建、设定和主持管理仍在工作台。Unity 不增加执行引擎选择或运行管理页。

- 主输入发送新行动；需要补充时按钮改为“回答”。正文按群聊呈现各玩家发言、DM回应、真实检定、私密内容与等待状态，仅真实待回答、待本人确认或中断恢复时提供辅助入口；working/stopping不再显示“查看进行中的行动”及同义入口，选择本身不执行。
- 主界面直接打开本人投掷/来源确认；投掷也可在主输入精确输入“投掷”或“取消”，不把“好”等含糊文字当同意。收到同一等待的已保存结果后自动接续本次叙事，DM 的对应裁定 resolved 后亦如此，不再要求“核对结果并继续”。新的选择/投掷仍停下等待本人同意；停止只阻止后续生成，残留等待只能另行明确放弃。菜单保留本次行动、停止和中断恢复；缺失结果或中断不能假装自动完成。自动接续沿用唯一 pending，丢回复只能原样重试，不在轮询中生成新请求。
- `unconfirmed` 不提供继续/停止，也不允许按相同原文补发。可只读同步或提出另一项新行动；客户端不能判定未知结果等于未执行。
- 能力发现使用 authenticated `GET /adventure`，仅 `409 harness_campaign_required` 选择旧链。401、404、5xx、网络错误和损坏响应都保留状态、禁止猜测降级。同一游戏版本也读取行动进度，GET 不触发模型。
- 业务命令与旧领域命令共用唯一待确认文件，发送前保存原端点/正文；stop 保存空正文并实际无正文发送。本机恢复 ID 不进入 stop 请求。启动后只恢复原请求，重试不刷新它的版本或新建 ID。
- Unity 草稿与最后行动位置按服务地址/战役/席位持久保存；这不同于浏览器普通行动仅在当前标签页保存。成功回执先保存行动位置，再清 pending；只有原文本和修订号同时匹配才清草稿。坏文件保留并阻止覆盖，晚响应不清较新草稿。
- `AdventureSessionView.actionId` 与 `ActivityEntry.actionId` 是同一意图身份，仅非空且精确相等才合并live与历史；旧服务/旧记录缺失时兼容但不按输入文本猜关联，不借别人的骰点。首次最近50事件范围，显式加载更早；新版本重读已加载范围以更新旧根。失败保留正文与草稿，读取重试不提交命令。`ActivityEntry.steps` 保留每一步的检定、消耗变化和战斗记录；有steps时不再重复兼容字段initialResult。Harness来源或多步记录尚无narrative时，不以initialResult.summary填充DM气泡；首次snapshot回退同样遵守。机械摘要仍在冒险日志，等待/失败仍有状态，旧非Harness直接行动保留摘要兼容。

获得提示只来自已保存活动的 `steps[].origin.changes` 中正整数inventory增加（无steps才兼容entry.origin），显示实际收件人、目录译名与差额；稳定activity/step/actor/item消息身份防轮询或最终正文重复。有steps时不同时显示外层兼容changes。不解析叙事或初次背包快照发提示，不在UI发物；服务端结算见[契约18](harness-runtime.md#剧情获得物品契约18)。

实现入口：AdventureBusiness、本机恢复。使用最新客户端源码和支持业务 API 的服务端；旧发布包不会因此自动更新。尚未提供 discovery 的旧服务可能返回无业务错误码的404，此时新客户端不会自动发送旧链。旧战役兼容指支持 discovery 的服务明确识别旧战役，不等于任意旧服务器版本兼容。

## 内容准备 · 冒险设定

以下同样以前缀 `/api/v1/campaigns/{id}` 拼接，设定/历史/导出仅主持可用：

| 方法与路径 | 含义 |
|---|---|
| `GET /adventure/settings` | `settingsVersion,activeRevision,latestRevision,draft,active,matchesActive` |
| `POST /adventure/settings/preview` | `{contentId,contentVersion,prompt,methods}`；只校验，不保存/外发模型 |
| `POST /adventure/settings/draft` | `{requestId,expectedSettingsVersion,contentId,contentVersion,prompt,methods}`；只保存服务器草稿 |
| `POST /adventure/settings/publish` | `{requestId,expectedSettingsVersion}`；发布**已保存**草稿 |
| `POST /adventure/settings/activate` | `{requestId,expectedSettingsVersion,revision}`；明确启用指定修订，仅影响后续新行动 |
| `GET /adventure/settings/history?before=N&limit=20` | 分页已发布历史 `items[{revision,savedAt}],nextBefore` |
| `GET /adventure/settings/history/{revision}` | `{revision,savedAt,prompt,methods}`；阅读，不启用 |
| `GET /adventure/settings/export?revision=N&includeDraft=false` | ZIP 内容包，不是完整存档备份 |

`draft/active` 均是 `{contentId,contentVersion,prompt,methods,fingerprint}`，`methods` 项为 `{id,description,content}`；`fingerprint` 仅用于客户端并发基线比对，**不在 UI 展示**。内容标识与版本须随正文在发送前显式冻结，原请求重试保持完全一致，不能从变化的服务器状态重新推断身份。三个命令各有独立回执与版本比较；发布过的相同内容不可假装再发布，`matchesActive` **只表示草稿与已启用内容相同，不表示已发布**。历史的“使用”由用户选择修订后走同一个 `/adventure/settings/activate`，**没有** `/history/{revision}/use` 命令。设定版本与游戏 `expectedVersion` 分离，冲突时保留本地文字、明确核对，不能静默重基。

旧 `/harness/*` 路由和原始请求体/回执仍保留，供旧客户端、已捕获的 pending 和 IndexedDB 草稿原样恢复；新请求走业务端点，不把旧请求重新包装为新请求。现有 IndexedDB 草稿格式兼容但不因此赋予普通会话跨关页持久性：普通行动与连接只保存在当前标签页。详细旧协议见 [运行协议](harness-runtime.md) 和 [工作区合同](harness-workspace.md)。实现状态以 [当前状态](current-status.md) 为准。
