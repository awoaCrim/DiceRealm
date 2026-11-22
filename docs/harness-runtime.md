# Harness P0/P1：运行、工具与恢复

这是 Harness 首阶段实现：**真实 Pi SDK 工具循环 + 标准 MCP 桥 + .NET 权威命令**。只对显式创建的新 Harness 战役启用，不迁移旧战役。后续已通过[业务冒险接口](adventure-sessions.md)接入工作台与Unity，新旧战役按服务端能力区分；这不表示已完成全部 P3–P4、部署或真实模型质量验收。

父子协议详见 [Agent Host wire v1](harness-agent-wire.md)。后续P2已增加 [版本化工作区与记忆](harness-workspace.md)，契约5加入[长期记忆与父进程上下文压缩](harness-long-memory.md)；浏览器 `#/adventure` 复用本页的 Run 与既有领域确认合同。

## 1. 组件与权限

- `agent-host/`：Node ≥22.19，固定 Pi `0.87.1`、MCP SDK `1.30.1`。Pi 真正执行多轮模型/工具循环；MCP Client/Server 经 `InMemoryTransport` 执行 `listTools/callTool`，不是把普通函数改名为 MCP。
- `HarnessRunService`：接受输入、绑定战役/席位、管理运行与预算、持久步骤回执、安排暂停/恢复。模型等待不持有 `CampaignStore` 锁。
- `HarnessGameService`：短事务内重新授权、查原回执、检查版本、执行既有 Domain。模型没有任意状态补丁、骰点、HP、资源或地图生成权限。
- `PiHarnessRuntime`：最多4个常驻 `PiHarnessProcess` 的空闲池；Harness启用时服务启动预热1个，其他按需启动，独立战役可同时等待供应商；空闲进程优先热复用。既有最多4条运行和同战役互斥不变，每条Run的模型/工具依赖链仍顺序执行。取消排队任务不触碰worker，执行取消/EOF只终止所属worker，不重试未知调用。只继承必要系统路径/临时目录环境，不传 provider key、Bearer token、`NODE_OPTIONS` 或开发者配置环境。
- Node 使用显式空资源发现、内存 credentials/settings/session、固定虚拟模型桥。桥通过父回调取得真实模型回复；测试提供 fake provider，**不是 fake Pi 循环**。无内置 bash/read/write/edit，无任意外部 MCP 地址导入，无脚本型 Skill 执行。

预设 `systemPrompt` 原文包括前后空白逐字保留。工具合同通过工具 schema/description 提供，不追加游戏 system prompt。SDK 自动重试、压缩和 cache warming 关闭；每次模型调用必须经过父回调。MCP 可能调整 JSON 对象键的排列，因此回放指纹规范化对象键；数组顺序、字段值和文字仍必须相同。

## 检定速查随清单给出（契约59）

契约59只在探索 checklist 末尾追加 `HarnessDmChecklist.CheckReferenceRule`：DC 六档（非常简单5、简单10、中等15、困难20、非常困难25、几乎不可能30）和常见能力/技能搭配，并说明普通检定不必再调用 `dm_reference(checks)` 或 `rules_search`。工具目录与战斗 checklist 同契约58，旧 0..58 运行不变。来源是2026-11-22网页真实模型实测：一条“答应委托、追问、去门口看泥地”的行动，主持在 `check_request` 前先调用 `dm_reference(checks)`（20s）和 `rules_search("Survival 追踪 脚印")`（15s），模型思考写明不确定 DC 与技能才去查；查到的速查只有六档 DC 和一句说明。改后同一房间两次检定（作者检定与自定 DC 的奥秘检定）都没有再查速查或规则。

## 后加入的公开到场（契约58）

契约58只改开场：公共开场保存后才入场的玩家，开场帧带 `opening.writeArrival=true`，`public` 可写最多两句、200 字以内的第三人称到场，只写本人加入当前场景，不重述地点、他人或已保存的开场；已有公开内容写过此人时留空。`writePublic` 仍只表示第一份公共开场，`opening.publicText` 不变，到场句作为该座位的 `story.opening` 公共事件保存。工具目录只在 `opening_commit` 描述后追加这一例外，探索与战斗checklist与契约57相同，旧0..57运行不变。来源是2026-11-22网页真实模型多人实测：第二位玩家加入后，其他人的剧情里没有任何他到场的叙述。同一契约起，当前场景的可委派遭遇若由剧本写定，探索帧的遭遇说明追加 `GameService.AuthoredEncounterRule`：敌人数值随遭遇保存，可直接委派；`encounter_plan` 的 `executableProfileId` 只限 `encounter_prepare` 新建敌人；委派前缺少的队员与敌人站位先用 `token_spawn` 从 `board.sources` 摆好。来源同一次实测：空白方格装好后，AI主持把规划工具的这条说明当成剧本河匪不能开战，转交了裁定。加上这句后，真实房间的情境说明（`workingContext.guidance`，全部为服务端文字）超过原 1000 字结构上限，帧校验失败、行动未调用模型就失败；上限改为 2000（`HarnessSceneContexts.MaximumGuidance`），对所有契约只放宽、不改帧内容。回归入口 `HarnessExecutionProtocolTests.CatalogIsShortAndFrozen`、`AdventureOpeningTests.OpeningCannotExecuteActionsOrRewritePublic`、`BlankGridTests`。

## 叙事不复述玩家原话（契约57）

契约57只在探索checklist末尾追加一条 `HarnessDmChecklist.NoEchoRule`：玩家原话会原样显示在公共叙事正上方，叙事从这一步实际发生的事写起；玩家明确写出的台词按已说出处理、不在正文重写，不按原话顺序复述动作、提问和计划。工具目录与契约56相同，战斗checklist不变，只影响新Run。来源是2026-11-22网页真实模型实测：改前几乎每轮叙事都把玩家原话整句重写一遍，改后同一战役的新回合直接从人物回应写起。回归入口 `HarnessExecutionProtocolTests.CatalogIsShortAndFrozen`。

## 探索只读预载与同轮查询（契约56）

契约56在每个新模型槽位复用 `ReadHarnessExecution` 预载资料，工具仍可按需读取。只影响新Run；0..55目录、checklist和已冻结槽位保持原样。执行帧的 `contract` 仍是15，不能以这个字段推断工具契约版本；应读取Run的 `toolContractVersion`。源码已实现不代表日常运行包已更新，实际交付见[当前状态](current-status.md)。

- `scenePresentation.arrival`：当前已访问场景的完整公开入场原文；`arrivalStatus=included`表示已完整提供。后续事件及当前状态优先，旧入场正文不代表新事件，也不要求重写开场。超过8 KiB（供应商JSON的UTF-8字节）时整项省略并标记 `omitted_size`，需要时仍用 `context_read {scope:"scene"}` 完整读取，不截取可能改变否定/归属的半句。
- `readPreload`：只存在于普通探索的私有模型帧，`audience=dm_only`。`encounter`复用 `encounter_read` 的当前机械准备、名单、隐匿和发现投影，超过12 KiB整项省略并在 `omitted` 标记 `encounter:size`；`rulesScope`复用 `rules_scope` 元数据，始终读取本Run固定的 `RulesCatalogVersion`，不跟随活动库指针。两者不进入玩家DTO、公开context或世界更新引用。开场生成不提供它们，独立战斗继续沿原合同按需读。
- 当前角色/候选、workingContext和棋盘 `board.state/maps/images` 已由旧合同提供，不再建立第二份预载。完整角色、物品目录、规则正文、历史扩展及 `checks_result scope=scene` 仍按需；当前checklist的progress不等于全部场景检定记录。
- 整个请求触及既有传输限制时，先省略这些可选预载，再尝试既有历史brief/整理路径；`arrivalStatus=omitted_transport`、`omitted=["encounter:transport","rules_scope:transport"]`明确标记。必需正文、当前工具链及原生签名保持；仍超限则沿原错误返回。没有新增模型调用、Token估算门禁、配置开关或额度；`HarnessInputBudget`只保留旧存档兼容，实际新槽位沿契约45的usage/传输策略。

探索checklist及读取工具说明要求优先使用已供同版情境。确实需要多个互不依赖的只读查询时，在同一回复发出多个tool call；依赖前一步ID、骰点或写入后新状态的调用必须等结果。服务器仍按原次序执行，不在本轮实现并发工具调度，也不修改导入的system prompt。原先契约55的主持工具说明在56移入checklist，避免叠加到未绑定遭遇的workingContext.guidance后超过已有1000字限制。

回归入口：`HarnessReadPreloadTests`覆盖实际读取一致性、私有受众/开场排除、固定规则库、大小省略和传输回退、真实Pi/MCP批量读取、55/56重启回放；`HarnessExecutionProtocolTests`保留0..55冻结目录与checklist。离线测试只证明协议和机制，减少实际模型往返及叙事质量须经另行授权的真实A/B验收。

## 移动后原输入续接与空转回合（契约53）

新运行使用53；0..52工具目录、检查单、冻结槽位与回执不改，执行帧仍contract15，没有新HTTP端点、玩家操作或存档字段。本人移动完成后的待叙述帧暂时隐藏下一步候选，因此它不能单独证明整句输入已经完成。`world_record`交付本人的新移动、仍轮到本人且没有规则等待时，服务器忽略该段的终止要求，返回`inputContinues=true`并沿同一Run刷新候选；普通final沿原`ContinueCombat`回执续接。只有确认刷新后的原输入已经完成才结束，不重做已保存的移动和叙事。独立按钮的自动叙述不获得新动作权限。

完整意图仍由原DM理解：需要接近则选择下一合法格，实际已进入范围且原输入要求攻击时才请求本人攻击投掷；“只走一格”必须在刷新后停止，不自动攻击或结束回合。这不是寻路/语义计划器，不从中文关键词认证授权，也不承诺任意真实模型都会正确执行剩余步骤；单步移动会增加一次原模型对新帧的判断。

新`combat_continue`调用`ContinueNarrated(c, coalesceIdleTurns: true)`；旧调用默认false。推进原队列时，只有当前NPC的待交付记录全部为`turn`才穿过其`advance`，不单独要求一段空转叙事。回合日志、先攻顺序、状态到期与时钟照常保留。任何实际动作（包括不可见动作）、反应、死亡豁免或真实玩家回合仍沿原边界暂停；不把无动作概括成瞄准/窥视或补造心理活动。GET、重启、原回执重放均不推进。

回归：`MovementNarrationRefreshesOriginalInput`覆盖显式complete=true和普通final、连续三格后本人攻击投掷、单步停止、旧52、重启与重放；`IdleTurnsKeepAuditAndDeathWait`覆盖三敌原日志/时钟、实际攻击暂停及旧行为；`AutomaticDeathSaveContinuesNarratedBattle`覆盖真实Pi/MCP下三敌空转只需3次固定模型调用、下一死亡请求与自然20保留回合。测试不替代在线生成质量或实际时延验收。

## 未说出口的意图与角色知识（契约52）

`HarnessStoryContext.ForVersion(52)`和探索/战斗`HarnessDmChecklist.InstructionsFor(52, combatAgent)`增加同一意图知情边界：输入给DM不是角色发言；未说出口的目的、内心和后续计划不能被NPC/其他角色当作已知。反应只依据实际可感知行为、明确听到的台词、已获知信息或已经成立的特殊获知依据；推断保留归属和不确定性，不借猜测精确复述未知计划。例：只看到玩家转身可以猜测逃跑，不能直接知道其计划“回去搬救兵”；确实说出并被听见后才可据此反应。

同一52增量还将死亡豁免接入自动本人待投掷与倒地回合续接，具体流程唯一见[标准战斗](standard-combat.md#自动死亡豁免与倒地回合推进)。自然Run绑定原intent等待本人投掷；命令叙述完成后使用独立待投掷，两者均不代投。

工具列表/schema与51相同，执行帧仍contract15；0..51的叙事合同/checklist和已冻结Run不变，导入system prompt原文、玩家输入、存档、公开受众规则不改。没有新增说话/保密按钮、审批、语义正则门禁或额外检定。此合同是模型生成要求，不是服务器已能验证任意正文没有读心；在线生成质量须另行实测。

回归：`HarnessDmChecklistTests.RealPiSeparatesUnspokenIntentFromCharacterKnowledge`用真实Pi+固定模型检查未说、明确说话、欺骗意图三种原文均完整传递、合同进入实际模型帧、旧51合同hash、冷读Run字节不变及零骰；`HarnessExecutionProtocolTests.CatalogIsShortAndFrozen`固定旧目录与两种checklist。

## 历史来源、布局诊断与战斗命令续接（契约51）

`toolContractVersion=51`，执行帧仍为contract15。0..50工具/checklist、已冻结模型槽位、原事件与回执保持；新说明不倒灌旧运行，不改数据库schema。

**剧情历史。** `HarnessHistorySources`按操作类型排除建房/导入配置、邀请/加入/撤销、房间设置及角色审核/重提记录；实际`content.activate`到达正文保留。原管理记录未删除，`memory_read`仍可用于授权业务审计。剧情查找优先`ctx_search/ctx_expand`，旧memory工具保留其原用途，不把几套记忆当作重复任务。已结算来源的原`result`片段附精确Check与CombatLog数值，保留来源修订；不附可能含未发现单位的Presentation。公开日志与本人原受众日志分开，另一席位秘密不进入本人的历史。

等待、未答问题和承诺必须注明“当时/截至该段历史”，当前状态读最新快照。`hasDc=false`且没有`difficultyClasses`的骰不因dc=0/success=false而被摘要为失败；多阈值逐项比较。旧摘要若混入已排除管理来源或旧结果修订，不能重新进入新常驻历史：合法剧情退回原文，不改旧摘要。增量摘要排除全部已发布祖先覆盖；外发前再核对覆盖，范围重叠就不发起无效部分替换，不重置已有工作账本。原生未闭合工具链、实际usage、预算及重启回执仍沿契约45。

**有效布局。** `board.state.map.grid`与`board.maps[].grid`使用同一`RuntimeEncounters.TacticalMap`投影，原地图资产元数据不变；方格投影不表示遭遇已经绑定。布局拒绝报告具体格、单位/实例、地形或冲突对象，并附实际mapId/version/hash、图片尺寸、cellPixels/offset/first/size/cellFeet。仍隐匿单位的掩护错误另报每位观察者的位置、实际cover与原要求；半/四分之三掩护格是遮挡格，不可放在单位脚下。失败零写零骰，不自动挪人、重建遭遇或重掷。已有正确选图/玩家位置直接复用，只为真正缺失的布局绑定原encounterId。`hidingReason`是原尝试依据，当前hidden、隐匿是否成功与各席位known/presented分别读取；不能据原理由宣称仍未被发现。

**已提交命令续接。** 正常行动/本人投掷/裁定等原端点在提交后，由`ObserveCombatCommand(campaign,token,requestId,expectedVersion,command)`接续尚未交付的战斗动作和原队列。原natural Run拥有对应intent/roll/ruling等待时仍由它恢复，不另开竞争Run。GET、列表读取和服务启动绝不创建续接或推进游戏。

新关联是可空`CombatAgentInput.Command`/`HarnessRun.CombatCommand`，值为`{requestId,battleId,sequence,rootSequence}`；由原授权回执和`expectedVersion+1`精确事件建立，身份按会话/席位/原请求确定。内部`Source="combat_command"`intent关联原结果的副本（只改副本IntentId以满足步骤归属），不写新的玩家请求事件，也不改原结果/回执。`agent.command`说明这是已提交动作的叙事，候选为空，只允许只读查询、`world_record/narrative_commit`及`combat_continue`。不能选择新玩家动作、代投或代答；`world_record complete=false`拒绝，原队列未完由服务端继续，到玩家/反应/投掷/裁定边界结束。普通自然输入仍可用complete=false完成获准的剩余复合步骤，不自动结束回合。

业务Run/progress不显示这份内部input；历史和战斗回忆不把它索引为新玩家发言。Activity沿原rootSequence追加独立continuation。原请求重放只读取已有续接，不复活完成、中断或unknown运行；既有明确恢复沿保存槽位执行，未知外发不重发。存档拒绝51之前带Command、首输入带Command、错战斗/序号/归属或重复请求关联。失败不撤销已经真实提交的原按钮命令，调度异常留安全日志。

回归入口：`HarnessHistoryTests/HistoryPipelineTests/HistorySummaryTests`（管理过滤、精确展开、祖先链/重启、实际usage与缺usage）、`MapScaleHarnessTests/MapIndependentPerceptionTests`（新旧网格、可定位错误、失败零副作用）、`CombatNarrationHttpTests`（真实Pi自动按钮续接、原等待所有者、普通final故障恢复、原回执与冷历史）。真实模型与原生客户端验收另记任务证据，不以这些隔离测试代替。

## 投掷前明确难度（契约50）

新`check_request`的普通主动能力/技能检定及豁免必须提供DC；缺失返回可修正的`invalid_ruling_check`，零骰、零状态提交。作者DC优先；未预写时由AI在投前给DC 5..30及私有reason。被动数值不涉及玩家投骰，仍可无DC。先攻/伤害等本身没有DC的骰种不伪造阈值。

隐匿对抗仍禁止模型自造DC；服务器按本人尚未发现、实际隐匿成功的目标取去重排序阈值，在SceneCheckSpecification中冻结`difficultyClasses`，待投掷preview和最终DiceCheck使用同一数组。显示如`DC 16 / 20`，没有目标姓名、位置或阈值与单位的对应关系。若所有隐匿均失败/已知，则走原零骰观察登记发现，仍等实际私人叙事交付；不能用空阈值拒绝并漏掉发现。旧0..49工具/检查单及已存检定不升级、不补DC或重掷。

本地启动准备通过`IHarnessRuntime.Prepare`启动可复用Node/Pi worker并加载工具目录、缓存当前探索/战斗检查单；不创建Run/战斗，不调用供应商或预先冻结场景。失败安全日志说明，下一次执行仍走原本地启动恢复。真实交接继续读最新工作区/权限/状态。首条战斗输入的持久`CombatFirstInput`投影为`HarnessRunView.firstCombatInput`，业务session.actionText及主持progress.input为空以免重复原话；原Run.input、actionId和历史审计保持，后续同文字新请求仍显示。

回归：`NarrativeCheckTests`、`MapIndependentPerceptionTests`、`HarnessPiTests`、`CombatAgentSessionTests`、Unity `ContextualRollTests/StoryChatTests`及工作台`dm-workbench.test.js`。真实Pi+固定模型验证本地调用链，不声称实际供应商生成质量。

## 逐单位战斗叙述与私人增量（契约49）

新标准战斗沿原持久 `StandardCombatFlow.Steps` 在下一单位的 `advance` 前暂停。当前单位的移动、攻击和即时后果组成一段；Shield、专注和死亡豁免仍在原本人等待点停止。`NarratedThrough` 是已交付的战斗日志序号，可空且缺省保持旧批量流程；域层不调用模型。先保存当前动作剧情，再推进下一单位，不能先结算整轮后补总述。

战斗执行帧 `agent.narration={pending,canContinue,records}` 只包含本次未交付且当前席位合法可见的日志，`records[].audience` 按首次保存的真实受众标记 public/actor。`combat_continue({})` 只推进原队列至下一行动边界或本人等待；待叙述时禁止继续、提出新动作或以提问结束运行。有实际公共行动时 `world_record` 需非空公共正文；全为私有/不可见记录时可以空公共确认，不为填满公共栏泄密。world_record与叙事指针同事务保存，仍有队列则沿原模型循环继续，不增加玩家“下一敌人”按钮。

普通模型 final 走原 `narrative_commit`，其回执可带 `continueCombat:true`。协调器保存原回执后给同一Run追加内部续接turn，不把它当成玩家新发言；重启重放已完成的model/tool/final槽位不重复外发、掷骰或写文。最后行动和终局叙述全部保存后才归还探索。已接受战斗的角色死亡时，只允许该战斗主持处理待叙事/原队列；耗尽后拒绝死者新输入和模型续接，unknown仍不可重发。

每段在原intent下追加独立事件，Activity保持sequence与continuationOf，玩家原话只出现一次，冷分页/详情不覆盖前段。Unity按同版本Activity就绪后播放该段机械变化，再显示该段剧情；工作台同样先读到相应剧情才展示该版战况。初次重连读取当前状态，不回放整场历史；GET失败只重读，不重发行动。

探索行动同样按段投影（2026-11-22）：一条行动里先 `world_record` 叙述、再请求检定或再次叙述时，Activity 拆成多段，每次已接受的叙述结束一段，后段带 `continuationOf`。原因是 `PendingIntent.Narrative` 只保留最新一次叙述（`check_request` 还会把它清空），单条投影会让检定前的回答在玩家剧情里消失。只有一段的行动仍按原单条投影。分段与战斗共用 `GameService.BeatSegments`；回归 `NarrativeCheckTests.NarrationBeforeCheckStaysAsItsOwnBeat`。

所有v49新叙述和开场都要求私人消息只交付实际收件人独有的新增信息。公开行动、对白、受伤、倒地与结果不换第二人称再讲一次；无新增时 `privateMessages=[]`，不编秘密、感受或职业发现。写入拒绝与本次公共正文完全同文的私人消息，开场还比较已保存公共开场；不使用相似度删除合法私文，也不改旧历史。改写复述的语义由生成合同约束，精确同文校验不能宣称能识别所有同义复述。

0..48工具与checklist黄金冻结；旧Run/已冻结model槽位不升级。活动v48会话只有全部旧输入已非running/waiting且原Run存在，下一次新输入才采用49；旧等待跨席位续接继续48。更早会话保持原协议。`CombatNarrationTests/CombatNarrationHttpTests`覆盖逐敌、本人等待、真实Pi普通final、原回执崩溃窗口/重启、终局、跨席位旧等待和冷历史；客户端回归为`CombatPlaybackTests`、`StoryChatTests`及`combat-narration-feed.test.js`。这些使用隔离fake供应商，不能替代真实模型文风/语义验收。

## 主动提问与战斗叙述（历史契约48）

`ask_player(question)`允许DM主动询问计划、选择、态度、本人信息或承接NPC问话，不再局限于缺少机械参数；不能替玩家回答，也不把普通行动变成例行确认。沿既有 `wait.kind=player` → `needsAnswer` → 主输入回答、同一行动continue；问题本身不掷骰、不扣资源、不跳过回合。玩家的回答随这条行动公开：DM本轮下一次写入时，`HarnessRunService` 把本Run的回答按顺序记入行动的 `clarifications`（问题字段留空），网页剧情在原话下显示“回答主持”；DM的问题仍只在本人的Run里，私密行动的原话不公开时回答也不公开。`DmQuestionTests`以真实Pi/MCP验证提问、重启、主输入回答及原回执。0..47工具与checklist逐字冻结，v47基线来自独立已交付程序集。

战斗代理在原模型循环内润色已结算的连续结果，保留命中/落空、实数伤害、倒地和等待；若先攻靠后或倒地导致原攻击未执行，要如实说明。不得先攻前补免费攻击、改写机械事实或逐条战报另发模型请求。双端同一Activity已有非空harness叙事时，主正文优先叙事，精确关联的机械条目收进“查看战斗记录”；无叙事仍显示短报。Unity仍按原顺序播放HP/位置，播放完成才折叠，快照中新条目不会被旧叙事吞掉。折叠只是呈现，不宣称模型已覆盖每条事实，原记录始终可查。

## 单次检定与侦察后开战（契约47）

同一角色对同一未变任务承接已保存结果，不能换输入、DC、模式或地图刷骰。隐藏搜寻按稳定`EncounterId`去重，准备图切换及布局绑定不重置；普通任务按场景、来源、原文、能力和技能匹配。新规格保存`SingleAttempt`，普通任务另冻结真实角色与来源情境的`CircumstancesHash`：实际状态变更且DM在`reason`说明与该任务的相关性后，可进行新尝试。哈希变化本身不证明相关性；任意语义改写、不同引用是否仍属同一任务仍由DM依据历史判断，不宣称通用物体语义识别。旧普通记录无情境快照时不能证明发生变化，保守承接原结果，不允许仅补reason解锁；真实新情况需要明确更新的来源/任务依据。旧Run及其既有投掷规则不升级。

`checks_result(scope=current|scene,offset=0,limit=8)`缺省保留当前输入输出；scene分页只读本人当前场景的持久规格与结果，不公开另一席位的检定。请求与确认均在掷骰前复核。先被动后首次主动允许；已结算主动不能再用主动/被动覆盖；取消零骰可在新输入重提。独立豁免和战斗Search不受战外单次限制。

战术`map_request`在Run工具回调内、战役锁外等待原地图任务真实ready/failed/withheld，不消耗模型轮询、不重排图片。原地图排队回执保持原pending内容；最终输出仅保存到原Run步骤。每次进度读重新核授权、场景、版本与原actor/command/fingerprint，ready要求实际发布、有效成品和合格战术尺度。失败/撤下/不可用返回工具错误；取消、版本变化和未知外发沿原运行恢复边界，不重开已取消输入。MCP地图调用等待覆盖父端既有最长1800秒执行期限，避免SDK默认60秒提前制造错误；父端仍拥有取消和默认750秒总执行期限，没有新增调用额度或等待确认。

当前图已有原遭遇时，以其布局图/观察图作为无显式选择的稳定默认。其他场景补图前，由DM调用原`map_select`固定当前图；未固定则`map_selection_required`给当前id/version且零排图，不把选图写入与图片队列混成跨库事务。首张真正局部站位图直接声明tactical及DM范围；城镇/区域/未知比例图不假校准。新图ready后显式选图、给原玩家实例新落点、绑定原遭遇，最后委派战斗；不能把pending或一张旧图的ready当作新图完成。

没有可委派遭遇时不提供`combat_delegate`；模型越界调用产生的`encounter_setup_unavailable`在原事务回滚后返回可修正工具错误，不再直接丢掉整次攻击输入。真实开战仍由战斗子会话进入本人先攻确认，不补射箭、不代投骰。0..46工具目录/checklist保持冻结。回归见`EncounterContinuationTests`及独立v46 golden，真实Pi测试包含超过60秒的图片等待、原实例/HP/发现保持和实际先攻。

## 侦察独立于地图校准（契约46）

有真实场景依据的必要侦察不再先要求战术地图。`encounter_prepare(mapId,sourceId,quote,layoutReason,enemies,terrain,encounterId?)`复用已有工具；首次省略`encounterId`，`terrain=[]`。在当前已发布玩家图上保存实际归一位置、规则来源和个体姓名，按明确场景掩护及脱离视线的依据保存一次NPC Stealth；不要求地图用途/尺度或全队棋子，不改变图片/校准，也不进入先攻。当前仍要求一张已提供的公开底图，不声称已支持完全无地图的遭遇准备。

随后`check_request`沿原`encounterId + sourceId + quote`进行Wisdom/Perception真实对抗，不提交模型DC；主动检定仍等本人投掷。个人发现与待叙事交付沿原`KnownActors / UnpresentedIds / privateMessages.discoveryIds`处理。明显信息不强掷；地图未校准不能成为跳过必要检定或只写环境描写的理由。

新准备保存`RuntimeEncounter.Layout=null`及`ObservationMapId`；定义中`X/Y=-1`表示没有战术格位，`Cells=[]`。这些字段只在明确的新式未绑定状态合法；旧缺失布局仍作为损坏拒绝。无布局不执行几何视线、不委派/开始战斗；读取和重启不补骰。原0..45目录、运行、已绑定布局与回执冻结，正式旧Run不会补掷或自动重新执行。

实际交锋前，再用同一`encounter_prepare`传原`encounterId`和精确原始来源，为同图重新校准后的版本或另一张局部`tactical`图绑定一次布局。使用原名单顺序及不变的姓名/来源/策略，明确新图归一位置和真实战术`terrain`，省略`hidingCover/hidingReason`；玩家先沿原实例完成新图位置。服务端校验真实比例、格位、当前仍隐匿单位的掩护后，仅更新原实例位置和布局；跨图保留旧位置，已离图或受限制单位不能借此重新入场/移动。HP、条件、实体身份、隐匿骰和个人发现不重置。按新几何更新实际观察者视线，不能把A的发现直接广播全队。绑定后才`combat_delegate`并沿本人先攻确认。

首次传战术地形、重复建立/绑定或名单变化返回`encounter_setup_unavailable`；不可靠战术尺度仍返回原`board_combat_*`错误，旧无布局开战明确`board_combat_layout_required`。失败整笔零写、零骰；原请求重放返回已存输出。`MapIndependentPerceptionTests`覆盖两类地图、无玩家棋子、真实Pi/MCP本人等待、两次重启/回执、跨席位私密、同图/跨图绑定及视线、当前伤势和旧v45拒绝；v45目录/checklist黄金来自独立已交付包。

## 原生链保护与历史规划（契约45）

新运行使用`parent-history-v2`：当前未完成行动的原始工具正文、call/result关联和原生Part完整保留到最终供应商请求，不再套用96KiB裁剪或旧128KiB模型正文限制。仅已闭合历史使用按受众隔离的已发布摘要；新槽位读最新状态，同槽位冻结实际输入，原回执不重执行。完整来源、分层选择、预算失败表与战斗交接见[历史上下文](harness-long-memory.md#契约45只整理已经结束的历史)。

新45只使用正常生成响应的实际input usage指导后续历史整理，不额外请求元数据/countTokens，也不做本地估算；首次或缺usage不阻止生成。辅助摘要沿用已有辅助模型配置，不新增UI开关；关闭、失败或未完成时，在技术传输边界内使用原文/旧组合，超界则整理或明确失败。主模型与摘要生成均逐次授权；历史资料不取得执行权。工程验收以Gemini为准，Step通过既有OpenAI Chat的分项实测见Step检查。

0..44工具、已开始Run和战斗Session不升级，旧96/128KiB行为仍只用于其原回放。最新候选不会自动修复或重发正式旧Run。

## AI DM 自主剧情检定（契约44）

新行动由AI DM结合玩家尝试、环境与NPC事件主动判断能力/技能检定或豁免，不等玩家请求骰子，不交人工主持发起。明显可见或已确定的信息直接叙述；无check的局部作者动作不代表全部情境触发已处理。完整匹配的作者动作与适用规则优先。

`check_request`沿用原参数，增加可选`checkType: ability|save`（默认ability）和私有`reason`（默认空，最多500字符）。save要求skill为空，复用真实豁免熟练、状态与规则修正。只作用于当前角色、战斗外，保留席位、死亡/终局、版本与待处理限制；不因为昏迷或倒地一律拒绝豁免。

当前提供的非模型场景`sourceId + 连续原文quote`仍必需。引用有明确DC时须匹配；普通剧情没有预写DC时，AI在投掷前给出DC 5..30和非空reason，说明触发、条件及难度依据，无需ruling_request。reason不作为新事实来源，quote/reason不进入玩家投影。历史v34..49允许有意义的原始数值省略DC，此时hasDc=false，不能据此宣称成功或失败；v50普通主动检定不再允许此分支。真实隐匿对抗继续用原encounterId/sourceId/quote、Wisdom/Perception且无模型DC；普通剧情检定不释放隐藏单位。

类型和依据随原`SceneCheckSpecification`持久化。主动检定沿原PendingRoll本人确认→服务端一次投掷→保存结果→叙事续接；规则自动失败则直接保存resolved结果，无等待、零骰。去重包含检定类型，改变reason/DC/模式/主动被动不允许同项重掷。此入口不自动修改生命、资源、库存或剧情fact。旧0..43目录、帧和DTO保持原合同；缺新字段的旧规格仍按ability，不升级旧行动或重新计算结果。

新v44的encounter_source_unavailable反馈明确要求原来源ID和一段连续原文，不再只建议校准地图。未知运行异常增加安全日志RunId/ErrorType/StepId/ToolName，不记录正文、异常message或stack，不改变未知调用恢复语义。

用法见[AI DM检定](ai-dm-checks.md)。验证入口为`NarrativeCheckTests`、原`HarnessFlowRepairTests`、`RuntimeEncounterHttpTests`及`HarnessExecutionProtocolTests`的v43目录/checklist黄金基线；固定模型验证执行链，真实模型判断质量需实际游玩观察。

## 契约43：按实际知情范围交付

`world_record` 接受 `{narrative,memory,privateMessages?}`，`opening_commit` 接受 `{public,privateMessages?}`。公共正文可为空；每次最多12条个人消息，每条为 `{recipientIds,text,discoveryIds?}`，收件人1..4个实际有效且不重复的角色，正文1..1024字符。新消息不回填旧 `private`，非空新旧私文不能混用；旧空private可与新数组并存。无补充省略消息，无新公共变化不造摘要或“某人获得秘密”提醒。开场空公共提交仍记录共同阶段已完成，后入场不重写；给其他角色的补充不替其完成本人入场。

个人信息按已成立的口信、身份、关系、实际感知、私下交流或共同经历交付，不与行动发起者绑定，不由职业推断免费线索。共同现象公开、个人理解私发；不得替玩家决定恐惧、信任或行动。主持未揭露材料、未发现目标及未来情节不因“不能公开”而随意私发，失败也不能确认隐藏目标身份。消息在工具提交事务中即可被相应席位读取。

v43以空公共消息建立的行动根保存 `PendingIntent.PrivateRoot=true`。同一Run后来公开叙事或执行公开机械步骤，只发布该事件自己的正文、结果与变化，不借 `Published` 重开原私有根。非行动者的公共续接 `Origin.Input/Label/Clarifications` 清空，活动带 `continuationOf` 原根序号，双端不重复或虚构玩家发言；原根未载入、事件转冷或重启后仍保持此边界。指定私文接收者只获得消息片段，不获得整个行动审计。旧合同缺标记继续使用原规则。

`PrivateStories.Plan` 校验收件人与精确发现：`discoveryIds` 每个目标必须已为**每一位**收件人实际发现且属于当前场景。提交只清指定目标的待呈现状态，普通私聊不释放其余发现，转述不授地图精确位置。未知收件人、重复收件人、空白消息、无依据发现及混用非空新旧字段拒绝 `harness_invalid_payload`，事务不提交半份正文或权限。开场不能用discoveryIds交付新发现。旧40..42仍使用其原单人发现交付合同，不改已有待检定或Run。

新model slot的 `knownInformation` 为 `{actorId,entries,omitted,notice}`；entry带 `source,text,atVersion,actorId,audience`，公开转述另带 `actorName,sharedSequence`。从原开场、事件、裁定与公开转述中取当前角色实际已知的正文，无主持旁路，不带私人行动输入或机械步骤。近期6条与输入相关6条去重，最多12条、provider JSON UTF-8不超过32KiB；选中正文完整保留，不截断否定或引文，omitted说明其他已知正文的省略数量。冷事件沿既有SQLite读取，不新建私人流水。每个槽位只捕获一次，原请求重放使用冻结帧。

空公共完成使用明确的已提交状态，真实Pi、业务会话及进度不能把它误判为失败或补造公共结果。0..42工具目录、已开始运行、旧冻结帧及旧分享回执保持原合同。HTTP投影与双端转述见[业务冒险](adventure-sessions.md#私人剧情按实际知情者交付与主动转述)，回归见 `KnowledgeVisibilityTests` 与v42工具golden。

## 契约42：逐图尺度与局部战术地图

每张地图保存独立用途、比例数值与依据。新 `map_request(kind,purpose,tacticalScale?)` 按场景和用途复用；城镇图ready不阻止补局部图。`map_select(mapId,mapVersion)` 选择当前场景公开图，模型帧的 `board.maps` 提供候选，`board.state.map` 与冻结图片始终对应真实当前选择。`encounter_prepare` 不再接受独立网格，服务端按已保存的局部物理尺度派生五尺逻辑格；原图比例和各图落点保留，不复制角色状态。旧0..41工具目录、帧和已开始运行保持原合同。字段、拒绝及回归见[逐图尺度](maps.md#逐图尺度与局部战术图工具契约42)。

## 契约41：敌人和NPC个体命名

新创建的敌人/NPC按实际设定取持久个体名字，遭遇、地图、战斗和叙事复用同一名称；作者专名保留，明确通用标签由服务端提供原创后备，不消耗战斗骰或增加模型调用。v41只补充`encounter_prepare`、`token_spawn`、`token_update`、`world_record`说明，schema不变，0..40工具目录及已开始的Run/战斗会话仍冻结。延迟确认保存命名策略，缺字段保持旧语义；已有编号实体不在读取或开战时自动迁移。接口、世界记忆错误及回归见[命名协议](npc-naming.md)。

## 契约40：发现随叙事交付

`check_request` 产生的新个人侦察发现先保存机械结果，再等待故事交付。持久的 `SceneCheckSpecification.WaitForNarrative` 只由新v40请求设置；`EncounterObservation.UnpresentedIds` 记录首次发现但尚未交付的实例。DM通过 `encounter_read` 读取已保存结果，不重掷；v40的 `world_record` 提交非空私人正文时，在同一事务发布本人当前场景待交付发现，其他席位仍看不到；仅公共正文和普通模型结尾不会发布。叙事失败或服务重启不会提前公开，玩家可用显式新输入接续原结果。实际攻击的公开揭示仍走原规则。

旧0..39工具目录、已有Run与待检定规格保持原合同；字段缺失不把过去已发现单位重新隐藏。工具参数不变，v40描述明确个人发现只交付本人。细节与回归见[发现与地图同步](shared-board.md#发现与地图同步契约40)。

## 契约39增量

旧0..38工具目录和已保存帧不升级。新 `NarrativeContract` 按版本冻结：公共故事第三人称、私人故事第二人称，NPC对白和有归属的引用保留自然人称；个人正文只写可感知的故事，不夹骰点、修正、DC、成功/失败标签或工具回执。机械结果仍保存在独立检定/日志投影。该合同约束新的模型生成，不正则改写已存历史，也不将fake脚本视为真实模型文风验收。

AI位置无需第二次同意，玩家无初始摆位入口；自动开场可先执行受限本人首放，再提交开场。详见[共享棋盘](shared-board.md#初始位置与ai控制契约39)。

契约39–53的探索帧以 `agent.combatPromptReady` 检查是否已采用独立战斗system源，缺失时不提供 `combat_delegate`。契约54起，新行动可直接使用服务端嵌入的 `content/prompts/dm-combat.md`；自定义战斗正文优先，默认稿不写回战役预设、不拼接探索system，也不触发战斗或模型调用。新战斗委派时冻结实际正文、版本和哈希；在途战斗、旧Run、已保存骰点与遭遇均保持原状。旧 `combat_prompt_required` 失败不自动重发，从当前局面发起新行动即可使用默认稿。工作台可查看和修改默认稿，清空并保存自定义稿后恢复默认。

并发改善的是不同战役间的等待，不并行同一行动的依赖工具，不改变模型、thinking或外发次数。`HarnessParallelTests` 用真实Pi四路供应商门闩验证并行、隔离与取消；`CombatAgentRedelegationTests` 覆盖两次交接/重启/一次归还。长上下文压缩中的重复历史提示缩短，原消息、来源哈希、用户回答、当前帧和原生续接仍保留；上下文上限未扩大。

## 2. 安装、配置与验证

在项目根：

```bash
npm --prefix agent-host ci --ignore-scripts
npm --prefix agent-host run build
npm --prefix agent-host run typecheck
npm --prefix agent-host test
# 真实 .NET → Node → Pi → MCP，使用本地 fake 模型，不调用供应商
# 使用独立构建输出，不覆盖正在运行的服务端文件
dotnet run --project tests/DiceRealm.Tests -c Release --artifacts-path artifacts/harness-build -- --filter "harness"
```

不要把 `NODE_TLS_REJECT_UNAUTHORIZED=0` 传给安装或运行器。已有不安全环境时应仅对该命令显式设置为 `1`，不要修改全局配置以绕过 TLS。

服务配置（默认没有启用，也没有默认模型）：

| 键 / 对应环境变量 | 意义 |
|---|---|
| `Harness:Enabled` / `Harness__Enabled` | 默认 `false`；显式开启新入口 |
| `Harness:AgentHostPath` / `Harness__AgentHostPath` | **绝对路径**，指向构建后的 `agent-host/dist/main.js` |
| `Harness:NodeExecutable` | 默认 `node`；可指定受信 Node 可执行文件 |
| `HarnessAi:BaseUrl` | 含 API 版本的前缀，如 `https://供应商/v1beta` 或 `/v1`；HTTPS 或 loopback HTTP，无 userinfo/query/fragment |
| `HarnessAi:Endpoint` | 显式协议类型 `gemini`（原生 generateContent）或 `openai-chat`；不根据模型名推断，不跟随重定向 |
| `HarnessAi:Model`、`HarnessAi:ApiKey` | 均须显式配置，不复用/回退到 `TextAi`；key只在服务端 header，禁止空白/非 ASCII/超长值 |
| `HarnessAi:ThinkingLevel` | 默认 `high`；`off/minimal/low/medium/high`，协议映射与模型兼容见下文 |
| `HarnessAi:IncludeThoughts` | 默认 `true`；Gemini请求返回thought分段，仅留私有续接，不作为玩家叙事 |
| `HarnessAi:RetryCount` | 默认3次额外重试，即最多4次HTTP尝试；0关闭，范围0..10 |
| `HarnessAi:RetryInitialDelayMilliseconds` | 默认1000，范围1..60000；指数递增并封顶60秒，默认1/2/4秒 |
| `HarnessAi:AttemptTimeoutSeconds` | 单次 HTTP 尝试时限，默认180，范围1..600；上游无响应到时即按超时重试 |
| `Harness:MaxModelCalls` | 每 Run 模型尝试上限，包含额外重试，1..16，默认16 |
| `Harness:MaxToolCalls` | 每 Run 工具回调上限，1..32，默认32 |
| `Harness:TimeoutSeconds` | 累计运行时限，1..1800秒，默认750（容纳单次180秒×4次尝试及重试间隔）；等待玩家不计入已结束的执行段 |
| `LocalRules:Directory` / `LocalRules__Directory` | 显式本地中文包目录；未配置不联网回退，完整维护说明见[规则库](local-chinese-rules.md) |
| 原有 `ProviderLimits:Text*` | 每次真实模型外发前持久预留，失败仍计数；默认 −1（不限，仍记录用量），0 关闭调用，正数为显式限额 |

另有固定边界：最多12个输入段、16份续接回执、模型文字累计8192字符、单次最终叙事4096字符、JSONL单行2MiB。新45按正常响应实际usage的增长及自然边界准备历史摘要，保留父端4MiB准备正文及桥接/HTTP技术传输边界；旧0..44保留原128KiB模型正文限制。没有累计Token续发阈值（原100000已取消），新运行`maxTokens:0`不写`max_tokens`/`maxOutputTokens`，保留供应商默认；旧运行仍用已冻结值。失控循环继续由模型/工具次数与超时约束。新45缺usage时保持未知，不用字节估算；旧0..44保留原记账兼容，不能用其估计作为容量。模型已可能外发时，超时/取消不能证明没有计费。

真正使用供应商前自行配置秘密存储并明确授权外发；本文的验证命令不会做真实外发。不要将现有 `OfflineTrial` 转为在线运行，它始终拒绝 Harness 模型调用。

四项必需配置和上述可选项可由本机服务管理员通过 .NET 配置文件/环境变量或独立包启动脚本提供（重启生效），也可在工作台「系统设置与 AI」页配置主/辅助模型，对应本机操作员 API `/api/v1/operator/ai-settings`（仅本机、同源，密钥不回显，不使用战役 token；规则见 [AI 设置规范](../.trellis/spec/backend/ai-settings.md)）。原来的 `HarnessAi:Endpoint` 完整 OpenAI URL 在**不提供 BaseUrl**时继续兼容；新版配置和旧 URL 混用会拒绝，不默默选择协议。原生 Gemini 追加 `/models/{model}:generateContent`，用 `x-goog-api-key`；OpenAI 追加 `/chat/completions`，用 Bearer。版本路径由使用者明确提供，程序不猜 `/v1` 或 `/v1beta`。

## 3. 新战役与输入 API

### 新战役

`POST /api/v1/harness/campaigns`，201：

```text
{
  name, characterName,
  adventure: 用户明确导入的 AdventureDocument,
  preset: { id, version: 正整数, systemPrompt: 用户原文 },
  skills?: [{ id, description, content }],
  templateId?, creation?, build?
}
```

冒险必须合法并立即启用；不要求伪造旧 Intent/Narration `PromptBundle`。preset/skills 成为初始绑定；后续P2可通过 [工作区](harness-workspace.md) 保存/发布并明确激活新版本，已接受Run保持冻结。preset最多32768字符；最多16个 Skill，单项正文16384字符、合计65536字符。Skill 只有显式导入的文本，没有文件路径或可执行命令。

返回仍是 `{accessToken, snapshot}`，`snapshot.content.status=active`，旧 `content.prompts` 可以为 null。原 `/campaigns` 行为不变，旧战役不会自动得到 Harness profile。

### 提交、查询、续接、取消

以下接口均使用原战役 `Authorization: Bearer ...`，请求不能自称 actor：

| 方法/路径（以 `/api/v1/campaigns/{id}` 为前缀） | 请求 |
|---|---|
| `POST /harness/runs` | `{requestId, expectedVersion, text}`；202 接受运行 |
| `GET /harness/runs/active` | `{runs:[HarnessRunView]}`；当前授权席位未结束运行，只读发现 |
| `GET /harness/runs/{runId}` | 只读；不启动或恢复模型，包含已冷存的终态 |
| `POST /harness/runs/{runId}/resume` | `{requestId, expectedVersion, text?}`；202 |
| `POST /harness/runs/{runId}/cancel` | 无正文 |

`runId` 为首次请求的 UUID，但内部活动 intentId 由服务器另行生成；不同席位可安全复用相同 requestId。活动记录仍只有一个原输入根，后续规则步骤关联同一根。

返回 `HarnessRunView`：`id,status,version,wait,text,error,modelAttempts,toolSteps,replayed,notice`。`wait` 为 `{kind,id,question}`，kind为 `player|intent|roll|ruling`。新增兼容的本人操作投影：

- `input`：该席位的原输入；`intentId`：服务端生成的原活动关联 ID，不能当 `runId` 使用。
- `binding`：`{presetId,presetVersion,profileHash,skillIds}`，指本次接受时的冻结绑定，不是当前工作区 active。
- `progress`：最多64项 `{number,kind,status,tool,version,waitKind}`。number从1开始；kind为 `model|tool|final`；status为 `started|done`；tool只含白名单工具名，旧步骤没有名称时为空；version是领域步骤回执版本或null；waitKind为空或合法等待类型。它只表示已登记/已完成的步骤，不是模型内部推理，也不替代权威检定和资源记录。

不返回完整预设、Skill正文、模型上下文、原始工具参数/结果或内部推理。`active` 只查可信 actor 的有界热记录（最多64），过滤终态，不扫描别的席位或全量冷存，不在GET迁移文件；停用执行后仍可查询。旧战役409 `harness_campaign_required`，坏记录409 `harness_corrupt_run`，撤权401；主持无权指定其他actor。页面丢失本地runId时可用此接口找回未结束运行，已知终态继续按ID查询。

重启后 `interrupted` 若含 `kind=model,status=started` 的槽位，表示该调用结果不确定，不可安全补发；不能仅看到 interrupted 就提供无条件恢复。

- `running`：已接受；HTTP 断开不撤销任务。
- `waiting`：等待明确回答/本人选择/本人投掷/主持裁定。
- `delegated`：探索父 Run 已把推进权交给持久战斗子会话，非终态；父模型不与子代理并行推进。
- `completed`：最终非机械叙事已提交；数值事实以 Domain 结果为准。
- `interrupted`：没有活跃执行器，已保存回执可以明确恢复；GET 不自动外发。
- `failed`：已知错误/冲突/上限；已提交效果保留，不自动重试。
- `unknown`：有模型步骤可能外发但没有可靠回执；禁止按原运行补发该模型步骤。
- `cancelling/cancelled`：停止后续生成。**不是游戏回滚，也不是取消所有关联领域请求。**

原 ID/正文提交或续接重放，只返回已登记运行，不启动第二次执行；同 ID 改正文返回409。凭证、席位和形状校验不能被重放绕过。服务端重启不自动恢复运行。

### 投掷与候选确认

1. v15起由父端在每次模型调用前自动提供当前 `execution_state` 及候选 enum，模型可直接 `actions_propose` 选择已提供 ID；旧0..14仍先 `context_read/actions_list`。
2. 服务端判定是否可安全直达；需来源/成本确认时保存 PendingIntent；需骰点时只保存 PendingRoll，**确认前零骰、零相关消耗**。
3. 玩家在原专用端点 `/intents/respond`（choose/cancel）或 `/rolls/respond`（roll/cancel）提交本人明确同意。模型没有这些确认工具。团队先攻仍需逐席位同意。
4. 客户端使用新 UUID 和当前快照版本调用 `resume`。服务端只接受该 Run 对应的真实结果；意图选择转为待投掷时仍继续等待，不抢跑模型。
5. 完成/取消结果与 Run 不匹配，或其后已有无关版本写入，则拒绝；不能通过填新版本默默重新执行旧行动。

`wait.kind=player` 的 resume 必须有新 `text`；领域结果续接和纯中断恢复必须为空，服务端自行构造确认结果。取消投掷/候选后续接会结束 Run，不让模型再次自动提议同一次动作。

旧0..14会在**等待态续接**时清空已提供候选，即使玩家答复没有改变游戏版本；此后再执行行动须重新调用 `context_read` 或 `actions_list`，沿用历史候选会得到 `intent_option_unavailable`。`context_read` 本身已含当前候选，无状态/等待变化时不需要再读一份相同列表。模型可直接使用服务端续接所附的真实 `confirmedResult`，不强制额外调用 `checks_result` 才算正确。

取消 Run 会在 `notice` 保留精确恢复提示：如果关联 roll/intent 仍待处理，先 GET 当前快照，再在对应原端点以新 requestId、当前 expectedVersion、原 wait.id 和 `decision=cancel` 明确放弃。**只取消生成后，原本人确认仍有效**；因此新输入仍可能被 `roll_pending/intent_pending` 阻止。已提交的主持裁定也保留在原裁定入口。

Harness 战役拒绝旧 `/actions` natural、`/actions/input`、`/actions/interpret` 和旧意图 clarify，避免双模型执行。结构化行动和专用确认端点继续使用原规则，不额外调用旧 narrator；普通旧战役不受影响。

## 4. 工具与规则范围

| 工具 | 能力/限制 |
|---|---|
| `context_read` | 默认有界公开玩家情境；v23另可按scope读取完整本人角色或受支持获物目录。不返回DM-only、未到达知识、SourceText或内部facts |
| `actions_list` | 当前合法候选及目标/来源/成本 |
| `actions_propose` | 仅提供过且仍合法的 candidateId；版本写入或等待态续接后旧候选失效 |
| `checks_result` | 本运行关联的权威检定结果，只读 |
| `memory_search/memory_read` | 契约2：检索超出近期12条的本人公开已结算行动，并读取原输入/当前更正叙事/原检定；非语义检索，不授予行动权限，详见[历史召回](harness-workspace.md#按需历史召回工具契约2) |
| `world_search` | 契约3：查找当前32条上下文之外的公共世界记忆；返回完整有界对象，并提供本次运行的更新引用，不授予行动或新场景权限 |
| `world_record` | 叙事 + 最多6个 npc/quest/place/clue；已有对象需合法公开引用；v18可显式记录实际获得的物品（见下节），不从叙事推导坐标/路线/规则效果 |
| `ask_player` | 提问并暂停；不是替玩家同意 |
| `ruling_request` | 未支持规则交主持；不执行规则 |
| `skills_list/skills_read` | 仅导入的只读文本，不扫描本机目录 |
| `rules_scope` | 已实现执行边界；契约4另报告本运行绑定的本地中文资料可用性/覆盖，不等于已取得能力或全规则执行 |
| `rules_search/rules_read` | 契约4：按需搜索并完整分页读取本地中文规则；固定包版本、零领域写入，不授行动或世界对象引用 |

当前新运行使用工具契约43（最新增量见上文；完整主持检查及独立战斗子会话见下节），其基础由契约4构成：契约1的省略语义、契约2的历史召回、契约3的世界检索/引用和本地中文规则查读。同版本已有完整情境/候选时重复读取返回明确的 `contextUnchanged` / `candidatesUnchanged`，指向**本次运行同版本的既有内容**，不表示空列表。先读actions_list再读context_read仍会补齐公开情境，只省去已有候选。任何写入版本变化或等待后续接同时清除候选与完整情境标记；每次读取仍授权，不做跨运行缓存。

自动世界记忆提议先完整校验；规范化名称、摘要、状态和关联场景均相同的更新不再增加修订或改变来源/排序。新叙事和命令回执仍保存，明确DM纠错保持原审计。重复ID和非法/未公开引用即使内容看似相同仍拒绝。

同一模型回复里有多个工具时顺序执行；一旦有工具要求等待，或v23 world_record最终提交成功，剩余同批工具不进入 MCP/父回调，不产生效果。普通模型文字只作非机械叙事提交，不从文字提取 HP 或资源变化。

MCP 是游戏工具的进程内标准桥，不是远程 D&D 资料依赖。规则全文读取来自显式本地中文包，不做即时下载/翻译；Domain 继续负责实际资格、资源与结算。不悄悄用2014规则补2024缺口，也不把完整资料阅读当作全规则执行。

### 共享棋盘与真实视觉帧（契约27）

v27 新增 `map_state_read`、`token_read`、`token_spawn`、`token_move`、`token_update`、`token_remove`。父端在每个新模型槽位冻结同版公开底图、可见实例、操作摘要及真实 JPEG；工具写入后下一槽位重新捕获，重试沿用已冻结字节。OpenAI/Gemini 接收真实多模态内容，不以图片路径代替。模型不得通过工具改 HP 或代替玩家同意；AI 操作玩家棋子沿既有本人意图确认，玩家普通直接拖动无需 AI。旧0..26目录及回放冻结，wire1/schema1不变。完整版本、权限、图像和同图战斗边界见[共享棋盘](shared-board.md)。

### 公开世界检索与更新引用（契约3）

`world_search({query,kind?:"",offset?:0,limit?:6})`检索`WorldMemories.Public`非机械记忆层，不读取全部剧本、内部Facts或任意库存。与仅本人行动的`memory_search`不同，**公开世界对象可由不同席位共同查阅和维护**，包括队友创建的NPC/委托。主持游玩也不得取得Hidden、host或尚未到达的arrival记录。

query必填，0..120字符，无控制字符，最多8个空白分词；所有词分别在完整Name/Summary中OrdinalIgnoreCase匹配，支持中文原文子串。空query浏览；kind为空或`npc|quest|place|clue`；offset为0..256，limit为1..6，拒绝额外字段。先过滤公共匹配，再按当前场景优先、UpdatedSequence降序、区分大小写的Id升序排序，避免同次批量写入共享序号时漏项。

```text
{ version, scope:"shared_public_world",
  entries:[WorldMemoryEntry], nextOffset:int|null }
```

entries是完整已保存公共对象（id/kind/name/summary/status/sceneId/revision/originSequence/updatedSequence/actorId/source及既有可见性字段），不发送私有命中数、更正理由或模型原文。最多24KiB，字节缩页后nextOffset仍按**实际返回数量**推进；空匹配/越过匹配尾部时空列表且nextOffset=null。用同query/kind、同version继续分页；改条件或版本后应从offset0重查，不承诺跨版本分页快照。对象ID区分大小写，兼容内容ID与UUID，不做GUID规范化。当前总容量仍为256，不因此扩大存储/模型预算。

**更新引用：**契约3..14只有实际`context_read`提供的KnownMemory和`world_search`返回页内的ID才能用于world_record已有对象更新；v15及以后另外接受每次新模型槽位自动提供的执行帧KnownMemory，见下节执行协议。其余边界相同：不是全部搜索匹配项，也不能靠猜中当前top32的ID。空ID的新建仍由原Domain校验。同一版本内多次读取合并引用，最多256项。任何游戏版本写入或等待态续接（包括同版本玩家答复）都会清空；重新更新已有对象须再读取。`actions_list`和历史`memory_search/read`不授予世界对象引用；世界检索也不授予行动候选。引用只属当前战役/席位/Run，不能从另一运行、读取快照或历史模型消息取得。

`WorldMemories.Plan`在提交时仍检查公共可见性、同类ID、规范化同类名称唯一、状态、已知场景和整批上限。对象合法修订会推进战役version，因此原Run游标同时约束对象revision；不能只把客户端expectedVersion换新强行提交旧引用。整批任一失败时，叙事、所有对象变更、事件/版本一起不提交。无变化更新保留revision/actor/source/origin与排序，但新叙事和回执照常保存。

sceneId只是原关联数据；检索不提供新的场景权限，更新仍受当前KnownScenes最多64条限制。不自动建立地图节点、坐标、路线、奖励、HP或资源变化；超出已知场景的关联仍须明确拒绝，不能因为看到了一个世界对象就将关联当作可旅行位置。同名新建仍可能被服务端最终拒绝，搜索为空不保证名称可创建。

**持久恢复：**私有Run及工具Outcome新增可空`OfferedMemoryIds`，null省略以保持旧序列化；契约3..14的引用来自context_read/world_search实际结果；v15也可由新模型槽位的执行帧授予。查询不写游戏，但完整回复和本Run引用与步骤一起原子保存。done槽位只回放原Result，不从旧Outcome重新授已失效引用；纯中断恢复没有wait/版本变化时保留此前持久引用。领域更新已提交、Run结果未保存的窗口仍从原commandId取完整回执，恢复cursor时清旧引用，不重复修订/创建。GET/原请求重放不执行查询、调用模型或代确认。

| 条件 | 行为 |
|---|---|
| 查询形状/长度/词数/kind/offset/limit错误，额外actor/机械字段 | `harness_invalid_payload`，零游戏写入 |
| 未实际提供、过期、跨Run或大小写不符的ID；类型/场景/同名/重复项非法 | `invalid_world_memory`，整批拒绝 |
| 外部游戏更新或DM修订/隐藏 | `stale_version`；即使内部持有旧引用也须重新授权/验证公共性 |
| 凭证撤销或席位不符 | `unauthorized` |
| 旧契约调用world_search | 不可用；已发模型的非法输出保持原unknown语义，不伪装未发送 |
| 旧版本带引用、引用重复/非法/超过256、非读取步骤携带引用、未知版本 | `harness_corrupt_run`，保留原文件 |

工具契约0/1/2保持原目录和原world_record当前32条规则，不自动加强/升级旧运行。契约3才要求实际读取。回退旧二进制须使用匹配版本完整数据备份，不能删除新字段伪装旧契约。验证入口`HarnessWorldSearchTests`包含253公共对象分页、共享权限/原子失败、wait/写/跨Run失效、检索保留原合法行动候选但不混入对象ID、真实业务Pi/MCP的44项记录检索与原ID更新、重开、纯中断与提交窗口以及旧v2恢复；全部fake/offline，不代表真实模型能始终正确识别同一人物或安排更新。

### 本地中文规则查读（契约4）

`LocalRulesCatalog` 只读 `LocalRules:Directory` 下的 `active.json` 和 `{version}.json`。新 Run 接受前捕获并验证活动包，私有 `RulesCatalogVersion` 固定其原 bytes SHA256；已接受运行不自动切换新版译文。首次上下文不注入全库，模型按需查读；`rules_scope.localRules` 提供可用性和覆盖说明，不是书籍正文。维护/许可/真实缺项见[本地中文规则库](local-chinese-rules.md)。

- `rules_search({query,category?:"",offset?:0,limit?:6})`：query 必填，0..120字符、无控制字符、最多8个空白词；名字/别名/canonicalName/完整正文做 AND OrdinalIgnoreCase 子串匹配。空query浏览，category为空或13类白名单；offset0..20000，limit1..8。精确名字优先，其余按ID ordinal。返回 `{version,catalogVersion,language,entries:[{id,name,category,preview}],nextOffset}`；preview最多480字符，总24KiB，缩页按实际返回数推进。
- `rules_read({id,offset?:0,limit?:4000})`：id为稳定ASCII规则ID；offset0..262144，limit1..6000。返回 `{version,catalogVersion,language,id,name,category,text,offset,totalCharacters,nextOffset}`，总48KiB。offset与totalCharacters使用UTF16单元，不允许落在低代理字符；limit1遇emoji返回完整2单元，nextOffset持续推进。读取至末尾才结束，不把摘要冒充全文。

查询和正文不输出 source/page/sourceRevision/sourceHash/canonicalName；catalogVersion仅供内部冻结引用，前端不显示hash。类别为spell/class/subclass/feature/species/background/feat/equipment/magic_item/monster/condition/rule/language。名称/别名仍可用于查找，不能从规则ID得到行动候选或世界记忆更新权限；原 `OfferedIds/OfferedMemoryIds` 不变。

每次查询仍重新授权战役/席位并检查游戏version，无actor、URL或路径参数。新读固定原包，每次校验bytes hash及严格schema。done工具步骤原样回放Result，不重新打开资料；未保存结果的纯读恢复只能读原绑定包，缺失时不能换active新包。旧0/1/2/3工具目录/描述/指纹逐字冻结，不升级旧运行；wire1/schema1及公开HTTPDTO不变。

| 条件 | 行为 |
|---|---|
| 未配置、绑定为空、旧包被删除或不可读取 | `rules_catalog_unavailable`，无网络/英文回退 |
| hash/schema/重复字段/固定revision/类别计数/译文状态错误或任一complete=true | `rules_catalog_corrupt`，保留文件；无独立完整源pin时不得自报三核心完成 |
| 参数形状、长度、词数、类别、游标、limit或UTF16边界非法 | `harness_invalid_payload` |
| 合法ID但包中不存在 | `rules_entry_unavailable` |
| 撤权/席位错误、游戏外部更新 | 原 `unauthorized` / `stale_version` |
| 旧工具契约调用新工具 | `harness_tool_unavailable`；若是已外发模型的非法输出，保留原unknown语义 |
| 旧契约携带包绑定、未知hash形状 | `harness_corrupt_run`，保留原记录 |

`HarnessRulesTests` 覆盖旧0..3目录hash、绑定切换/等待/重启/回放、缺原包拒绝、权限及零游戏变化、完整Unicode/字节分页。显式 `--local-rules <绝对dist目录>` 另验证实际维护数据409条逐条完整分页和真实Pi/MCP查读火球术，使用隔离数据与fake模型，不调用远程规则服务或付费模型。默认测试不要求商业全文存在。

### 按需自动地图（契约13）

以下为13—41契约；42地图增量与当前43知情合同见上文。旧目录与回放冻结，`map_request(kind)`仅在已读当前公开情境、角色获批准及正常权限下接受，由服务端构造当前地点PUBLIC描述、按地点去重并使用独立地图队列/预算。原actor+commandId完整输出与地图同记录提交，地图版本不推进游戏版本；模型不能传自由prompt、指定私有地点或冒用host。就绪自动发布仅适用于受控player/未标定用途；手工撤下/维护、失败/未知不自动重排或重新公开。详细用途、字段和双端测距限制见[地图协议](maps.md#ai-按需地图工具契约13)。

### 地图情境刷新（契约14）

本节固定旧v14行为：任何状态写入或等待续接后，地图请求必须先执行新的 `context_read`。v14 缺此读取时返回正常结构化工具结果 `{version,status:"context_required",code:"harness_context_required",nextTool:"context_read",message:...}`，不终止运行、不排队地图、不写游戏、不计图片尝试、不授候选或世界引用。模型读取情境后再发新的地图工具调用；不能重复已经完成的移动、观察等行动，也不能用 `actions_list` 代替公开情境。反馈不依赖 SDK 的 `isError` 标志。

权限、外部版本冲突、非法参数仍按原边界拒绝；旧v13缺情境仍保留原终止行为，已保存地图回执优先原样返回。`AutomaticMapTests.RefreshContextAfterActionRecoversWithoutSideEffects` 使用真实Pi/MCP验证反馈→重读→单次生成及原请求零新增。

### 父端执行帧与短工具协议（契约15）

目标是让服务端负责权限依据与流程推进，不再让模型反复执行“写后重读、重新取得候选、遇等待停止”的文字检查清单。模型仍负责理解输入、选择当前候选、查询需要的规则及生成非机械叙事；权限、骰点、资源、确认和持久回执仍由原服务端执行。

`HarnessRunService.Callback`只对**新模型槽位**先验证原SDK请求/系统原文和冻结工具目录，再在已授权、已批准角色、精确游戏版本的只读gate内调用`ReadHarnessExecution`。父端向本次供应商请求末尾追加一个结构化user消息：

```json
{
  "kind": "execution_state", "contract": 15, "version": 7, "phase": "ready",
  "context": { "intent": {}, "knownMemory": [], "knownScenes": [], "canNarrate": true },
  "combat": null, "availableTools": ["actions_propose", "world_record"]
}
```

示例仅显示结构；真实intent使用同一有界PUBLIC情境/候选投影，combat为当前标准战斗公开投影或null，availableTools是本次实际目录。模型看不到内部Command、私密对象或凭证。`actions_propose.candidateId`的schema enum只含本次候选；没有候选时不外发该工具，不能叙事时不外发world_record。schema是引导，执行时仍经过Domain门禁，不能用猜中ID或伪造字段绕过权限。

工具description缩为用途/参数说明；`context_read/actions_list`保留为可选完整查阅，不再是每轮前置。父端执行帧不写入SDK transcript、不修改导入system prompt、不改原callback指纹或有序原生parts。压缩在本次供应商派生请求上进行；先清被裁历史的引用，再仅授予当前帧真实提供的候选与最多32个世界对象，并保留同版本已实际检索的对象引用（总上限256）。全部外发消息、schema及必要内容仍受原上下文字节限制，不能通过帧绕过预算。

模型槽位在外发前与`ExecutionFrame`一起原子保存为started；旧done只返回原Result，不重新读取/授予旧帧。帧仅存在私有Run存储，不进入进度API、活动或前端DTO。缺失/错契约/非法版本/重复候选或工具/过大帧拒绝读取并保留坏文件；旧0..14不得携带帧，不迁移旧等待或unknown运行。wire1/schema1和旧目录指纹保持。

对象工具结果保留原字段，并附加：

```json
{"protocol":{"contract":15,"phase":"refresh_required","version":8,"applied":false,"next":"model","wait":null}}
```

- `ready`：当前工具执行完成，未改变游戏版本且没有等待；`applied:true`表示执行过该工具，**不表示一定改了游戏状态**。只读数组结果不额外包壳。
- `refresh_required`：版本写入已清引用，或同一批后续受保护写工具缺当前帧。后者`applied:false`、零游戏写/排图/骰点；父端下一次模型调用自动读取新帧，**不会自动重新提交被拒工具或已完成动作**。受保护工具为actions_propose/world_record/world_route_propose/map_request/ruling_request；原回执仍优先返回。
- `awaiting_player`：包含真实wait kind/id，工具Stop继续截断同批后续工具，并立即清执行引用。玩家答案不代替机械同意；原本人同意/独立继续合同不变。续接的新模型槽位自动得到新帧。

游戏外部版本改变仍报stale_version，不由此协议自动重基；超时/unknown、原供应商有限重试与预算规则不变。地图独立回执的崩溃窗口也必须返回与首次一致的protocol字段，不因恢复而重新排图。

验证：`HarnessExecutionProtocolTests`通过真实Pi/MCP证明首轮直接行动→地图→完成、同批失效零二次写、等待后停止/确认一次/重启自动新帧、读取零SQLite变化、坏帧保留；fake Gemini/OpenAI HTTP检查enum、UTF-8及字面反斜杠、原生签名与压缩。`HarnessEfficiencyTests`/`HarnessAuthorityTests`相关历史用例显式固定v14，不以新帧行为抹掉旧失效合同。0..14全目录SHA冻结；这些是工程证据，不代表真实模型长冒险质量或费用下降。

### 完整主持操作合同与行动进度（契约30）

v30在每次新模型槽位的现有`execution_state`中增加`dmChecklist:{instructions,progress}`，包含完整的六项操作合同：行动意图、移动、检定、NPC反应与战斗、信息可见性、保存及结束。每项保留适用条件、实际入口和不可无依据宣布的结果；完整正文唯一维护在[HarnessDmChecklist.Text](../server/DiceRealm.Server/Application/HarnessDmChecklist.cs)，不压缩成关键词，不要求每项都调用工具或改变状态。末尾明确当前工具的能力边界，包括普通observe不执行察觉、checks_result只读、公开记录不能靠private撤回、world_record.complete默认结束。

`progress`是只读派生，字段为`intentId,actorId,version,recordedSteps,pending,rulings,toolReceipts,notice`：

- `recordedSteps`完整复制本次精确intent的权威步骤及原消耗；不借用近期历史，不新增自然语言“剩余计划”。空步骤不等于无需行动。
- `pending`只取本次行动、本人实际等待的roll/intent/ruling。主持转投掷须经精确ruling关联，不能仅查PendingRoll.IntentId。
- `rulings`记录该行动的当前裁定状态、公开理由、实际Check/rollId、角色效果及剧情后果；不带PrivateText或内部Reason。主持投掷不会自动写回原HarnessSteps，不能因此遗漏或伪造新步骤序号。
- `toolReceipts`来自本Run已持久化工具回执，只含stepId/tool/version/isError/applied/waitAtCall。done或applied=true可能只是读取/等待，不代表行动成功；waitAtCall是历史等待，不能盖过当前pending。
- 当前实际位置、战斗和角色状态仍取同版board/combat/self；原始玩家意图与真实续答保留在已有消息中，由AIDM据此判断尚未执行的部分。

合同及领域进度在授权只读gate内捕获，父协调器补工具回执后，在外发前与started槽位一起持久化。只经既有provider projection追加一份当前帧，不写SDK历史、工具结果或导入system；Gemini原生parts与签名保持原样。压缩保留当前帧和所有玩家输入/续答，不丢六项；同槽位供应商重试复用冻结body。旧0..29目录/帧/输出不升级，执行帧contract仍15；done重放不重新捕获或发模型。

读取校验v30必须有合同且正文匹配冻结版本，actor/intent/input/版本必须对应本Run；旧版本不得夹带合同。错误沿harness_corrupt_run保留原记录。现有上下文及记录大小边界不变，不为合同静默剪裁内容。

本合同不增加自然语言移动授权、自由检定或战斗执行能力，也不改变已公开发现的存储权限。测试可证明合同每次正确提供、进度与回执一致；不能仅凭fake模型通过宣称真实主持行为改善。真实供应商长短提醒对照需另外记录授权和实测结果。

验证：`HarnessDmChecklistTests`覆盖真实Pi+fake模型的读/写/拒绝/答复/投掷/主持转投掷/重启回放及跨席位隔离；`HarnessExecutionProtocolTests`检查实际Gemini/OpenAI请求、v29无新字段、压缩/签名和坏帧保留；`SharedBoardTests.RealPiBatchRefreshAndRestart`检查真实移动回执与同版棋盘帧一致。

### 自然移动、场景检定与参数修正（契约31–34）

本节记录v31–34历史合同；v44普通自定DC与豁免见上节。v34运行保留此合同，旧0..33目录、模型回调与已保存回执保持冻结；完整六项检查及导入system原文不变。v31增加场景检定和语义普通移动；v32修正新实例/角色ID的说明并反馈可修正棋盘错误；v33反馈可修正参数错误；v34增加DC数值来源校验、显式段落表示并收拢新增重复说明。

- **移动**：AIDM依据原话和实际图像决定是否靠近及摆位，不以固定关键词识别行动。服务端仅直接执行本轮本人一次普通探索摆位；身份、原输入、既有位置、无待处理、非战斗和移动限制仍校验。其他角色、战斗和资源操作不因此获得授权。
- **检定**：`check_request(ability,skill,mode,sourceId,quote,dc?,passive?)`只作用于本人战斗外。来源必须是当前提供的场景或非模型证据，quote保留在私有请求中，不发给玩家。v34的数值DC必须以`DC N`明确出现于原文引用，不能拿任意场景文字自证DC16；这仅核验出处和数值，**不证明该DC适用于本次目标**，目标/技能/条件仍由AIDM据原文判断。既有作者动作完整匹配时优先使用其冻结检定，不借其他任务的DC。
- **缺少阈值**：寻找潜伏者而资料没有对应隐匿结果/阈值时，直接以`ruling_request`说明缺口，不重复读取已经提供的场景，不把找人换成找足迹，不先让玩家掷无法判定的骰子。只有原始数值本身确有用途时才省略dc；此时`hasDc=false`，不是成功也不是失败。
- **执行**：主动检定先保存`PendingRoll.SceneCheck`，沿原本人确认入口和权威规则结算一次；被动仅支持Wisdom/Perception，使用当前角色修正与实际优势/劣势计算，不掷骰。两者都不自动发现敌人、写剧情fact、扣资源或开战。同一行动相同来源/引文/技能任务不能换DC重掷或将取消/失败改成被动成功。旧31..33的已保存数值检定不重算。
- **参数错误**：棋盘已知提议错误（v32）及参数/check已知校验错误（v33）仅在游戏事务退出、零保存后返回`isError=true,applied=false,next=model`；允许模型发新的修正调用。授权、过期、IO和未知结果不在此降级，也不重放整个行动。
- **正文**：v34可用`paragraphs:[...]`且`narrative:""`，1..20段、拼接后≤4096字符。服务端以真实空行拼接，`NarrativeHarnessArgs.PublicText`同时用于提交和Run完成校验。非空正文与段落混用、空/空白/null段、超长或旧版本使用均拒绝。没有全局反转义，路径和故意引用的字面转义保持；旧已保存坏换行也不会被猜测改写。

验证入口：`HarnessFlowRepairTests`（真实Pi/fake、HTTP、原回执/重启、旧记录隐私、DC与段落零写边界）和`HarnessExecutionProtocolTests.CatalogIsShortAndFrozen`。真实冒险证据归当前任务research，不把工程检查当作模型质量证明。

### 运行时遭遇（契约35）

本节记录v35引入的合同；v36/37新探索通过下节 `combat_delegate` 交接，再由战斗代理开战，不旁路使用探索 `encounter_engage`。0..34目录和旧回执冻结，v34独立黄金哈希为`a9dc83e21425567558450480e216b3d6d0329e126d4efcf222345810e134d872`。完整六项主持检查仍逐次只有一份，六项正文不缩写；仅把原“无法创建隐藏遭遇”的能力说明更新为实际入口，旧≤34文本不变，导入system不改。

- `encounter_read`：DM私有准备记录、已保存隐匿骰/个人发现、实际实例与支持的descriptor。不属于公开叙事或公共回忆。
- `encounter_prepare(mapId,sourceId,quote,layoutReason,grid,enemies,terrain)`：原文须为当前非模型证据，地图须同当前帧。显式战术格/地形、敌方来源与位置先完整校验，之后一次保存实例并掷NPC Hide；原Adventure/PNG和已有玩家位置/HP不改，无新审批。非法布置返回可修正错误，不消耗NPC骰。无作者比例时明确标记独立DM战术标尺，不假称已校准原图。
- `check_request(...,encounterId)`：只允许当前记录的来源与引文、Wisdom/Perception、无模型DC；服务端将本人结果与原隐匿比较，发现保存在席位范围。战斗中用候选`combat.search`，不能用战外检定绕过动作消耗。
- `encounter_engage(encounterId,reason,surprisedActors)`：DM判断实际敌对交锋，沿原全队本人先攻确认；不能重复开战，也不能越过已有行动/投掷/待主持裁定。惊讶不生成额外回合。
- v35战斗中允许无机械变化的`world_record`叙述；仍禁止借此改物品/补给/HP或越过自己的待回应步骤。

完整规则、个人投影与限制见[标准战斗](standard-combat.md)。`RuntimeEncounterTests/RuntimeEncounterHttpTests`覆盖原图/原内容保留、准备失败零写入、个人发现、真实Node/Pi工具链、三席位确认、重启/原回执、私有日志与实际地精攻击。真实供应商与原生Player验收另记任务报告。

### 持续战斗子会话（契约36/37）

v36探索代理通过 `combat_delegate` 在先攻之前保存战斗归属、独立提示词绑定及最小交接；父执行释放后子代理才进入原权威开战/本人先攻流程。一场战斗有稳定 CombatSessionId，每条自然输入仍是独立 Run，外部业务 `sessionId` 保持原输入 request/run ID。一次生成、一条输入、角色回合与整场战斗结束不同；战中交谈不切回探索，也不以文字宣称停战或结算伤害。

子会话共用原角色、棋盘、骰子与 StandardCombat，不复制规则引擎。其独立 system 由工作区显式提供，缺省不能用探索正文兜底。同一席位后续输入恢复本子会话的原生历史；跨席位不复制私人消息、工具结果或签名。多人投掷/反应仍需各自同意。供应商身份绑定持久化，重启不能丢签名或换模型补发未知请求。

权威战斗结束后冻结 ReturnId、真实终态/资源/位置/日志及有来源和受众的主持连续性；先向原父 Run 幂等登记，再记消费并调度承接。原父权限用该次委派保存的可撤销身份引用重新核对，不接受结束者冒充父Actor，不保存token明文。崩溃恢复沿原回执补齐交接，模型started无可靠结果仍保持unknown，GET只读不启动生成。`combat_history_read` 按授权读取当前场或本人参与过的已结束场次，不把有界摘录当全部历史。

v37允许显式接管尚无子会话的既有活动战斗，保留同一BattleId、单位、HP、站位和先攻，不重建或重掷。精确父回传承接帧才附 `Agent.AfterCombat`：只处理眼下处境与下一步，不再次演绎整场战斗或无条件续做已失效的原输入；随后新探索 Run 不携带此临时字段。回传Units标明public/actor受众，个人发现只能进入本人/主持投影。标签和完整检查单不保证任意自由生成正文绝无泄漏，仍须实际多席位核对。

子文字直接进入连续活动流，不经父代理逐回合改写。父回传以真实返回事件序号出现，`continuationOf` 避免重复首条委派原话并保持原actionId/审计。0..35与v36已保存目录、原生parts、回执分别冻结，不自动给旧Run升版。回归入口为 `CombatAgentSession/History/Recall/Multiplayer/Recovery/RedelegationTests`；实际供应商验收与fake工程回归分别记录。

### 私密正文（契约16）

v16 在 `world_record` 增加可选 `private`（字符串，≤1024）：只有行动者本人感知的内容（内心活动、仅其察觉的细节），只对该席位和主持可见，队友收不到。公开叙事仍写 `narrative`，不在 `private` 重复。其余工具、执行帧与 v15 协议不变；v15 及更早目录冻结，仍拒绝 `private`。私密文本不进入 `Resolution.Summary`、事件公开字段或后续模型上下文；所有读出口经 `ActionUnderstanding.ForViewer` 过滤，见[长期历史](history-and-storage.md)。

### 世界提议拒绝反馈（契约17）

新建世界对象必须发送 `id:""`，服务端生成 ID；非空 ID 只用于修改本次实际提供的同类公开对象，不能自造。v17 在 `world_record.memory[].id` schema 中明确此规则，0..16 的目录与回调指纹保持冻结，执行帧仍为 contract15。

v17 的 `world_record` 遇到确定的 `invalid_world_memory`（例如自造 ID、未知 sceneId、重复名称）时，GameService 原事务先退出、不保存；Run 协调器才将错误转换为工具输出：`IsError=true`、`Stop=false`、`code/reason/guidance`，protocol 为 `applied:false,next:model,phase:ready`，版本不变。下一轮模型可依据反馈发出修正后的新工具调用，不能重复已完成的行动。服务端不擅自替换 ID，不放宽引用、场景或权限检查，也不把叙事的一部分先保存。

拒绝的原输出保存到 Run 的 done 步骤，重放返回同一结果；这不是游戏写入成功，也不新增游戏回执。授权、stale_version、容量、持久化/IO 和未知错误不进入此修正路径；旧0..16保持原失败语义，已有 failed/unknown 运行不会自动重发或补写。Pi SDK 的工具错误标记经受控 `tool_result` 钩子传回下一轮，文本与 stop 独立保留；不能仅在 execute 返回值塞入被 SDK 忽略的 isError。

后台请求日志的 `HTTP 200` 只证明供应商传输响应，不证明模型输出已解析、工具已执行或剧情已保存。实际结果看剧情页执行进度、活动记录及权威事件。回归 `HarnessWorldRecordRecoveryTests` / `HarnessWorldSearchTests` / `agent-host/test/host.test.ts` 覆盖零写拒绝、错误标记、修正后落库、已完成行动不重复、旧契约、过期/跨Run引用、重启及原请求重放。

### 剧情获得物品（契约18）

v18 仅为 `world_record` 增加可选 `items:[{itemId,name,quantity}]`，`narrative/memory/private` 保持原语义。真实取得物品时必须明确调用此字段；仅提及、承诺、询价不发放，数量不明先提问。已由剧本行动结算的奖励不得重复提议。普通模型最终正文与 `narrative_commit` 不接收 items，也不解析“已放入背包”代替结算。

- `itemId` 是工具 schema 提供的服务器装备/货币目录 ID（如 `rope`、`torch`），此时 `name` 必须为空。目录名称及规则仍由服务器决定。
- 未知目录的普通剧情记录物使用 `itemId:""` 和非空 `name`（trim后1..60字符、无控制字符）；服务器生成稳定的 `story-item:` ID。记录物不授予名称暗示的机械能力，不自动装备。
- `quantity` 为本行动取得的该物品总数，整数1..9999；每批最多16种，不能同批重复；库存种类/总数量沿原400种、每种9999边界。只写真实行动者的库存，不接受actor、HP、效果或任意补丁参数。
- 同root已保存的正向 inventory changes用于防重复提议：相同数量跳过，不同数量拒绝；原工具commandId回执仍优先，领域已提交但Run输出丢失时原样恢复，不重复发物。新root不靠文本猜测与旧请求相同。
- 先完整验证memory和items，再在同一游戏事务保存叙事、库存、`inventory.grant`步骤、活动变化及完整工具回执。库存变化是`origin.changes`的`operation:"inventory"`、before/after数量；双端从这些权威差额显示获得提示，最终叙事不覆盖已有步骤。

非法目录、覆盖目录名称、空记录物名、重复项、数量或容量错误为 `invalid_story_items`。GameService事务异常退出、整批零写后，v18 Run才返回 `IsError:true,Stop:false,applied:false,next:model` 供模型修正；权限、版本、IO及未知错误不降级。0..17目录/回执冻结，旧契约拒绝items，已有Run不会升级或补发历史物品。

验证：`HarnessInventoryTests`覆盖真实Pi拒绝→修正→数量冲突→重复提议→最终正文、SQLite零写、仅guest本人到账、活动明细、原command重放和停用模型重启零新增调用；纯叙事不发物。工作台和Unity以活动步骤验证提示去重与实际背包。错误做法是正则解析正文直接加库存或由GET修补；正确做法是结构化提议、服务器同事务结算、只读展示回执。

## 5. 持久化与故障恢复

权威游戏状态仍在原每战役 SQLite 内，原 `user_version=1` 不变。新增可空 `Campaign.Harness`、`ActionReceipt.HarnessOutput` 以及 Harness 意图的逐步 `HarnessSteps`，旧记录缺省兼容。

运行在 `DataPath/harness/{campaign}/{sha256(actor)}/{requestId}.json` 原子保存。终态记录原样移动到 `closed/{id前两字符}/{requestId}.json`，仍可直接按 ID 重放；**不删除历史回执，也没有“玩满64次就不能继续”的终身上限**。最多64条未结束记录；通常每席位只允许一个未请求取消的未结束 Run；v36起 delegated 父 Run 挂起时允许其所归属的战斗输入 Run，仍由同一战斗子会话串行推进。已请求取消但尚未退出的旧执行可短暂与新 Run 并存，读取端不能假定活动列表只有一项。单记录8MiB，损坏/未知 schema/重复标识拒绝且保留原文件。

私有运行保存 `ToolContractVersion` 与 `ContextReadVersion`。缺字段为0，历史契约0保持原工具描述与完整输出，契约1保持原省略语义与10项工具，契约2加入两项行动历史召回工具，契约3加入世界检索与实际对象引用授权，契约4再加入本地中文查读。私有可空 `RulesCatalogVersion` 为新运行绑定资料 hash；旧0/1/2/3保持缺省 null，null 不写入旧 JSON。工具描述也参与回调指纹，执行与验证必须读取该运行冻结目录，不能把已等待的旧运行升级后强行重建为新描述。标记不改变wire/schema或公开业务投影。

恢复策略不是重新问模型“再做一次”：

1. 固定 Pi/协议版本、原输入段及每个 `(turn, kind, sequence)` 槽位。
2. 模型可能外发前保存 started；成功回复先落盘，工具才能执行。未完成模型槽位禁止重新外发；已由受信适配器证明外发前拒绝时记录 failed，细节见下节。
3. 工具先登记稳定 commandId。写工具在原战役事务中把**完整原工具输出**与效果/事件/回执一起提交。
4. 重建 Pi 时回调旧模型/工具槽位，只返回已保存输出。若战役已提交而运行文件未保存，按 commandId 找回原输出，不拿新的快照版本替换旧输出。
5. 只有自己提交的效果或显式确认的匹配结果推进 Run cursor。指纹不匹配直接停止。

新完成的意图在领域结算同事务将 `intent.Version` 更新到当前游戏版本。旧多步意图可能保留落后的标记；近期、按ID召回、搜索、摘要和语义投影统一取标记与已保存 `HarnessSteps.Sequence` 的最大值作为 `resultVersion`，仅只读派生，不改旧记录、冻结的Run记忆或回执。不能把超过当前版本的坏步骤截断为合法；原校验仍拒绝。回归见 `HarnessContinuationRegressionTests`。

运行不是跨多工具的全成全败事务；后续模型失败不撤销已保存线索、消耗或骰点。活动列表/详情的 `steps`（仅 Harness 可选新增）保留各规则步骤；最终叙事不能抹掉检定/rollId/消耗来源，`initialResult` 仍可读取机械结果。

运行日志属于席位私有内容，主持不能旁路读取其他席位 Run。新步骤保存白名单 `toolName` 作为安全进度标签，以及可空、null省略的 `toolRequest`（tool/final确切参数，登记先于副作用）。读取必须核对kind/name/对象形状和原callback指纹；旧schema1缺字段仍合法。主持独立步骤投影见[业务接口](adventure-sessions.md#主持执行进度只读)，不放宽原始Run读取，也不在GET补写旧记录。HTTP读取新字段的兼容不等于旧二进制保证识别所有新存储字段；需回退时用匹配版本的一致备份，不能运行中删字段。完整备份需包含新的 `harness/` 目录；正常停服后复制整个数据目录，不通过删回执“清容量”，不把运行中散拷当一致备份。

### 模型拒绝与未知结果

`OpenAiHarnessModel` 和 `GeminiHarnessModel` 只对自身确定的外发前拒绝抛出受信 `HarnessModelNotSentException`；协调器将证明关联到具体模型槽位，不能根据模型正文、子进程错误字串、余额或无响应推断未外发。

| 确定的外发前拒绝 | 终态错误码 |
|---|---|
| 适配器配置缺失 | `harness_model_disabled`（正常入口会更早由启用检查拒绝） |
| 地址/端点类型不合法、不安全、混用配置或含 userinfo/query/fragment | `harness_model_endpoint` |
| 密钥含空白/非 ASCII、超过8192字符或无法形成合法 header | `harness_model_credentials` |
| 消息角色/原生续接历史不符合合同，或续接换端点/模型 | `harness_model_contract` |
| 完整供应商请求体序列化超过128KiB | `harness_context_limit` |
| `ProviderBudget.Reserve` 明确拒绝额度 | `harness_model_quota_exceeded` |

没有同时取消时，这些运行以 `failed` 结束；若调用方同时取消，沿用既有取消终态优先级，但不会把已取得的拒绝证明误报为未知。不发生该次 HTTP 外发或新额度预留。保留原 started 槽位、无结果和 `ModelAttempts`，所以登记尝试次数不等于供应商预留次数。已完成模型回复与工具效果不回退；同 ID 重放、GET、重启不补发，failed 不可 resume，修正配置/补足额度也不会重新执行旧请求。

当前活跃槽位可先按下节有限重试；重试关闭、用尽、遇不可重试错误或中断后，仍未取得有效回复时保守按未完成模型槽位记录 `unknown/harness_model_unknown`，预留不退还。即使 HTTP 429 或响应正文声称额度不足，也不能当作本地外发前拒绝。取消竞争中未取得证明时同样保持保守语义。

证明随失败终态一起持久化；若终态写入前进程崩溃，旧日志仍只有 running/started，恢复继续拒绝补发。升级不重分类原 unknown，也不修改 schema、wire 或指纹。

### 供应商中文、思考与有限重试

`HarnessProviderJson`只在供应商外发边界使用可读UTF-8 JSON；系统生成的第一个玩家输入/历史封装和工具JSON正文会解析后重新序列化，避免把内层 `\uXXXX` 当成模型可见文本。用户字符串中的字面反斜杠、后续用户手写JSON及原系统prompt保留原值。不能全局修改 `HarnessJson` 或对文本做Unicode正则替换：旧Turns、profile/callback指纹、签名parts、记录和原回执都不改。

Gemini把思考等级映射为 `generationConfig.thinkingConfig.thinkingLevel`，`off`映射为 `thinkingBudget=0`；包含思考由 `includeThoughts` 独立控制。等级/预算是否支持取决于配置的模型，不猜型号、不自动降级参数。新运行不写输出上限（旧运行仍为4096，含供应商思考计数）；`MAX_TOKENS` 截断不会当作成功。OpenAI-compatible使用 `reasoning_effort`，`off`省略此字段；该协议没有通用 `includeThoughts` 字段，不能伪造同名参数或承诺返回思考。返回thought不进入玩家回复/共享日志。

重试由服务器供应商适配器拥有，Pi SDK重试仍关闭。默认首次失败后等待1、2、4秒再尝试，最多3次额外请求，同一模型、地址、请求正文不变；不会新建行动ID、重跑Run或重复已执行工具。仅HTTP408/429/5xx、网络/读取异常、单次尝试超时（`AttemptTimeoutSeconds`，非调用方取消），以及坏JSON/缺candidates或choices/无效结构等可重试。401/403/其他非暂态4xx、内容安全/明确拒绝、输出长度截断、响应超限、本地配置/签名历史错误不重试。`Retry-After`可增加等待；超过60秒时结束本轮而不提前重发。取消、总时限、额度或Run上限均可提前停止，不能保证任何失败都刚好重试3次。

每次额外尝试之前，父协调器通过进程内 `BeforeProviderRetry` 重新核对当前席位/权限、游戏版本、取消和Run上限，持久递增 `ModelAttempts`，随后 `ProviderBudget.Reserve` 再持久计一次外发额度。退避等待不持有游戏锁。发送失败仍可能计费，重试可能增加供应商费用；不能宣称恰好计费一次或把失败usage当0。已发送一次之后再发生本地额度拒绝，不能将整个槽位误标为从未发送。

辅助历史摘要也复用同一重试循环，默认失败后额外重试3次，1/2/4秒退避、每次最长180秒。来源、受众、供应商配置和请求正文冻结，首发及每次重试前重新授权；每次单独计账和记录请求日志。重试用尽仍保留原文/上一版摘要，持久issued标记阻止读档或重启补发已结束工作。此规则不改变辅助连通探测的一次请求合同。

有效回复才交给Pi处理工具；失败输出的工具一律不执行。重试用尽后保留started/unknown及全部计数；读取、同ID重放、重新启动、改重试配置都不会恢复旧unknown。这里只允许当前仍存活调用内的有限模型重试，不允许图片重排、游戏命令重试、跨进程恢复补发或自动更换模型。

### Gemini 原生续接与安全诊断

`GeminiHarnessModel` 使用非流式 `generateContent`：原样 `systemInstruction`，`parametersJsonSchema` 函数声明，按顺序组合 `model` 内容与同批 `functionResponse`；只接受单 candidate、`STOP` 和完整有界 JSON。`MAX_TOKENS`、安全拦截、重复字段、未知输出类型等不会伪装成完成。usage 输入采用 `promptTokenCount`（不减缓存），输出包含 `candidatesTokenCount + thoughtsTokenCount`；缺少数据按字节保守估计。原生调用没有 SDK 网络重试。

Gemini 的 `thoughtSignature` 可能在函数、文本或空文本分段上。服务端保留有序原生 parts 和工具 ID 映射，以 `HarnessStep.ProviderContinuation` 与完成结果原子持久化；每份最多128KiB，记录仍限8MiB。原生缺少工具 ID 时只为内部回执生成一次 ID，不伪造并外发原生 ID。默认显式发送 `thinkingLevel=high, includeThoughts=true`（可配置）；供应商返回的 thought 分段只属于私有续接，不进入文本、Node wire、HTTP、导出或日志。

下一次外发只从**当前已授权 Run** 的已完成模型步骤获取元数据。适配器逐项核对普通 assistant 消息、工具名/参数/ID及非秘密的端点+模型身份哈希，再原样恢复签名与分段。不跨 Run 查缓存，不接受 Node 提供私有历史。`HarnessModelRequest.ProviderHistory` / `HarnessModelReply.ProviderContinuation` 为进程内 `JsonIgnore`，普通回执、wire1、schema1 和旧指纹不变；旧步骤缺省元数据为 null。缺失、错配或更换端点/模型的原生续接在外发前拒绝；不能丢掉签名降级重发。新存储需匹配版本读取，回退旧二进制不能靠删字段迁移。

OpenAI 最终文本的 `tool_calls:null` 与缺失/空数组等价；不放宽其他容器、重复字段或 length 截断。两个适配器的失败诊断只记录固定阶段、状态/字节数、JSON 字段类型、封闭 finish 类别和异常**类型名**。禁止传异常对象、原始请求/响应、签名、密钥、模型文字和用户字段值；诊断日志不是未发送证明。

### LLM 请求日志

`ModelRequestLog`（数据目录 `model-requests.sqlite`）由挂在 `OpenAiText`、`OpenAiPreparation`、`OpenAiHarnessModel`、`GeminiHarnessModel` 以及辅助历史整理、`PrivateStoryRetellings` 等命名 HttpClient 上的 `ModelRequestLogHandler` 写入：每次 HTTP 尝试在发出前插入一条（进行中可见），结束后补状态、错误、耗时和响应正文；只保留最新 300 条。记录完整请求体与响应体，**不记录任何请求头**，URL 中的 `key=`/`api_key=` 等查询参数打码。冒险引擎调用时附带战役、行动编号、玩家原话与第几次尝试。日志写入失败只告警，不影响游戏请求；图片生成不记录。

接口：`GET /api/v1/accounts/model-requests?before=&limit=&failed=` 与 `GET /api/v1/accounts/model-requests/{id}` 仅管理员账户；`GET /api/v1/campaigns/{id}/model-requests[/{requestId}]` 需该战役主持权限，只返回本战役记录。列表不含正文，详情含完整 `requestBody`/`responseBody`。工作台「请求日志」把 Gemini/OpenAI 请求体分为系统提示词、对话条目、工具定义与生成参数展示。

战役列表可传 `failed=true&unresolved=true` 只读未恢复提醒；不影响普通failed审计列表。仅当可重试失败（网络/408/429/5xx）之后，存在同client/campaign/非空runId/method/url/非空完整requestBody、更大attempt且已结束的2xx，并且中间没有attempt重置，才从提醒排除。不同正文、不同槽位、无运行身份、401或证据不足均保留。只在现有全局300条保留窗口内关联，不删除失败记录或费用。HTTP恢复只证明传输恢复，模型解析/工具提交仍看原执行结果；不能以同Run任意200冒充恢复。回归 `ModelRequestLogTests.RecoveredRetriesLeaveAlertsButKeepAudit` 与真实工作台轮询。

### 当前行动角色详细事实（契约19）

新运行在每次模型请求末尾的 `execution_state.self` 自动附带本人角色事实，不需要模型先调用 `context_read`。包括身份与职业等级、六属性、AC/HP/临时HP/熟练、速度/先攻/被动察觉、全部技能与豁免、当前资源与恢复方式、库存数量与准备状态、当前使用武器、能力/熟练/专精/精通，以及已知/准备法术、法术书和各自独立的免费次数/法术位/仪式来源路线。只传明确投影，不发送原始Build/成长取得历史、其他席位私密身份、主持隐情、完整剧本或凭证。

首轮、工具写入后与等待续接后的新模型槽位都从当前已授权角色重新投影；已保存步骤与旧回执不重写。完整角色集合不做静默截取，极端超大内容沿用既有上下文字节限制并明确拒绝外发，不新增Token门槛。规则全文仍按需查读，角色事实和来源路线不构成自动施法/扣资源的权限。

工具目录v19与旧0..18分别冻结；执行帧 `contract` 仍为15。旧15..18帧省略 `self`，新19要求存在，版本混用或坏角色形状拒绝并保留原运行文件。此改动只对升级后新发起的行动生效，不把旧运行强制升版。`HarnessCharacterContextTests`覆盖首轮、写后/确认后最新资源、本人隐私、旧18字节与重启回放；`HarnessExecutionProtocolTests`同时验证OpenAI/Gemini实际HTTP正文、原生签名及压缩后保留self，全部使用本机模拟供应商。

### 显式装备组合（契约20）

v20在同一个 `execution_state.self` 追加只读 `loadout`：当前近/远组、近战握持、五个装备槽及双手占用、配置状态说明。精确装备选项仍由同帧的intent候选提供，self.loadout.options为空，不重复一份执行入口。每次新模型槽位重新从本人权威配置投影，确认后看到实际主副手；不会把备用弓当作第三只手，也不把模型描述当作换装。模型只能提议服务端候选，再走既有本人确认与原子角色命令。

`HarnessCharacterContext.Capture(c,toolContractVersion)`按运行版本发字段；新loadout候选只在v20出现。0..19工具目录及v19 self由改前真实程序集golden冻结，旧待办不升级，原回执不重算，执行帧contract仍为15。新角色状态为nullable/null省略loadout；GET只读推导旧档，不在模型投影时迁移。`EquipmentLoadoutTests`验证旧目录/self精确值、HTTP拒绝零写与重开、真实Pi加本机假供应商的提议→本人确认→最新槽位，不声称远程攻击或Light额外攻击已自动化。

### 完整穿戴与同调（契约21）

v21的`execution_state.self`新增只读`wearables`与`equipmentStatus`，库存附精确`rulesId`；options/attunementOptions在self中为空，唯一执行入口仍是同帧候选。普通`wear`可直接执行且不要求安全休整地点；`attunement`须本人确认新的一小时专注短休，正常只恢复本人资源，不复用旧短休或替队友恢复。缺库存同调仍可投影和通过原候选解除。具体wire及规则边界见[客户端契约](client-contract.md#wearables-and-attunement)和[角色使用](character-play.md#完整穿戴与同调)。

原`world_record.items`目录增加12件穿戴物，沿`StoryInventory`发放独立quantity1实物并写稳定规则ID，成对物品算一件。实物ID由本行动/目录/序号派生；同一行动换toolCommandId、丢失物品或服务重启后不能重复领取，改变已领总数量原子拒绝。旧0..20不仅schema不含新目录，服务端同样拒绝新目录输入；旧目录hash和v20 self由改前程序集golden验证，旧运行与回执不强升。执行帧contract仍为15。

`WearableEquipmentTests`覆盖规则、领域投影、HTTP授权/并发/重启/回执、缺库存解除与冻结边界；真实Pi/MCP经本机fake完成获物→直接穿戴→本人确认同调→最新self→缺失物品解除，不调用真实供应商。

### 当前场景地图状态（契约22）

v22从v21冻结目录派生，只修改 `map_request` 的按需主动制图说明。执行帧仍 `contract:15`，新增可空、null省略的 `map:{sceneId,status,generationEnabled}`；状态取值和玩家图册采用[同一安全投影](maps.md#当前场景地图状态契约22)，不包含未发布图ID、提示词、参考图或供应商诊断。每个新model槽位都重新授权读取并与started一起保存；重放使用已存帧。

仅 `status=missing && generationEnabled=true` 时把 `map_request` 放入 `availableTools` 和实际供应商声明。探索需要空间示意时可主动申请，无需玩家明确索图；不等于每次换场景自动调用。`pending/generating/ready/failed/withheld/unavailable` 不提供新申请；已公开的当前手工图优先ready，图片配置关闭不撤销已发布图的读权限。执行边界再次检查状态，失效则原 `refresh_required/applied:false`、不入队；原地图回执在此检查之前恢复，不能因当前ready改变旧pending输出。

0..21工具目录、帧省略map和旧回执保持冻结。新旧map形状混用、未知状态、多余字段、隐藏地点或缺generationEnabled视为坏Run，保留原文件并拒绝。GET和模型状态投影不生成地图、不推进游戏。`SceneMapStatusTests`、`AutomaticMapTests`、`HarnessExecutionProtocolTests`覆盖纯读字节、状态矩阵、执行门控、旧目录golden和真实Pi加脚本fake的普通探索→申请→发布；后者不证明真实模型一定自主选用工具，也不证明远程图片质量。

### 最终回应、来源与工作情境（契约23）

v23加入以下行为；旧0..22目录、回执、原Turns/MemorySnapshot及原生签名均冻结，不升级正在等待或unknown的Run。执行帧仍`contract:15`，wire1/schema1及公开客户端接口不变。

**完成一次。** `world_record`新增可选`complete`，省略/true表示本行动最终回应；只有`complete:false`才是中间记录。领域同事务保存叙事、物品、世界记录与完整回执，内部`CompletedNarrative`为受信终结标记；工具返回`stop:true`及`protocol.phase=completed,next=done`，Pi停止同批余下工具。父端直接将已接受正文作为Run.text，不再请求模型复述或额外执行final/narrative_commit。普通模型直接返回最终文字的原路径仍保留。运行器在Pi原生turn边界读取父端停止状态；即使本批前面已有非停止的查询，也在保存全部工具结果后结束，不会追加模型请求。显式下一轮仍可正常继续。

标记只允许出现在v23末尾成功world_record步骤，必须与参数、Stop、版本和原工具结果一致。工具提交后Run槽位未保存时从原commandId找回；done工具已保存但Run终态丢失时，授权及原回执校验后可用空文本resume直接恢复终态，即使后来游戏版本已变化或模型已禁用，也不重写游戏、不外发。该纯恢复可多保存一份续接回执，不增加执行轮数。unknown模型槽位、取消或新正文不能借此补发。

**当前获物。** v23每个`items[]`必须含`source:{kind,id,detail}`。`current_scene`要求当前已到访场景ID；`public_memory`要求本Run本版本实际提供的当前当地公开npc/place/clue引用。detail为1..240字符的本次交付依据。旧历史行动、规则条目、未知ID、私密或异地对象不能当当前来源。itemId不再展开约240项enum，仍经服务端既有精确目录验证；空itemId与非空name只创建无机械能力的剧情物件。旧0..22不接受source，新合同不补发历史漏记，也不从正文正则发物。

合法引用和明确来源说明只能证明引用资格，不能证明自由文字绝对真实。目录存在、NPC一句建议、尚未履行的承诺或历史“已入包”都不应当成当前交付；数量未知先问清。实际接受的来源保存在本人原行动`StoryAcquisitions`，库存、活动权威差额与原回执仍决定是否到账，同根重复工具不重复领取。

**按需资料。** `context_read({scope?})`默认`context`沿用原公开情境和候选；`scope=character`读取完整本人self；`scope=items`支持query≤120、offset≥0、limit1..24（默认12），返回可获物目录、total/nextOffset和coverage。中文名称/别名只由本Run固定本地规则包的精确身份关联，不联网翻译或猜ID；缺包使用原英文/ID，报告覆盖。后两种读取不授行动候选或世界更新引用，也不标记默认情境已读。`world_search`新增coverage，空匹配不证明人物/物品/世界事实不存在。

**私有工作情境。** 新模型槽位在同一个授权、同版本gate内捕获`workingContext`：当前静态/动态人物、带来源的公开证据、覆盖范围和`dmOnly`。公开人物按规范化名称去重，但保留来源ID；authored/model_record/host_record表示记录来源，不是可信度评分。公开证据被实际提供后可成为同版本更新引用，DM-only永远不能授引用。

DM-only仅限导入冒险`initialKnowledge`中显式host、关联当前场景的ID，再用当前世界索引逐ID检查仍为host、同场景且未隐藏；不读取任意host记录、其他席位、纠错理由、SourceText或整份剧本。工作情境分区本身只进入私有保存帧及供应商请求，不进入公共context_read/world_search或玩家快照/DTO；原主持资料管理页依既有host权限读取同源资料的能力不变。作者必须明确写入这类资料；换运行包不会替旧剧本创造NPC动机、硬期限或招募资格，也不会自动增加战斗同伴能力。

**紧凑外发。** 完整self仍保存在私有ExecutionFrame。一般交谈的供应商视图保留身份/职业、HP/AC/状态、真实库存、当前资源与装备概况、已熟练技能及输入明确匹配的能力/法术；省略项标为未加载，不冒充不存在。战斗或本轮已结算机械步骤自动用详细self，其余细节随时可读scope=character。初始工作记忆见[连续性投影](harness-long-memory.md#来源化工作记忆契约23)。仅父端自有第一条输入封装和执行帧作派生；不改用户原话、system原文、后续消息、native parts/signatures或历史回执。v23保存帧允许512KiB容纳完整审计，旧帧128KiB不变；外发压缩仍以96KiB为目标、实际HTTP体仍128KiB硬上限。

**逐项目标揭露。** 内容`quests[].objectives[].visible`可用原条件表达式；缺省/null维持旧公开行为与旧序列化指纹。`ContentRuntime.World`统一过滤未揭露项，玩家世界面板和模型goals共用该投影；提示词“不要剧透”不能替代服务端过滤。新作者修订须显式导入/启用，运行包不迁移正式内容。

`HarnessFinalNarrativeTests`验证真实Pi单次保存/停止同批、中间继续、两类崩溃与禁用重启；`DmContextTests`验证揭露、隐私/来源、紧凑与完整读取、中文身份关联、旧历史保真、体积和引号否定上下文；旧目录有独立golden。全部为隔离fake供应商，不代表真实模型文风或判断质量已验收。

### 当前场景呈现与行动范围（契约24）

v24引入以下合同；0..23目录、保存帧与回放仍按原版本，不升级旧Run。私有执行帧仍为contract15，新增必需的 `scenePresentation` 和 `hasImportedSkills`；旧合同省略这两个字段。

`scenePresentation:{sceneId,title,currentSummary,arrival,notice}`只取当前已访问且公开的场景。title/currentSummary来自`Adventure.Current`的当前变体，arrival保留导入的公开入场原文；它不是本轮事件，也不意味着入场时的条件一直成立。当前状态、变体和后续已确立事件优先。没有符合条件的场景时，四个内容字段为空；不外发其他场景入场文、SourceText或图片提示词。标题≤160、summary/arrival各≤8000，仍受实际provider请求体总上限约束。

`hasImportedSkills`取自该Run冻结的Profile，不取战役创建时的bootstrap配置。为false时，实际供应商tools与AvailableTools同时省略skills_list/skills_read；保存读取也核对该值与冻结Profile一致。它只减少空查，不增加新工具权限。

`actions_propose`描述要求玩家输入涵盖候选完整动作范围；人物名字或话题相同不足以选择剧情动作，身份问答与普通交谈可直接world_record。工具合法性校验不证明语义匹配；作者须将询问、提出委托与玩家接受拆成合适的效果，不能让单纯询问暗中写入接受事实。回归`StoryIntentContextTests`验证纯读、变体/跨景/未访问边界、实际Gemini正文、真实Pi冻结方法配置和重开；脚本模型不证明真实语义选择或文风质量。

### 局部物资与按需入场正文（契约25）

v25只用于新Run，0..24工具目录/保存帧/原回执冻结，执行帧仍contract15。没有新HTTP写入口、商店框架或普通领取审批。

**记录与领取。** 原`world_record`可带`supplies:[{id,itemId,name,quantity,unit,permission,source}]`，最多16项。标准物使用支持的目录itemId和空name；独特无机械道具用空itemId与1..60字符name。quantity为0..9999的已确立总量（包含已经领取的量），不是剩余量；unit为1..24字符的单件目录单位说明，不做长度、容积或规格换算。permission为`allowed|ask|unavailable`；source只接受原`current_scene|public_memory`当前来源并提供事实/许可依据，不能用规则目录或历史文字证明现货。

空id创建，服务器按当前场景+来源+物品身份生成稳定ID；相同来源同物品只能有一条记录，不能换空id重新补满。更新使用原id，不能换身份/单位，总量不能低于已领取量；真实新增或减少物资可显式更新总量，许可也可在实际对话确定后更新。服务器维护claimed与`remaining=quantity-claimed`。来源变私密、隐藏、移走或换场景后不进入当前物资投影，也不能引用领取。

`items[].source.kind=supply`引用物资ID；本次同时声明且身份唯一匹配时id可为空，保存前规范化为真实ID。已记录的当地同身份物资必须走supply引用，不能用current_scene绕过余额；尚未登记的实际即刻交付保留原来源路径。同一次工具中可声明、许可、领取并最终回应，无需为了拿新ID多一轮模型请求。只登记supplies不入背包；只写正文也不入背包。

数量、同场景/公开来源、身份、许可和余额由服务器校验；库存、叙事、世界记录、物资和完整回执同事务提交，任一拒绝都不半写。重放原commandId返回原结果；同一行动新工具重复相同领取总量不再次扣物资或加背包，改来源/总量拒绝。v25自定义name统一trim后匹配、存领取依据和计算背包身份，避免物资扣两次而背包只加一次。失败沿`invalid_story_items`恢复反馈，库存未变；并发新请求仍用stale_version。

来源说明、permission和总量是模型依据当前情境提出的受限记录，服务端不声称能证明任意陈述真实。未知许可/数量需自然澄清，不暗补历史欠物。用本Run固定规则包关联名称/aliases；与目录名称或别名精确匹配的自定义道具会被拒绝并给出正确itemId。此边界不是通用自然语言物品分类器，不能把搜索失败解释成允许捏造自定义物品。

**当前情境。** 私有帧新增必需`supplies:{version,sceneId,entries,total,nextOffset,notice}`，默认提供当前公开的前12项，包括单位、许可、来源和实际remaining；`context_read scope=supplies`以offset/limit1..24分页（不接受query）。未登记不等于现场不存在；该投影不另造玩家快照字段或授予行动/世界更新候选。

普通轮次的scenePresentation保留当前变体摘要及既有公开证据，arrival为空；首次入场、本轮新结算observe/travel，或显式`context_read scope=scene`才给当前已访问场景入场全文。成功world_record保存当前场景及叙事版本标记，实际旅行清除；observe步骤序号晚于叙事标记才再次提供正文。读取本身不写标记，不按中文关键词判断意图，不把每个Run首调当首次入场。旧v24仍每轮提供原文。作者摘要应保留稳定地标；不从入场修辞自动提取事实或把历史条件冒充现状。

**系统正文不变。** 用户导入的原样system仍为唯一system字符串；工作记忆与execution_state通过user消息，tools独立。DM提示词页展示当前生效/编辑稿的原始分段，请求日志对OpenAI/Gemini使用相同切片函数，不把方法正文或动态用户上下文伪装成自动system注入。

验证入口`HarnessSupplyTests`覆盖真实Pi首轮状态/同工具声明领取/最终停止、同事务拒绝、并发/原回执/重启、自定义空白去重、隐藏/跨景来源、实际observe/travel和纯读；`--supplies-rules <维护包目录>`以真实不可变包核验别名检索及自定义拒绝。`StoryIntentContextTests`继续验证v24旧帧，目录0..24有独立golden。提示词UI的DOM与真实嵌入浏览器验收分开，不据fake结果声称在线文风已验证。

### 物品模糊检索与来源依据（契约26）

v26只用于新Run，0..25目录、旧items查询结果及回放保持原样；frame仍contract15。没有新增工具、HTTP端点、向量库或在线检索服务。

`context_read {scope:"items",query,offset,limit}`沿原参数限制（query≤120、limit1..24）查询同Run固定规则包和既有支持获物目录。先规范化大小写、全半角及标点；名称/ID精确优先，其次名称片段或不依赖词序的多词命中，再英文编辑距离/相邻换位、中文字符重叠，最后规则正文关键词。单字符不参与模糊或全文匹配；中文近似不丢弃数字/拉丁限定。纯空白浏览，纯标点不浏览。按score降序、itemId ordinal升序分页；没有相关证据就返回空，不拿任意目录项补数。

每个entry在原itemId/name/canonicalName/aliases外增加`rulesId`（未绑定译文时null）和`match:{kind,field,text,score}`。kind为`exact|partial|terms|fuzzy|text|browse`，text为匹配字段原文或最长240字符正文摘录；score只表示检索排序，不是语义正确率。rulesId可交给原rules_read取完整规则。名称/正文匹配只是候选；既有获物身份与自定义道具拒绝仍采用精确规则，不用相似度自动选物、发物或赋予机制。规则可查≠场景有物≠允许领取。

**来源检查。** 新物资及即时获物复用`source.detail`，要求逐字摘录预先存在的当前导入场景公开summary/arrival，或当前当地、公开且实际提供的`preparation|dm`记录summary。`harness`/其他模型记录、同次新建记忆、规则目录或自由编写的交付描述不能作为该依据。引用已有supply领取时检查其原来源；不自动迁移旧物资。若同次memory更新会把引用的作者/DM来源变成模型记录，整笔拒绝，新增观察可用原continuity入口记录。所有检查在CommitNarrative之前，失败为`invalid_story_items`，叙事、记忆、物资、背包和回执不半写；模型得到可修正反馈，不增加普通人工审批。

**叙事边界。** v26每次执行帧workingContext.guidance和world_record描述要求所有物品陈述来自已确立场景、实际库存或权威结果，不凭搜索候选/旧模型文字编造物品、位置、归属、数量或许可；资料未给出时先读、仍未知则不作肯定断言。导入system仍原样不变；作者prompt候选须通过原发布/激活流程采用。引文硬检查只证明文字确实在允许来源中，不能证明任意正文、数量或许可的语义忠实；省略items/supplies的纯正文仍依赖生成约束，不宣称已实现任意自然语言幻觉拦截。

验证入口`HarnessItemSearchTests`和`--item-search-rules <维护目录>`覆盖无别名真实数据、规范化/错字/中文近似/正文/噪声、稳定分页、v23..25结果冻结、纯读、模型自证/隐藏/异地来源拒绝与同事务零写、真实Pi修正后领取及重启重放；v25独立包golden在`HarnessExecutionProtocolTests`冻结。

### 主持辅助工具（契约55）

沿现有Pi/MCP工具链提供三个只读工具，不另启网页、远程MCP或运行时网络查询。旧0–54工具表不变，正在恢复的旧Run保留原合同。

| 工具 | 输入与结果 |
| --- | --- |
| `dm_reference` | `topic=checks/objects/traps/hazards/cr`，返回2024的DC、物件AC/HP、陷阱设计与常见危险参考。探索及战斗主持均可用。 |
| `encounter_plan` | `difficulty=low/moderate/high`；按实际未死亡、未撤销、已批准角色等级求和预算，怪物XP直接相加。`query/count/offset/limit`查询同类组合；`monsters:[{id,count}]`评估混合名单。仅返回本Run固定中文库内有完整资料且已核验CR/XP的怪物。`executableProfileId`区分已有战斗执行支持，其余只供规划。 |
| `treasure_generate` | `challengeRating`、`kind=individual/hoard`、`creatures`、`theme=random/arcana/armaments/implements/relics`。同一意图与参数稳定生成；个人财富按同类数量相乘，宝库使用2024金额/魔法物数量，稀有度按当前角色实际等级。每个结果的choices是单件允许的选项，变体与缺失本地正文显式保留；不补造、换物或重抽掩盖缺项。 |

遭遇规划与战利品工具仅向探索主持提供。工具不创建遭遇、开战、修改库存/货币或消耗正式骰点流；生成结果不是现场存在或可领取的证据，仍须使用既有来源/执行与结算流程。任意自造怪物的官方2024 CR反算未支持，不伪装成旧版计算器。内部来源、版本与标识不向玩家朗读。

实现为`HarnessDmTools`与嵌入`dm-tools-2024.json`；开发脚本`scripts/build_dm_tools.py`从项目同pin证据生成数字表和身份，不包含整本正文。固定版本与文件哈希保留在资源后台元数据。测试`HarnessDmToolsTests`覆盖实际HTTP授权调用、字节不变、2024预算、旧合同拒绝、稳定方案及真实Pi/MCP工具往返；模型为本地替身，不代表任意供应商的自主选工具质量。

## 6. 已验证与后续

测试入口：

- `agent-host/test/`：真正 spawn Node，实际 Pi/MCP，多工具停止、跨 turn、精确 system/schema、规范化回放、限制、取消和 EOF。
- `HarnessPiTests`：真实 .NET/Node/Pi/MCP → 待投掷 → 本人确认 → 服务/子进程重启 → 旧回执重建 → 检定读取/世界记录/最终叙事。
- `HarnessTests`、`HarnessBoundaryTests`、`HarnessAuthorityTests`：权限/撤销、私有投影、版本、来源确认、并发请求、unknown/失败保留效果、崩溃窗口、冷存回执、取消提示和损坏记录。
- `HarnessProviderTests`：fake HTTP 检查原文传输、工具映射、可空 tools 的旧红新绿、严格输出、地址/大小、诊断隐私与持久外发次数，无真实供应商调用。
- `HarnessGeminiTests`：原生 URI/header/system/schema、无 ID/并行工具、有序签名、thought 私密性、进程内字段不改变旧 JSON、错误/配额/换供应商与非法 key；真实 Pi + fake native HTTP 验证本人确认前零骰、确认一次、重启续接、线索唯一和原回执零外发。
- `HarnessProviderOptionsTests`：实际HTTP正文UTF-8/内层解析/字面反斜杠、思考参数、默认1/2/4秒、重试分类/额度/取消、真实Pi单次工具提交与重开不补发、版本变化/总时限拒绝额外外发。
- `HarnessBudgetTests`：显式关闭重试后的兼容路径，真实 Pi/MCP + fake HTTP 验证额度0、已提交效果后额度拒绝、非法地址、发送异常/坏响应/HTTP 429/伪造错误码仍 unknown、增加隔离额度后原请求重放与重启不补发；
- `HarnessRulesTests`：本地包严格校验、完整查读、旧契约/固定译本、授权及无新增执行权限，另有显式真实维护包集成入口。
- `HarnessWireTests`：真实Node在多种字符/byte分片边界、多行同chunk、连续运行及坏帧下验证原始bytes分帧和拒绝；详见[wire协议](harness-agent-wire.md#stdout-字节分帧)。
- `HarnessReadTests`：本人活动发现、脱敏字段/Skill哨兵、跨席位/撤权、旧无标签和未知槽位、GET零写入/零执行、冷存与坏记录。真实Pi测试还验证重启前后的绑定和工具标签保持一致。
- `HarnessRecallTests`：35条历史的关键词与字节分页、公开更正/原骰点、权限和零写入；真实Pi/MCP从业务入口15条行动中召回第1条，重开恢复原工具输出；0/1目录指纹不变、v1等待恢复与拒绝升级。
- `HarnessWorldSearchTests`：世界对象公共查询/分页、原ID更新和来源、实际读取引用的授权/失效、零机械变化、纯中断与领域提交窗口；真实Pi业务检索/重开与旧v2恢复、0/1/2目录不变和损坏引用保留。

fake回归仅证明工程合同；短场景通过不证明任意自由行动或长时间叙事均正确。可编辑版本化工作区与冻结记忆见后续 [P2](harness-workspace.md)；浏览器运行状态/恢复见[业务冒险与设定](adventure-sessions.md)；Unity业务接入已完成；本地中文规则查读已经接入，完整三核心中文资料和更多领域工具仍在后续工作中。另有独立本地目录包，见下节。

## 7. 独立本地运行包

打包脚本 在新隔离目录构建 .NET Release 与 Node，并按锁文件单独 `npm ci --omit=dev --ignore-scripts` 安装生产依赖；不覆盖开发目录、旧包或存档。入口/四字段模板/运行说明在 scripts/package。运行包要求 Windows x64、PowerShell7、.NET10 ASP.NET Core Runtime、Node>=22.19，不需 SDK/npm/源码。默认全模型关闭，只有显式配置+启用才可外发；默认工作台 `http://127.0.0.1:5190/workbench/`。

`licenses/inventory.json` 与 `upstream/sources.json` 保存实际依赖、许可正文/来源和未确认项；原始许可证与嵌入字体许可均保留。`proxy-agent-negotiate` 的两个安装副本尚缺许可正文，清单明确标记需复核，本项目也未提供根许可证。因此这是本地运行交付，不宣称已完成公开再分发许可、正式发行、部署或公网加固。
