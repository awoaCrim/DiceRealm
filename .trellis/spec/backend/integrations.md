# 内容、规则与外部集成

## 产品方向与现有能力

后续开发遵循 [输入优先、系统维护世界](../frontend/user-experience.md)：玩家表达行动，LLM和服务器承担日常叙事、互动、推进及对象识别/创建/关联/更新。人工DM主要负责角色审核批准、部分LLM无法可靠决定的问题和LLM出错后的纠正；不要求其逐项录入对象或批准每次普通决策。角色规则校验与人工审核批准是不同事实，不能相互冒充。当前有限意图候选和手动管理端点尚未完整实现这一目标，不能将它们的限制反写为必须人工维护的产品要求。

LLM负责理解、叙事及结构化变更提议，服务器负责规则、权限、引用、可见性、幂等和持久化；已接受的世界变化应自动更新相关投影，不再要求DM重复添加对象。新增世界维护能力应定义受限且可验证的服务器操作，不从自由叙事直接解析HP或任意数据库补丁，也不把所有可自动确定的更新重新排成主持确认队列。缺少关键依据时先向相关玩家自然语言澄清，确需人工判断的问题才升级给DM；纠错须保留已执行效果与修正记录。没有地图位置依据时保持未知，不造坐标。

现已加入受限主输入、非机械世界记忆与审核/纠错协议，字段和验收边界见 [输入驱动冒险](../../../docs/input-driven-adventure.md)。自动地图由下述契约13受限工具提供；不代表任意地图路线/机械坐标或在线供应商质量已验收，也不构成实际调用付费供应商或外发参考图的操作授权。

## 内容与规则来源

- 新战役保持空白，只有明确导入或从剧本库点击启用的冒险/探索提示词才能驱动故事；战斗默认稿见下文契约54；用户已明确允许随程序提供可选原创剧本，不能默认替用户启用。生产代码不引用测试夹具。剧本库流程见[剧本库](../../../docs/adventure-library.md)。启用后的剧本固定版本，提示词版本不可覆盖，同一命名版本不同原文不能偷偷替换。
- 模型通过 [AiPorts.cs](../../../server/DiceRealm.Server/Application/AiPorts.cs) 提议已有白名单意图、非权威文字，或受限 `narrate` 非机械 world-memory；输入模型的是有限公共上下文，不是可写 Campaign。只有已提供的公开 memory/scene 引用可修订/关联；不解析叙事为 HP、库存、事实、奖励或路线变更。
- 不支持的规则不能猜测执行；建卡合法、拥有能力、支持自动结算是不同状态。剧情推进必须使用明确内容或主持命令，不因为 AI 写了「成功」而解锁。
- 修改 D&D 规则前记录 `ruleset`、source 和固定版本证据。默认 `dnd2024`，不静默拿2014补缺。用户已明确本地中文核心库不依赖D&D MCP：本任务以本地不可变原始文件/pin取证和维护，不为补译启动远程查询。其他需外部取证的任务再按 dnd-mcp skill 选择工具；无法取证就标记缺口，不能把记忆写成已验证规则。
- 规则数据可检索不代表可再分发整本书；本地全文置于忽略目录、不得未经许可公开打包或匿名分发。资料覆盖见[本地中文库](../../../docs/local-chinese-rules.md)，自动执行覆盖见 [rules-2024.md](../../../docs/rules-2024.md)。

## 供应商边界

[OpenAiText.cs](../../../server/DiceRealm.Server/Infrastructure/OpenAiText.cs) 和 [ImageGeneration.cs](../../../server/DiceRealm.Server/Infrastructure/ImageGeneration.cs) 拥有外部协议。文本与图片配置独立，密钥仅在服务端秘密存储/环境注入；缺少配置明确禁用，不默认挑付费模型。

- 外部 HTTP 有服务端截止时间、响应大小/结构检查和受限地址策略；不跟随会泄露凭证的重定向，不下载供应商任意 URL。
- 使用 [ProviderBudget.Reserve](../../../server/DiceRealm.Server/Infrastructure/ProviderBudget.cs) 在外发前持久预留次数，失败/超时仍计数。用量表示尝试次数，不伪装成精确货币费用。默认不限额但仍登记；本机配置和新运行不设输出Token上限见[AI设置与用量](ai-settings.md)。
- 缓存与离线不扣外发额度；不得因换供应商、重启或重试重置账本。游戏事务回滚不退款已经尝试的外部调用。
- 供应商测试使用 fake handler，检查原文传输、拒绝路径和调用次数；真实计费验证必须有本次明确授权。

## 原生执行链与历史预算（契约45）

1. **范围/所有者**：`HarnessHistoryPlanning`只规划已结束历史；`HarnessContextCompactor.PreserveCurrent`保护当前完整链，供应商适配器拥有native Part，Run/Session继续拥有恢复。字段与错误表唯一归[历史上下文](../../../docs/harness-long-memory.md#契约45只整理已经结束的历史)。
2. **签名/输入**：`IHarnessModel.Capture/Complete`冻结配置并正常生成；只消费响应实际usage，不请求元数据/countTokens、不做本地估算。`ctx_search/ctx_expand`只返回授权来源。缺usage为null且不阻断首次生成，实际输入量不代表模型容量。
3. **冻结/权限**：新槽位更新状态，started槽位不重选摘要/层级/原文/图片。来源先按公共与本人私有拆分；主持权限不扩大历史受众。模型笔记始终为model_reported，战斗return与回查不得把它标成公共事实。相同笔记去重限定同意图，窗口外的已接受原回执仍保留。历史原文补充不能因通用词全量回灌；明确引文和已知发言者须独立于词频保护，旧单参搜索行为保持。
4. **失败**：技术边界下优先完整detailed/brief，必要时等待整理；仍无法完整发送为preparation_failed，必需内容本身超技术边界为transport_limit。required-only占位绝不外发。供应商实际拒绝/unknown沿原合同，不裁当前链补发，不把后续生成失败说成已保存行动失败。
5. **正常/基线/边界**：自然边界或实际usage增长可整理未覆盖的完整闭合组，冻结基线＋增量；短Run也须沿同席位/scope/timeline/profile的历史首槽位观察增长，不把累计run.Tokens当窗口。未配置/后台未完/失败时在技术边界内继续原文/旧组合。0..44保持旧回放，旧45 inputBudget只读兼容；新增模型的只读语义试验不替代真实Pi工具循环验收；已测工具路径与长期连续游玩分别记录。
6. **验证**：`HarnessGeminiTests`验证正文/签名到最终HTTP与冻结重试；`HarnessHistory*Tests`验证受众、精确展开、覆盖集合、发布竞争和失败表；战斗组验证return一次消费。真实语义验收单独授权，须先核实实际摘要覆盖与原文补充范围；全原文仍在、HTTP200或fake正文均不能证明压缩后语义。临时消费者也须使用input/ruleset=dnd2024/memory三字段产品初始包络，并核实际wire已走HarnessProviderJson的中文展现路径；不能把转义文本测试直接当产品输入质量。摘要与消费正文、尾部清单都要对照原文，区分已知否定、真实未答问题、未来选择与有触发条件的义务；不得只凭“拒绝”等单词判错，也不以引用ID存在代替归属核对。
7. **正误**：错误是工具返回就视作闭合并裁正文，或把整个探索Session永久保护；正确是保护当前未完行动，已结束交流用来源化历史，HP/装备/位置只读最新状态。`ConfiguredHarnessHistorian`的既有指令明确sequence/version是定位信息，不是对话轮数；清单不得从未承诺扩写新问题或义务，借后义务保留触发条件。指令要求需由真实样本检验，不是程序已验证任意叙事正确的保证。

## 自然语言理解与叙事上下文

[IntentContexts](../../../server/DiceRealm.Server/Application/IntentContext.cs) 是有界玩家投影的所有者：只用当前席位、可见地点/人物/目标、有限近期本人行动，人物经历按相关词截取。理解与叙事不得恢复发送 SourceText、内部 Facts 或完整 Character/Campaign。候选来自当前 Domain 可用操作，模型只选择已提供 ID，不生成执行参数。字段、集合和 128 KiB 序列化 payload 上限均在外发前执行。

主输入 [AdventureDirecting](../../../server/DiceRealm.Server/Application/AdventureDirecting.cs) 只接收 typed `action|clarify|narrate|adjudicate`：只有 `narrate` 带有界非机械记忆；先完整验证再整组应用。新 `Direct` 调用原样发送导入的 Intent 和 Narration **两段 system prompts**；旧 `{kind,target}` 响应只在已提供的合法场景候选内兼容，不表示旧提示词能可靠满足新协议。部分已导入行动在合法且安全时可从主输入直接执行，需投掷的只建立待同意请求；角色来源/成本或多候选须明确确认，不得强弹辅助面板。无效输出/超时回到未执行澄清。`OfflineTrial` 必须在应用入口强制绕过注册供应商。回归见 [ActionUnderstandingTests](../../../tests/DiceRealm.Tests/ActionUnderstandingTests.cs)、[WorldMemoryTests](../../../tests/DiceRealm.Tests/WorldMemoryTests.cs)；fake-provider 不证明真实语言质量，字段细节见 [新协议](../../../docs/input-driven-adventure.md)。

## 来源化上下文与内容揭露

- v23详细字段统一归[运行协议](../../../docs/harness-runtime.md#最终回应来源与工作情境契约23)与[工作记忆](../../../docs/harness-long-memory.md#来源化工作记忆契约23)。`HarnessSceneContexts`只从当前索引构造有来源/覆盖的情境；DM-only只可读取导入initialKnowledge显式当前场景host白名单，并复核当前非hidden/同场景/host。不得扩大为主持席位可看所有私有信息，也不向公共DTO或更新引用泄漏。
- `ContentObjective.Visible`复用原条件表达式，缺省/null保持旧公开和指纹；唯一过滤点为`ContentRuntime.World`，客户端与模型共用。不能依赖prompt隐藏已经外发的目标；揭露条件引用也须纳入StoryConsequences已知事实校验。
- `HarnessProviderContext`只派生当前外发视图，完整self/原始日志/MemorySnapshot/native parts保留。紧凑未加载≠没有能力；完整角色按需可读，机械结果保持详细。保存帧上限和实际provider体积上限分开，不用Unicode转义持久体积误拒可容纳的中文请求。
- continuity与source.detail都是模型报告而非机械真相；实际物品仍由StoryInventory在原事务校验来源引用/目录/数量并幂等到账。禁止从文字解析库存，禁止把旧历史漏记当新发放，不能声称形状校验可证明任意叙事真实。
- 旧文摘录必须保留引号外围的归属/否定句，无法完整保留就明确省略；不以半句肯定冒充原承诺。附加笔记超预算先减附加项，不能挤掉memory_read原正文。回归依据：`DmContextTests`、`HarnessFinalNarrativeTests`及冻结目录golden。

### 未说出口的意图与角色知识（契约52）

`HarnessStoryContext.ForVersion`与`HarnessDmChecklist.InstructionsFor`共同拥有知情边界，详见[运行合同52](../../../docs/harness-runtime.md#未说出口的意图与角色知识契约52)。玩家输入给DM不等于角色说话；NPC/其他角色只能依据实际感知、交流或已有获知依据推断，不能精准复述未知计划，猜测不得写成确知。此约束贯穿探索、战斗、公开memory/continuity，不增加说话/保密确认、不改玩家原话或通过正则声称验证语义。旧51及以前保持冻结；固定模型实际Pi测试证明合同到达和恢复不变，不证明真实生成已无读心。

### 当前场景与玩家意图（契约24）

1. **范围/签名**：`ReadHarnessExecution(..., toolContractVersion, hasImportedSkills)`及私有`HarnessExecutionFrame`；字段唯一归[运行协议](../../../docs/harness-runtime.md#当前场景呈现与行动范围契约24)。
2. **合同**：当前已访问且公开场景的入场原文须进入v24模型帧；`Adventure.Current`提供变体摘要。入场原文是历史情境，不压过当前状态或后续事件；不得因缺开场而发送完整剧本、别处arrival或图片prompt。
3. **来源**：方法是否存在由冻结`run.Profile`决定，不读取可能不同的Campaign.Harness bootstrap；空方法不提供查询工具。旧0..23目录/帧保持冻结。
4. **拒绝**：v24缺字段、旧版夹带新字段、场景错配、过长文本、工具表不匹配或方法标记与Run Profile不符，沿原坏帧/坏Run错误保留文件拒绝；不补造默认资料。
5. **正常/基线**：当前变体和入场资料分开呈现；换景只供当前arrival；未访问不供内容。普通身份问答不因NPC/话题重合自动代表请求整个剧情候选。
6. **验证**：`StoryIntentContextTests`检查纯读字节、场景边界、实际请求及真实Pi重开；`HarnessExecutionProtocolTests`保留独立旧目录golden。作者效果另按真实导入稿验证，fake工具选择不冒充语义质量。
7. **正误**：错误为用自然语言正则认证授权、强加每次对白确认，或只改未实际启用的稿件；正确为模型范围引导、作者效果拆分、绑定版本/哈希核对。合法候选只证明当前可执行，不证明玩家已选择。

### 局部物资与按需场景（契约25）

1. **范围/签名**：`StorySupplies.Plan`、原world_record与私有frame.supplies；字段唯一归[运行协议](../../../docs/harness-runtime.md#局部物资与按需入场正文契约25)。不建商店/新写端点或逐项审批。
2. **合同**：局部物资声明与items领取在原授权事务计划后一起提交，服务器拥有claimed/remaining；当前同身份登记物不能绕过supply引用。当前来源/许可/总量仍是模型提议，不声称形状校验可证明叙事真实；未知保持未知，不自动补发过去库存。
3. **身份/兼容**：v25统一trim自定义名再做领取去重和入包身份；标准名称/别名通过本Run固定真实规则包精确关联，拒绝降为同名道具，不另写中文语义分类器。旧0..24目录、参数和回执冻结，可空聚合字段缺省不迁移/补造物资。
4. **拒绝**：无许可/超余额/异地或隐藏来源/身份单位变化/重复声明重置/同根改变领取，invalid_story_items且整笔不写；原回执优先于新版本及状态门禁。
5. **正常/基线**：同工具声明并领取无需额外模型往返；旧v24保留arrival全文，新v25成功叙事记录场景/版本，旅行清除，已结算observe序号晚于标记才重新给正文。纯读不消耗入场，不以每Run首调或正则猜意图。
6. **验证**：`HarnessSupplyTests`覆盖同事务/并发/重启、跨景私密、自定义空白变体、真实Pi首轮与默认结束、实际observe/travel及纯读；`--supplies-rules`必须用生成的真实包验证，而不只造含别名的夹具。
7. **正误**：错误为物资按原始name扣减、背包按trim后name去重，导致一加二扣；正确为同合同在行为所有者规范化后贯穿事务。错误为把入场 prose 无条件当本轮描写范本；正确为当前摘要/公开事实常驻、原文按实际进入/观察或显式请求提供。

### 物品检索与叙事依据（契约26）

1. **范围/签名**：`HarnessContextReads.Items(...,toolContractVersion=23)`按新版本调用`HarnessItemSearch`；`HarnessItemEvidence.Validate`在原world_record提交前校验。详细字段只维护在[运行协议](../../../docs/harness-runtime.md#物品模糊检索与来源依据契约26)。
2. **检索合同**：同pin真实目录，规范化后精确/片段/多词优先，名称近似和正文靠后，score+ordinal ID稳定分页；显式返回匹配类型/依据。相似度不是身份或现场存在证明，不能用来合并/发物或赋予规则。别名是补充数据，不能拿补几个样本代替通用检索。
3. **兼容**：0..25工具及旧items输出冻结，新行为仅v26；不改system原文，不新建物品注册表/向量库/搜索服务，不改库存和公开DTO。
4. **依据/拒绝**：新声明和即时获物须引用预存当前导入场景公开文或当地公开preparation/dm记录，已有stock领取复核原来源。模型记录/同次新建不能自证；同次改写被引用来源导致其变成模型记录则整笔拒绝。失败invalid_story_items，无叙事/记忆/物资/库存半写。
5. **正常/边界**：无别名麻绳返回绳索fuzzy候选，燧石返回打火匣text候选；绳索XYZ不因丢ASCII限定而成为高分近似。规则存在不说明可领取，缺信息不等于不存在；对未知不编物也不随意宣告缺货。
6. **验证**：`HarnessItemSearchTests`覆盖排序、分页、空/短/错字/混合限定、真实无别名包、来源自证/隐藏/跨景/同次更新、原子拒绝、真实Pi修正和重启；旧golden来自改前已交付assembly，不能用新实现自证。
7. **正误**：错误为忽略中文查询中的数字/型号，或只验证提交前引用却让本次更新立即破坏它；正确为保留查询限定、核拟提交状态。引用Contains只能验证出处，不能声称验证整段自由叙事的语义；正文防编造是明确生成要求，不加审稿模型/人工逐项审批来伪造保证。

### AI位置、叙事及战斗配置（契约39）

新合同的实际参数与拒绝码归[共享棋盘](../../../docs/shared-board.md#初始位置与ai控制契约39)及[Harness运行](../../../docs/harness-runtime.md#契约39增量)。v39新增全队获准角色位置控制，旧≤38确认分支只供旧Run恢复；不得把旧的单次/本人/无路径条件重新加到新合同。内部`narrator && controlPlayers`不可从HTTP自报，战斗回合、移动限制、实际地图版本及投掷确认不因位置授权放宽。`DmPositionTests`须覆盖直接多次移动、开场首放、玩家首放拒绝、跨席位普通HTTP拒绝及旧Run。

`HarnessStoryContext.ForVersion`拥有第三/第二人称与私人纯故事合同，不能修改旧常量导致保存帧失效。对白/分享引文保留原归属，不正则替换历史代词或删除机械审计。契约39–53缺独立战斗system的能力预检属于`ReadHarnessExecution`/`HarnessAgentContext`；`combatPromptReady=false`不提供委派，并给具体配置恢复提示，不能回退探索提示词、自动采用作者稿或重新掷骰。`HarnessCombatPromptTests`验证缺配置零战斗副作用、旧失败兼容、明确应用后恢复能力而不自动重发。

### 内置战斗主持提示词（契约54）

按用户2026-11-03要求，战斗主持内置一套默认提示词。`HarnessCombatPrompts`从服务端嵌入的`content/prompts/dm-combat.md`解析独立战斗预设；未自定义时新战斗直接使用，已有自定义原文优先。只在战斗委派时冻结实际原文/版本/哈希，不改探索预设、在途战斗、旧Run或旧骰点。设置页显示默认原文，修改沿原保存链，清空并保存恢复默认；GET不写回、不调用模型。契约≤53保留原缺配置行为。验证见`HarnessCombatPromptTests`与`prompt-import.test.js`。

### 检定速查随清单给出（契约59）

探索 checklist 追加 `HarnessDmChecklist.CheckReferenceRule`（DC 六档与常见能力/技能搭配，普通检定不再先查 `dm_reference(checks)`/`rules_search`）；工具目录与战斗 checklist 同契约58，旧 0..58 运行不变。原因：真实模型每次普通检定前多花两轮查资料。

### 后加入的公开到场（契约58）

公共开场保存后入场的玩家，开场帧带 `opening.writeArrival=true`，可写最多两句、200 字以内只关于本人加入的第三人称公开到场；不重述场景、他人或已保存开场，已写过此人则留空。`writePublic` 与 `opening.publicText` 含义不变。剧本写定的可委派遭遇另在探索帧遭遇说明追加 `GameService.AuthoredEncounterRule`（可直接委派，`executableProfileId` 只限 `encounter_prepare`，委派前用 `token_spawn` 补齐站位）。契约58只在 `opening_commit` 描述追加到场例外；checklist与契约57相同，旧0..57运行不变。

### 叙事不复述玩家原话（契约57）

玩家原话原样显示在公共叙事正上方，所以探索叙事从实际发生的事写起：玩家明确写出的台词按已说出处理、不在正文重写，不按原话顺序复述动作、提问和计划。契约57只在探索checklist末尾追加这一条（`HarnessDmChecklist.NoEchoRule`）；工具目录、战斗checklist与契约56相同，旧0..56运行不变。

### 探索只读预载（契约56）

普通探索的新模型槽位复用已有读取投影；角色/候选/棋盘不重复注入，完整场景入场原文和有界遭遇/固定规则库范围仅作可选补充。私有遭遇只留在DM模型帧，开场生成与公共DTO不获得它，也不增加世界更新引用；工具仍能按需补查。预载超大小/传输边界须整项省略并明确标记，不能截断语义、修改未完原生工具链、自动补发或升级旧0..55运行。互不依赖的只读查询可由模型同轮发起，服务器执行次序不变。完整字段、边界和验证见[运行协议](../../../docs/harness-runtime.md#探索只读预载与同轮查询契约56)及 `HarnessReadPreloadTests`；真实性能与生成质量仍待在线验收。

### agent内置主持辅助工具（契约55）

按用户2026-11-03要求，剧本库不展示来源按钮和外部DM工具入口；来源/许可留在后台。主持辅助能力直接进入agent现有工具链，当前由`HarnessDmTools`提供2024速查、实际队伍遭遇预算/配队和战利品方案，详细合同见[运行协议](../../../docs/harness-runtime.md#主持辅助工具契约55)。规划只读，不消耗正式骰点或改写世界/库存；结果不自证敌人、奖励存在或具有执行能力。与本Run固定本地中文资料绑定，缺项保持未知，禁止2014静默补缺，禁止把任意CR反算或全部魔法效果宣称已支持。旧0–54合同冻结，新工具仅新Run可用。验证入口`HarnessDmToolsTests`与`adventure-library.test.js`。

### 发现交付与头像生成

- **范围/签名**：v40 `EncounterConcealment.Search(..., waitForNarrative)` / `PresentedTo` / `CommitNarrative` 分开机械发现与玩家呈现。协议归[发现同步](../../../docs/shared-board.md#发现与地图同步契约40)，旧请求缺字段保持旧语义。
- **事务/兼容**：实际骰点和KnownActors先保存；40..42 `world_record` 非空旧private沿原合同发布本人待交付发现。v43只按privateMessages中的明确discoveryIds逐recipient核验已发现并释放，不因普通私聊放出其余待交付目标。纯公共正文、普通final/narrative_commit、转述、轮询、重启和叙事失败均不释放。攻击Reveal沿原规则，不能重新掷骰来补叙事。实际收件消息、空公共完成和每槽位KnownInformation沿[跨端合同20](../contracts.md#20-自动地图持久开场与实际知情范围)，0..42目录/帧冻结，不在既有常量上追加新要求。
- **头像边界**：Join/Resubmit成功提交后锁外Ensure；GET不登记生成，头像不能阻断已成功的入场。规范化初始build+style决定身份，不能用当前HP/库存或provider切换让ready重新收费。
- **外发/权限**：头像复用 `IMapImageGenerator` overload、ConfiguredImages和ProviderBudget；只发视觉白名单，不发私人经历或整战役。完整DTO/HTTP/状态及拒绝码唯一归[角色头像](../../../docs/character-portraits.md)。同伴未审批画像不公开，图片每次鉴权。
- **失败**：先存generating再可能HTTP；重启/超时unknown不可自动重发。原请求优先重放，显式失败重试绑定failureId；游戏提交后登记IO失败只影响头像，不谎报建卡失败。
- **验证**：`EncounterPresentationTests` 实际Pi暂停叙事并跨重启/失败验证无提前token、无重复骰、只本人交付；`CharacterPortraitTests` 覆盖两个Join、重交、跨房复用、图片权限、关provider后的ready、unknown/显式重试和登记恢复。
- **正误**：不能以UI延时修地图泄露，也不能从每次GET触发图片；分别在权威呈现事务与明确入场/补图动作登记，使用已有结果。

### 持久个体命名（契约41）

- **范围/签名**：`NpcNames`只负责有限通用标签识别及原创后备；`RuntimeEncounters.Prepare`、`SharedBoard.Execute`、两种CombatEngine及`WorldMemories.Plan`尾部内部`namingVersion`控制新行为，完整合同见[命名协议](../../../docs/npc-naming.md)。
- **创建/身份**：名字在创建事务中确定并沿definition→appearance→combat复制；原专名、玩家、object和ExistingId保留。只为后备避撞，不能按名称合并实体。GET、渲染、重启不补名；不消费机械IDice或额外命名调用。
- **同步/兼容**：显式update只同步匹配BoardEntityId的非玩家活动unit，不改旧日志/回执。v0..40冻结；新pending保存NpcNamingVersion=41，缺字段/0仍旧策略，不能在确认端点隐式升级。
- **校验/失败**：新v41 world_record明确通用npc名以invalid_world_memory整笔拒绝；已有记录不自动改名、无entity绑定不猜关联。空/非法创建仍沿原错误，不以生成后备吞掉参数错误。
- **例子**：新“伏兵1”取持久个体绰号；作者专名和“吕三2”保留，两个Twin仍是两人；旧存档编号不自动迁移。根据2024 XDMG Name指引拟名，不伪称有硬性种族姓名表或官方译名。
- **验证**：`NpcNamingTests`覆盖创建零骰、同批/来源保留、hidden投影、重启/回执、活动单ID改名、延迟确认版本及真实Pi旧新分支；独立v40黄金由`HarnessExecutionProtocolTests`检查。
- **正误**：不能每次显示时随机取名或用当前版本执行旧pending；正确是在创建/确认的原事务保存名字与冻结策略，读端直接消费已存值。

### 共享棋盘与模型视觉（契约27）

1. **范围/签名**：`BoardService`、`SharedBoard`、`BoardCombat` 与 `HarnessBoardFrames` 拥有单位/命令/视觉帧；完整API及工具字段唯一归[共享棋盘](../../../docs/shared-board.md)。地图标记不是单位，完整Character不应强套所有NPC。
2. **身份与事务**：玩家引用原Character；非玩家来源只初始化新实例，移出/重现引用原ID，不重置HP。写入同时绑定战役版本与地图版本，原回执优先，命令/状态/私有审计同事务；GET无补造。只改摆位的撤销不回滚规则效果。
3. **权限与同意**：服务端计算可见/可控，当前不可见单位及旧隐藏位置不公开；完整审计只留私有回执。普通本人直接拖动无AI往返；AI提议玩家移动默认保存精确命令并走原本人确认，v28仅有下述整句本人摆位例外。主持不能代替其他玩家同意。
4. **图像与兼容**：每个新模型槽位在同一公开投影下捕获底图字节、版本/hash、实例及操作，再冻结真实图像后外发；重试不重新截图。不能向模型发送GM底图，不能把签名原生历史或Node transcript改写为截图。旧0..26目录和回放冻结，图片失败明确可见。
5. **战斗与拒绝**：原战斗使用同一实例、实际地图标定和位置，按真实已结算前缀回写。未知尺度/资料或不支持状态明确拒绝，不猜7×5位置；`OnStart`先预检，再在效果后重新取得机械状态。地图版本改变返回stale/refresh要求，不按新网格执行旧坐标。
6. **回归**：`SharedBoard*Tests`覆盖真实HTTP、双版本、幂等/重启、隐私/历史、实际多模态bytes、真实Pi/fake、原战斗循环。Unity `SharedBoardTests`检查真实JsonUtility未知值、拖动只在结束提交、pending隔离、共享面板；fake不能代替在线模型理解质量。
7. **正误**：错误为从叙事改HP、用请求目标冒充已结算位置或隐藏棋子后仍外发秘密底图；正确为领域结算、公开投影、冻结图像与原请求重试。

### 执行入口与有限本人摆位（契约28）

#### 1. 范围 / 触发

适用于路线读取、工作情境检索、敌对事件入口和本人棋盘意图的执行流程修正。新Run使用工具契约28，旧0..27目录、版本分支输出与已存回执冻结；执行帧仍contract15，不升级旧Run。完整字段与使用边界归[共享棋盘契约28](../../../docs/shared-board.md#执行流程修正契约28)。这不是通用自然语言授权，也没有新增自动完整战斗。

#### 2. 签名与行为所有者

- [HarnessTools.ForVersion(int)](../../../server/DiceRealm.Server/Application/HarnessTools.cs) 按Run冻结版本取目录，`CurrentVersion=28`。
- [WorldRoutes.KnownRoutes(Campaign)](../../../server/DiceRealm.Server/Domain/WorldRoutes.cs) 返回 `KnownWorldRoute[]`；[HarnessTool](../../../server/DiceRealm.Server/Application/HarnessGameService.cs) 的v28 `world_routes(offset,limit)` 使用该投影，旧版本仍用 `WorldRoutes.View`。
- [HarnessSceneContexts.Build(Campaign,AdventureContext,int)](../../../server/DiceRealm.Server/Application/HarnessSceneContext.cs) 按版本选输入词；[ReadHarnessExecution](../../../server/DiceRealm.Server/Application/HarnessExecutionService.cs) 仅为v28给 `working.Guidance` 追加 `EncounterGuidance`。
- [DirectPlayerBoardIntent](../../../server/DiceRealm.Server/Application/HarnessBoardIntent.cs) 由 [ExecuteHarnessBoard](../../../server/DiceRealm.Server/Application/HarnessBoardService.cs) 在已认证原输入和领域写入之间调用；通过后仍走原 `ExecuteBoardCommand`，不另建授权或执行端点。

#### 3. 契约

- 路线只读响应的 `scope=current_scene_authored_and_dynamic` 明示范围；`source` 区分作者出口/动态路线，`canTravel` 只表示当前出向可走。作者出口无维护ID、不承诺反向，动态路线的 `bidirectional/open` 与 `editable` 不互相代替；可维护不等于立即更新或旅行。已锁作者出口不返回，原 `View` 与动态路线确认规则不变。
- v28输入词先取实际命中的合法公开已知实体名，再取动作动词后的字面对象，最后原片段；查询范围和数量仍有界，旧版本保留原排序。检索词、memory、发现叙事不产生facts；完整作者动作须符合玩家实际输入，观察不能冒充接近/搜索。纠正走既有主持 `StoryConsequences` 的内容声明事实/后果边界，不新增从memory开facts的工具。
- `EncounterGuidance` 先判 `CombatEngine.InCombat`；否则检查本帧合法 `combat.start` 候选及当前遭遇，以 `BoardCombat.Prepare` 只读预检。可执行时提供准确候选入口，未覆盖时指向 `ruling_request`。`rules_scope` 仍只是规则可读性与执行范围，不代结算；未知NPC攻击须由主持裁定，不借外观、图标、custom或完整NPC构筑补出攻击规则，不切2014/2024。命中、落空、护甲挡下、成功闪避/撤离及零伤害结果均须有权威结算，不能由叙事先决定。
- v28 `ruling_request(question)` 将已校验问题写入原 `PendingRuling.Reason`，与原等待/工具回执同事务；它只请求具体裁定，不代表攻击已完成。该引导不构成对自由正文的机械语义证明。
- 免二次确认仅覆盖原输入完整匹配有限句式、本人实例、精确中心/0..1坐标的一次 `move` 或单个本人 `player` 来源 `spawn`；无吸附/非空路径、战斗/角色受限/移动限制、本人待投掷/意图/裁定，同输入无已执行 `board.move/board.spawn/travel`。同一运行席位/原输入和当前地图版本必须匹配；模型不能自报consent或代其他玩家授权。其他情况保留原精确确认及领域规则。
- 棋盘工具与视觉始终为当前公开玩家图/公开单位，不是隐藏GM棋子管理。规则字段本地化只属显示，不翻译人物名、自由正文或库存物品名，不改规则身份和机械值。

#### 4. 校验与错误矩阵

| 条件 | 结果 / 边界 |
|---|---|
| `world_routes` 的offset不在0..2048或limit不在1..16 | `harness_invalid_payload`，无写入；锁出口过滤而非返回秘密条件 |
| 目标模糊、命令坐标与整句不同、有路径/吸附/限制/等待或已执行动作 | 不取得直接摆位资格，保留原精确提议/确认或领域拒绝；未确认不改实际位置 |
| 试图摆放/移动其他玩家；地图或场景变化 | 原 `forbidden`、`stale_board_map`/刷新要求或 `board_scene_mismatch`，不放宽身份和版本门禁 |
| 无合法自动开战候选，或预检遇 `board_combat_*` | guidance明确 `ruling_request`，不暴露隐藏参与者/私有准备资料；不假称已完成攻击 |
| `ruling_request` 问题空/超240字符或已有待投掷 | 原参数/待投掷校验；不产生半份裁定。旧版本不倒灌新Reason |

#### 5. 正常 / 基线 / 拒绝例

正常：本人输入“把我的棋子移到地图中央。”且满足全部条件，准确目标 `(0.5,0.5)` 经原命令保存；NPC实际攻击但没有自动遭遇时，保存具体问题并等待主持裁定。基线：v27仍冻结精确棋盘确认与原路线输出，旧回执不因新目录/投影变化而重做。拒绝例：模型把本人 `(0.6,0.5)` 改成 `(0.7,0.5)` 后声称已同意；从动态入向路线、锁出口或一段发现memory推导可旅行/危险已解决。

#### 6. 必需验证与断言点

`HarnessExecutionProtocolTests` 保留0..27独立golden并检查缺遭遇→ruling等待及具体Reason；`WorldRouteTests` 检查作者出口范围、动态出入向/关闭、只读不改时间和拓扑；`DmContextTests` 检查v28实体/对象优先、旧排序及无facts副作用。`SharedBoardIntentTests` 检查整句直行一次、目标错配/受限不直行、重开和原确认；`HarnessGeminiTests` 检查本次提供的新工具可接受、未提供工具拒绝及历史调用/签名绑定不变。真实供应商和双端仍须走实际流程；脚本模型/静态审阅不证明语义质量或未支持NPC自动攻击已实现。

#### 7. 错误与正确做法

错误：用正则命中或AI自报consent认证任意自然语言授权；“箭射空了、无需扣血”当作无需结算；把模型记忆中的发现自动写成facts。正确：有限整句只绑定本人准确摆位，原领域入口仍判权限/版本/限制；实际敌对事件先走可执行遭遇或主持裁定；发现先取得符合实际输入的作者动作或原主持事实裁定回执。

### 裁定必要性引导（契约29）

v29仅调整 `HarnessTools`、`ReadHarnessExecution` 与 `rules_scope.note` 的新版本指令，执行帧仍contract15、HTTP与存档不变；旧0..28目录与输出分支冻结。遭遇信息是条件性能力说明，没有Encounter、威胁或潜在敌人不等于本轮发生攻击。普通交谈、可见/已知信息不增人工审批或无依据检定；完整符合原输入的已有作者动作走原候选，缺意图/目标先ask_player。只有实际未覆盖机械事件或具体纠错才提请主持；真实攻击仍不得叙事预判命中/射空/挡下/闪避/撤离。

不新增语义正则门禁、不把缺能力改为自动成功、不转换2014/2024、不升级已有Run。`HarnessExecutionProtocolTests`保留独立v28目录golden；`StoryIntentContextTests`验证旧帧字节、纯读与真实Pi/fake普通对话零裁定/零facts。脚本模型只证明路径与指令确实到达，不证明真实供应商能消除全部误判。

## 显式剧本库与原图导入

1. **范围/签名**：`AdventureLibrary.Load`、`GameService.ActivateLibrary`、`MapCatalog.Import`；HTTP和本机包字段统一归[剧本库](../../../docs/adventure-library.md)与[地图](../../../docs/maps.md)。只提供显式选择，不替空房自动套故事。
2. **内容合同**：库摘要绑定manifest/剧本/原样prompt字节及PNG哈希，启用复用首次设定与ChangeContent；旧房不能转换或重置，角色/审核保留。库内原创可随包，商业完整素材仅本机明确安装，不能混进公开默认素材。
3. **地图合同**：原图沿Create→Import→Scenes→Publish原生命周期，ready/attempts0且不预留供应商；固定阶段requestId/expectedVersion。全部文件先校验，全部导入关联后发布玩家图；游戏与地图非跨文件全局事务，失败不伪报成功，残留阶段原回执可恢复。
4. **拒绝**：坏包/PNG/引用拒绝；hash变化library_changed；已开始content_locked；同ID异内容幂等冲突。身份/原回执优先库读取，完成重放不依赖源文件仍在。GM、未发布风格和私有prompt不进入自动生成。
5. **正常/基线**：明确选库一击采用；原手工导入和0..26工具目录不变。未覆盖场景仅按核验为同冒险的公开原图文字风格生成扩展图，已有有效关联玩家图直接复用；图面无迷雾、无校准不测距。
6. **验证**：`AdventureLibraryTests`、`ImportedMapTests`、`adventure-library.test.js`覆盖权限、纯读、坏包零游戏写入、并发、阶段恢复、重启原回执、旧房保护及真实Pi/fake图片风格隔离；实际作者包与真实浏览器另验，fake不证明制图质量。
7. **正误**：错误为重放Create得到v4后改用v4重做原Import、用假生成器导入原图、失败时删除旧图；正确为固定阶段版本和哈希、正式导入回执、保留原图和已提交效果。

## 同任务结果与异步地图衔接（契约47）

1. **范围/签名**：`HarnessCheckService`拥有战外去重，`HarnessMapReadiness.AwaitHarnessMap`拥有Run内等待；实际字段与错误见[运行合同47](../../../docs/harness-runtime.md#单次检定与侦察后开战契约47)。不把战外一次性策略写进所有战斗Search。
2. **持久/语义**：复用PendingRolls/PassiveChecks，确认前再次查本人历史；真实遭遇用稳定ID，普通任务保存真实情境哈希。相关性归DM的reason判断，哈希/字符串不能证明任意语义同任务。旧记录没有的情境不能伪造追溯，也不能把旧hash=null与新hash不同当成变化证据；保守承接原结果，实际新情况须有更新的来源/任务依据。
3. **异步合同**：原地图回执永远保持排队时输出，最终ready仅写原Run步骤；轮询在campaign gate外，无模型、重发或新调度器。MCP请求期限不能短于父执行期限，父端继续拥有取消。
4. **错误**：failed/withheld/unavailable为工具错误；无固定当前图时map_selection_required先指向原map_select且不排图。不要把选图写入与队列保存放在两个库的假原子事务里。授权/版本/IO沿原错误，不吞异常伪造ready。
5. **正常/基线/拒绝**：被动后首次主动允许；换输入/地图不重掷；新相关条件可新尝试。0..46回放冻结。未绑定布局不提供委派，越界调用在回滚后反馈具体缺失，不丢完整行动。
6. **验证**：`EncounterContinuationTests`覆盖跨输入/重启零骰拒绝、合法新条件、被动/豁免与隐私、真实Pi超过60秒等待→同实例绑定→本人先攻，以及失败/取消/重启无重新生图；旧目录用独立已交付DLL的golden。
7. **正误**：错误是只等fake短延迟却遗漏MCP一分钟超时，或把旧图ready当新任务完成；正确是按原receipt锁定指定图、验证真实终态并保留已完成骰点和伤势。

## 地图流程

地图任务只有两个明确入口：主持确认的手工生成，或新冒险契约13的受限 `map_request`。后者由AI按需请求当前PUBLIC场景，复用MapCatalog队列/预算，受控成品自动发布；不能冒用host端点。保存草稿、打开页面、读取快照、场景推进自身不能生图；旧场景生成保持退役。

- 生成、发布是不同操作。主持图不能发布给玩家；未发布玩家图、完整提示词和参考列表保持私有。
- 新图片通过已授权地图端点读取，不复用历史公开 `/assets/` 路径。图片和缓存按战役/席位权限处理。
- 缓存身份包含原提示、尺寸、参考顺序和供应商身份；请求规格与实际图片尺寸分别记录，下载后验证 PNG、哈希与大小。
- 参考图由用户选择，服务端外发开关独立控制；有本地文件不代表同意上传。
- 已经可能发送到供应商的任务不自动重试；重启遇到遗留 `generating` 标失败，未发送的排队任务按当前策略处理。新生成要新确认；租约防旧完成覆盖新任务。

例子：保存地图规格只产生草稿；明确确认后才预留额度并外发；HTTP 超时记录失败而非无条件循环重试。本地幂等不能承诺外部供应商恰好计费一次。

隔离试跑的 `OfflineTrial` 由服务端持久化并在调用入口强制执行，不能靠前端开关假装离线。覆盖来源：[AuthoringTests.cs](../../../tests/DiceRealm.Tests/AuthoringTests.cs)、[ResourceTests.cs](../../../tests/DiceRealm.Tests/ResourceTests.cs)、[AssetTests.cs](../../../tests/DiceRealm.Tests/AssetTests.cs)。

### 逐图比例与局部战术图（契约42）

- **范围/签名**：`MapScale.TacticalGrid`、`SharedBoard.PlacementOn/WithPlacement`、`MapSelectionService` 和新42地图工具共同拥有物理尺度、逐图位置及选择；字段与HTTP唯一归[地图协议](../../../docs/maps.md#逐图尺度与局部战术图工具契约42)。
- **合同**：用途独立于kind和比例；新42遭遇只能从已保存的可靠局部尺度派生五尺逻辑格，禁止仅改distance。图册原比例保留，AI冻结图片、棋盘、测距和吸附须表示相同物理长度。
- **身份/兼容**：同实体跨图保留原HP/资源，只增加明确给定的各图落点；选图本身不传送，pending移动只投影Origin/Destination都属于本图的记录。新增可空字段省略null，旧0..41目录/帧/回执及已冻结战斗恢复不倒灌新条件，GET不批量校准旧图。新普通行动/v42的PendingIntent与开战PendingRoll保存UseCurrentBoardMap=true，确认/重启继承；缺省false保旧语义。
- **拒绝**：unknown/未校准/区域/城镇不能直接进入新战术布局；非当前场景、未发布或版本过期的选择拒绝。MapCatalog统一解析实际View.Status=ready的当前图；非战斗失效选择回退最新合格图，活动战斗锁原图且失效不回退。新开战读解析后图的PlacementOn，缺图/站位分别报board_combat_map_required/board_combat_placement_required。自动图按场景+用途去重，原请求回执优先，不因城镇ready阻止局部图，也不因失败重排计费。
- **例子**：100px/10ft派生50px/5ft，原100px仍10ft；没有可靠比例保持未知。补局部示意图在成品实际尺寸上保存本场DM范围，不能继承风格参考比例或假称原资料。
- **验证**：`MapScaleTests/MapScaleHarnessTests`覆盖比例、同实例分图、HTTP权限/双版本/重启、实际Pi选图及成品尺寸；`HarnessExecutionProtocolTests`比较独立v41黄金。工作台两点校准和Unity真实头像交互另验。
- **正误**：错误为把城镇distance从50改为5、复制旧归一坐标或客户端默认尺度；正确为逐图保存依据、同物理比例细分、按原实例给局部落点。

### 补图依据与来源

1. **范围/签名**：`HarnessMaps.PublicSpecification` / `MapCatalog.RequestAutomatic`，旧13—41模型只给kind；新42用途与范围沿上节，旧工具目录冻结。`MapGenerationBasis`仅在host Specification保存；玩家`MapProvenance`只含kind/referenceMode/layout，完整字段见[地图](../../../docs/maps.md)。
2. **合同**：当前作者变体+公开preparation/dm/host地点记录与合法出口；按场景分页而非快照截断后筛选，动态场景沿WorldAtlas.Places.MemoryId核验源记录。模型prose不自行升级成地理；目的地只取公开标题，不含尚未到达正文/隐藏出口/私有负向细节。
3. **来源**：新库安装把`MapLibrarySource`作为内部参数落记录，不进Create请求指纹。旧记录只按同冒险文档hash、确定性安装ID、PNG hash和作者风格核验；查不到或无关坏包不给参考资格，不阻断无参考生图。源图须已发布player；实际仅description，不宣称上传PNG。
4. **校验/错误**：客户端自填GenerationBasis/StyleReference拒绝；新字段可空并忽略null，旧图/回执仍可读。正常库启用对坏包继续严格拒绝；可选风格发现才跳过无法核验的包。
5. **兼容/显示**：扩展示意身份与比例校准分开，默认none+uncalibrated，不把Distance默认5显示为可信尺度。校准不改变生成身份；公共摘要不含源图URL/完整prompt。棋盘图片沿同版capture/renderer进入下次模型请求，Notice说明布局来源，不额外付费通知。
6. **验证**：AutomaticMapTests公开哨兵/分页/动态源/冻结依据，ImportedMapTests同冒险风格版本hash与零PNG参考，AdventureLibraryTests旧阶段恢复、旧原图零改写、无关坏包降级，Unity CartographyTests与工作台map-reader测试标注独立于校准；真实PNG质量需另看图。
7. **正误**：错误是从model记录或同战役标题猜地理、把文字风格说成看过原图、改旧Create payload回填来源；正确是在行为所有者过滤并冻结证据、nullable元数据与独立安全投影。

### 当前场景地图状态（契约22）

1. **范围/签名**：`MapCatalog.SceneStatus`、`MapLibraryView.Status`与`HarnessExecutionFrame.Map`共用`SceneMapStatus(sceneId,status,generationEnabled)`白名单；完整协议归[地图](../../../docs/maps.md)与[运行说明](../../../docs/harness-runtime.md#当前场景地图状态契约22)。
2. **合同**：状态只含公开当前sceneId、封闭status和启用布尔；公开有效手工图优先ready。地图列表与状态同锁读取，GET不排队、不落库、不调用供应商；关闭配置仍可读已发布图，未发布ID/提示词/参考不外泄。
3. **模型**：新model槽位追加map帧，仅missing且generationEnabled提供`map_request`。描述要求空间探索确有需要时主动按需制图，不等待玩家索要，也不每个场景无条件生成。pending/ready/failed/withheld不重复请求。
4. **执行**：v22在真正`RequestAutomatic`前重查同一状态，未提供的工具不能由完整目录绕过；不满足返回原refreshRequired、零排队。已提交原回执在新状态门禁之前恢复，避免ready后旧pending回执失效。
5. **兼容/错误**：工具22与帧contract15独立；0..21目录、旧帧和回执冻结。新map缺失、额外私密键、无效状态或隐藏scene拒为坏Run并保留文件，不迁移旧行动。
6. **回归**：`SceneMapStatusTests`、`AutomaticMapTests`与`HarnessExecutionProtocolTests`覆盖纯读SQLite不变、状态矩阵、执行绕过、真实Pi+脚本模型/fake图片、重启回放和0..21golden。脚本模型通过不能声称真实模型自主判断或制图质量通过。
7. **正误**：错误为只改prompt而不提供安全状态、客户端开地图就生图或猜文字模型充当图片供应商；正确为服务器白名单、执行复核、独立显式配置和唯一图片生命周期。

### 物品元信息与携带容量只读投影

1. **范围/签名**：`InventoryWeight.Project(Character,ContentItem[]?)`和`CharacterRuleDetails.Project/Enrich`共用`ItemMetadata.Find(itemId,rulesId)`；只增GET sheet读字段，不改数据库、命令或Harness旧帧。
2. **合同**：单件numeric重量/价格与封闭rarity由同pin/sourceHash审核生成；无正文、无定价推断。总重只乘正库存数量，套装不展开、装备不重复计、离包同调不计总重；库存显式身份优先，包括未知/空串，不回退名字或runtime ID。容量由服务端当前`strength`（小写协议名）与明确体型按XPHB362表计算；`Powerful Build`按大一级体型，S→M不是翻倍。
3. **字段/来源**：在原DTO尾部追加hasWeight/hasPrice和hasCapacity等有效标记，完整wire、来源与显示唯一归[负重及物品元信息契约](../../../docs/client-contract.md#carried-inventory-weight)。未知不是0；价格用decimal cp，可保留弹丸0.2cp，不能受建卡整数购置目录的Price=null抹除。
4. **错误/兼容**：旧响应标记false保持未知；缺/坏正文包仍返回已核元信息与真实notice，超长正文不截断、数值不丢。缺有效力量/体型或越出已核表只给未知容量；不增加超重惩罚或游戏写入。
5. **例**：正常为精确药水ID返回单件0.5磅而数量4计2磅；基线为无新字段按旧文本读；拒绝为名叫Potion of Healing的自定义物被猜成魔法物品，或按稀有度生成售价。
6. **回归**：`InventoryWeightTests`覆盖六体型/强健体魄、真实建卡力量字段、同源重量、coin与fractional cp、身份优先、纯读授权HTTP及SQLite字节不变；`CharacterRuleDetailsTests`覆盖缺/坏/超长正文、缺库存同调和真实维护包。生成器`--check`核同pin输出且不改原全文。
7. **正误**：错误为Unity从中文正文拆价格或计算容量；正确为Domain共同数值来源，客户端只按typed facts画角标与比例。不把元信息读取当作能力取得或执行授权。

### 角色公开规则引用

1. **范围**：双端能力完整正文和来源分组复用 `CharacterRuleDetails`，不建立第二份全文JS或客户端推导规则。
2. **签名**：`GET characters/{actorId}/references` 与 `CharacterRuleDetails.References`；完整字段归[角色规则引用](../../../docs/client-contract.md#character-rule-references)。
3. **合同**：授权 CampaignStore 纯读内选同战役未撤销角色，返回固定规则，不改 ActingActorId，不返回私人build/角色对象/命令；遵守原Party公共资料可读范围，不新增host-only门槛。
4. **错误/兼容**：无角色/未知/撤销目标404，调用者鉴权沿原路径；坏规则包给notice与空正文，不猜。group/category尾部兼容缺省空串，无存储迁移。
5. **例**：队友“机智”与本人sheet同源全文；旧字段缺失归其他/未分类；同名自定义物不得获得目录分类。
6. **回归**：`CharacterRuleDetailsTests` 覆盖host/self/peer、跨战役/撤销/空主持、精确响应字段和SQLite零写、真实维护包同源正文；客户端检查index、来源变化、回填和生命周期。
7. **正误**：错误为获取他人self sheet后只在DOM隐藏私密信息；正确为服务器只投影公开固定规则及当前身份。

### 装备套装原子拆开

1. **范围/签名**：`EquipmentPacks.View/Apply`拥有候选和同一拆包计划；原GET sheet与POST character/commands新增字段/操作，完整wire与错误矩阵唯一见[套装契约](../../../docs/client-contract.md#equipment-packs)。不增加端点、数据库迁移或Harness工具版本。
2. **来源**：七种具名装备套装由`build_character_reference.equipment_packs`核同pin/sourceHash与精确child ID/正数量生成；不从中文说明、2014记忆或弹药bundle猜内容。MCP无法查到时保留失败证据，不能把本地补充称作MCP成功。
3. **事务**：本人库存身份沿`ItemMetadata.Find`优先显式RulesId；当前库存/内容冲突先在局部计划验证，整个变更才交原命令事务保存。只减一包、全部入库存，保留既有合并项的Name/Equipped/RulesId，特殊不同ID实例不吞并。
4. **边界/兼容**：旧库存只读不展开；旧sheet无packs不造操作。命令接受省略/null/空choices，只拒非空附加选择；原回执指纹不能因新操作改变。400项/9999及身份冲突失败无半写，原权限/版本/可用性门禁继续适用，不额外审批。
5. **计重**：拆包后由实际库存重新投影；套装标重与已知child合计可能不同。窃贼子物已知42磅、铃铛与10蜡烛未知，不能硬凑47.5或把未知变0。
6. **回归**：`EquipmentPackTests`与生成器测试覆盖七包、多份、合并、别名/显式来源、冲突/边界、纯读、权限、并发同请求、回滚与重启；Unity `EquipmentPackUiTests`覆盖原按钮提交、失效、旧DTO与quiet；真实Player补实际HTTP取出及丢响应恢复。
7. **正误**：错误为UI删除套装后自行添加物品、把查看当执行、给所有背包做通用容器框架；正确为服务端单份原子计划和原提交/恢复入口。

## 明确输入的准备供应商

[OpenAiPreparation](../../../server/DiceRealm.Server/Infrastructure/PreparationGeneration.cs) 是独立目的入口：只外发本次明确提交的 source/intent 和原样 preparation prompt，不复用游玩提示词、不扩展普通上下文。完整 HTTP body（含系统原文、模型字段、JSON转义）在预算预留前限制128KiB；供应商与离线inspect均严格拒绝重复、大小写、额外/缺失字段。逐字来源核对不能证明语义忠实，UI必须说明。准备记录先于可能外发保存，不承诺外部恰好计费一次；超时/无效输出不回显供应商私密正文。协议、配置与评估授权见 [输入式准备](../../../docs/input-preparation.md)。


## Harness 集成

新Harness战役使用 `agent-host/` 的真实Pi SDK/MCP循环，父进程拥有模型外发和领域权限；不用通用shell/file工具，不继承开发者凭证、全局Skill/extension。原样preset通过显式system钩子固定，并在每次模型回调核对；MCP schema对象键重排可以规范化，数组/值/原文不能改变。Pi SDK自动retry/compaction/cache-warming保持关闭；父供应商适配器可配置的有限重试经过同一持久预算入口，见下述专节。旧`rules_scope`保持原元数据；契约4新增显式本地中文查读，不是远程D&D MCP，也不冒充全库或全部自动结算。协议与必需回归见 [Harness契约](../contracts.md#12-harness新战役工具回执与明确恢复) 和 [使用文档](../../../docs/harness-runtime.md)。

外发前拒绝的阶段证明由受信 `IHarnessModel` 适配器产生，使用 `HarnessModelNotSentException` 的封闭原因，不把任意 `GameException`/HTTP状态或响应正文转换成未发送。协调器只将证明绑定到发生拒绝的当前模型槽位，保留审计，不扩散到其他未完成步骤；发送后的错误与没有证明的取消仍保守未知。代码和回归见 [HarnessModel](../../../server/DiceRealm.Server/Infrastructure/HarnessModel.cs)、[HarnessBudgetTests](../../../tests/DiceRealm.Tests/HarnessBudgetTests.cs)，完整矩阵只维护在 [运行文档](../../../docs/harness-runtime.md#模型拒绝与未知结果)。

Pi同批工具的`terminate`是“全部结果同意停止”，不能单靠最后工具返回`stop:true`结束混合批次。`HostSessionOptions.shouldStop`只读取`RunExecution`现有停止状态，包装公开`agent.finishTurn`时先await原边界钩子，再返回`{action:"end"}`；保留真实assistant/全部工具结果和被阻断兄弟项，不伪造完成消息、不放宽父端已完成门禁。次轮在原`#beginTurn`清状态。回归必须含读(false)→完成(true)→阻断、最后轮停止、显式次轮恢复、无stop正常继续及原生回放，见`agent-host/test/host.test.ts`和`HarnessFinalNarrativeTests.RealPiFinalStopsBatchAndSavesOnce`；不允许为规避问题移除同批先读步骤。

### 托管执行进程退出与取消

1. **范围**：修改`PiHarnessRuntime.Execute`、Node进程监护、排队/取消/停服或provider等待时适用；这些属于服务端内核，不成为前端产品概念。
2. **签名**：`Execute(HarnessExecution, Func<HarnessCallback,CancellationToken,Task<JsonElement>>, CancellationToken)`保持不变，wire/schema/HTTP及既有预算不变。
3. **合同**：`PiHarnessRuntime`以4个懒启动常驻worker复用既有active上限，独立战役可并发，同战役和单Run依赖链仍串行；没有新用户开关或额度。空闲池LIFO复用热进程，排队取消不能租用/终止别人的worker。取得worker自己的gate之后，单次执行token同时关联调用方取消和自己child的`Exited`，覆盖订阅前已退出；Send/Receive/callback使用同一生命周期。单次执行finally解绑监听并释放CTS。排队WaitAsync在清理try外，排队取消不能Kill其他席位的活动child。退出只中止当前等待，不自动重发；下一明确任务才可创建健康child。
4. **错误**：child退出导致的取消若已收到半帧则映射`harness_wire_partial`，否则`harness_runtime_eof`；调用方取消保留原分类。stdout直接按LF分原始bytes再严格UTF8解码，不能用StreamReader字符buffer猜帧结束；坏UTF8为`harness_wire_invalid`，具体边界见[wire分帧](../../../docs/harness-agent-wire.md#stdout-字节分帧)。已经started但未保存回复的模型槽位仍`unknown`，保留attempts和已提交效果，不能当作未计费失败。仅进程退出通知与CTS清理竞争允许忽略ObjectDisposedException；取消回调的AggregateException不得逃出进程事件线程终止宿主。
5. **正常/兼容/拒绝**：正常为child退出→provider等待及时停止→释放gate→下一已明确提交的席位任务健康执行。兼容为原回执/旧wire不变。拒绝为轮询重启旧unknown、取消排队任务杀活动child、将前席位上下文带入新执行。
6. **回归**：[HarnessParallelTests](../../../tests/DiceRealm.Tests/HarnessParallelTests.cs)使用真实Pi验证4个独立输入同时进入provider门闩、满池排队取消、取消其中一路不影响其他三路及热复用。[HarnessPiIsolationTests](../../../tests/DiceRealm.Tests/HarnessPiIsolationTests.cs)使用真实Node/Pi/MCP+fake模型验证：同战役第二请求拒绝且0attempt；模型callback期间只杀自己runtime的Process；及时终止等待；下一席位无私有输入；忽略取消的晚provider回复不提交；供应商失败后新任务健康；主动取消/停服杀自己child、被拒请求不外发；重开只读/同IDreplay不补发。该真实进程测试不替代领域提交/journal崩溃窗口的既有回执测试。
7. **错误与正确**：错误是仅取消stdout读取，而await模型callback仍占gate至deadline；或用Task.WhenAny丢弃尚在提交的callback。正确是把child生命周期传入callback，模型所有者通过已有`Complete(...).WaitAsync(ct)`及时结束等待，工具callback仍被观察完成，已提交完整领域回执不丢。供应商忽略取消仍可能继续外发/计费，不承诺外部事务撤销。


### Harness 原生供应商与可搬移运行包

1. **适用范围**：修改Harness供应商选择、HTTP转换、原生续接或包启动。行为所有者是 `HarnessProviderSettings`、`GeminiHarnessModel`/`OpenAiHarnessModel` 与父协调器，不放到前端或Node SDK网络层。完整字段和使用例只维护在[运行指南](../../../docs/harness-runtime.md)。
2. **签名**：`IHarnessModel.Complete(HarnessModelRequest,campaignId,ct)`不变；request的`ProviderHistory`、reply的`ProviderContinuation`只在进程内且`JsonIgnore`。私有`HarnessStep.ProviderContinuation`可选、null省略，与done/result一起原子保存，不改wire1/schema1或既有指纹。配置显式四项`HarnessAi:BaseUrl/ApiKey/Endpoint/Model`；旧完整OpenAI Endpoint仅在无BaseUrl时兼容。
3. **合同**：Gemini原样system、parametersJsonSchema、有序parts及functionResponse；签名可在文本/空文本/函数上，不合并、不移动。新回复 `ParseParts(...,offered:request.Tools)` 只接受本次实际提供的工具，不能用冻结v15的 `HarnessTools.All` 代替；原生历史不套当前工具表，仍用已存调用ID、回复内容/参数及身份校验绑定原parts和签名。父进程只从当前已授权run收集done模型历史，逐项核对公共reply和端点+模型身份后恢复原生parts；不接受Node/HTTP提供元数据，不跨run缓存。thought内容不转为文本/日志/用户投影。每份元数据128KiB、完整run8MiB、完整外发体128KiB；缺usage保守估计，原生输出包含thought tokens。key只放header，鉴权构造也须在Reserve之前验证。安装/运行包独立，关闭继承的provider/Node注入环境，默认模型全关，只显式配置+启用才外发。
4. **拒绝与错误**：配置/地址混用→`harness_model_endpoint`，非法header key→`harness_model_credentials`，原生历史错配/缺失/换端点或模型→`harness_model_contract`，均为受信外发前证据，HTTP/新预留为0；发送之后的截断、坏JSON、工具/usage校验失败仍unknown，不退款。安全诊断只含阶段/数值/字段kind/封闭finish类别/异常类型，禁止异常对象或原生parts。非法容器/重复JSON/不完整finish不能因为兼容null而一并放宽。
5. **正常、兼容、拒绝**：正常为带签名函数回复→保存→本人确认/重开→原回执重建→保留原签名/ID的原生续发；兼容为旧无元数据记录及旧OpenAI URL/指纹可读可重放；拒绝为丢签名降级、换模型强续原run、错误凭证零外发却被当成已计费unknown。旧二进制回退须匹配备份，不能删除新字段以伪装迁移。
6. **必要测试**：[HarnessGeminiTests](../../../tests/DiceRealm.Tests/HarnessGeminiTests.cs)必须覆盖显式URI/header、签名文本/空文本与无原生ID、并行结果、有序parts、JsonIgnore旧JSON、0外发拒绝与发送后未知、真实Pi/fake native下本人零骰→同意一次→重启续接/重放；[HarnessProviderTests](../../../tests/DiceRealm.Tests/HarnessProviderTests.cs)保留null合法、其他容器/重复/length拒绝与日志隐私哨兵。包必须搬到项目外，从包内JS启动实际Pi/MCP并经业务API执行，不能用源码Entry定位冒充独立运行。
7. **错误与正确**：错误：仅把OpenAI URL换成Gemini，或给ToolCall加signature后被SDK归一化丢弃；正确：在协议所有者保留原生分段，在可信父进程中绑定/持久化并恢复。错误：只成功publish就宣称交付；正确：隔离安装生产依赖、保留实际许可/未确认项、默认关闭供应商并通过可搬移运行验证；本地包不等于公开许可或部署。

运行包的日常端口、旧文字供应商兼容、共享额度及接替边界见[运行包接替合同](runtime-packaging.md)。

### 供应商UTF-8、思考与当前槽位重试

1. **范围**：`HarnessProviderJson/Settings/Retry`与两种模型适配器、`ConfiguredHarnessHistorian`、父`HarnessRunService`及包配置。完整配置和错误矩阵唯一归[运行协议](../../../docs/harness-runtime.md#供应商中文思考与有限重试)。
2. **签名**：`HarnessModelRequest.BeforeProviderRetry`为JsonIgnore的可信进程内callback；HTTP/wire/Run schema不变。HarnessAi思考/包含思考/重试次数/初始间隔由启动时快照，默认high/true/3/1000ms。
3. **合同**：UTF8只改外发投影；仅第一个系统input/ruleset/memory封装及tool JSON重新序列化，保留字符串原值、后续用户JSON、签名parts和旧指纹。只在活跃model槽位同正文重试，先取消/授权/版本/Run上限复核并持久增加ModelAttempts，再每次Reserve。失败输出的工具不执行，游戏效果不回滚或重做。历史摘要复用同一`Execute<T>`循环，默认额外3次；捕获配置/URI/body后冻结，首发与每次重试均先授权、再Reserve，每次独立超时与请求日志。`TextProviderProtocol`仍只拥有协议，不增加新的重试配置或假model请求。
4. **错误**：暂态HTTP/传输或坏结构有限重试；非暂态4xx/安全拒绝/截断/超限不重试。取消/时限/额度提前终止；已经发过一次的槽位不能借后来的本地拒绝取得NotSent证明。重启、GET、旧unknown及原回执均不补发。
5. **例**：正常缺candidates→1秒→有效文本→只执行有效回复；兼容四字段provider文件/旧哈希不变；拒绝正则反转义用户文本、重跑整个Run、退款失败外发。
6. **回归**：`HarnessProviderOptionsTests`验证真实请求bytes与内部字符串、字面\u、思考/私有元数据、1/2/4间隔、逐次预算、已写工具恰好一次、真实Pi重启重放、取消/版本/时限/上限；其historian组验证两协议前三次失败（含空候选数组）后成功、正文冻结、逐次授权/计账及401/取消/撤权停止；辅助读取在结构解析前识别Gemini promptFeedback.blockReason、Chat length/content_filter/refusal，禁止把安全拒绝或截断误作坏JSON重试；`HarnessHistoryPipelineTests`验证持续503最多四次后仍保留原文、读档不重发；`package-launcher.mjs`验证默认与typed覆盖、拒错、包内503恢复与账本。
7. **正误**：错误是改全局JsonSerializerOptions或让SDK隐式补发；正确是仅供应商边界投影，父持久尝试与权限门禁拥有每次额外外发。

### Harness 工具契约与重复读取

1. **范围**：修改工具描述/输出、运行回放或自动世界记忆时适用；描述属于模型回调指纹，不能直接改全局目录使旧运行换合同。
2. **签名**：`HarnessTools.ForVersion(int)`返回冻结目录；私有 `HarnessRun.ToolContractVersion`（init）/`ContextReadVersion`（可写）缺省0且省略默认值；新运行使用 `HarnessTools.CurrentVersion`（当前34），旧运行0..33保持各自冻结目录；契约2增加历史召回，契约3增加世界检索与实际对象引用，契约4增加本地中文规则查读，详见后续各节。`HarnessTool(..., frozenProfile, toolContractVersion=0, contextAlreadyRead=false, offeredMemoryIds=null)`给直接/旧调用保留full输出；可选集合用于契约3及以后实际对象引用，后续可信`rulesCatalogVersion`参数绑定本地包。wire1/schema1/公开DTO不变。
3. **合同**：旧1..14先重新授权及检查版本；同run已提供相同候选时actions_list返回version+candidatesUnchanged；完整context已读则context_read返回version+两个unchanged。只读过列表时仍发送完整公开情境，只省候选。任何版本变化和原wait续接（即使版本不变）清OfferedIds与ContextReadVersion，历史回执只原样回放。`WorldMemories.Plan`完成形状/公开引用/已知地点/重复校验后，规范化名称/摘要与status/scene完全相同才跳过自动更新；原revision/provenance/排序不变，叙事/回执仍提交，DM纠错审计不变。
4. **校验与错误**：未知工具版本、负数/超cursor上下文标记或旧契约非零标记→harness_corrupt_run；wait后直接沿用候选→intent_option_unavailable；同批重复ID、隐藏/未提供memory、未知scene仍invalid_world_memory，no-op不跳过校验。
5. **正常/兼容/拒绝**：正常context→list只回unchanged；list→context仍含公开情境。兼容旧记录缺标记用历史description与full输出。拒绝跨run引用、认为unchanged代表空列表、等待后拿同版本历史ID执行。
6. **回归**：[HarnessEfficiencyTests](../../../tests/DiceRealm.Tests/HarnessEfficiencyTests.cs)覆盖真实Pi/MCP+fake重复读取、wait/写失效、重启、旧描述精确回放；no-op保留出处、重复/权限拒绝及HTTP叙事回执重启。体积证据说明比较对象，不把字节差伪称精确token/费用节省。
7. **错误与正确**：错误是在全局All上改描述、无条件跳过“相同”提议；正确是按run版本选择目录，先完整验证后跳过实际无变化的自动记忆。不压缩/重写历史回执，不回退未知结果。

### 普通移动、场景检定与显式段落（契约31–34）

以下数值DC必须出现在引文的要求只属于历史31–34合同；新普通剧情检定按下节v44处理，真实隐匿对抗仍沿其专用入口。

1. **范围**：`HarnessBoardIntent`、`HarnessCheckService`、工具回调与`NarrativeHarnessArgs.PublicText`。详细参数唯一归[运行协议](../../../docs/harness-runtime.md#自然移动场景检定与参数修正契约3134)。
2. **签名**：新`check_request`复用`PendingRoll.SceneCheck`与`rolls/respond`；v34可选DC、world_record.paragraphs。均不增加公开任意状态接口，旧字段缺省兼容。
3. **合同**：移动语义由AIDM判断，服务端绑定本轮本人普通摆位；检定确认前零骰。真实来源引文只证明出处，数值DC还须明确出现，目标适用性不能由数字匹配推定。缺少必要对抗阈值先具体裁定，不先无效掷骰；无DC结果明确hasDc=false。相同任务不换阈值/主动被动重来。标准战斗入口和原版权边界不变。
4. **拒绝**：未知引用/DC不在引文/非法技能/重复任务/角色受限→零游戏写；可修正反馈必须在事务退出后生成。权限、版本、IO不降级。段落混用、空/空白/null、拼接超长、旧版本传入拒绝；不全局反转义。
5. **兼容**：0..33目录独立冻结；旧已保存数值检定继续原结果。段落输入和完成回执必须经同一个PublicText，不能只改提交而让RunStore因字符串形式不同拒绝合法结果。
6. **验证**：`HarnessFlowRepairTests`检查真实Pi恢复/回执一次投掷、段落/字面路径、旧版拒绝及零写、数值来源、被动当前修正和取消重复；`HarnessExecutionProtocolTests`保留0..33黄金。真实模型的目标适用性和查询次数须另有实际请求证据，不能由fake推断。
7. **正误**：错误是场景有伏兵文字便允许任意DC16、拿足迹DC10判伏兵，或叠加五份主持训诫；正确是参数合同在工具、当前缺口分流在workingContext、完整主持流程保留唯一六项检查，system原文不变。

### AI DM自主剧情检定（契约44）

- `HarnessCheckService`拥有触发请求、先验难度、私有规格及去重；复用原PendingRoll和RulesEngine，不建第二个裁定队列。AI按真实行动/环境/NPC事件判断是否需要检定，普通未预写DC不转人工；明显信息不强掷。字段与旧版兼容只维护于[运行协议](../../../docs/harness-runtime.md#ai-dm-自主剧情检定契约44)。
- 来源连续原文只证明出处，reason只记录AI判断依据，两者都不证明新敌人/危险存在。作者适用条件与真实遭遇隐匿结果优先；不能拿普通DC绕过隐藏单位发现权限，不从检定正文写HP/资源/fact。
- 能力和豁免区分资格：`CombatEngine.Restricted`包含Unconscious/Prone，不能整项套到非战斗豁免；请求和确认两端均检查真实战斗状态，豁免状态效果交原规则引擎，死亡/终局与席位限制仍保留。自动失败保存原resolved结果而非等待一次无骰确认。
- 旧DTO/目录/帧投影分别冻结。新字段不能直接添到旧DTO使旧版本接受；新checkType/reason缺失的历史规格按ability且不迁移。新工具能力也须同步到紧凑self.coverage，不能继续声明只有作者候选能执行；仅改新版本，不改旧原文。
- `NarrativeCheckTests`验证真实Pi/HTTP、无关键词输入、自定难度、save修正、昏迷自动失败零骰与非自动失败豁免、同项取消去重、重启/重放及后续叙事失败保留；原flow/encounter及v43黄金保证兼容。fake选择验证执行与指导到达，不当作在线模型语义验收。

### 世界提议修正（契约17）

1. **范围/签名**：`HarnessRunService.Callback`、`HarnessExecutionProtocol.WorldRecordRejected(version,reason)`、v17目录及 `agent-host/host-session`；wire/schema/公开DTO不变，详细结果归[运行协议](../../../docs/harness-runtime.md#世界提议拒绝反馈契约17)。
2. **合同**：只在GameService事务已因异常退出后，将v17 world_record的`invalid_world_memory`转成`IsError=true,Stop=false,applied:false,next:model`；保留版本与引用，保存原工具输出。不得在Access内部吞异常正常返回，否则临时HarnessRoot可能被保存。
3. **拒绝矩阵**：自造ID/未知scene/同名提议继续严格拒绝，由模型重新提议；auth/stale/容量/IO/unknown仍原处理。新对象id必须空字符串，更新只能用已提供同类公开ID，不能自动猜改。旧0..16目录及失败语义冻结。
4. **正常/基线/错误**：正常为拒绝零写→新提议→原子落库；基线为旧Run原输出重放；错误为以HTTP200或工具返回done宣布保存成功、重跑已完成机械动作或自动恢复旧failed。
5. **Pi传播**：SDK忽略execute结果中的isError，使用唯一受控tool_result钩子消费本session中该toolCallId的错误标记；不改变content/stop、不修改SDK依赖。普通成功与历史无错误回放不变。
6. **验证**：`HarnessWorldRecordRecoveryTests`与host真实进程测试检查错误旗标、stop两种状态、拒绝前后SQLite字节一致、修正后世界/活动可读、动作恰好一次、旧16失败、权限/过期引用拒绝及重放重启零额外调用。
7. **正误**：错误是在存储gate里返回“可恢复错误”从而提交部分修改；正确是严格领域异常退出后才投影模型可读反馈。不能用fake loop代替真实Pi验证错误标记。

### 剧情获物（契约18）

完整字段、错误矩阵与兼容只维护在[运行协议](../../../docs/harness-runtime.md#剧情获得物品契约18)。`StoryInventory.Plan`先验证显式items并派生本人库存，`CommitNarrative`在原游戏事务中提交库存、叙事、活动steps/origin及完整工具回执；普通最终正文不发物。目录身份归服务器，自定义剧情记录物不自动获得规则能力；同root真实已获差额去重，不能依赖模型回忆或客户端快照diff防重复。`invalid_story_items`必须等事务异常退出后才转模型可修正反馈。0..17目录冻结，不改旧回执。回归`HarnessInventoryTests`包含真实Pi、guest权限、非法批次与数量冲突零DB写、重复工具/崩溃窗口回执和停用模型重启。

### 本人详细角色投影（契约19）

1. **范围/签名**：`HarnessCharacterContext.Capture(Campaign,int toolContractVersion=19)`、`ReadHarnessExecution(...,ct,toolContractVersion=15)`与可空null省略的`HarnessExecutionFrame.Self`；完整字段归[运行协议](../../../docs/harness-runtime.md#当前行动角色详细事实契约19)。不要修改旧`IntentContexts`来给所有供应商灌入新形状。
2. **合同**：每个新model槽位授权读取本人事实，先随started保存再外发；重开回放用已存帧。工具v19与帧contract15不同，不把Version15整体加一。0..18目录、帧缺省与原回执冻结；当前武器选择候选按v19门控。
3. **隐私/完整性**：显式选择本人属性/资源/库存/法术来源，正常集合完整，不发送Character/Build/Campaign原对象、其他席位身份或隐藏剧情。来源法术路线不能合并成“可施放次数”；派生值复用Domain，不让模型算规则。
4. **拒绝**：新旧self形状混用、非法值/身份/集合→坏Run保留并拒绝；既有128KiB超限→明确外发前失败，不偷偷裁掉清单、加Token门槛或发空数组。
5. **正常/兼容**：首轮即有事实，写后资源/库存与确认后HP刷新；旧18继续省略self且重放不产生外发。
6. **回归**：`HarnessCharacterContextTests`与`HarnessExecutionProtocolTests.ProviderSelfFramesPreserveNativeHistoryAndCompaction`覆盖实际Pi、假双供应商HTTP、隐私哨兵、原生续接、压缩、坏文件保留和修改前v18golden。
7. **正误**：错误为只在context_read里加字段并要求模型主动查；正确为每次实际供应商请求自动追加本人只读投影，不能把投影当执行授权。

v20增量：Capture须传运行冻结toolContractVersion，self.loadout与新装备候选只给>=20；v19 self与0..19目录保持改前golden。不能通过全局新字段倒灌旧回放，不能把帧contract15同步升号。字段与回归归[显式装备组合](../../../docs/harness-runtime.md#显式装备组合契约20)。

### 按需历史召回

1. **范围**：模型访问超过近期12条的本人公开行动，行为所有者为Application的`HarnessRecall`，详细字段仅维护在[历史召回协议](../../../docs/harness-workspace.md#按需历史召回工具契约2)。无HTTP/DB/前端新增模式。
2. **签名**：工具契约2新增`memory_search(query,before=0,limit=6)`与`memory_read(intentId)`；在已授权GameService.HarnessTool内调用。`HarnessTools.ForVersion`、模型回复/callback和RunStore.ToolName均按冻结版本校验；0/1目录指纹不变。
3. **合同**：与HarnessMemories共用本人+harness来源+published+完成结果资格，主持无旁路。检索完整文本后再投影，当前公开更正替换可检索叙事；只取原步骤DiceCheck，不发更正理由/私有运行/其他席位。分页降序root，字节缩页仍可推进；read声明totalSteps，不把有界步骤当全集。零游戏写入/供应商调用/候选授权，仍受既有工具和上下文限额。工具输出首次落盘后冻结回放，不重写初始MemorySnapshot/Turns。
4. **错误**：形状/长度/游标/limit/UUID错误→harness_invalid_payload；他人/私有/未结算/取消/不存在ID统一harness_memory_unavailable；撤权unauthorized；外部版本变化stale_version；越界context_limit，不自动总结/重试。旧版新工具模型输出仍按已经外发的未知处理，不转为未发送。
5. **正常/兼容/拒绝**：正常找到第1条旧线索→按ID读来源→等待/重开恢复同一输出。兼容旧0/1真实Pi恢复。拒绝用查询参数actor指定他人、按当前All校验旧运行、让召回ID成为合法行动ID。
6. **回归**：`HarnessRecallTests`断言35条分页/字节、摘要外中文词、大小写AND、公开更正不抹骰点、本人/跨战役/撤权、坏输入零DB变化与零骰；真实业务API/Pi/MCP的15条回忆及旧v1重启。近期投影提取仍跑HarnessWorkspace/Boundary回归，fake不证明真实语言质量。
7. **错误与正确**：错误：裁剪成12条后再搜索，或用主持可见World/Event投影拼成模型历史。正确：先用统一资格筛全历史，检索后有界投影，按当前已授权版本读取且保存原回执。

### 世界检索与对象引用

1. **范围**：世界记忆超过context32条后的查找/更新；`HarnessWorldSearch`拥有公开查询，`HarnessRunService`拥有实际读取引用，原`WorldMemories.Plan/Apply`仍拥有非机械验证与提交。详细字段仅维护在[契约3协议](../../../docs/harness-runtime.md#公开世界检索与更新引用契约3)。
2. **签名**：v3 `world_search(query,kind="",offset=0,limit=6)`；私有Run/Outcome可空`OfferedMemoryIds`且null省略；`HarnessTool`受信可选参数传集合，模型/HTTP不能自填。旧0/1/2目录、Outcome缺省和回放冻结，wire/schema/公开DTO不变。
3. **合同**：先WorldMemories.Public再匹配/排序/分页，主持无旁路，公开对象跨作者共享；同UpdatedSequence以ID tie-break。只将实际context_read或返回页ID加入本Run引用，与OfferedIds独立。v3不把未读top32自动授权；任意写/等待续接清引用，done步骤不重新授旧引用，纯中断同版本保留。领域cursor约束对象revision，Plan仍完整验证公共性/同kind/名称/场景/批量原子。检索不扩大当前64条knownScenes、行动或机械权限。
4. **错误**：参数坏→harness_invalid_payload；未提供/过期/非法对象引用→invalid_world_memory且整批零写入；外部改动stale_version；撤权unauthorized；存档未知版本/旧版带引用/非法重复超限集合/非读取步骤带引用→harness_corrupt_run保留文件。查询空不保证同名创建可用，不回显隐藏对象或主持理由。
5. **正常/兼容/拒绝**：正常查旧NPC→改同一ID→新修订保留origin；无变化更新保留provenance。兼容旧v2自动上下文规则。拒绝从历史召回/快照/其他Run借ID、wait后旧查询回放重授、仅改expectedVersion使用旧数据。
6. **回归**：HarnessWorldSearchTests必须覆盖字节分页/同序号、host/hidden/arrival/跨作者公共、实际读取引用和失效、原子批量失败、零骰/资源/路线、真实业务Pi/MCP重开、纯读中断/领域已提交而日志未写窗口及旧v2冻结；context_read→world_search→actions_propose仍可使用原合法候选，但世界对象ID不能作为行动ID。存档元数据不等同Node wire或用户投影，不得扩大可写参数。
7. **错误与正确**：错误：保存旧查询结果后每次replay都把ID加回集合，或在写时重新把top32自动视作已读。正确：只有新执行的读取授引用，状态/执行段变化清除，回放只返回原内容；写回仍在已授权gate通过原Domain。


### 本地中文数据包与只读规则工具

1. **范围**：修改`LocalRulesCatalog`、`HarnessRules`、规则包发布/绑定或离线维护器时适用；原始证据/翻译属于`scripts/local_rules`，读取/授权属于现有Application gate，角色资格/结算仍归Domain。
2. **签名**：契约4 `rules_search(query,category="",offset=0,limit=6)` / `rules_read(id,offset=0,limit=4000)`；`LocalRules:Directory`显式配置；私有Run可空init `RulesCatalogVersion`、null省略。完整参数/响应/错误只维护在[运行文档](../../../docs/harness-runtime.md#本地中文规则查读契约4)，不新增公开HTTP或wire/schema版本。
3. **合同**：固定本地包bytesSHA256、schema1、当前审核revision、13类完整counts键集合；实际来源和中文覆盖分别记录，当前任一complete=true拒绝，未来启用须先有独立完整源pin。原始definition/hash与中文单元分离，数字/骰式/条件/表格不得裁掉。先有界严格读取、校验原始manifest/pin/精确文件集合，未知结构留缺口；不可变文件采用原子create-no-replace，只有active可原子切换。新Run捕获hash，未done读固定旧包，done只回放Result。旧0..3目录/描述冻结。读不写游戏、不授OfferedIds/OfferedMemoryIds，不即时联网/翻译或英语回退。
4. **校验/错误**：缺配置/原包→rules_catalog_unavailable；hash/JSON/schema/revision/计数/自报完整错误→rules_catalog_corrupt；坏参数/UTF16边界→harness_invalid_payload；无条目→rules_entry_unavailable；权限和cursor沿原拒绝。坏资料/旧记录保留，不自动重新签名或切新版。机械泄漏/数值检查不等于完整语义校审或human-reviewed。
5. **正常/兼容/拒绝**：正常为中文名搜索→按稳定ID完整分页→active换新版后旧Run仍读原文；兼容为旧0..3运行不升级且done在原包消失后仍原样回放；拒绝为只译名字就标全文完成、用任意hex revision伪装已审核源、缺分类counts隐藏缺口、拿规则ID施法或修订世界、同名新包覆盖旧原文。
6. **必需验证**：Python真实raw+明确LOCAL_RULES_ARCHIVE不得静默skip来源审核，测试源改动/重复JSON/未知结构/单位与列表表格/原子发布竞争/有界读；`HarnessRulesTests`测试旧目录hash、权限零DB变化/零骰、UTF16完整分页/字节缩页、等待与重开绑定/缺旧包。显式`--local-rules <绝对dist目录>`再以实际维护包逐条分页并经真实Pi/MCP+fake查询火球术，不将商业全文嵌入常规测试。双端定向测试隐藏书籍出处但保留能力来源/成本。
7. **错误与正确**：错误：看到820个中文名就宣称全汉化，或将当前active用于恢复旧运行。正确：逐类区分源完整、正文结构支持和翻译状态；绑定不可变版本并保存原输出。错误：为修stdout停滞增加timeout或重试。正确：协议所有者按原始bytes分帧，真实分片/多帧/半帧退出与连续业务回归证明修复。

离线分类渲染扩展须遵守以下可测试合同：`RenderContext.from_entities(entities)`只接调用者已验证raw的实体，快照目录与不可变`ReferenceIndex`显式传入`render.build_nodes(entity, context=...)`。所有待译单元、结构/未知键检查和正文使用同一分派；角色内嵌武器通过同一上下文的物品树，不另猜统计。缺上下文/同ID不同definition/错源/歧义拒绝，不能从可变library或模块全局索引回退。`Node(kind="field", text=中文前缀, source=原文, translatable=True)`将标签绑定到本节点，嵌套/变体不靠key猜含义；固定中文标题不用索取译文。纯统计装备/怪物须分类树验证，name-only记录不放行。原始别名只作内部检索，来源按sourceHash绑定，不能放宽显示名/正文中文门禁。

独立发布资格由离线 `eligibility.exclusion_reason(Entity)` 统一判定：仅审核过的纯身份／展示元数据索引及未绑定物品参数模板标为 `excluded`，不按名称关键词、正文长度或执行支持过滤。保留原始 Entity、sourceHash、译文及完整 `RenderContext`，具体物品仍展开模板。维护投影／报告区分排除与真正待补源／译文；运行schema1的sourceCount仍计全部源，用 `excluded:category` 区分 `translation:category`，不能缩小分母伪造全量。包构建独立检查资格，单改translated状态不能绕过；新增正文／未知字段交正常结构检查，不能继承旧排除结论。回归 test_eligibility.py 与 test_end_to_end.py 覆盖精确源集合、未知字段、状态绕过、短规则／统计条目和模板展开。

中文门禁不得靠删信息通过：`chinese.problems`允许已核`3..12位数字-单个大写字母`标签（如`331422-W`），仍拒裸字母、多字母/小写后缀及英文自然句；不能把整个字母加入全局豁免。Loading与Reload有不同规则身份，分别使用装填与重装，武器Versatile的多用不适用于所有同名职业/物种特性。数字/中文门禁无法发现回合所有者、总环阶、全掩护或穿戴/持用差异，必须按原文定向语义复核；重复叶子的修订以完整源文本相等为证据，候选修订绑定ID/key/source与before/after，保留作者原稿。检索别名用于已核同一实体的译名差异，不能让显示名继续误指另一类实体；更新包前审计旧条目差异并保留不可变旧包。

角色的 `additionalSpells` 同样是关联索引，不能让生成摘要盖过正文：`ability=inherit` 不等于随职业（如触碰类与心灵类专长使用本专长提升的属性）；`innate.daily` 次数桶不证明按自然日恢复（当前部分正文明确长休后恢复）。保留各法术／本组次数、关联名称与筛选条件，但生成段明确选择、资格、费用、恢复从属于完整正文；多个分组不表示全部同时获得。检查译文时同时读最终合成文本，不能只审叶子译文，也不能把错误的生成标签断言当正确性证据。回归 test_render_context.py 的真实专长用例及 `HarnessRulesTests.RealMaintainedPackage`，更新包审计只允许已核生成文本变化，raw、译文叶子key/source和旧包不改。

资源/效果索引不是规则正文：`charges=6`可能是星辰法袍6颗星，`charges=1`可能是发条护符每日次数；`bonusAc`也可能仅对特定攻击有效。保留原始审计值，以完整正文/可验证变体展示条件和资源，不按字段名生成统一充能或无条件加值。`attachedSpells`的`#N`是施放环阶，不能混入来源身份。前提OR/AND、`1e`每法术各次、filter DSL与preserve消耗须结构化解析，未知形状阻断。回归依据：上下文、角色、物品、怪物；同时核对既有已发布正文不变，机械测试不等于逐条语义认证。


### 角色详情的精确规则归属

1. **范围/签名**：`CharacterRuleDetails.Project/Enrich`是角色阅读投影的唯一服务端所有者，接收可选`ContentItem[]`由`CharacterPlayService.CharacterSheet`传入当前冒险Items；公开DTO、规则结算与存档不变。
2. **物品合同**：剧情物品的明确`RulesId`优先，按equipment/magic_item稳定ID精确读；兼容既有source:slug格式。显式ID未知不退到基础装备、更不按可编辑名称猜；没有RulesId才按`PlayCatalog.Equipment`及既有套装别名读。
3. **能力合同**：先按已取得的专长/可选能力ID，职业/子职业按本角色来源与等级限定，同名多职业分段注明来源。普通同名feat须有取得证据，不把class ASI与feat ASI合并。相同原始语义树的成长行可去重，不按最高等级删除基能力，也不按相似中文裁句。
4. **物种与错误**：生成器从已验证原始AST子树产生`character-rule-sections.json`（嵌入`DiceRealm.RuleSections.json`），存路径、精确正文hash及UTF-16范围，不再嵌入另一份商业全文。按真实lineage/ancestry选替换节点，保留本节点的子段和表格。hash变化或找不到精确节点返回notice，禁止退到整物种正文。`featureBodies`同样绑定sourceHash，只标同职业/子职业相同语义树。
5. **正例/基线/反例**：人类Resourceful只读其激励能力；卓尔Darkvision读120尺不夹60尺或其他血系；治疗药水按剧情明确规则ID读取。未匹配仍可查看已有记录与缺口，不用不相关全文掩盖缺失。
6. **验证**：`CharacterRuleDetailsTests`覆盖取得身份、来源、腐坏包和真实HTTP；`--local-rules <绝对目录>`用实际维护包覆盖10物种、已选血系、跨职业、重复成长、物品override/未知显式ID及hash撤回。生成器`--check`与`scripts.tests.test_character_reference`检查可重建索引/UTF-16边界。阅读测试必须证明零游戏修改/零模型请求。
7. **正误**：错误是canonical名全类别联查、按中文标题猜切片或把整物种作为单能力fallback；正确是可信身份/取得上下文与原始树定位，完整保留属于该条目的内容，无法确定时明确缺口。

### 长期记忆与父进程上下文派生

1. **范围**：新增语义检索、摘要、上下文压缩或修改原生续接时，所有者为`HarnessLongMemory`/`HarnessContextCompactor`及Run协调器。完整协议只在[长期记忆](../../../docs/harness-long-memory.md)。
2. **签名**：契约5`memory_semantic_search(query,offset=0,limit=6)`/`memory_digest(before=0,limit=8)`；`HarnessMemory.Archive`、`HarnessStep.ContextPlan`可空并省略。wire1可选`contextPolicy=parent-compact-v1`；受信`HarnessModelRequest.PriorProviderIdentities`JsonIgnore，不接受Node/HTTP元数据。
3. **合同**：先本人+PUBLIC+完成资格/当前纠正再派生。local-concept-lexical-v1明确为有限本地概念匹配，非通用embedding；摘要保留原句和引用，不生成权威状态，无额外模型费。压缩只影响新模型槽位，保留全部用户目标/答案/确认结果，按完整assistant+tool组截取；原Turns/Steps/回执/原生parts不改。新的started前存contextPlan，清context/candidate/world引用以避免unchanged引用被省略的上下文。原生身份跨被省略的历史仍校验，不能借压缩换模型。旧0..4保持原路径。
4. **错误**：查询形状/游标坏→harness_invalid_payload；错组→harness_model_contract；不可分割内容仍过大→harness_context_limit且零外发；已started未知仍unknown不重发；坏contextPlan/旧版带archive→harness_corrupt_run保留原件。
5. **例**：正常“口令”找回原文“暗号”，再按intentId读完整原记录；兼容旧v4不带新wire字段且目录hash冻结；拒绝从其他席位摘要或全省略native历史后换供应商。
6. **验证**：HarnessLongMemoryTests覆盖1200记录分页/改述/更正/私密/UTF-8、真实Pi大回调/重新full context/重开原回执、unknown/腐坏；HarnessGeminiTests.CompactionNativeHistory核对保留native有序parts及无历史时身份仍拒绝。DICEREALM_TEST_AGENT_HOST_PATH仅测试夹具可指定隔离编译入口，不扩展产品配置或自动寻找文件。
7. **正误**：错误是删除旧Steps后继续SDK，或摘要后继续发contextUnchanged却没有原上下文；正确是保留完整日志和callback指纹，仅派生新provider请求并重新授予当前引用。JSON字符串中的中文须解析后断言，不用Contains判定未解码的Unicode转义文本。

探索可执行自我效果与当前root已核检定后果已通过v8候选分支接线；旧0..7不新增这些候选。机械身份、本人确认、规则来源与拒绝合同见[natural-effects](natural-effects.md)，不是将旧施法记录case悄然升级。

契约v20保留0..19目录；v20在本人事实中加入显式装备槽/握持与候选，v19自动附带本人详细角色事实，见[装备增量](../../../docs/harness-runtime.md#显式装备组合契约20)；v18的剧情获物见[运行协议](../../../docs/harness-runtime.md#剧情获得物品契约18)，v15的父端执行帧见下节，v14将地图缺情境反馈限定为可恢复且无副作用的工具结果，v13增加按需自动地图，v12保留日常自动执行边界；v11 增加本人长休来源重选候选与确认边界，见[休息来源选择](rest-source-choice.md)。标准战斗公共战场与扩展候选仍从 v10 开始，v9 原公共投影和候选族保持；新反应/专注/区域实际流程与来源限制见[标准战斗规范](standard-combat.md)。完整本地固定来源由独立脚本验证，未实现的精通/触发/材料不能从工具叙事补执行。

### 自动地图的受限用途与原回执

`HarnessMaps`只用当前公开场景及本地点PUBLIC记录构造图，不使用全IntentContext或模型自由prompt。`AutomaticMaps`拥有每场景去重、actor+commandId完整回执与状态同次Save；旧工具目录冻结。AutoPublish只在受控player用途且未标定时生效，手工维护清除它，失败/中断不自动重排。所有加载路径验证AutomaticSceneId/回执身份/响应形状，坏文件保留拒绝。`MapGrid.Uncalibrated`缺省false并省略以保护旧JSON；自动新图true，双端测距函数与按钮均拒绝，不能用grid.type=none推断是否有比例尺。详细字段只维护在[地图协议](../../../docs/maps.md)，回归[AutomaticMapTests](../../../tests/DiceRealm.Tests/AutomaticMapTests.cs)、`CartographyTests`及`maps.test.js`。

地图缺情境恢复只属于v14 `map_request`，不能把全部工具异常降级。先做原权限/版本/参数校验，反馈不排图、不授权引用；只有新的 `context_read` 才可恢复。不要依赖Pi custom tool的 `isError` 传输标志表达必需业务分支，断言模型实际收到的结构化status/code/nextTool。测试覆盖一次观察、缺读零生图、重读一次生图、旧13拒绝与原目录hash。详细协议见[地图情境刷新](../../../docs/harness-runtime.md#地图情境刷新契约14)。

### 父端执行协议（v15）

`HarnessExecutionProtocol`拥有短工具目录投影/状态结果，`HarnessExecutionService`在既有GameService授权只读gate内生成帧，`HarnessRunService`在新模型槽位持久并授引用，RunStore严格读取；完整字段只维护在[运行协议](../../../docs/harness-runtime.md#父端执行帧与短工具协议契约15)。不新增可写HTTP或模型自报权限。

工具description保持用途/参数及权限；完整主持流程由下述v30固定检查单拥有，不复制到各工具description。每次新model自动提供当前PUBLIC帧和候选enum，context/list为可选full读取。game write/wait清引用，同批缺帧的受保护写入返回applied=false且无DB/地图变化；原权限/版本/领域参数与原回执顺序仍有效。下一model重新提供帧不等于自动重做被拒工具；Stop仍阻断后续工具。

### 每次调用的完整主持合同（v30）

1. **范围**：修改`HarnessDmChecklist`、执行帧和provider投影时。完整字段和正文归[运行协议](../../../docs/harness-runtime.md#完整主持操作合同与行动进度契约30)及源码唯一维护，不能再复制多份提示。
2. **签名**：`HarnessExecutionFrame.DmChecklist`为私有可空字段，null省略；v30新运行必需，旧0..29不得携带。工具目录不新增能力，frame contract仍15，wire/schema/HTTP不变。
3. **合同**：每次新模型槽位完整提供六项条件/入口/禁宣告结果，包括工具后与确认后续轮；在授权gate内按本次intent+actor捕获权威steps/pending/rulings，父补已持久工具回执元数据。不能把done/applied当行动成功、旧wait当当前等待、空步骤当无需检定，不能生成没有来源的“剩余行动计划”。主持投掷按RulingId关联，真实结果保留在独立rulings而不伪造步骤。
4. **校验/错误**：错正文、缺字段、跨版本/席位/intent或未来序号拒绝坏Run并保留；外发大小沿原限制，不为容纳提示擅加预算或静默裁掉职责。当前帧随started保存，重试body冻结，done回放不外发。
5. **正常/兼容/拒绝**：正常为移动回执后继续剩余观察，确认后承接原骰点；兼容为v29请求无该字段且原目录hash不变；拒绝为把固定合同写入SDK历史、摘要、工具结果或改用户system，导致多版累积或原生签名失效。
6. **验证**：`HarnessDmChecklistTests`真实Pi+fake覆盖读/写/拒绝/同版本答复/骰子及主持转投掷/重启/私密哨兵；`HarnessExecutionProtocolTests.ProviderDmChecklistFramesPreserveNativeHistoryAndCompaction`检查双供应商实际body和v29基线；原生部件/用户输入/系统原文不变。fake只证明接入，不证明真实模型质量。
7. **正误**：错误为检查单只剩“移动/骰子”或每轮强制执行六项；正确为每次完整检查、只执行适用部分、承接真实回执。正文不创造未执行的位置、判定、战斗或权限。

帧在供应商边界追加结构化user消息，不改变system原文/SDK transcript/原生parts。先压缩清旧引用，再授本次真实提供的有界ID；外发前与started一同持久。旧done不得用旧帧重新授引用，started未知不补发；旧0..14目录SHA与输出冻结。地图独立回执恢复须与首次结果包括protocol逐字一致。测试同时覆盖真实Pi新行为与显式v14历史行为、fake双供应商、压缩、坏帧/权限/零DB变化、同批失效及确认恢复。真实供应商质量/费用另验，不从描述字数或fake调用次数推算。
