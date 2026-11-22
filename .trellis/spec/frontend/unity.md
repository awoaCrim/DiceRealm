# Unity 分层与生命周期

## 已确认的 A 版主冒险界面

> 2026-11-04 起，A 版的配色、平角控件与 `MarkFlat` 去皮肤做法由 [前端视觉规范 v2](visual-v2.md) 取代（G2 布局 + BG3 资源）；下文的行为、焦点、测试与动效约束仍有效。

历史 A 版采用左侧地图、右侧连续阅读栏和轻控件；其设计稿已由[视觉规范 v2](visual-v2.md)及G2主冒险稿取代，并于2026-11-05清理。当前主冒险的全屏地图与浮窗布局见下文“左侧常显地图与独立地点页”，V2 源码进度见交接。A版的旧几何和配色不再约束本轮改造；行为与权限边界继续有效。

主冒险、地图、战斗辅助、投掷和菜单已在既有C#展示所有者中迁移；已通过真实Editor编译、相关EditMode/PlayMode、普通Player构建及同源隔离QA Player读取真实存档验证。完整建卡/角色/背包未重做布局，不能把主屏迁移说成所有页面均已重设计。Prefab引用与字号基线保留，未手写YAML或改正式数据；设计稿演示状态和样本骰点不进入游戏规则。

`AdventureHud.ApplyNarrativeHud/LayoutHud`负责新分栏、阅读底和下缘导航；`UiKit.TextAction/FlatSurface`只改现有控件表现，不添加主题开关或第二套交互器。文字动作由Selectable统一着色，Text基色保持白色，避免颜色重复相乘；既有监听器、禁用态、IME与模态保护保留。分隔条按键归原AdventureApp键盘循环，与指针拖动共用边界，不同时再接IMove重复推进。

主HUD打开的辅助窗（角色窗、冒险日志、任务与人物、地点、行动确认/预览、投掷、游戏菜单）同属A版：构造时在窗口根`UiKit.MarkFlat`，其下`UiKit.Skin`返回false、`Surface`改为FlatSurface+细线Frame、Row/Ornament/CloseButton/Round/下拉箭头跳过BG3图，统一走既有纯色回退；动态重建的行/页签自动继承，不另写一套控件。物品/法术/职业图标仍用BG3原图。建卡与主页/加入/设置不在此列，保留BG3皮肤。

## 代码放置

`client-unity/Assets/Client/Scripts/` 中：

- `Core/`：无引擎 DTO、纯展示投影、本地草稿/待确认请求、文件/时钟抽象和同步策略。`DiceRealm.Core.asmdef` 明确 `noEngineReferences`。
- `Api/`：`UnityWebRequest`、JSON 归一化、图片下载解码。依赖 Core，不依赖 UI。
- `UI/`：uGUI 组件、输入、焦点、面板与应用协调。依赖 Core/Api，不决定权威规则。
- `Assets/Client/Tests/EditMode` 和 `PlayMode`：相应引擎层测试。纯 Core 通过 `Tools/DotNetCheck` 编译同一份源码，不复制业务实现到测试工程。

新展示逻辑尽量做纯投影，组件负责绑定和交互。可沿用现有 UiKit、UiFrame，不引入并行的控件/主题体系。Core 使用当前 C# 9 兼容范围与 Unity 可用 API，不照搬服务端新语法。

## 固定视图与美术资产

主冒险以 `Assets/Resources/UI/AdventureHud.prefab` 为固定结构来源，嵌套 `StorySurface` / `MapSurface`，按需阅读选择/队员使用条目 Prefab；当前主画面不再生成重复的常驻行动条目。`AdventureHudView` 只保存序列化引用及 `AdventureHudLayout` 参数；AdventureApp 与既有面板类拥有行为和状态。其他未迁移页面可继续用 UiKit，不为一致性无关重写。

- Prefab、Sprite 切片、border 与 `.meta` 由真实 Editor 保存；一次性种子不进入启动/编译钩子，不覆盖人工编辑资产。编辑入口见 主冒险资产维护。
- `HudAuthoredGeometry` 在绑定前捕获几何/字号基线，响应式代码只调整必要容器。地图内使用原生锚点；不要在 `Layout/Refresh` 中重写所有子节点位置。字体放大乘资产基准，不强制改回 C# 默认字号。
- `UiKit.BindButton/BindInput` 给已有控件绑定焦点、提示和事件，不重建皮肤。结构 Prefab 缺失应明确报错；可选装饰 Sprite 缺失由 `HudSurface` 提供实底回退。不能烘焙真实用户输入、凭证或命令监听器。
- 主故事与双控件输入栏透明无框，不带 `HudSurface` 或装饰卡片子层；`ActionDock`（含 inactive 子节点）仅有 `NaturalAction` 与 `Submit` 两个 Selectable。原请求重试留在正文上方，不因极简布局隐藏 pending/Blocked；战斗保留在唯一地图。右上 `Navigation` 统一地点、冒险日志与菜单，地点标签为“地点 M”；`ActionDetails` 按钮/字段/接线及 `SidebarTools` 容器已删除，不另加替代入口。正文无 Read/Rules 按钮和固定标题；历史检定/消耗仍在日志中只读查看。见 `HudPrefabTests` / `DesktopInputTests`。
- 保留框架的地图/按需阅读面板中，`MaterialWash`、`CopperSkinFrame`、图标不拦鼠标；边框必须排在正文/控件之前。`fillCenter=false` 不会移除九宫格四边的不透明条带，`SetAsLastSibling` 会遮字，单纯边界检查无法发现。
- 战斗过程的 `combat` 消息与普通状态提示在正文栏内居中；不改变DM剧情、私人正文或玩家发言的对齐。同一Activity有非空harness叙事且该组战报已播放完，机械条目收进 `combat-details` 的“查看战斗记录”；精确CombatIds去重，缺叙事或快照新条仍显示短报。不能跳过HP/位置播放、删权威日志或按附近叙事猜归属；同一行轮询保留展开及阅读位置。
- 先攻整卡用Row保hover/keyboard，头像选中框只包头像；不能把Slot皮肤或活动框铺到姓名/生命上。名字和状态按preferredHeight排布，先攻条随最长内容增高；禁重复的大悬停卡，点击详情仍可达。`SharedBoardTests`覆盖长名、0HP、键盘/选择和不发命令，真实截图核合成遮挡。
- 主正文只放故事（用户反馈“不要放不需要的文字”）：本人行动不加“你的行动”标题，以金色竖线+较淡字色区分，队友行动只写名字；“行动结果/故事的回应/主持人已回应”等通用标题不显示，只保留有状态含义的（待补充、待确认、等待投掷/主持、未准许、检定已记录、DM更正）；有行动后不再重复场景简介；`KnownContext`（目标/人物/世界记忆）不进主正文与`Reading`，在冒险日志查看。正文字体、字号与行距写在`StorySurface.prefab`：Context/Response/Private及段内对白用思源宋体（对白仅以暖色区分）、Intent用黑体，当前作者基准为22（Intent 19，按 G2 稿 19px/16px）、lineSpacing 1；由真实Editor保存，运行时按作者基准乘阅读倍率，旁白与段内对白共用Response模板字号，行距用`ProseLineSpacing`（`HudPrefabTests`守护）。正文字号只在“设置 › 阅读与操作 › 正文字号”（100/125/150%，示例句用宋体并随档位变化）；主界面不放字号控件（用户要求放进设置）。私人正文由服务端按实际收件人过滤，新聊天按精确 `PrivateStoryPart` 逐条展示，带partId的新消息标为“指定玩家与主持可见”，不能声称仅一人可见。CanShare只消费服务端授权，缺partId旧源才回退本人；主持真实角色若被指定也可转述，代读不可。“快速转述”直接冻结quick:true且无text到唯一pending，生成一次即公开，不开预览确认窗；“手写转述”打开空编辑窗，关闭零提交，提交才冻结明确text。回执核source/partId、本人、publication；手写核精确正文，quick核合法非空≤1024生成正文。同源不同转述不标整源已公开。旧无text请求与全文已公开状态继续兼容，公开引用注明原所属角色。无来源的旧私密文本只读兼容。旧单回应 `StoryFlowView.Private` 仍复用 `StorySurface.prefab` 的 `PrivateHeading/Private`，不能将合并正文当作一个可分享来源；业务合同见下文“本机与响应契约”。
- 左侧队伍栏照BG3：头像框、下沿压一枚生命徽章（数字，>50%常色、≤50%琥珀、≤25%红）、名字在下（本人金色、过长自动缩字），不显示生命条；卡片96高。固定尺寸的数字徽章要关掉垂直截断，否则某些缩放下整行不绘制。
- `StorySurfaceView.Followup` 是唯一按情境出现的事项入口，普通状态置于 `Body` 的提示后；旧共享阅读层的内部兼容代码仍在打开时临时转入 `ReaderPanel`、关闭移回，但当前HUD已无该阅读入口。`StepFocus` 去重并保持本人同意、异常恢复及停止可达。业务模式下本人待投掷/来源选择直达原确认窗口，已确认结果按下文业务协议自动接续；停止留在菜单“本次行动”，不要求正常流程先经过业务中转窗。终态无残留/其他活跃行动不保留按钮，纯主持待办只作工作台提示。
- `PlayerStoryPanel` 将 Followup 显隐/父节点变化纳入重排条件；移动正文起点时同步删除旧固定标题，避免文字覆盖。切换查阅面板保持草稿、正文滚动及返回原入口焦点。
- 队伍行按上下文/actor 身份复用。HP 改变不得全栏销毁重建，否则焦点会丢失；移除已聚焦成员时明确恢复到仍存在的入口。`PartyScroll` 仅滚动人物，使用整列可用高度，不给已移除的查阅容器预留空白；长队伍键盘聚焦复用 `UiFocus.Reveal`，不另建滚动机制。地图和正文须避让整列侧栏。

回归：HudPrefabTests 断言资产引用、无持久命令、装饰绘制顺序、编辑几何/字号和地图锚点；DesktopInputTests 断言 HP 更新保持实例、输入及 EventSystem 焦点。SidebarLayoutTests 覆盖单人/长队伍、地图/正文不重叠、终态入口和提示后重排；DesktopInputTests 同时验证地图查阅的草稿/滚动/返回焦点。真实屏幕截图仍用于检查合成后的遮挡和可读性。

## 正文人物名

`StoryChatPresentation.KnownNames(snapshot)`只取当前可读角色、未撤销队员、已知NPC/非hidden人物记忆和可见战斗单位，不从引号或未知剧本名单猜姓名。`PlayerStoryPanel.Render(view,scope,knownNames)`在每条DM/私人消息内仅为每个姓名的首次匹配添加`TextColor`颜色，不加粗；旁白、对白和段落共用已强调集合，重复姓名沿用`NarrativeText`。私人信息仍保留明确受众标签与授权转述；单字姓名保留，重叠名最长优先，ASCII姓名不能命中长词内部。同名普通词的语义歧义仍存在，不用黑名单或NLP猜测。`StoryDialogue.Split`保留明确台词；非冒号引入、无对白标点且闭合后紧跟叙述的引文保持正文（如“铮”一声），已知姓名引文同样受保护。冒号引入、独立短对白及逗号插入说话人句式保留样式，分段拼接必须逐字还原；见`StoryChatTests`与Core invariants。

原文本/玩家输入/存档不改；uGUI无法无损转义富文本，含`<`的段保持plain，不解释模型标签。测量与绘制使用同一已样式化Text，字号仍来自Prefab及阅读倍率；名字集合改变时重排并保留阅读锚点，相同快照不重建行。Core回归在`AdventureInvariants`，引擎层在`StoryChatTests.KnownNamesStayInlineAndFitWhileRefreshKeepsRowsAndReading`；编译不替代实际字重、对比和阅读倍率的原生验证。

## 正文不保留右侧动态栏

用户明确指向角色窗口「状态」页，并要求正文右侧动态可直接删除。`AdventureHud.prefab`的`CurrentStatus`节点、`HudStatusView`/`PlayerStatusPanel`及作者入口已移除，不能只隐藏节点或保留320宽空列。`AdventureHud.LayoutHud`在左侧人物栏之外分配正文与右侧地图；右侧地图按用户最新要求常显（见下一节），但地点/任务/资源仍回原页面，不能借此恢复已删的动态状态栏。快照刷新不改变聊天阅读位置、行实例、焦点或草稿。回归`SidebarLayoutTests`、`HudPrefabTests`与`DesktopInputTests.SnapshotRefreshWithoutStatusColumnKeepsComposerFocusAndStoryScroll`。

## 左侧常显地图与独立地点页

> 2026-11-05 起主冒险改为 G2 saga 布局（用户要求“按照设计的来”，稿为 `game-2-saga.html`），本节旧的左图右文分栏、`StoryMapSplitter`、窄栏和 `MapShare` 规则作废。

- `AdventureHudSaga.LayoutSaga` 负责布局，单位为画布单位（1920×1080 下 ×0.85）：
  - 地图铺满全屏。`CartographyPanel.SetHudInsets(left,top,right,bottom)` 让工具、菜单、头像避开左侧队伍和右侧故事面板。
  - 铭牌在左上。五个圆形图标导航在右上（地点 / 日志 / 角色 / 背包 / 菜单）。
  - 队伍在左上，从铭牌下方往下排。
  - 故事面板悬浮在右侧，`ActionDock`（输入框和发送）在面板内。战斗时面板高度让开行动栏。
- 当前地点没有地图且不在战斗：背景用压暗的 `Art/TavernTable`，布局不变。读取或发布失败（`mapAvailabilityProblem`）时，在铭牌下方说明。
- 战斗时 `CombatPanel` 画三块，只改展示，命令仍是服务端原选项：
  - 顶部居中的先攻条和回合数。他人伤势用粗略档位血条，精确生命只给本人。
  - “你的回合”横幅。
  - 底部行动栏（`CombatHotbar`）：数字键 1–9 对应可见行动格；移动是一个格，展开后列出原有选项。
- 回归：`SidebarLayoutTests`、`HudPrefabTests`。

`PlayerStoryPanel`消息透明且同列，检定为青色短行；当前本人事项移到Story根的固定底部，滚动历史不带走操作入口。重排保存可见消息锚点和实例，不清草稿；原请求重试也靠近输入。队伍位于地图左下，长队伍仍滚动和复用原实例；PartyRail横向起点归零，不能把旧侧栏的24单位内缩带入新卡片宽度而裁掉姓名。正文Body保留Prefab拉伸锚点，用SetSizeWithCurrentAnchors设置实际内容宽高，不能把完整宽度直接写入sizeDelta再叠加父宽。StoryChatTests与SidebarLayoutTests核对内容及姓名均在各自可视宽度内。

“地点 M”与M只打开 `ExplorationMapPanel` 已知地点，不再有场景图/地点双页签，也不reparent地图。唯一 `CartographyPanel`/`MapViewport` 常驻正文host，鉴权下载与纹理只有一份；拖宽、辅助页往返和正常刷新保持当前图的手动缩放/平移、草稿及聊天首个可见消息锚点。手动视野保存归一中心，布局只夹取显示投影，不回写用户中心；legacy单回应保留原normalized滚动合同。图册权限未能确认时仍清图，恢复重新适应全图，不能声称网络失败也保留视野。

`MapSurface.prefab`继续提供地图引用、工具尺寸和字号。`CartographyPanel`在绑定时将工具放到图内右侧中部，布局只调整地图容器、真实叠层与工具菜单空间，不重建数据控件。考虑 `UiControlText` 小窗口增字，工具标签保留足够内宽与行高：1024宽时25字号的实际行高为37.5，原40高按钮减上下留白后会整行不绘制；Prefab使用48高并以22/25字号回归。不能在stretch anchor下再写绝对总宽sizeDelta。地点页作为上层优先处理Esc/Tab，不能让后台地图菜单或测距截获；回到正文后Esc先关图内菜单再退出测距。FocusScope只看activeInHierarchy。图状态只消费服务端白名单，读取不生图，未知定位/比例尺不猜。

`MapPresentation.CurrentSceneMap` 使用服务端 `selectedMapId`，且仍核对 `currentScene/published/player/ready`；仅旧响应缺少选择ID时按服务端顺序取当前场景最新图。显式ID不可读时不本地改选，非战斗回退由服务端统一解析。`AdventureMaps`在活动战斗优先使用snapshot.combat.boardLayout.mapId，图失效保留该锁并显示不可用，不画另一张图。玩家不再手选底图，`MapSurface` 的 picker 及其回调已删除；没有关联图显示空态，不回退异地公开图。地点变化立即清旧图，迟到元数据/图片不得覆盖新地点；同图刷新保留缩放与平移。回归 `CartographyTests` / `ExplorationSyncTests`。

详见[地图生命周期](../../../docs/maps.md)。回归 `CartographyTests`（地点页无图/页签、头部/隐藏焦点）、`SidebarLayoutTests`（常显、避让、草稿/单实例）、`HudPrefabTests`（可编辑几何）、`DesktopInputTests`（真实InputSystem地图手势、地点页Esc/Tab）与 `ExplorationSyncTests`（权限、迟到响应、撤图）。巡检使用明确离线样本，后台Player另验实际鉴权图片与失败恢复，不以样本代替网络验收。

地点页统一列表，不绘制第二张节点/路线图；服务端真实坐标仍保留在协议中，未定位不能伪造路线。仅选中地点后显示title/hint，无选中回收详情空间。通用公开记忆只在`WorldPanel`分类阅读，不在地图底部拼成“冒险中记下的信息”。

## 颜色令牌与组件状态

> 下表令牌值已由 [前端视觉规范 v2](visual-v2.md) 取代；状态表（悬停/焦点/选中/禁用/处理中/失败）与层级规则仍有效。

颜色只取 UiKit 的静态令牌；主冒险不再套用BG3按钮/纸面皮肤，未迁移的辅助页仍可使用既有素材。

| UiKit | 值 | 用途 |
|---|---|---|
| `Ink` | `#0D0D0D` | 阅读带与浮层底色 |
| `Panel` / `Raised` | `#121412` / `#1F211D` | 场景缺失底、悬停与局部分组 |
| `Bronze` | `#464842` | 低干扰轮廓，不独自承担焦点 |
| `Gold` | `#EC7D37` | 现有字段现承载橙色当前项与待执行操作 |
| `NarrativeText` / `Muted` | `#D4D5C6` / `#A4A597` | 连续叙事 / 辅助文字 |
| `TextColor` | `#ECE3D1` | 正文姓名首次匹配；未迁移组件原有主文字，避免降低其素材底对比 |
| `Information` | `#78B8C8` | 已记录检定与过程信息 |
| `Focus` | `#F8F8F8` | 键盘焦点 |
| `Health` | `#9E443F` | 既有异常强调，仍伴随文字/数值 |
| `Paper` | `#DED0AE` | 既有成长页文字；主叙事不再使用纸面卡 |

对比度须按实际材质和合成后的画面检查，不沿用旧纸面/金色比值；尤其不能把Text颜色与Selectable正常色重复相乘。

| 状态 | 必须出现 | 禁止 |
|---|---|---|
| 悬停 | 已知皮肤使用同族Hover图，物品/装备槽使用对应Overlay；图标可用`UiHoverPop` | 全部控件套矩形金框；放大挤动旁边布局 |
| 键盘焦点 | 同形状Hover图；无配套图的输入等控件保留可见焦点框 | 只改细铜线或撤掉所有焦点反馈 |
| 选中 | 前导符/下划线/选中框与高亮共同表示 | 仅靠色相 |
| 禁用 | 可读标签 + 不可用原因 | 淡到看不清；只靠悬停读原因 |
| 处理中 / 未确认 | 明确“正在提交”，保留“确认原请求” | 提前显示成功、重新掷骰 |
| 失败 / 无内容 | 就近原因与恢复；说明暂无何种内容 | 全屏笼统错误；伪造任务、队员或物品 |

层级从下到上：场景、HUD、非模态提示、当前大窗、模态确认；一次只开一个主窗，Esc 关最上层并回原焦点。

## 桌面密度与动态字体采样

主Canvas的唯一缩放所有者是`UiDesktopCanvasScaler : CanvasScaler`，由`AdventureShell.BuildUi`创建并开启`pixelPerfect`；沿用`HandleScaleWithScreenSize`/`SetScaleFactor`，不另加竞争的Update缩放器。按用户明确要求，桌面UI比原密度缩小15%，由Canvas负责按真实比例重新采样字体，不在页面Transform再乘0.85。先算既有fit=max(min(w/1920,h/1080),min(1,min(w/1600,h/900)))，再取max(0.01,0.85*fit,min(0.8,fit))。因此1080p为0.85，1440p为1.1333，4K为1.7；720p/768p保持0.8的可读下限。用户显式阅读/界面放大仍独立保留。

详细页`UiPageFit`仍使用1600×960设计坐标，`localScale=min(1,min(parentWidth/1600,parentHeight/960))`，只缩小、不放大填高。不要改变固定坐标来补偿两次放大，也不修改用户保存的正文/整界面放大选项。工程构建窗口基准保持1920×1080；Player未保存明确显示偏好且无恢复记录时，由`UiDisplaySettings`使用显示器原生分辨率无边框，避免继承Unity偶然记住的小窗口。已确认的显示偏好与中断恢复记录继续优先，不能每次启动强制覆盖。

动态思源字体的`Text.pixelsPerUnit`和`GetGenerationSettings(...).scaleFactor`按Canvas比例采样，不包含页面Transform的额外缩放；因此默认1080p应使显示比例与字形生成比例同为0.85。不能把dynamic字体importer的`fontSize=16`误当固定16px字图，或通过增大它代替检查真实Canvas/页面/屏幕比例。显式辅助放大与小窗口适配仍可保留，不宣称所有尺寸都是整数像素。

回归：DesktopDensityTests覆盖上述比例、真实App单一Canvas/原层级、页面只缩小、动态字体生成比例与草稿。EditMode中需要直接执行组件布局方法时采用现有反射调用，不用`SendMessage("LateUpdate")`触发Unity生命周期断言。实际截图必须是原生GameView/Windows客户区，并核对小窗口、长文/长队伍滚动及阅读放大；固定公式断言不能代替视觉验收。产品名临时隔离QA后必须恢复，测试/观察器不得进入正式Player；不通过清profile或注册表重置掩盖问题。

背包检索/分类/排序只投影原entries，筛选清空时有清除入口；类型只读服务端category。套装内容物可用同源 `sheet.packs.contents` 的原名/中文名匹配，命中仍列原套装并标“尚未取出”，点击原详情，不伪造散件库存；stale metadata 仅同 itemId/rulesId 可读复用。装备带详情始终查完整实物集合，不被网格过滤阻断。轮询快照先于sheet时，同实物同rulesId可保留上一分类，不因暂时缺元信息丢选择/关闭详情；命令仍按stale禁用。切角色/战役清筛选，普通切页和同步保留。能力分组按服务端group排序但保留原features index与完整详情。回归 `InventoryFilterTests`，真实Player另验输入焦点、滚动、全背包负重和筛选后装备槽。

## 共享棋盘与同图战斗

协议唯一归[共享棋盘](../../../docs/shared-board.md)。`MapViewportTokens`拥有单击/拖动手势：图标不拦射线，单击只读，松手最多提交一次；平移/缩放/测量不改权威坐标。pending目标与实际棋子分开，版本/地图/席位变化取消旧手势；同图刷新保留缩放、选中ID及详情阅读位置，新选中详情从顶部开始。本人首次摆放须由实际按钮触发，不在GET自动创建。

`BoardTokenLayout` 只安排屏幕头像矩形，`MapViewportTokens` 保留实际位置锚点。`SetOverlayInsets(top,bottom,right)`把先攻/地点、队伍/动作和右侧地图工具纳入头像及拥挤列表的显示避让；不得为了避开HUD修改服务器坐标。地图头像用既有Round素材的alpha作隐藏Mask，`UiFrame.Circular`画细轮廓，真实尺度和命中/拖动算法不变。局部战术头像按服务端体型与实际比例缩放，城镇/区域为定位标记；不再绘制常驻占地框、真实落点十字或头像连接线，选中只突出头像。密集时避让，空间不足走原单位列表，不叠头像或无限缩小点击目标。实际拖动或待确认移动仍保留目的地预览。拖动提交真实锚点加指针位移，不提交避让后的显示坐标。缺尺度/体型不猜，旧协议没有新字段仍可读取。`MapScaleLayoutTests`验证同点/邻格/边界/缩放的可选性与零隐式位移；实机另看合成画面。

`MapViewport.SetImage`默认铺满（Fill）；明确Fit时由CartographyPanel将图像区域收进真实HUD安全区并适应整图。手动缩放/平移后尺寸变化仍只Apply原归一中心，不重设视野。地图本身可在HUD下绘制，头像须避让叠层。

`CombatPanel` / `CombatPanelShared` 仅拥有同一地图内的先攻头像条和底部动作区；构造、绑定在 MapSurface 下，不放入 PlayerPages，不建第二张网格、战况子页或导航入口。新旧战斗都沿这一布局，无图保留真实空态。目标通过地图棋子或头像选择，只投影实际 availableActions；actionOptions 仅补文案。动作列数按实际标签宽度计算，长/多候选保留滚动；不能为匹配草稿删掉回气等真实选项。先攻姓名在测量前使用与UiControlText相同的字号下限，窗口变化立即重排，并保留完整姓名与生命文字。其他单位只读姓名与伤势，本人的生命和必要资源保留。方向菜单和原请求恢复仍使用既有提交路径。关闭辅助页不关闭地图战斗，刷新不丢草稿、焦点或已手动滚动的位置。

`CombatEntry.presentation` 是已结算事件的可选视觉瞬间。`CombatPlayback` 按 combatId/sequence 消费新增事件，在主正文显示简短事实，并同步地图、角色与队伍头像生命；权威 snapshot 始终用于命令版本，不能用播放拷贝发命令。首次读取/重连不回放旧战斗，旧空字段不猜状态；未知单位不因终态已经出现而提前显示。播放期间只锁新命令，不伪造反应或允许取消已结算步骤。本人原投掷结果可先读完并关闭；播放结束才呈现下一次真实待投掷。`StoryChatPresentation`按同战斗/序号去重；只有同一角色相邻倒地/死亡状态已由可见伤害短报及其结构化终态涵盖时才合并，独立状态、死亡豁免结果、其他角色或尚未呈现的伤害不合并，不解析中文判断。回归见 `CombatPlaybackTests`、`SharedBoardTests`、`DesktopInputTests`。

`CanConfirmRoll`允许原Harness匹配等待，或精确匹配本人当前rollId、空intentId、`roll.request/awaiting_roll`与`combat.*`来源的持久按钮请求；不因新会话/重连而取消既有结构化攻击的本人确认。未关联自然输入、其他席位/其他roll和未知结果仍不放行。先攻等已结算结果可能只有 `combatLog`、没有单个check，自动续接须认精确rollId的resolved回执；不能仅凭pending消失或借另一个Run继续。回归见 `AdventureBusinessTests` / `AdventureBusinessSyncTests`，确认仍沿原四字段端点，零额外模型行动。`ContextualRollPanel`投前只在同版本有效preview下把空标题/“行动检定”/“行动豁免”替换成具体skill（否则ability）及testKind；不覆盖已有武器/目标标题，不借过期preview或description猜名称/DC。回气的固定自用双语标签`Second Wind / 回气`只显示一份中文；不得按翻译后两段相等去删武器/目标后缀（目标可能恰好同名）。回归`ContextualRollTests.GenericDemandNamesTheCurrentAuthoritativeCheck`及双语/武器标题测试。`PresentRoll`接受只有skill、无ability的有效check：死亡豁免的`Death Saving Throw`必须显示真实骰面/修正/总值，并同时保留累计或自然20苏醒的结构化后果；不按总值在本地重算成功，不从技术文字抽取骰点。回归见`ContextualRollTests.DeathSaveWithoutAnAbilityShowsRecordedDiceAndItsActualConsequence`。

用户2026-11-03要求U2战斗与地图演出。`AdventureCombatPlayback`只在原播放游标推进后通知`CombatPanel.PresentBeat`：先攻头像中的本人生命条显示已保存的损失段/恢复进度，其他单位仍只显示粗粒度伤势；漂浮数字来自相邻保存瞬间的生命差额，同一行动内先受伤再治疗分别呈现，暴击标记只取对应`attack.critical`。当前行动者描边呼吸，新增轮次/行动者切换短暂提示；历史首次读取、失败恢复和会话变化不补播。

`MapViewportMotion`只移动独立、不可交互的头像展示层，实际Button、命中矩形和DTO在开始时已是该播放步骤的服务器终点；缩放/平移每帧按当前视图换算路径，不挪动布局或提交中间坐标。探索移动使用原位置、服务器waypoint与终点；战斗棋盘持久化会清除path，因此`CombatPlayback`从同一播放步骤的已保存位置瞬间投影折线，保留格内偏移，不在客户端寻路。未执行的pending路径不播放；首次读取/重连补读/相同位置刷新保持静态。

地图氛围只画在棋子和控件下方；已授权地图替换可短暂淡出旧公开底图，所有权交给转场并在完成/跳过/撤图时释放，旧棋子与交互立即清除。切场景待关联、撤权和读取失效仍沿原立即清理规则，新图到达后淡入；不因动画保留无授权纹理。有限时长演出可点击/按键跳过，`UiMotion.Reduced`即时结束数值/位移动画并关闭呼吸、雾层与转场。回归见`CombatMotionTests`及既有战斗/棋盘测试；U2源码交付不代表日常包已更新。

## 公共皮革窗口与氛围背景

交互动画由`UiMotion.cs`统一拥有（用户要求“加一点交互动画/过渡”）：`UiFade`只渐变CanvasGroup透明度（约0.14秒，缓出），用于窗口/设置/建卡/物品卡/快捷菜单/提示卡打开，以及角色页切页签、建卡切步骤、日志切页时的正文；`UiHoverPop`让背包、法术、建卡卡片的图标在悬停时放大到1.08（围绕中心，补偿左上枢轴）。不得做位移或缩放整个窗口/控件——布局、命中区与PlayMode逐帧几何测试都依赖静止的Rect。“减少动画”经`UiMotion.Reduced`全部关闭；EditMode（非播放）不执行。取组件必须用`GetComponent`后判`==null`再`AddComponent`，`??`对Unity的假null无效（曾导致74个PlayMode用例在打开窗口时抛MissingComponentException）。在active对象上AddComponent会立即触发OnEnable：先挂UiFade后若还需CanvasGroup，必须复用它已添加的组件，不能重复Add；inactive建UI的测试不会发现这个差异。`DesktopInputTests.ActiveCanvasSettingsReuseTheFadeGroupForHintModalAndSettings`覆盖真实active初始化与F1/设置的交互组。

用户2026-11-03要求U1叙事与检定演出：`UiStoryMotion`在完整文本排版后只改变字形顶点透明度，文字、富文本与预留高度不变；仅新到达的DM/私密叙事逐步显示，新消息淡入0.24秒。`AdventureStoryFlow`先建立历史与本人行动基线，读取失败/重连、切换席位/时间线和扩展历史窗口重建静态基线；`StoryChatMessage.PresentationId`将同一action的实时与持久化投影去重。等待指示只用于已确认working（或有working子行动的delegated）。`UiDiceMotion`只转动独立骰子图形，约0.65秒亮出保存的骰面，1秒内展示保存的总值/成败；本人投掷回执同样处理，replayed回执静态。按U1验收修正，同批新增内容中，检定后面的DM/私密叙事等前面的骰子演出及总值/DC/成败完整显示后再开始，全文高度仍预留；跳过骰子只启动后续叙事，不以同一按键同时跳过两段。成功/失败分别复用现有绿/红色，未知或多DC保留中性色；自然20/1的取用骰子加粗描边和淡色填充，结果行加粗，仍按服务器成败着色，不改判定。无骰/自动失败不造骰面。点击、按键完成当前演出；减少动画全部立即显示；设置的叙事速度只控制逐字显示。`StoryMotionTests`和`AdventureBusinessSyncTests`验证这些边界，U2战斗/地图演出另行验收。

控件优先BG3原图（用户要求）：`UiKit.Button`非主按钮且高≤64时用建卡页青金钮`ButtonPlain`并去掉静止描边（悬停/键盘焦点使用同族`ButtonPlainHover`），更高的按钮是卡片，保留面板底；关闭钮为容器圆形关闭钮（“×”文字保留为名称但透明）；`UiKit.Round`给加减钮圆形底；属性页加值为Options勾选框+勾；下拉框/弹出面板/滚动条用`Dropdown`/`DropdownPane`/`ScrollTrack`/`ScrollHandle`；素材缺失时全部回退原样式。`UiKit.Skin`复用`PlayerIcons.Surface`缓存的九宫格：Panel/Button优先BG3（边距与PPU由`AgentScripts/Bg3IconImport.cs`设定，使density 4/5下角饰约为原图一半），其余及回退用`AdventureSurfaces`（Panel/Inset/Button/Portrait），仅主按钮可直接换底。窗口使用`UiKit.Surface`：原不透明底色移入内缩的`SurfaceFill`（内缩=最小切片边距×0.6，落在边框不透明区内），皮革为其上一层、`raycastTarget=false`，窗口Image改透明但仍拦截指针；精灵中心略透明，不能去掉底色让背后正文透出，也不能把满矩形底色或矩形`Shadow`留在窗口上——BG3边框有透明边距和圆角，会在框外露出暗色矩形（用户反馈“背景溢出”）。`AdventureShell`给实际辅助页面挂底材，主页仍透明、故事正文仍无框；缺素材沿用原Frame回退。设置全屏底层始终不透明且在辅助放大层外。

`UiFocus`是唯一交互状态所有者：`UiKit.Skin/Focusable`按明确normal Sprite绑定同族Hover/Pressed/Disabled，圆形Close/Round及CheckBox显式绑定；22张配套资源由`Bg3IconImport.States`在Editor导入并继承normal切片/PPU。库存使用`SlotHover`，装备槽使用`EquipmentHover`子层，均不覆盖物品/空槽图且不拦射线；已匹配美术的控件不再绘制`UiFrame`矩形。Row先清旧美术状态，仍由原行条纹/ColorTint表示高亮。禁用、父CanvasGroup禁用和关窗撤回hover；换tab皮肤保持焦点。无配套图的普通输入保留焦点框。回归`ControlArtTests`与`PlayerVisualTests`，资源来源归`scripts/extract-bg3-ui.py`，不靠控件名猜皮肤或另挂第二个状态组件。

主页背景为`Art/HomeGate`（右侧留暗区承载标题与菜单），`UiKit.Ambient`使用`Art/TavernTable`，EnvelopeParent铺满且不拦射线；HUD无场景图与建卡背景使用压暗版本。两图由`scripts/generate-art.py`（用户指定优先grok-imagine-image-2.0，计费，每次一张）生成，候选与原图备份在`artifacts/art-candidates/`；换图先用`GameUiPreview.HomeArt`在真实主页试看再导入（无mipmap、最大2048、BC7）。背景材质不证明文字合成对比度；需实际GameView检查叙事/标题区域，截图夹具明确不代表真实战役内容。

## 角色阅读与按需恢复

角色窗口固定1280×766（PlayerPages坐标），页签/正文的几何由`CharacterOperationsPanel`统一拥有；宽桌面两侧留边，不随桌面拉宽（按桌面86%拉伸的旧做法被用户否定为“太宽”），也不在窗口Transform额外缩放字体，不改变全局0.85密度。标题只写“名字 · 职业 等级”，不再有物种/背景/生命骰副行；数值带照BG3只读HP/临时HP、护甲与六属性（熟练加值、生命骰、力竭>0、背景移入人物页“基本信息”，用户认为放在标题区无用）；临时生命独占一行防止三位数挤掉正文，缺属性为—，角色丢失则隐藏旧数值带。护甲与六属性共七块紧跟生命块，最宽80、固定8间距；窗口变宽时末尾留空，不拉宽数值块也不拉大空隙（两者都被用户否定过）。背包为BG3式约75.6宽的图标格（1200宽为15列，G2设计稿 2026-11-05），格子不随窗口放大；物品详情是560正文宽的紧凑卡片（窗口600），高度按“副标题+正文+操作”收缩（`FitPopup`），不随网格选中改变宽度。

右侧阅读栏是一张凹陷卡片：`Entry.Title`（默认Label）衬线标题、`Subtitle`金色状态行（法术“戏法 · 学派 · 已准备”、资源“剩余 x / y”、物品“已装备 · ×n”）、分隔线，再是正文；物品弹窗的标题在窗口标题栏。正文开启rich text，`UiKit.Facts`把行首“标签：”染金（`Body`经`UiKit.Plain`去标签供测试/读取）。`DetailNotice`只过滤固定完整的“规则说明仅供查阅；当前次数、加值和可执行选项以角色状态与服务端操作条件为准。”，缺资料/错来源等具体notice保留，不按包含“规则”的模糊子串全删。正文不得重复标题区已有数值或标题本身，不写“仅供阅读/由后端记录”“服务端未提供描述”“耗时未标注”、英文重名、“请回到冒险中说明”之类套话，空字段整行省略；已收录规则的法术读中文规则，不再附服务端英文简写。`RuleReference.Details/SpellDetails`不再以“名称（English）”开头（阅读栏与提示卡已有标题）。查正文必须限定类别：`Find(key,kind)`要求kind，`Details(key,kind="rule")`默认仅规则；物品传equipment，法术用spell。禁止从整句子串扫描被提及的其他词条（旧`Related`已删除），盾牌缺资料不能借护盾术正文，未知法术也不能借同名装备的译名。`CharacterOperationsTests`覆盖固定宽度/长生命/空角色/弹窗网格，`DesktopInputTests`覆盖首帧下拉与焦点、Esc及宽网格滚动稳定。法术`Entry.Detail`只放完整规则与真实不可用原因，取得来源独立为`Entry.Sources`，由`SpellSourcesFooter`在原ScrollText正文末尾放置默认收起的轻量`SheetSpellSources`行，无顶部按钮占位；来源作为同一content的子Text，保留根Text供阅读字号识别，caption随UiControlText增字时向父布局转发失效。展开只增加末尾高度，不改变规则正文，以绝对像素偏移保留阅读位置而非按比例跳动；同条目刷新保留展开，切条目/关窗/换角色收起，实际用法选择与本次成本不折叠。`EntryExplanation`与F1只读完整规则，不再补一份`RuleReference.Details`或附来源链；准备页直接取全文（未知法术保留服务端描述），不把摘要与全文叠放。取得记录和可用路线按source/ability/attackBonus/saveDc精确合并展示，保留全部mode、成本、剩余及不可用原因，不合并实际命令候选；选择用法只补特有操作说明，不重复追加来源。物品完整规则与旧equipment摘要互斥，stale时旧摘要同样撤回。去重修拼接所有者，不对规则做模糊裁句，材料/限制/成长/属性解释不可丢；全目录点击/F1及准备回归见`CharacterOperationsTests`。

角色窗“状态”页签（人物之后）集中当前持有的非背包资源与状态：“状态”组为状态（规则说明来自`RuleReference.Details`）、力竭、临时生命、当前专注法术、计时效果（剩余时长按快照时钟），无则“无异常状态”，不再用正文重复一段空态说明。默认选中“当前概览”，直接列真实法术位各环剩余/上限（无池也明确写“无”并保留法术位组）、免费施法次数/恢复、戏法、本回合预算及当前权威动作候选。动作来自snapshot与同版sheet.effects，其他施法来源须保留sheet.spells.details中的仪式/目标/环级/触发限制；空resource不能推导无条件任意施法。stale撤回旧sheet选项，只读队友不借本人动作，不新增确认/提交入口。`resources`全量保留，普通/契约法术位以`RuleReference.SlotLevel`精确匹配服务器1..9环池名，单列“法术位”组、按环阶显示明确的剩余/上限，耗尽不隐藏；其余职业资源、来源免费次数与生命骰仍在“资源”组，≤6次用●○、更多写数字。免费施法不意味着角色有职业法术位：一级游荡者只有服务器记录的生命骰/激励/免费次数，不能按职业名、法术列表或缺失字段造池。人物页不重复资源/效果/已跟踪生命骰。

战斗状态只读当前快照中匹配`party.selfActorId`（只读队员为`readOnlyActor`，无party旧协议为player）的`combat.units[].id`，不可拿`character.id`或第一名单位匹配。活动战斗显示本回合移动/未消耗动作、附赠与反应、剩余攻击，以及明确的闪避/撤离/护盾/反应受限标记，不计算可执行动作。`standard`死亡豁免/稳定/死亡仅在活动战斗、角色和该单位HP均为0时显示；已结束战斗的board不再随角色同步，不能拿历史稳定/死亡计数冒充当前状态，即使角色后来再次归0也不能恢复旧记录。无单位/已离场不借用他人，旧无standard协议不造0/0死亡豁免。`ApiJson`仅在`combat.standard.turnSerial>0`时保留单位standard，回归夹具必须经过真实归一化。`CharacterStatusTests`覆盖槽池/免费施法、角色ID与席位ID不同、队友只读、活动稳定与战后回血再归0、旧协议和错误反馈。

列表行可带`Entry.Group`，同组上方画花纹组标题。“同调”组读取同版`wearables.items`的attuned记录，包括缺失库存的物品，以实际候选提供结束同调，不伪造背包物品。人物页“防御来源”和AC数值提示只读服务端`equipmentStatus.armorClassSources`，不在UI复算。

`CharacterOperationsPanel`拥有角色窗口，继续使用`UiKit`/`UiHint`，不要另建浮层/分页器。正常页面底栏不放“选择条目查看详情”“拖动物品/右键”等常驻教学文字，也不保留其空白占位；`BodyHeight`按实际`note`显隐分配高度，空态只留16单位边距，真实反馈才预留原底栏。`SetNote`同时重排列表/正文，背包负重条每次同步位置；不是只把文字清空。真正的读取失败、pending重试、同步及操作回执按需保留，恢复后回收空间；回归`InventoryMetadataTests.EmptyFeedbackReleasesTheFooterAndRealProblemsReserveItWithoutMovingItems`。地图正常态不常驻滚轮/拖动/点击说明，设置不放“不会改变游戏规则”免责声明；不据此删除来源选择、成本、数据未定位/不完整或恢复入口。×使用原`Hide`回调，不给明显的关闭图标加大块自动提示；长列表保留当前行与滚动，真正只读条目隐藏确认区域，并将无实际操作的底部空间还给正文；`ReflowDetail`按实际可见操作/notice分配高度，pending/stale/读失败的恢复提示仍保留，不能靠隐藏按钮使旧回调可执行。`CharacterOperationsTests`覆盖无选项、不可用与原pending的高度和零执行。资源/成长在人物、准备在法术；有服务端合法行动时才保留预览/确认。原始feature索引只用于规则说明，不能再直接生成`operation="feature"`；旧请求端点兼容仍由原队列与服务器拥有。

背包由`CharacterInventoryGrid`拥有：BG3式全宽图标格，点击物品或菜单“查看详情”打开独立`InventoryDetailWindow`弹窗，禁止切换两栏。弹窗有标题拖动、×与独立焦点域；打开、拖动和关闭均不改变底层网格几何/滚动，关闭回原物品格。已投影`sheet.packs`的套装右键只开“打开套装”，进入同一详情；其他未装备物品右键只开“装备 / 查看详情”两项菜单；已装备物品只有“卸下”：穿戴物取同版wearables清槽候选，其他装备沿精确equipment候选提交`equip,value=0`清除该物品所有装备位置，不隐式开详情。不可用或只读时保留对应禁用操作及可读原因。只有一个合法位置时直接装备，多个位置复用有界菜单明确选择，不猜默认主手。`CharacterOperationsPanel`将唯一`SheetOperationContent`移入弹窗，关闭后移回；背包详情默认只读，清空旧command/action并隐藏无关controls/send，不再出现通用“选择本次用法”、装备/effects确认。可写详情仅限同版typed套装`RenderPack`与同调`RenderAttunement`。前者显示服务端一份内容清单及“取出全部”，只发原`unpack`候选key、value=1；打开不拆包，不在本地改库存，pending/失效/只读阻止旧按钮回调。缺packs按旧详情只读，不猜内容。后者只取同版`wearables.attunementOptions`，展示实际1小时成本及本人短休说明，复用原Confirm/Send/pending管线；不可用时正文显示reason、不能发送，不加第二层确认。普通穿戴仍直接提交。法术多来源与成本确认保持原流程，禁止复制提交逻辑。弹窗阻断背景控件和HUD快捷键，F10设置仍作为上层，Esc逐层退出。不得自动选择首项、常驻详情/装备按钮或加“请选择”的占位面板；关闭详情后刷新不复活，关闭角色窗后重开也保持未选。复用物品控件和原焦点/滚动，打开/关闭不发命令。格子只画图标（Slot底）、右下数量（>1才显示，超过9999显示9999+）和左上金色“装”（当前使用武器显示“用”）；名称、装备状态/数量与真实简略属性放进该格`UiHint`的`Title/Subtitle/Explanation`（BG3提示卡），`FullExplanation`复用点击正文的`EntryExplanation`；物品简略取同版`itemDetails.id`正文的首个属性块，再退到精确规则目录，未知则说明缺口，不能只读空目录summary，无图标时格内仍写名称（在数量上方）。空格`InventoryEmptySlot`铺满可视区，只有真实物品决定滚动高度。菜单项的`UiHint`仍抑制；菜单由`CharacterInventoryGrid`拥有，不另建提示所有者。库存按ID复用，保留滚动/焦点，不造假图标/容量。右键、菜单键及Shift+F10进入同一菜单（Shift+F10不同时打开设置），Esc先关闭快捷菜单，再关闭独立详情弹窗，最后关闭角色窗口。武器装备/手槽卸下按同版本loadout选项提交完整key，护甲、背包卸下与旧响应仍走精确equip；旧snapshot装备行动可从根菜单“装备”进入原预览，不重复追加装备route。物品使用由玩家在主输入说明，除明确的套装拆开与同调外不恢复通用详情操作区、右键第三项或自动填稿/提交。

`CharacterInventoryDrag`处理背包物品拖到原五槽及服务端wearables穿戴槽：格子上的`InventoryItemDrag`拥有左键拖动阈值之后的手势并取消点击资格，空白处/滚轮/滚动条保留原滚动所有者；ghost不参与布局、不拦射线、不改库存。目标按同版`itemId + slot`定位并经`SubmitEquipmentOption`提交完整候选key（loadout/wear由所属选项集区分），不能解析文案、切分含冒号实物ID、构造key或自动卸下冲突装备；当前投影中无任何手槽候选但有equipment路径的物品可向护甲槽发`equip,value=1`，缺loadout旧响应不猜目标。Show/版本或scope变化、读失败、pending、关窗/换页、Esc/F10及失焦取消拖动，迟到松键零提交；仅真实回执更新装备栏。回归`InventoryDragTests`与`DesktopInputTests.InventoryMouseDragEquipsOnceAndEscapeCancelsWithoutClickingOrMovingTheWindow`，真实后台Player另验网络写入与大小窗口。

`CharacterEquipmentSlots`在全宽背包上方合并同版`sheet.loadout`与`sheet.wearables`绘制一个装备带：显示时将近/远四手稳定分组到左侧，其后依次为头、护甲（头盔右边）、衣着、披风/手/护腕/足与饰品；不修改服务端数组顺序或槽ID，不另建页。只对四个精确手槽ID使用手持语义，双手影像取`occupiedBy`且不复制库存，两手可同时显示“用”。槽位按ID复用Button与Artwork，不创建槽下部位标签；空槽使用`PlayerIcons.EquipmentSlot`的BG3默认整槽图，护腕/腰饰/眼部用blank加低亮度SlotMark代表图。空槽由`itemId/occupiedBy`均为空判定，缺库存不伪装空槽。槽位始终可聚焦以读取位置提示，是否能提交仍由同版候选及Ready决定；已装使用同族BG3 `Slots/blank`底框与物品图，不能退回通用黑色Slot造成空/已装皮肤割裂；双手ghost保持。动态饰品超宽使用原生水平ScrollRect/Scrollbar和`UiFocus.Reveal`，同步保持横滚与实例，不硬编码饰品上限。装备带同调计数取实际used/limit，不按equipped猜。`CharacterInventoryWeight`在背包底部独占42单位，只消费同版`sheet.weight`，以砝码、细条、刻度/指针和`当前 / 上限 磅`呈现；部分重量以≥和未计重件数标记（件数按数量相加，不是物品种类）。负重悬停提示从同版`itemDetails.hasWeight`列出具体物品与数量，仅在这些数量之和与权威`unknownCount`一致时显示名单，缺字段旧响应或stale不能猜哪些物品未知；规则缺数值不能当作0或随便指定圣徽的具体变体。0合法，缺字段写未记录，stale撤旧数值；未知容量显示—且隐藏填充/指针，超量保留真实数字，不自定黄红惩罚阈值。有角色无槽也保留标题，不伪造空槽。`ApiJson`以unit=lb归一缺字段对象，客户端不复算、不增加负重惩罚；字段和来源唯一归[负重契约](../../../docs/client-contract.md#carried-inventory-weight)，回归`WearableUiTests`。装备带不再创建右侧当前持用标题、近远/握持按钮或说明文字。空槽选择复用唯一`ShowInventoryMenu`，只发相应`loadout.options.key`或`wearables.options.key`；已装槽右键仅“卸下”，手槽从同版`slot + 空itemId`清槽候选取得完整key，仅清该槽；双手副槽ghost映射同组主槽，护甲复用`equip,value=0`；穿戴槽按同版`slot + 空itemId`取得wear清槽候选，不把普通wear套成休息审批。不可用原因必须可读，不在客户端算两用/轻型/盾规则。已装槽点击仍开独立详情，不改变网格。缺失/null loadout才退到旧equipment投影，未装`equip,value=1`、已装`equip,value=0`；不能同时显示新旧两套武器命令；JsonUtility缺字段产生的空activeSet归一为null。stale/新快照读取失败不保留“用”。右键菜单为紧凑深色列表：只用Tooltip细外框（density 2，让透明边距落在滚动区外），菜单项用Row轻高亮、左对齐文字，不套ButtonPlain青绿按钮或内层焦点描边；保留UiFocus导航/自动揭示，以行高亮指示选中，禁用行无高亮且原因可读。宽度按实际文字在200–360之间，单项/两项菜单不固定拉长，内容滚动、窗口高度有界，按真实preferredHeight排行；复用ScrollText时移除菜单viewport的额外纵向正文留白，两项菜单必须完整可见不滚动，不能只检查文字自身高度却漏掉父viewport裁剪。拖动期间抑制物品与槽位的悬停卡，落点提示不能被延时卡遮挡；`UiControlText`的小窗字号下限及打开后resize也须触发`InventoryMenuLayout`重排，不能用overflow或缩字藏裁切。`EquipmentSlotTests`覆盖五槽/ghost/精确提交/回调失效/切tab几何/菜单增字重排。物品正文以同版本`itemDetails.id`精确关联完整文本；来源缺失明确提示，不能用操作说明冒充属性。币与旧套装图标只做显式协议别名（gold-piece/gp、silver-piece/sp、copper-piece/cp、dungeoneers-pack、scholars-pack），仍不按显示名猜图。回归在`CharacterOperationsTests`/`PlayerIconTests`，包括新版快照后读取失败和菜单失效。

`RenderList`须在背包等专属布局的early return之前清理上一页`groupTitles`；不能只在普通列表分支清。跨页回归`EquipmentSlotTests.StatusGroupsDoNotLeakAcrossInventoryOrOtherTabs`覆盖状态→背包/法术/人物循环及零命令。

`ItemCardVisuals`是原物品详情与hover/F1卡共用的小装饰：typed单件重量/金币角标置于右下，已知rarity着色物品框与标题，普通非魔法none无特殊框但可去掉等值header。hasWeight/hasPrice区分0和未知—，不乘库存数量、不猜售卖价；元信息同版本/ID绑定，stale撤回。正文仅删除被相同typed值完整替代的精确独立header行，不删材料/条件/不一致事实，旧无标记响应仍保留原文。调整正文高度时给footer留位，保留独立详情/唯一operationContent、F1原卡及Alt手势，不另建tooltip层。完整字段归[客户端契约](../../../docs/client-contract.md#carried-inventory-weight)，`InventoryMetadataTests`覆盖DTO旧值/0、正文精确去重、弹窗/hover/F1与stale、0/unknown/overcapacity。

菜单回调须校验generation、scope、version和当前条目；Show/刷新、搜索、换类、Hide、pending/stale/读失败均使旧菜单失效，不能只禁新菜单而让旧引用执行。服务端撤回effects即无使用入口，不从物品名字推导规则。成本notice按实际preferredHeight增高并等量收缩详情，确认按钮不可被文本或提示覆盖。回归在`CharacterOperationsTests`与`HomeSettingsInventoryTests`，原生菜单/关闭仍另验。

主HUD导航与发送由`AdventureHud.ApplyNarrativeHud`绑定平角文字动作，徽记不再常驻主屏；`PlayerIcons.Class`仅BG3（角色窗数值块不再叠属性徽记底纹），用于`ChoiceGrid`可选职业图标。`PlayerIcons.Equipment/Spell/Interface/Surface`先查`Resources/UI/Art/BG3/<分组>`的博德之门3原版单图（用户要求优先；ID中`:`存为`_`；仅本机私用，公开分发前必须删除该目录，见玩家图标），未命中再按大小写敏感的精确 ID 从五个固定 `Resources/UI/Art/Player*` 图集缓存 Sprite（Equipment/Spells/Interface及EquipmentExtra/SpellsExtra；装备/法术先原图、未命中才查Extra），不通过名字或 effect key 猜身份，不为了素材增加规则或 DTO 字段。库存优先使用已有权威规则身份`ItemDto.rulesId`、缺失才用`ItemDto.id`；普通装备的`equipment:xphb:<slug>`和`xphb:<slug>`仅作明确美术别名映射到原slug（拆包后内容同样保留图标），不剥任意namespace、未知显式身份不回退runtime ID；详情同样精确关联规则身份而非显示名。法术与准备清单用 canonical spell ID；同法术多来源共用图片但不共用/预选消费 route。未知/缺图隐藏装饰并还原文字空间，动态物品没有 canonical 身份时保持文字。背包/法术固定格由局部`IconSlotName`按实际字体、字号与矩形显示完整短名或明确省略号，不静默裁切或缩字；完整原名仍由既有hint/详情拥有。窗口字号变化须重测，图→文字复用须清测量缓存，回归见`PlayerIconTests.MissingIconNamesShowExplicitEllipsisAtTheActualControlFont`。装饰`Artwork`复用原按钮内的 Image，`raycastTarget=false`、`preserveAspect=true`，不新增提示层或菜单。BG3布局件同样只在有素材时生效：`UiKit.Tab`（TabOn/TabOff页签）、`UiKit.Row`（透明行+Row高亮条+金字，替代色块与“◆”）、`UiKit.Ornament`（花纹小标题）、Slot/Tooltip/Dashed/NavOn/NavOff九宫格（边距见`Bg3IconImport.Slices`）；缺图回退纯色/纯文字。左栏顶部`SheetListHeader`：人物页为职业徽记（`className`小写查`PlayerIcons.Class`）+等级职业+种族·背景+“详情”，其他页签为花纹标题。法术页由`RenderSpellGrid`按`SpellViewDto.level`分组（戏法/N环/其他）排56图标格于虚线框，未准备半透明，提示卡写名称/环级·学派·准备状态/摘要，点击仍在右侧正文阅读与施放；“调整准备法术 →”保持行。真实 `.meta` 与来源/边界见玩家图标，回归`PlayerIconTests`覆盖精确身份、资源实载、缺图、刷新复用、图标格长中文、弹窗开关几何与多来源。补漏检查须包含 creation 与 advancement 的 canonical 目录；本机图库选图固定在 `scripts/bg3-icon-library-picks.json`，逐项核图并注明代表图/共用分支语义，不能把近似英文子动作当作通用法术。套装可共用背包图示，但不能因此合并物品身份、内容或工具规则。

穿戴wire和错误矩阵集中见[客户端契约](../../../docs/client-contract.md#wearables-and-attunement)与[后端规范](../backend/natural-effects.md#完整穿戴与同调)，不在UI复制规则。`ApiJson`以wearables.attunementLimit>0及equipmentStatus.armor非空归一缺字段对象（无甲也有明确armor文字）。`WearableUiTests`覆盖缺失/空对象、两类槽路由、成本/门禁、缺库存结束与RulesId图；`EquipmentSlotTests`/`InventoryDragTests`保留旧五槽回归。反例：按物品名猜同调、刷新自动提交或用空对象压掉旧栏；正确：只消费当前服务端候选，stale撤回命令，缺字段走原显示。

取消常驻刷新时必须保留同步与恢复：`NeedsRead`只在窗口打开、stale、非loading、无已知读错误、无pending时为真。`PollParty`收到快照后复用`OpenCharacterOperations`读取，不能打开已关闭的窗口；await后重验存活、session及generation。`ReadFailed`停止后台重试并显示一次明确“重试读取”；pending只显示“重试原请求”，从不自动重发命令。只读/未批准不等于不能恢复读取，读取与命令权限分别判断。

回归：CharacterOperationsTests覆盖缺失按钮、无空法术分类、45条滚动、无固定角色搜索/冗余hover、无能力裁定、来源成本与恢复状态；CharacterWorkspaceSyncTests通过真实TCP验证新版自动读、关闭/换席位迟到响应、失败后不再轮询sheet、显式恢复、草稿与0 POST。原生悬停/键盘/关闭仍须单独实测。

`RestWindowNotice`按连接/战役/席位及真实`party.rest`回执识别本人恢复窗口；`PollParty`仅在其他辅助页关闭后按需打开，关闭后不为同一窗口重复抢焦点，失败/换席位/迟到响应不可打开旧窗口。不自动花费生命骰、不代同意；生命骰按后续已确认的角色布局放在“状态 → 资源”，不恢复标题区生命骰、独立Hit Dice、休整时钟或建卡记录页；旧验收要求不得覆盖后续明确删改。回归见`RestWindowNoticeTests`与`CharacterWorkspaceSyncTests`。

## 可拖辅助窗与模态屏障

`UiWindowDrag`统一接管紧凑窗口拖动（用户要求弹窗都能移动）：标题，以及窗口内任何不自带拖动的空白处——`UiWindowFront`把冒泡上来的拖动转给标题的拖动器，并在同一文件负责窗体/控件聚焦置顶；`UiFocus.OnSelect`复用它，不给业务页复制拖动逻辑。滚动区、输入框、滑条保留自己的拖动；从按钮上起拖会移动窗口并取消该次点击。悬停提示卡同样挂拖动器：按住Alt锁定后（`UiHints.Hold/Release`）卡片接收指针，可滚动、可按标题拖走、可拖右下角`UiHintResize`调整当前卡片宽高；缩放从`PointerEventData.pressPosition`计算，不能吞掉越过拖动阈值的首段位移；松开Alt时若指针已离开原目标则关闭并改由当前指针下的提示接手，仍在目标上则只解锁；按下提示卡本身不触发`UiWindowDrag`的“关闭提示”（`UiHints.Owns`）。F1通过`UiHints.Pin`把同一个`HintPanel`原位放大并将正文切到`FullExplanation`（无独立全文时沿用Explanation），不创建新窗、不居中、不加暗遮罩；只按屏幕边界夹取，仍保留×/Esc和原焦点域以避免快捷键穿透。固定卡可直接滚动/标题拖动，按Alt可缩放。标题、副标题和底栏按preferredHeight排版，字号变化和用户缩放保持正文滚动。用户明确不要Alt操作说明文字：简卡底栏只留“F1 展开完整详情”，展开后只留“完整详情 · Esc 关闭”，按单行收紧；不因删文案移除Alt手势。源对象禁用/销毁、拖动Suppress、角色scope/版本变化或读失败撤回旧卡；同源同版资料刷新可更新当前正文。背包/装备槽共用精确物品投影（双手ghost只读主武器），法术FullExplanation含完整规则，取得来源在点击后的“施法来源”按需展开，不自动选择消耗。回归`UiWindowDragTests`、`PlayerIconTests`和`DesktopInputTests.HoverAltResizeScrollAndF1ReuseTheSameCardWithoutChangingTheBag`。置顶只越过同parent可拖窗口，不能越过显示中的固定页面或业务遮罩；设置/行动确认只移动内部卡片，不移动遮罩。全屏建卡页不挂拖动器；独立伙伴页已移除。Overlay Canvas下用整个实际游戏屏幕换算到parent坐标作为边界，不与居中`PlayerPages`阅读区求交；窗口保留原parent，不能为扩大拖动范围跨越模态屏障。无Canvas的纯几何测试用parent边界。尺寸/缩放改变后重夹取；150%超视口仍保留标题，内容由原滚动拥有。窗口只在从关闭到打开时居中；轮询重绘只改尺寸，不重设位置，否则玩家拖开的窗口每次同步都会跳回（`InputAndWindowStabilityTests`）。仅角色页打开时可和HUD共存，其他模态仍阻断底层。

`UiWindowDragTests`覆盖拖动边界、输入不变、同层置顶与屏障。EditMode新建EventSystem并不注册为current，测试直接使用实例，不能强写current制造Unity错误。真实Player仍需验小窗与放大后边界。读取`EventSystem.currentSelectedGameObject`后调用Unity组件方法须用`focus!=null`判断；`?.`不能识别已销毁对象，阅读卡关闭/重绘后会导致快捷键每帧空引用。`DesktopInputTests.InventoryShortcutIgnoresDestroyedReaderFocus`覆盖真实销毁焦点。

## 关闭、直接选择与日志层级

普通辅助窗口复用 `UiKit.CloseButton` 与原 Hide/Close，显式放弃、停止、显示还原不能改绑为×。建卡是root下的全窗口工作页，保存并返回/Esc自动保存草稿，关闭不丢弃；成功加入再归档完整角色，详见[建卡与本机角色](character-creation.md)。已发送pending独立保留。正常自动检查不保留重复按钮，检查失败在窗口内保留输入及重试入口，空或无 fingerprint 的检查响应不能静默当成功。

`UiKit.Choice` 基于标准 uGUI Dropdown；`UiChoiceDropdown` 只拥有弹出列表的焦点范围与关闭帧，不另建选择框系统。Tab 留在当前弹出列表，Esc 先关列表且同帧不再关父窗；销毁时清自身静态引用。测试真正 Show 前须让 uGUI Start 完成，不能为绕过 TweenRunner 生命周期修改包。长标签按实际 preferredHeight 扩行且保留滚动，不缩成小字。来源有多个时第0项为未选择；选回第0项必须清空 selectedRoute，不能外观未选择却保留旧命令。显示尺寸不同于命令来源，可默认当前尺寸；15秒预览/确认/还原由原 DisplaySettings 负责。

日志上的任务与人物读页作为上层窗口，关闭返回原日志及滚动；独立同伴读页已移除。`JournalPanel.Hide` 即使初次读取尚未显示，也通知协调器递增 `journalReadGeneration`；每个 await 后核对代次，防止迟到GET重新弹窗。服务器历史分页仍有界；只隐藏当前不可用的翻页/无更新工具，不能改成无限下载。回归见 `ElementAuditTests`、`DesktopInputTests`、`JournalReadSyncTests`、`FullCharacterBuilderTests` 和 `CharacterWorkspaceSyncTests`。

所有输入框经 `UiKit.Input`/`BindInput` 统一处理旧版 `InputField` 的 Esc 取消语义：Esc 只退出当前层，保留本次键入并让草稿监听收到恢复后的文字；多行框拒绝Tab字符，Tab只移动焦点。真实键盘仍需在原生Player复核。

紧凑输入框同时检查 `UiControlText` 的小屏字号提升：1280×720时Canvas0.8与页面0.9375合成0.75，20字号会提升至22；42px框内原30px高度小于31.25px字行，uGUI会整行截断。`UiKit.Input` 单行上下4px并垂直居中，多行保持原6px；测试须运行实际字号调整后再断言输入及placeholder都容得下，不只测初始20字号。不要用缩小中文字体代替修复。

显式网络查阅（角色、日志、世界检索、成长预览、建卡目录）由 `AdventureApp.RunRead` 进入，以“正在读取…”替换旧全局错误、成功后清空、失败再显示本次错误，读取期间发送按钮不显示“发送中…”；命令仍走原 `Run`，普通轮询读不走 `RunRead`，避免遮掉命令回执。异步读取回归必须让 app.alive=true，并同时测成功打开与关闭后不再打开，不能靠未启用的生命周期门禁得到假阳性。已有公开记忆时世界概览不显示“没有手记”的矛盾空态，见 `WorldUiTests`。

## 本次建卡、滚动与卡片展示

`CharacterBuilderPanel`持有编辑中的`BuildDraftState`，`AdventureCharacterCreation`通过`CharacterLibrary`接入独立草稿保存/恢复及加入后完整归档。来源选择和法术页按服务端groups/issues决定显隐，不按职业名猜；背景加点用候选行内互斥的+2/+1，另可选择三项各+1模式；不超额，未分配完由服务端拒绝采用，服务端仍独立校验。起始装备逐项展示，购置为同一表单内独立子页，分类/搜索和清单返回不丢本次输入。回归见`FullCharacterBuilderTests`、`PartyUiTests`与后端建卡测试；这些不能代替原生从零采用/加入验收。

`UiSmoothScrollRect`是单一滚动所有者，限跃幅后以非缩放时间平滑到目标；拖拽、程序定位、内容尺寸变化、关闭和减少动画选项取消旧目标。保持原Scrollbar与惯性，不接管`MapViewport`缩放。资产组件通过Editor迁移并保持引用，不另挂竞争的Update。紧凑间距由`AdventureHudLayout`与正文排版控制，不能双重缩放字体。回归见`ExperiencePresentationTests`、`DesktopInputTests`和`SidebarLayoutTests`。

`PartyPanel`只保留加入房间与本人加入欢迎页，删除独立同行卡片页及“查看队伍伙伴”入口；HUD/聊天头像仍按actor打开只读角色窗。`JournalPanel`仅三个NavOn/NavOff页签：历史原文、冒险回顾、任务与人物。J默认打开最近历史页，按sequence降序排列卡片与Body；后端after/through/nextAfter有界游标不变，翻页标为更早/更新记录。`AdventureApp.FormatEvents`保留已保存原输入、clarifications、changes、真实耗时、resolution摘要/战斗日志/检定及授权privateText，不显示内部narrativeSource。日志与正文时间通过`ActivityPresentation.RecordedTime`读取该条origin游戏累计时钟：行动/回顾取before，事件取after；缺失/倒退时钟明确未记录，不拿现实日期或最新snapshot伪造历史时刻。`IsEquipmentControl`仅在阅读投影过滤直接换装，审计/回执仍保存；全换装页显示空态并保留原有界分页，同调与正常行动不误删。回顾先GET recap取得元数据与截止version，再GET同范围activity，经StoryFlowPresentation显示已保存故事/更正/本人可读私密内容；按新到旧排列，不拿quests/party/branches替代叙事，不调用模型。无故事显示真实空态但仍保留有界翻页。每次await后检查session/actor/generation，关闭任一阶段都不复活；阅读放大保留滚动，更新通知不强制翻页。`ExperiencePresentationTests`、`JournalResourceUiTests`、`JournalReadSyncTests`和`DesktopInputTests`覆盖三页签、排序、原文/消耗、回顾投影及关闭迟到读取。

### 世界信息分类读取契约

1. 范围：`WorldPanel`按任务/人物/地点/线索/势力/抉择六类卡片阅读已有公开事实；静态与动态记录独立保留，不按同名猜合并。地点页才显示当前场景，查询限制当前类，正文未变不重建列表。
2. 签名：`WorldMemoryProtocol.Path(version,query,offset,kind="")`、`Matches(page,version,offset,kind="")`及`ApiClient.GetWorldMemory(...,version,query,offset,kind="")`复用既有`world/memory` GET。合法kind为空或quest/npc/place/clue；势力/抉择仅过滤静态记录，不发动态查询。
3. 契约：`scope=public&limit=32&expectedVersion=...`不变，非空kind加查询参数；query≤120、offset≤8192、页内条目≤32且同kind/version，不能混入隐藏记录。静态卡片同步按关键词过滤，不将其计入服务端动态total。
4. 错误：坏kind/游标/形状/版本拒绝；换类、关窗或版本变化递增ReadGeneration，旧回调不替换新类。失败保留当前阅读并显示既有RunRead错误，不自动无限重试。
5. 样例：正常人物查询只返回人物；无记录有分类空态；错误示例是无kind拉全部后在本地假分页。
6. 回归：`WorldMemoryPagingTests`、Core invariants与`WorldUiTests`覆盖kind URL/错类、游标、代次、分类/状态/小窗放大；只读入口不发命令。
7. 正误：不得把所有种类拼成一个长文本或按同名丢掉一条事实；应使用明确kind和独立标题/状态/正文卡片，搜索翻页仍由服务端拥有。

## 只读文字与空态投影

`build_character_reference.py`以固定维护包、原始pin和完整advancement目录生成391个法术（不局限建卡98个）；正文、材料、反应触发、双施法选项、表格与升环全部保留，额外头部事实由`factsZh`承载。准备页和仅取得来源的法术也用同目录`level`显示环级；此字段只在本地参考资产，不进wire DTO。18个condition用独立全文；资源优先本人`featureDetails`（保留恢复/notice），静态fallback使用明确class-feature/feat ID或物种单能力子树，不复制整物种。通用词条的手译全文依据同版本本地取证，不把旧“只支持一环/需主持代做”之类实现说明混入规则。回归`RuleReferenceTests`、`CharacterOperationsTests`及`scripts.tests.test_character_reference`逐项核对391全文/全部头部事实、状态全文、错类别、未知能力、成长与缺口提示。修改JSON后`AssetDatabase.Refresh`不会清除已载入的静态目录，验收必须经历domain reload或新Player，不能用旧缓存得到假通过。

`RuleReference`只在已知规则/职业/语言/体型/钱币字段进行结构化中文投影；规则资料展示可去Markdown标题/强调标记，不能全局重写用户姓名、叙事或输入。语言组按group类型显示“兽人语”等，物种名称仍是“兽人”。回顾职业后缀只转已识别结构，未知原文保留。回归见`CharacterOperationsTests`、`FullCharacterBuilderTests`、`ExperiencePresentationTests`。

`StoryFlowPresentation.LegacyRoot`仅接受实际旧玩家行动类型，不能将所有`content.*`管理事件作为故事根。无玩家行动时显示真实空态；`ExplorationMapPanel`只显示已选地点的详情，无节点或未选中时隐藏详情，不拼接通用knowledge；日志空态按真实分页状态给提示，不承诺不存在的翻页。回归见`StoryFlowTests`与`ExperiencePresentationTests`。

`PartyPanel.ReturnFromBuilder`清除打开建卡过程的瞬时loading提示，保留加入输入、真实错误/原pending；保存草稿返回不表示已采用角色或加入成功。建卡复核使用可自动增高的精确issue导航，保留全部漏项，法术页不复制整份漏项列表。回归见`PartyUiTests`与`FullCharacterBuilderTests`。

## DTO 与反序列化

使用显式可序列化字段和 Unity 支持的类型，名称匹配 camelCase 协议。不要往 DTO 放行为、Unity 对象或 Domain 引用。

ApiJson.Deserialize 统一处理 `JsonUtility` 将 null/缺失内联对象生成为空实例的问题。新增可空字段须在此归一化，并在真实 Unity 中测 null、缺失、合法实例；仅 Core 默认值测试不够。可空数字按协议的显式有效标记解释（如 `hasDc`、`hasPrice`），不能把 0 当缺失。

```csharp
// ApiJson：用契约身份字段识别不存在的对象，而不是 UI 到处猜
if (string.IsNullOrEmpty(snapshot.combat?.id)) snapshot.combat = null;
```

CoreInvariants 的 DTO allowlist 是回归检查，不是另一份协议所有者；新增契约字段须同步断言。

## 状态与异步

分清权威快照、未发送输入/建卡草稿、持久待确认请求、视图状态和图片缓存。不要用一个全局可变模型替代所有生命周期。会话与待确认文件按服务地址、战役、席位隔离；凭证属于私密本机状态。

异步开始时捕获会话和视图代次，返回后检查对象仍存活、会话未换、代次仍当前。只取消请求还不够，已经完成的旧响应也可能晚到。例子：AdventureStoryFlow.ReadStoryFlow：

```csharp
bool Current() => alive && generation == storyFlowGeneration
    && session == scope && snapshot == value;
// await 后先检查 Current()，再更新当前面板
```

- 按 [跨端契约](../contracts.md) 保留原端点和原 payload；不能因 UI 超时清掉未知结果，或新建 UUID 再执行。
- 已确认拒绝后的自动刷新保留当前已验证 pending store，不通过 `BindPending` 换代后再用旧 `Current()` 判断；否则真实拒绝原因会被“同步成功”覆盖。公共重新连接/刷新仍按既有规则换代。回归需包含当前 400/审核 403 以及刷新期间切席位/换代的迟到响应（`AdventureInputSyncTests`）。
- 更高版本同步不应重建所有控件。输入、滚动及同图缩放按业务上下文保留；换席位/地点时明确重置哪些状态。
- 事件订阅、协程、纹理和动态 GameObject 的所有者负责释放。复用未变化的纹理和列表，不在每次轮询重复分配/下载。主地图由战役/席位/地点拥有，辅助页关闭不释放；换上下文或权限失效必须释放。元数据与图片分别维护代次，在途同图下载不被元数据轮询取消，详细行为见 [地图生命周期](../../../docs/maps.md)。手动刷新也必须先检查请求会话与代次，再处理 401 或应用快照；旧席位失败不能清掉新席位视图，回归见 ExplorationSyncTests。
- 自定义正文重排时，先在旧尺寸下记录阅读位置；仅在正文确实溢出视口时使用 `ScrollRect.verticalNormalizedPosition`，内容全部可见时 uGUI 的 0/1 不代表用户选择了底部。`PlayerStoryPanel` 将短文扩展为长回复视为从顶部开始，已有长文保持位置；高度变化也要参与布局判断，重排后清除旧滚动惯性。回归见 `StoryFlowTests.ShortPendingStoryExpandsAtTheTopAndRetainsPositionThroughHeightChanges`，不能只测“长文刷新仍是长文”。
- `PlayerStoryPanel.Reflow` 手动排版后仅 `scroll.Rebuild(CanvasUpdate.PostLayout)` 更新本滚动区 bounds，再停止惯性并恢复位置；不能在输入变化回调中强制整 Canvas 渲染。uGUI 的 `InputField.SetText` 先调用 `onValueChanged`、后更新 placeholder；全局裁剪中的 `CanvasRenderer.hasMoved` 可触发延迟尺寸回调，进而禁用 placeholder、修改正在遍历的 `RectMask2D` 集合。仅删 `ForceUpdateCanvases` 也不充分：尚未完成布局的 `ScrollRect.SetNormalizedPosition` 会间接强制全局刷新。此局部方式适用于当前手动排版的正文，不机械替换依赖 LayoutGroup/滚动条布局的其他窗口。回归 `StoryFlowTests.ReflowUpdatesLocalBoundsWithoutRenderingOtherCanvases` 覆盖零全局渲染、短转长/字号/事项/隐藏重开和实际阅读位置；`AdventureBusinessSyncTests.OlderDiscoveryCannotReplaceAnAcceptedActionOrClearDraft` 覆盖真实输入占位变化、迟到读取、草稿及编辑零命令。
- 长历史读有界页，使用 StoryFlowHistory 一类纯协作逻辑，不用后台无限重试掩盖坏响应。

## 地图标记与输入所有权

`MapViewport` 用归一坐标乘实际纹理宽高绘制标记。同一 `id:contentHash` 的元数据刷新在 `CartographyPanel.Retain` 更新网格和标记，不调用 `SetImage`，保留平移、缩放、测距。图片/权限/上下文清除时同步清标记与详情；动态对象先 inactive 再 Destroy，当前帧不可继续显示私密内容。

标记子对象提供键盘 Selectable，但鼠标射线仍由 viewport 统一拥有，否则子 Button 会吞掉拖动、滚轮或测距。点击、拖动阈值和测距模式在同一路由裁决，不能每个图钉各自执行鼠标逻辑。`CartographyMarkers` 的按需详情纳入既有焦点/Esc 范围，generation 与当前标记校验让已移除标记的旧回调无效。

自动地图的元数据、下载与棋盘分别校验会话、场景及读取代次。选图使用最新授权列表，撤图后不能继续显示缓存纹理或保留已撤回的棋子交互；同图阅读状态不得被普通轮询重置。首次开场未保存时不能通过旅行改变入场地点；等待个人入场补充时，地图仍可阅读/缩放，玩家移动与旅行控件暂不执行。

`AdventureMaps.PreviewMapMarker` 点击时重新核对当前地图、当前标记和快照，只有已有可用 travel 才调用 `PreviewChoice`；不保存一份可执行的旧 ActionChoice，不给人物/任务猜测动作。测试见 MapMarkerTests（实际纹理变换、拖动/测距、空DTO、合法旅行、旧回调）和 `ExplorationSyncTests`（权限失败与旧会话响应清理）。

## Editor 与输入

操作工程必须先读 unity-pipeline skill，优先真实已连接 Editor。不要为修改界面重建工程、手写场景 YAML 或另起一个冲突实例。

新建/移动 Assets 内文件保留相应 `.meta` 和 GUID；使用 Editor 导入验证，不手工换掉既有资源身份。原型与临时验证脚本放 Assets 外，确需常驻自动化时才进入测试/Editor 程序集，不能带到正式运行时。

主行动框按用户要求为真正SingleLine，长句由uGUI横向跟随光标，不自动折行；Prefab的`UiActionInputField`在自身LateUpdate、基类延迟激活之后恢复本次submit前的光标/选区，避免重新激活默认全选覆盖草稿，只在原框仍被选中且可交互时恢复，不抢回点击/Tab移走的焦点。`AdventureHud`接收该框`onSubmit`并在同帧LateUpdate计算模态/IME门禁后消费，复用`RequestNatural`发送，拒绝的意图当帧丢弃；不再同时用原始Enter轮询发送，也不在`onEndEdit`发送（失焦不能提交）。保留Enter/小键盘Enter、busy/pending/Alt/Meta/模态门禁，IME候选与确认帧不提交，不改变其他多行表单或字符上限。`InputField.ProcessEvent`仅调用KeyPressed，不会运行真正submit/deactivate分支；相关PlayMode回归显式覆盖该顺序，原生Player另验真实事件队列。

UiInputGuard 处理 IME 组合期；输入框聚焦时禁用字母全局快捷键。输入/窗口改动的验收分清 EditMode、PlayMode 与原生 Player，详见 [验证规范](../verification.md)。

## 投掷预览与结果窗口

`ContextualRollPanel`只消费服务端可空 `pendingRoll.preview` 和原 `rolls/respond` 的成功回执，字段与错误合同归[按需投掷](../../../docs/contextual-rolls.md)。没有preview不得从description解析DC、推断单骰或自行算加值。确认前零骰；未知结果保留原payload，重试不建新ID。结果页复用 `StoryChatPresentation.PresentRoll`，无DC不按success猜成功，自动失败不造0点；先攻等从该回执的本人结构化check/attack读取，不能把整批NPC审计日志塞入投掷窗口。

本人新有效roll按战役/席位/rollId自动弹出一次，不先要求点击入口。业务同意、版本与available就绪后再开，战斗播放期间延后。关闭不取消；重复轮询、迟到回执不抢开。弹窗只放检定名、真实预览/结果和主按钮“投掷”，真实错误就近显示；普通状态不堆操作说明。

`ShowResult(snapshot,resolution,requestedRollId)`只能在调用方验证会话/代次并确认原命令后调用；普通GET pending消失不构成结果。先接收原投掷结果再应用其新快照，避免新wait覆盖眼前结果。结果的“继续”仅关闭窗口；播放锁不得禁用它，否则播放等待关窗会死锁。关闭结果后接续真实下一步，切席位清旧状态。`ContextualRollTests`覆盖待同意、播放延后、关闭和旧回执；最终仍须真实Player/服务/模型连续游玩查看布局及实际反馈。

Harness角色初始位置由AI DM决定，不创建「放置本人」及其隐藏回调；已在图上的本人移动保留原pending/幂等路径。旧持久spawn的精确恢复不改端点或payload，见[共享棋盘](../../../docs/shared-board.md)。

## 旧战役自然意图续答

仅在 authenticated discovery 明确返回 `409 harness_campaign_required` 的旧战役中，主自然输入使用 `actions/input`，由服务端决定新行动、意图补充/选择、投掷同意或退回角色的重交。`PlayerInputPresentation` 在正文显示审核状态、问题、候选来源/成本及明确投掷说明；有 pendingIntent/pendingRoll 不等于锁死 composer。已发送而未确认的请求仍须锁住新提交，角色未批准时不能借结构化按钮绕过门禁；401/403 不能全部当成可丢弃请求，只有已认证的 `character_review_required` 明确拒绝可按终态处理。

ContextualIntentPanel 只展示本人 pendingIntent；关闭不是取消。AdventureApp 对意图面板传 `autoOpen:false`，补充问题仍在主输入路径；本人新有效投掷按上述约定自动弹出一次。候选来源/成本由服务端提供，一次选择不叠第二层 ActionPreview。回答草稿按连接/战役/席位隔离，只有对应已保存答案才能清空，不能擦掉较新的输入。

`actions/input`、旧 `actions/interpret` / `intents/respond` 与其他命令共用 PendingActionStore，旧请求恢复不迁移端点/指纹。损坏文件进入 Blocked，HasPending 为真、CanRetry 为假，UI 同时禁新提交和损坏重试。SendPending 捕获 session、代次与 store，旧请求不能清除或更新新连接。故事正文只选 intent.request 根，followup 通过 intentId 获取真实结果；更正按精确 originSequence 覆盖当前正文，不串入别条行动或重复执行规则。当前行动/回应排在长世界信息之前；worldMemory 只作阅读投影，未知地点不生成地图节点。接口见 [主输入协议](../../../docs/input-driven-adventure.md)，回归见 `InputAdventureTests`、`AdventureInputSyncTests`、`ActionUnderstandingSyncTests` 与 `DesktopInputTests`。

## 业务冒险接入与本机恢复

### 1. 范围与触发

新战役的自然输入由 `AdventureBusiness` 协调，UI 保留 HUD 双控件输入栏及按需“本次行动”面板，不暴露内核模式。`AdventureProtocol` 负责无引擎契约检查和操作可用性；后端拥有执行、权限、检定与结果。完整 HTTP 合同唯一维护在 [业务接口](../../../docs/adventure-sessions.md)。

### 2. 入口与签名

- `ApiClient.GetAdventure / GetAdventureSession` 返回 `ApiResult<AdventureBoardDto / AdventureSessionDto>`；`SubmitAdventure(baseUrl,campaignId,token,endpoint,payload)` 仅接受狭窄业务路径。
- `AdventureProtocol.SessionPath(id)` 要求 `Guid:D`；业务命令限 `adventure/actions|opening` 或 `adventure/sessions/{id}/continue|stop`。不接受 query、额外分段或任意 URL。精确私人分享由 `PrivateStoryProtocol` 校验，沿原 PendingActionStore 提交，不属于模型会话命令。
- `PendingActionStore.TryBeginRaw(requestId,payloadJson,endpoint,adventureDraft = null,adventureDraftRevision = -1)` 复用唯一队列；`AdventureStateStore.Confirm(id,submittedDraft,submittedRevision)` 先持久保存位置/草稿，再清 pending。

### 3. 本机与响应契约

开场由 `AdventureOpening` 在已批准角色、能力读取完成、没有在途命令且没有既有开场会话时自动提交一次；GET、重开失败/未确认会话不得另起生成。开场请求只含 requestId/expectedVersion，不假造玩家发言或清除编辑草稿；公共开场用 `snapshot.opening` 一份持久投影，后来加入只补本人现况。失败提供显式重试，未知结果先保留原请求恢复；显式重新生成须说明会产生新模型请求。详见 [业务开场协议](../../../docs/adventure-sessions.md)。

`StoryChatPresentation` 按精确来源逐条绘制私人片段，仅本人可点击公开，主持不能代发；公开原文保留原角色标识，不替换第二人称代词。`PlayerStoryPanel` 的发布中/已公开按钮不可重复执行，旧 scope 回调失效。同版本新分享通过 `PlayerSnapshotPolicy` 的独立分享序号刷新；本 scope 已确认来源还需保存在 `AdventureStoryFlow`，避免迟到GET或快照尾部淘汰把“已公开”退回按钮。切席位清该缓存，不能按正文相同误合不同来源。快照尾部并非完整共享历史；回归 `PrivateStorySharingTests`。

`ApiJson` 在 JsonUtility 前校验业务字段真实类型、已知 phase、非空有效 sessionId、confirmation 形状；`needsConfirmation` 不接受空 confirmation，终态可保留残留确认。不能把缺失列表当成成功空列表。`ActivityEntryDto.steps` 展示所有已保存机械步骤，`initialResult` 仅是最后一步的兼容字段；有 steps 时不重复最后一步。业务 session 与 Activity 用可选非空 `actionId` 精确合并；旧记录缺失身份时不按输入文本猜骰点归属。

恢复记录按 `PendingScope.Key(baseUrl,campaignId,token)` 隔离。stop 的 payload 必须为空字符串、线上无 body；本机恢复 ID 不进入请求。草稿元数据只进本机文件、不进 wire/hash。`AdventureStateStore` 使用 schemaVersion=1、lastSessionId、draft、非负 draftRevision；DiskFileSystem 原子替换。确认仅清除原文本且原修订匹配的草稿，重输同文仍是新修订。坏文件保留并阻止覆盖；切席位不迁移私有状态。

### 4. 校验与错误矩阵

| 条件 | 客户端行为 |
|---|---|
| discovery 200 且形状有效 | 业务链；每次轮询均可 GET，不能仅按游戏 version 决定 |
| discovery 409 + `harness_campaign_required` | 原自然输入链；其他 401/404/5xx/损坏均不降级 |
| 请求网络/5xx/损坏/通常的401或403、成功却 sessionId 不符 | 保留原请求，只允许原字节重试；认证的 character_review_required 是明确拒绝 |
| stale_version / idempotency_conflict / 其他明确业务拒绝 | 保留草稿，清该 pending，刷新不重绑当前 store，提示原拒绝而非掩成同步成功 |
| needsAnswer | 主输入回答；非回答状态不把随意文字当成确认 |
| needsConfirmation | 精确匹配本人 waitId 才允许同意；有同一等待的权威完成结果后自动接续原行动，不再要求二次点击 |
| 原 intent 已结束但生成新 roll | 可自动接续至新 roll 等待，必须停下征求新投掷同意 |
| 缺失/不匹配结果、ready 中断或未确认 POST | 不推断完成、不自动补发；保留恢复或原请求重试入口 |
| ruling 要求 roll | 需 public event 同时绑定 rulingId 与 rollId 且 ruling=awaiting_roll；不猜关联 |
| stopped/failed/unconfirmed 的残留等待 | 不允许同意，可单独明确放弃；unconfirmed 不继续或 stop，不按相同原文补发，可发无残留冲突的其他新行动 |
| 更早 GET/POST 或 Refresh 跨 session/代次返回 | 不更新新席位正文、草稿、状态；已发旧请求留待原 scope 恢复 |

### 5. Good / Base / Bad

- Good：回答→精确同意→显示已保存骰点并自动接续→最终回应；本机保留下一步未发送草稿。
- Base：空 board 且无历史位置，提示新行动；保存过的终态从精确 id 只读恢复；多 active 明确选择，不隐式执行。
- Bad：坏 DTO/未知能力猜成 legacy；stop 构造假正文；把等待消失当成完成或自动同意下一项投掷；因为文字相同就擦掉较新草稿。

### 6. 必需测试

`AdventureInvariants` 覆盖路径白名单、bodyless stop 重建、原字节/草稿分离、坏文件保留和精确等待关联；`AdventureBusinessTests` 在真实 JsonUtility 下覆盖缺失/null/合法/终态确认。`AdventureBusinessSyncTests` 经 loopback HTTP 验证恢复、权限失败、完成证据后的自动接续/新投掷停下/丢回执不自动重发、旧链、同版本 GET、跨代次、草稿和多行动选择。`ActivityTests` 断言每步检定/消耗存在且不显示原始内核来源标签。最后通过真实 Editor→业务 API→Pi/MCP/fake 链并核对 GameView，不能拿 TCP 替身冒充真实服务执行。

### 7. Wrong vs Correct

Wrong：先 GET 新版本，然后用新 UUID/expectedVersion 重建未知请求；或用 `input == submitted` 清除后来重新编辑的同文。

Correct：从唯一 pending 读取原 endpoint/payload；回执身份正确后 `state.Confirm(sessionId, originalDraft, originalRevision)`，持久成功才 `pending.OnSuccess()`。GET 与打开面板仍只读。`CanAutoContinue` 只接受精确 rollId 的检定/取消回执、intentId 的完成/转入新等待回执，或同 rulingId 的 resolved；`TryAutoContinueAdventure` 在玩家界面空闲且无 pending 时通过原 continue 命令衔接，每个当前等待只自动尝试一次，失败仍由原 pending 或显式恢复处理。不能用帧刷新或轮询生成多个新请求。正常流程不显示“核对结果并继续”，菜单保留停止和中断恢复入口；另有未选中的 working 行动时也必须能打开选择列表。

## 连续群聊正文

Harness来源或存在steps的活动，空narrative不能用initialResult.summary作为DM临时正文；summary是机械/剧本材料，仍保留在冒险日志。StoryFlowPresentation的activity与FromSnapshot回退路径统一处理，骰点和失败/等待状态照常显示，旧直接行动摘要兼容。生成中working/stopping不显示泛化行动查看入口；真实待本人回答/确认与中断恢复仍可达，自动接续的已完成确认不放二次继续按钮。主聊天状态和辅助列表均消费 `StatusLabel(session,snapshot)`；列表缓存必须包含投影状态，不能只用未变化的 session.phase。已完成窗口只在同一行动进入 done 时关闭，不能在轮询时关闭手动重开的其他行动选择。回归为`StoryChatTests.HarnessReceiptsNeverFlashAsDmProseBeforeFinalNarrative`与`SidebarLayoutTests`。

客户端状态文字区分实际生成与人工等待：working显示“正在生成回应”，人工裁定显示“等待主持裁定”，沿原请求展示问题/理由；缺少具体问题时明确说明未提供，不编造。重复状态只在当前`needsConfirmation`且确认类型、wait ID和快照待办完全匹配时合并，stopped/failed等状态不能隐藏仍有效的pending。仅整理客户端自产提示，不改权威正文、不删历史存档中的技术说明；输入、停止、本人投掷和原请求恢复协议保持。

`StoryChatPresentation.Build` 按已授权 Activity 的 sequence 投影 player/dm/roll/private/system 消息；用非空actionId合并live回执，重复同文的不同玩家仍是两条发言。`AdventureStoryFlow` 从最新版本向前按不重叠的50事件窗口读取，累计到配置的完整对话轮数且找到当前本人待处理根，或到历史起点停止；空页和静默换装不算一轮，不能将50事件当成50轮。新version重读最近窗口以更新旧根，不无限累积旧聊天；读取期间到达的新快照在完成后接续读取，旧战役不能依赖同版本业务轮询来补回。每个await校验连接、席位代次、读取代次及响应campaign/游标/version；错误保留缓存与草稿；聊天读取失败清除本次attempt标记，原轮询可在同版本重新GET，不重发业务命令或模型请求。标准战斗只有同版本Activity加载后才展示对应快照战况/新短报，不能用snapshot尾部或run-wide outcome覆盖某一行动段。这个门槛只适用于snapshot.combat.standard非空的战斗；探索已收到的live.outcome不能因历史GET延迟或失败而隐藏，AdventureBusinessSyncTests.FailedHistoryReadKeepsExplorationOutcomeButStillGatesStandardCombat同时守护两种情况。`PlayerStoryPanel` 按消息ID复用行，预览与正文页复用同一组件而非正文再拼纯文本；短开场替换为首批历史时定位最新，底部读者跟随新内容，上滚阅读者以前部可见消息+偏移保持锚点，已有聊天的后台读取不插入“正在读取记录”行、不触发Reflow或停止滚动惯性；仅真正无内容的首读显示加载提示，失败保留错误与显式重试。HUD原请求重试在busy期间隐藏，AdventureHud仅按该入口实际显隐预留noticeSpace，不能把用于锁定新命令的HasPending直接当作需要恢复的提示。回归见StoryChatTests.HistoryReadsStaySilentWithContentAndKeepRealFailureRecovery和SidebarLayoutTests.InFlightRequestDoesNotInsertRecoveryBannerOrMoveStoryAndMap。加载或错误控件显隐仍保持阅读锚点。按真实preferredHeight排长文，沿用Prefab字体/字号模板及阅读缩放，不能全Canvas重建干扰InputField回调。私密内容只显示服务端过滤字段，不自行推断权限。

已记录检定由`StoryChatPresentation.PresentRoll`投影`StoryRollView`，`StoryRollCard`只绘一份`RollSummary`：“检定名称 · DC 数字 · 掷骰总值”。单一DC时追加记录里的“ · 成功/失败”（多DC不合并结论，自动失败为“失败”），无DC为“DC —”，automatic-failure为“未掷骰”。`StoryRollView.Breakdown`（“d20 17/8 取 X −2”）只在`ContextualRollPanel`结果行括号里出现。按实际preferredWidth收窄居中、preferredHeight与阅读倍率换行，不画框/徽记/公式/角色重复行。`ContextualRollPanel`和日志投影沿用三事实，真实死亡后果与重试仍保留。`UiKit.IconButton`提供36×36命中区、24px glyph及原UiFocus/UiHint；私人转述使用↗/✎，已公开用禁用✓。按原CanShare/sharingAllowed/会话执行，不加确认。回归`StoryChatTests`、`ContextualRollTests`、`PrivateStorySharingTests`，实际GameView检查1280/1920及150%。

裁定已落实剧情后果时，`StoryFlowPresentation` 保留实际 `ruling.rationale`；`story.mode=none` 的通用结算文本仅作次级附注，其他 mode 的真实 resultText 仍进入回应，缺 rationale 才回退 resultText。主聊天与回顾共用该投影，不改已存历史。

正文栏由`AdventureHud.LayoutHud`按地图和可用空间分配，无图宽度上限见上节；内部阅读层仍消费Prefab的`StoryMaxWidth`。`PlayerStoryPanel`的玩家、DM和私人消息透明、左对齐、同列，宽度统一为`min(正文可用宽度,1200)`，短消息不另收窄。阅读倍率只放大文字和相应间距，不同比扩大栏宽或消息上限。所有新旧消息显示全文，不提供聊天折叠；长文按真实高度滚动。`StoryChatTests`/`StoryFlowTests`覆盖全文、宽度、轮询、scope和阅读锚点，`SidebarLayoutTests.ReadingScaleKeepsTheSameColumnWidth`覆盖有图/无图的倍率边界。

`StoryDialogue.Split`识别成对“”、「」、『』及英文双引号，台词/人物名判定见上节；原CR/LF换行串保留在片段中，拼接必须精确还原输入。`PlayerStoryPanel`只在空行处分段：每个作者段落是一个`NarrationText`（单段消息仍用`MessageText`），单个作者换行留在段内为硬换行；段间额外留18虚拟单位，消息间留18单位，均乘阅读倍率。对白不再拆成独立块（用户2026-10-30确认：拆块会把“陶叔又惊又急，……”这类夹在两句台词间的旁白挤成孤行），而是在原句中用`UiKit.Dialogue`暖色`<color>`标签着色，与旁白同用宋体模板与`StorySurfaceView.ProseLineSpacing`；uGUI Text不能在一段内混用字体。richText只用于客户端生成的姓名/对白颜色标签，段落原文含`<`时整段保持plain。`ProseLineSpacing`(1.2，思源字体自带约1.45em行高，合计约1.75em)与`ProseMeasure`(34em)必须序列化在`StorySurface.prefab`：未写入YAML的新字段会沿用导入缓存里旧的代码默认值，改代码默认不会生效。日期/来源标题使用`Muted`，私人受众标题保留`Information`；私密正文用正体，转述按钮仍为“快速转述/手写转述”。回归见`StoryChatTests.ParagraphSpacingAndDialogueGroupsKeepTheOriginalSourceAndReadingWidth`与`HudPrefabTests.StoryReadingScaleUsesTheAuthoredTypefaceSizeWithoutOverwritingItOnRefresh`。

`UiKit.WrapCjk(text,value,width,balanceTail=false)`按实际字体、字号、宽度与画布采样测量换行，依`CjkLineBreak`避开中文行首/行尾标点，并将贴着汉字的空格换为不折行空格。只有正文/对白调用启用短尾处理：自然末行仅一两汉字时尝试从足够长的上一行借到四字；短句、Latin尾行和作者硬换行保留，富文本标签不遮掉硬换行。其他控件缺省不启用；缓存区分画布采样、richText和短尾用途。只改绘制字符串，不改消息或存档。完整性测试同时核对源消息/分段拼接、作者段界、全部字符及标签完整，不能要求含测量换行的`Text.text`与原文直接相等。回归为`CoreInvariants`和`StoryChatTests.ProseTailUsesTheMeasuredFontWithoutChangingHardBreaksOrControlText`。

`StoryChatMessage.ActorId`只属本地投影。聊天头像与左队员入口按当前actorId核对可见成员，首字占位不猜照片；未知/撤权头像不可读。本人复用原ShowCharacter，队友经`ShowMember(snapshot, actorId)`复用只读角色窗，禁止GET本人character/sheet或生成其命令。`IsReadOnly`使NeedsRead/Ready及装备、法术、恢复、成长、描述使用入口不可执行；迟到本人sheet响应以generation与只读门禁拒绝，撤权/离队/换scope清旧view并关闭。资料只含服务端授权Character，peer缺Build不补推私密设定。打开/关闭不改行动草稿，焦点沿用UiModalFocus。回归`CharacterOperationsTests.TeammateSheetUsesOnlyCurrentPublicCharacterAndNeverBorrowsSelfActions`与后台真实Player头像/分页/撤权0POST。

“设置 → 阅读与操作 → 最近对话轮数”由`UiAccessibility.SetChatTurnLimit(int,bool)`拥有，PlayerPrefs键`dicerealm.ui.chat-turns`，默认50。接受正整数；空、非数字、非正数或整数溢出保留原值并就近提示，不增确认或人为档位上限。已有偏好缺字段时默认50，读取坏值回默认；有效编辑结束保存并即时重排，调大按需读较早范围。onEndEdit读取`chatTurnsInput.text`（UiKit前置listener已恢复Esc键入内容），不能解析uGUI取消时携带的旧事件参数；`DesktopInputTests.ChatRoundSettingKeepsTypedValueWhenEscapeEndsEditing`覆盖实际ProcessEvent/Deactivate取消顺序。`StoryChatPresentation.Build(...,turnLimit)`以完整Activity根为一轮，检定/私密/获物/更正同轮保留；尚未关联的live行动占一个名额，已关联不重复计算，当前提示独立保留。`CurrentRoundKey/MatchesCurrentRound`只按非终态live.actionId、本人pendingIntent.id、pendingRoll.id及精确roll→ruling.originSequence、本人待处理裁定的originSequence找当前根；该完整根占N中一个名额，不因队友新发言裁掉，不按历史awaiting状态保留队友旧轮。读取缓存额外保留该根，显示仍取N轮；等待身份同版本变化也会重新读取。已成功读取时记住对应sessionId/actionId，终态旧行动在窗口外就不再追加成最新；新version或GET失败不清该事实，新session/换scope不会继承。旧无actionId响应仍兼容，不按同文猜关联。改设置递增读取代次，拒绝旧窗口迟到响应；不改模型上下文、存档、服务端历史或冒险日志的分页。聊天不再提供“更早的记录”无限累加入口，完整历史从日志查阅。`HomeSettingsInventoryTests`与`AdventureBusinessSyncTests`覆盖无效设置、默认50、稀疏事件/空页/静默装备、调小/调大及在途改变；真实隔离Player另验本机保存及进程重启回读。

回归 `StoryChatTests`（合并、骰点去重、长文、行复用与锚点、对白原文安全和头像actor身份）、`AdventureBusinessSyncTests`（TCP分页、旧根更正、失败/显式恢复、跨代次和草稿保持）；真实Editor/Player查多人长文、720p/150%、滚动与原Enter发送保护。可选actionId是显示关联，不替换requestId或旧pending原字节。

## 独立主页、设置与状态感知入口

游戏内菜单与标题主页是两个独立界面。HUD `Menu`和游戏内无其他上层窗口时Esc调用`ShowGameMenu`，展示`GameMenu`的返回游戏、设置、返回主页与×；×/Esc只关菜单，设置关闭回菜单，只有明确返回主页调用`ShowLobby`。复用`pagesRoot`、`UiModalFocus`与原遮罩，保持HUD可见但不可操作，I/M/J等快捷键不穿透；不清session、行动草稿或pending，不假称联机暂停。回归`HomeSceneTests`的菜单分离/设置返回/精确pending保持，实际Player另验焦点、键盘、背景及放大。

主页采用场景优先标题画面：正常为继续（有session/snapshot才显示）、我的房间、加入房间（主持时为「冒险」）、设置；历史房间必须能从主页直接到达，不能藏在冒险次级菜单。玩家的次级菜单只会有「加入房间」一项，所以主页按钮直接打开加入页；主持时才保留含主持工作台的冒险次级菜单。`LobbyScene`作为root全窗口背景置于`PageBackdrop`之前，不放在1600×960的`UiPageFit`之内；透明`Lobby`保留原焦点作用域且不自动加页面框。主页按钮复用`UiFocus`，仅将指示器收为左侧小标记，保留完整射线区域与键盘选中颜色。`LateUpdate`区分主页与其他辅助页，仅后者开启backdrop，并同时令主页CanvasGroup不可交互/不可射线/不可见，不能只靠位于pagesRoot下方的遮罩拦主页。Esc按加入等辅助页→（主持时）冒险菜单→主页逐层返回；真实错误与原请求恢复不随极简布局删除。结构、恢复及草稿见`HomeSceneTests`，焦点与指针见`DesktopInputTests.TitleMenuPointerAndKeyboardShareTheSameLayers`，实际多尺寸图仍须另核。

主页不能混入连接输入、分辨率或字号。设置是outside-zoom的不透明独立层，左侧阅读/显示/快捷键/连接，右侧实际设置内容；`UiAccessibility.Attach`由可选buildConnection回调嵌入`AdventureConnectionSettings`，不复制一份连接状态。阅读/整体字号100/125/150与动画直接选择，原Prefs键和显示15秒预览/Keep/还原保持。关闭恢复焦点，背后页面不可操作，连接导入成功关闭设置再读冒险，失败就近显示脱敏原因。

固定中文标题/数量/标签高度须容纳真实SourceHan `Text.preferredHeight`。uGUI不足一行时会整行消失，不能仅以Rect未越界作为通过。`HomeSettingsInventoryTests`检查新主页无连接字段、四设置分组/opaque/outsidezoom、实际字体行高及草稿；真实GameView/Player检查1920、1280、150%与显示自动回退。


`AdventureShell.ContinueFromLobby`是唯一的返回/继续入口：已有snapshot时仅关闭大厅，不执行ResumeAdventure、不重绑session/pending；仅有本地session时才读取上次冒险。无两者或busy时禁用。`UpdateLobbyActions`在Build/Awake读取session后、ShowLobby和UpdateButtons同步；host工作台仅host可见。`AdventureParty.BuildPartyPanel`读取pending join，只有原请求或损坏记录才显示恢复入口，损坏文件保留并禁重试，不新建请求替代。回归 `LobbyNavigationTests` 覆盖引用保持、无重复CloseLobby、无会话、busy、pending与corrupt；真实GameView核对布局。

玩家端仅加入或继续工作台已创建的战役。`AdventureShell`不构建创建表单，`AdventureApp.CreateAdventure`、`ApiClient.CreateCampaign`、创建专用DTO/路径已移除；不能只隐藏入口并保留可达回调。邀请加入仅保留`PartyPanel`完整建卡与`OpenFullBuilder`；没有合法完整build时不发送加入，无角色主动作进入建卡。新建独立空白草稿且使旧选择失效；继续草稿恢复输入并重验，关闭自动保存，成功加入才清理匹配修订。归档角色在目标服务校验合法后可直接加入，不要求重走向导；旧档与坏文件保留。`AdventureParty.JoinAdventure`不得提供无build分支或默认模板，姓名来自已采用的构筑。`CreatedCampaignDto`虽保留历史名称，仍是`/join`响应；不可按名字误删加入反序列化。连接导入和原pending恢复继续有效，旧host玩家仍可游玩。新无角色主持的`character=null`由`ApiJson`按id归一化；Import/Switch/Refresh在保存session、库或BindPending之前通过`RequirePlayerConnection`拒绝，保留原玩家状态。工作台创建无角色战役，服务端显式完整build创建仅保留协议兼容；新角色门禁与回执顺序见[跨端契约](../contracts.md#18-完整建卡唯一入口与无角色主持)。回归`HomeSceneTests.PlayerHasNoCampaignCreationSurfaceOrClientCommand`同时检查隐藏层级中无表单、无客户端创建方法/DTO且建卡/导入保留；`PartyUiTests`检查空白新建、完成即单次加入与pending门禁；`DesktopInputTests`在真实加入页覆盖IME事件、焦点和Esc层级。

邀请加入反馈由 `PartyPanel.TryJoin` 在回调前设置提交态，`AdventureParty.JoinWithFeedback` 在同一加入页显示脱敏错误；不能在回调后写“正在加入”覆盖同步失败。`joining.HasPending` / 损坏恢复状态禁新提交和建卡，但不移除关闭/原请求恢复入口；401等未知结果仍按既有传输分类保留原payload，不因中文“邀请无效”自行改成确定拒绝。采用摘要不拼canonical ID；加入成功使用本人 `PlayerInputPresentation.ReviewNotice`，不能把队长当所有玩家行动的唯一执行者。回归 `PartyUiTests.AdoptedJoinShowsReadableIdentityAndImmediateFailureIsNotOverwritten` 与 `LobbyNavigationTests.JoinFailureIsLocalAndUnconfirmedJoinLocksOnlyNewSubmission`；真实HTTP需另核未知保留与合法加入的审核提示。

### 房间入口与建卡中文展示增量

PartyPanel正常只收8位房间号、共享密码并选择本机角色或进入建卡，姓名由构筑拥有，不再要求UUID/一次性token。`PendingJoinStore`新schema2有rooms/join endpoint，旧无schema记录保留原join，不自动转换；房间密码不成为席位凭证，响应中真实campaignId经过校验后才保存session。后端与恢复合同见[第19节](../contracts.md#19-房间共享加入与创建后首次设定)。

BackgroundBonuses由属性页拥有；起源改背景清旧bonuses/采用，background_boost_invalid定位abilities。展示BuildName按类别+canonicalID查固定有源buildLabels，SpellName保持法术/同名装备区分；不能翻译用户姓名/经历或wire。选择项不用可见全文复制Explain，UiHint仅显示不重复caption的说明或确实被裁切的全文（图标格这类无可见名称的控件用`Title/Subtitle`作卡片标题）；提示呈现为BG3卡片（Tooltip框、衬线标题、金色副标题、正文、紫色底栏提示F1展开与Alt操作），F1沿用同一张卡片在原位展开完整正文；InputField caption只取placeholder，密码/用户输入不能进入hover/F1。真实字号与截断、1920/1280及引擎/原生分别验收，依据FullCharacterBuilderTests/RuleReferenceTests/RoomJoinSyncTests。


## 本机战役目录

CampaignLibrary 自动导入旧的最近会话与会话副本，不覆盖已有更完整的元数据；不同凭证各自一条记录，展示模型不含 token，目录位于 Unity 本机私有持久路径，不能当截图或日志分享。切换前必须先重试/确认当前未确认行动；目标战役有自己的未确认请求时先恢复它。列表是上次读取的元数据，选择时先读取权威快照成功后才替换当前会话，失败保留原会话；它不是服务端账号或云端存档索引。

## 本机传输与启动地址

### 1. 范围 / 触发
Windows Player 原生网络可能忽略系统 loopback 排除；Editor 成功不能证明 Player 成功。仅明确本机 URL 走托管直连，不关闭全局代理。

### 2. 签名
`StartupConnection.Read(string[] arguments)` 读取 `--dicerealm-server <origin>`；`LoopbackHttp.Handles(url)` 决定本机传输，`Send(method,url,body,token,seconds,file=null,maximumBytes=0,cancellation=default)`由ApiClient与MapTextureLoader复用；0保持已有JSON/导出行为，地图明确32MiB上限并传取消令牌。Reply.ContentType供图片验证，不把服务器URL当作可信外部下载地址。

### 3. 契约
启动参数仅设新加入地址，不写 session 或旧战役连接。地址必须 HTTPS 或 loopback HTTP，无 userinfo/query/fragment/非根路径；缺省 null、缺值或重复拒绝。托管传输仅 HTTP(S)+Uri.IsLoopback+无userinfo，UseProxy=false、AllowAutoRedirect=false；保留默认TLS校验、原body/鉴权、逐请求超时。远程沿用UnityWebRequest；JSON、资源文件、日志导出和鉴权地图PNG共享本机边界。地图先核对固定同战役image路径，再直连且不跟随重定向，Content-Length与实际流读取都限制32MiB，读取失效取消；之后仍核PNG MIME/签名/尺寸/SHA256及当前席位代次。临时文件在finally清除，坏图不显示。不能让元数据走直连而PNG仍进系统代理。

### 4. 错误矩阵
无状态/连接异常→Transport；取消超时→Timeout；3xx不跟随→Transport（未知结果不清pending）；401/403→Unauthorized；404→NotFound；5xx→Server；其余拒绝→BadRequest。共用MapResult继续处理明确业务拒绝和DTO校验，不凭网络分支改变幂等语义。下载失败清临时文件。

### 5. Good / Base / Bad
Good：新版入口将5191传给新版Player，旧战役5180不变。Base：无参数沿用原默认连接。Bad：改系统代理、允许携token重定向，或新加入地址覆盖历史session。

### 6. 测试
`StartupConnectionTests`、`LoopbackTransportTests` 覆盖校验/分流、方法/body/header、超时/重定向、业务分类与文件清理；`RoomJoinSyncTests`、`AdventureBusinessSyncTests` 检查真实TCP和pending。`MapDownloadTests`以真实TCP覆盖带鉴权PNG成功、坏hash/MIME、超大声明、401、302及读取中撤权；原生Player还须验证地图PNG真的到达loopback，而非只读元数据。最终按验证规范在原生Player完成真实建卡审核。

### 7. Wrong / Correct
Wrong：只设置NO_PROXY并凭Editor请求成功验收。Correct：确认原生Player实际直连游戏端口、真实流程成功，且系统配置不变。

### 建卡异步重绘焦点
`CharacterBuilderPanel.RenderBody` 对 EventSystem/当前对象用Unity `!= null` 判断，不能对可能已Destroy的GameObject使用 `?.name`。销毁body前清其中选中对象；异步评估期间暂不可交互时保存控件名，响应后仅恢复存活且可交互的同名控件。外部已取得焦点时不抢回，Show清延迟焦点。`CharacterBuilderFocusTests` 须实际选中对象、跨帧Destroy并连续评估两次；直接调用未选中的回调不能复现fake-null问题。

### 建卡紧凑布局的文字验收

`CharacterBuilderPanel/Steps`的紧凑导航与属性选项不得只检查RectTransform在屏幕内：思源中文Text实际preferredHeight可能大于字号，容器差1px也会在Truncate下整行不画。导航标题/状态分别给足真实行高，背景加点保留+2/+1与三项+1规则但不平铺七组合；当前界面只保留27点购，六行属性表应在默认桌面属性viewport内同时可见。`FullCharacterBuilderTests.CompactAbilitiesKeepAllAllocationsInViewAndNavigationTextReadable`覆盖几何回归，真实Player截图另查字形、标点和选中标签；不要用构建成功或旧截图证明密度达标。

建卡按BG3三段式（2026-10-05用户确认，推翻旧“不建右栏”）：左步骤（圆环+勾/感叹号、步骤名/当前选择或状态、竖线相连、`UiKit.Row`）、中面板（`Title`花纹页标题、职业/物种/背景为`IconCards`大图标卡+金框，缺图首字占位，描述在卡片悬停卡；选中项名称+`FeatureBox`特性框）、右侧只读`BuildSummary`（宽`clamp(0.21×宽,300,380)`，职业徽记、物种·背景、等级职业、六项分配预览、已选法术图标、职业训练与上次服务端检查的技能），`CharacterBuilderLayout.cs`拥有这些件。属性页照BG3：`Title("属性点数")`、居中“剩余点数”，居中紧凑列表（最宽840，行高52）：属性图标、职业主属性★、名称、−基础值+、背景加值+2/+1两列方格（仅背景三项候选可勾，其余为—，符合2024规则）、最终值、修正值；下方为“+2 / +1 / 三项各 +1”页签式模式按钮、“清除”（全部回8并清加值）与“使用推荐”（重走`InitializeAbilityDefaults`），再下为检查条。禁止再改成六张卡片或带`AbilityOverview`；列位置按表宽比例、按钮与数字框固定尺寸，窄窗口不重叠。`FeatureBox`与摘要栏熟练项为“标签：内容”左对齐行，标签染金（居中多行被用户认为难读）；职业特性框的施法行仅在有戏法/准备/法术书时出现。`IconCards`复用Selector做targetGraphic，给`button.colors`赋值前先把`canvasRenderer`设为静止色，否则重建的卡片会从不透明淡出，表现为切换职业时所有卡片闪一下选中框。列宽变化不缩放字体，不冒充权威HP等派生结果。基础未选显示破折号，修正值用floor((基础+背景-10)/2)；原Edit/evaluate链继续拥有失效与采用权限。属性页仅27点购，不创建标准数组池或方法切换；旧角色标准数组协议/存档不因此删除。`InitializeAbilityDefaults`仅在首次进入属性页或来源变更后触发，按当前12职业主属性优先级分配15/14/14/12/8/8（当前目录成本27），背景候选项按同优先级取+2/+1。推荐是可编辑的产品起步选择，不宣称官方唯一最优；战士明确标为力量起步。换职业重推基础和加成，单换背景只重推加成；往返、手动减点未用满、检查失败/迟到响应都不能再次填默认覆盖输入。默认和手动写入均走BuildDraftState.Edit，最终由服务端校验。回归FullCharacterBuilderTests覆盖全部12职业×16背景、未选来源、切源、手动保留与成本上下限。

`CharacterBuilderAbilities`在进入本页时构建一次`AbilityForm`；数字/加成点击与同页评估返回由`RefreshAbilities`更新既有Text/Button，不进入整正文销毁重建、焦点重选或归一化滚动。当前窗口尺寸下的表格行、按钮、数字与结果区固定Rect；加值方格内◆选中标记是独立固定子节点；三项+1时只禁用+2槽而不改变占位。`AbilityNotice`固定42设计像素高，viewport上下仅2px内边距，保证实际中文整行可见；长错误只在内部ScrollText滚动，不增减父content高度。不能只验证Text.preferredHeight小于Text自身高度，默认ScrollText上下12px会把紧凑提示裁掉，须另验viewport及真实截图。属性页常规检查只由本页检查条显示，侧边不再重复挤提示；保存/检查失败恢复仍显示。校验开始/成功/失败均保持外层尺寸，不使用已删除的上/下一步文案。PlayMode CharacterBuilderFocusTests逐帧检查pending/长错误/失败/成功期间控件实例和四角不变，真实Player仍需补逐帧几何与中文截图，不能仅凭零编译错误断言不抖动。
