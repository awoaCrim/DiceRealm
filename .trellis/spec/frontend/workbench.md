# 浏览器工作台分层与生命周期

## 结构和依赖

工作台创建战役时只提交名称与可选内容，不创建玩家角色，也不提供预设或完整建卡表单。新主持`character=null`且`party.isHost=true`是合法状态：冒险页只读概览，无composer/玩家轮询；默认主持处理，成长隐藏，空角色纠错明确邀请提示。旧真实玩家席位保留原行动能力。零成员休整响应须三种选项全部不可用并有原因，不能误判为不完整。跨层门禁/旧回执见[完整建卡与主持合同](../contracts.md#18-完整建卡唯一入口与无角色主持)，回归`host-only.test.js`/`party-rest.test.js`。

工作台是PC管理工具，不复用Unity沉浸式少控件目标：保留有任务依据的信息密度、查找/比较、可见管理操作和追溯恢复；共同交互原则及双端区别见 [使用者流程](user-experience.md#主持工作台的平台范围)。

工作台采用原生 ES modules，无 React、TypeScript 或前端构建器；不要为了遵从模板引入 hooks、状态库和打包链。只有真实维护收益且有迁移范围时才考虑更换技术。

- [main.js](../../../client-workbench/src/main.js)：账户登录、战役选择、快照、路由代次、统一提交/恢复和顶栏状态；[accounts.js](../../../client-workbench/src/accounts.js) 与 [account-view.js](../../../client-workbench/src/account-view.js) 拥有账户传输、登录和用户管理界面。
- [api.js](../../../client-workbench/src/api.js)：端点 allowlist、字段序列化、HTTP 与响应验证。
- [session.js](../../../client-workbench/src/session.js)、[pending.js](../../../client-workbench/src/pending.js)：连接约束、席位隔离的未确认请求。
- [navigation.js](../../../client-workbench/src/navigation.js)：唯一的页面目录与旧路由别名；`story.js`、`world.js`、`content-page.js`、`room-settings.js`、`request-log.js` 拥有实际视图，不另建跳转聚合页，也不各自发明网络/恢复策略。
- [rule-labels.js](../../../client-workbench/src/rule-labels.js)：规则名中文显示（只用于显示，载荷保持规范 ID）；名称数据 `rule-names-generated.js` 由 `scripts/build_character_reference.py` 与 Unity 目录同源生成，勿手改。工作台文件名不能带 `.zh-CN.` 这类文化段：服务端把它当卫星资源编进 `zh-CN/` 程序集，浏览器得到 404。
- [dom.js](../../../client-workbench/src/dom.js) 与 `styles/`：安全 DOM 与共享样式。纯投影或状态逻辑按业务拆出，如 [tasking.js](../../../client-workbench/src/tasking.js)。

新复杂逻辑使用可命名的小函数，不复制已有文件的压缩长行。JSDoc 用于容易误用的数据形状，不要求给所有显然的值加注释；运行时边界校验不能由注释替代。

## 视图协议

视图接受 `renderX(mount, ctx)`，经 `ctx.read/submit/refresh` 访问 API。新写端点必须同步 `api.js` 的分类、请求字段、路径、响应验证和 pending 行为；不绕过 `ctx.submit` 直接 fetch 修改战役。

`main.js` 用 `renderGeneration` 防止晚完成页面替换当前页面，并对旧 mount 发 `dispose`。视图里的异步读取、监听器、定时器和 object URL 也应服从本地生命周期：

```javascript
let disposed = false;
mount.addEventListener('dispose', () => { disposed = true; }, {once: true});
const data = await ctx.read('activity', {after: 0});
if (disposed) return;
// 再更新本视图；需要时还检查请求代次/预览版本
```

不要把全局渲染代次当成每个面板异步都已安全的证明。预览用请求版本和表单 revision，提交前重新核对，见 [StoryReview](../../../client-workbench/src/activity.js)。

全局AI配置是单独的本机管理资源，`ai-settings.js`使用同源operator transport，冻结当前管理员账户的Bearer，不借用战役`ctx.submit`或游戏pending存储密钥。页面直接读取/保存，主辅均可选择OpenAI/Gemini原生；测试点击即单次请求，无解锁或重复确认。配置CAS、在途快照、密钥不回显、原回执和账本合同统一见[AI设置](../backend/ai-settings.md)，不在此复制安全或协议实现。

导航到新页须在等待数据前 dispose 旧正文并显示目标页读取状态，账户页也不例外；失败留在目标页并提供重试，401沿原退出路径处理。主读取与局部读取均拒绝旧会话/旧代次响应，不把 URL 改了而正文仍可编辑当成正常等待。

## 公共对话框拖动

`dom.js`与`workspace-dialog.js`统一使用`dialog-drag.js`：只在`.modal-head`非按钮/输入/链接区域捕获指针，关闭清监听、捕获和ResizeObserver，窗口或内容变更后限制视口边界。保留原生dialog的top layer、inert与Esc，不用close/showModal循环或自建z-index穿透确认层。位移通过Web Animations，不开放inline style/CSP。

暂停动画在time zero使用两个相同transform端点。单关键帧会从底层样式开始，测试替身能看到位移参数而真实浏览器不移动；必须用headless真实pointer拖动核对bounding box，不能只靠DOM shim通过。

## 三类本地状态

- 权威快照：只接受服务端返回，不能乐观扣资源或用响应文案拼状态。
- 未发送草稿：当前主持回应/后果草稿在 [drafts.js](../../../client-workbench/src/drafts.js) 内存 Map 中，调用方使用 `ctx.scope` 和实体 ID 隔离；跨页面保留，刷新浏览器不保证保存。新增可恢复草稿要明确存储期限、schema 和清理策略，不伪称现有内存草稿可长期恢复。
- 已发送但未确认请求：保存到当前标签页 `sessionStorage`，发送前持久化完整原请求，重载恢复；不承诺关掉标签页后仍存在。账户scope包含origin、战役和稳定用户ID的摘要，重登不丢原请求；旧席位scope仍用token摘要。摘要不是加密，存储里仍有需要保护的凭证/请求。401不清原请求，重登同用户才能原样恢复。

共享重试、终态错误和纯预览保证见 [跨端契约](../contracts.md)，不要在表单里重新实现。切换路由/刷新不得把预览版本静默替换成新版本；明确选择新操作后才生成新 ID。

提示词正文/工作方法另由 `prompt-editor.js` 持久到同标签页 `sessionStorage`，key含原 `ctx.scope`、schemaVersion1与冻结baseVersion。切页/刷新恢复，版本变化保稿并显式采用新base或放弃；损坏记录不覆盖。activate确认只结算对应草稿，并通知同scope已重开的编辑器，不能因切换全文模式复活已确认草稿；更晚输入保留为冲突待处理。关闭标签页不保证保留，且此草稿不是已发送请求的pending。回归 `prompt-import.test.js`。

提示词编辑界面采用固定操作条与左右目录/正文：System 段落和工作方法分组，仅当前项可见；切目录、切全文、导入、刷新仍使用同一 sections/methods 草稿。不得因重排增加第二套保存链或将方法内容并入 System。目录编辑与原文阅读分别保留规范化/逐字合同。

## 提示词注入可见性

提示词透明度必须覆盖完整请求组成，不是只将编辑框的system再复制到一个预览。`prompt-editor.js`用「编辑提示词／注入位置／已发送请求」分开编辑、来源说明和真实数据；说明必须标明首条user的input/ruleset/memory、对话及工具结果、末尾execution_state具体字段、tools裁剪和按需方法的来源/条件。不得把静态说明或当前状态拼成“下一次真实请求”。

真实请求复用`requestLogCard`和原host-scoped model-requests/model-request，只在选择时读本战役日志，不新增权限、模型调用或预测端点。详情验证选中id/campaign/run，迟到/失败不沿用其他正文；旧冻结版本与当前生效稿可不同，缺日志明确提示。工作方法只是skills_list/read按需返回的参考数据，不自动System注入，也不保证模型会读；强制要求写入System。

保存仍走原draft→publish→activate、CAS/草稿结算，编辑器的LF规范化不冒充原active.prompt；生效原文用明确按钮在只读窗口逐字符展示。只改战斗正文或工作方法时，未编辑的探索正文须提交原base.prompt字节，不得顺带CRLF→LF；比较规范化草稿与base来识别实际修改。浏览器textarea.value赋值即可能规范化换行，sync只在值不同于原战斗稿的LF视图时更新稿，不以读取控件冒充用户编辑。`prompt-import.test.js`须模拟真实textarea换行行为并断言另一份正文/方法不变；真实headless浏览器核对导入、保存和只读原文，DOM shim不能独立证明逐字保留。请求解析仍用`splitPromptRaw`保留标题/CRLF/原part边界，不插合成换行。请求分段常显，原始JSON通过具名按钮读取，不恢复箭头折叠。切页、晚确认、冲突和焦点沿原生命周期。回归`prompt-import.test.js`/`request-log-reader.test.js`验证真实日志不同于当前稿、缺失/失败、纯读与保存；真实嵌入浏览器另验100/150%、动态正文及草稿。

## 审核与世界纠错草稿

`character-review.js`、`world-memory.js` 的审核/纠错复用 `ctx.submit` 与原请求重试；正常世界记录只读，无逐项创建/审批队列。纠错冻结战役版本与memory revision。后台已移除所有叙事更正入口与新草稿组件；`activity.js`只保留历史更正读取和旧pending的精确确认清稿，兼容API/原字节重试不删除。协议与隐私边界见 [输入驱动冒险](../../../docs/input-driven-adventure.md)。

提交已获确认后，即使跟随刷新失败也不能复活原草稿：共享正常/重试确认入口清匹配的 scope/草稿修订/版本，并让旧组件 settled；纯 `update` 不偷偷重新存入已确认草稿，迟到的 toggle 也不得复活它。提交过程中产生的新草稿不匹配旧确认，必须保留。版本冲突由显式“放弃草稿并载入当前记录”处理，dirty 草稿不自动重基。回归见 [world-memory.test.js](../../../client-workbench/tests/world-memory.test.js)，需覆盖 2xx 后 GET 失败、旧组件事件、新输入及真实丢响应重试，而非只测 happy path。

## 逐图用途与比例尺

`content-page.js` 的「地图图册」通过 `map-reader.js` 浏览、校准及选择当前图。浏览只读 `maps` / `map-image`，不生成、不自动切换；用途独立于Kind与距离。已保存的 `grid.scaleBasis` 区分 source/dm/unknown，缺值显示未记录；unknown/uncalibrated 或缺少有效单位不能展示可靠测距。HTTP字段和范围以 [地图合同](../../../docs/maps.md) 为准。

主持保存沿 `ctx.submit('maps-grid',{mapId,expectedVersion,grid,purpose,mapDraftRevision})`，地图版本冻结在取稿时；成功撤下发布，用 `maps-publish` 重新公开。`mapDraftRevision`仅本地恢复，API序列化剥离；`main.sendOriginal` 正常/重试成功均调用 `confirmMapGridDraft(scope,payload)`，只清同scope/id/baseVersion/revision，保留在途新稿。409保留旧版本草稿，只有“放弃草稿并载入当前记录”重基；已确认组件不能靠迟到事件复活草稿。

两点取尺按图片自然像素与实际显示矩形换算，SVG显示端点/连线；输入已知实际长度后换算 distance/cellPixels。有原网格保留cellPixels/offset；无网格按实测跨度保存同物理比例。方格对齐预览沿现有格距与偏移，不按分类猜5尺。表单说明、端点与对齐样式复用语义令牌，不开放inline style/CSP。

“设为当前地图”走 `maps-select`，同时冻结战役 `expectedVersion` 和 `expectedMapVersion`；仅当前场景已发布就绪玩家图可选，不传送单位。没有选图时不下载像素，空图隐藏尺寸控件。主持/玩家/发布状态有文字标记。图片用鉴权Blob/Object URL；`renderMapsPage`须向内部reader转发dispose（普通Event不冒泡），切图/离页/失败回收URL，局部代次拒绝旧响应与旧编辑器写操作。原始尺寸只在局部容器滚动。

正确：同图200px已知20ft→保存每像素0.1ft，原100px网格仍10ft。错误：按用途填5ft、切图复制归一化落点、成功时无条件清草稿、只监听未收到dispose的内层视图。回归 `map-reader.test.js` / `map-scale.test.js` 覆盖权限、两点缩放、未知尺度、跨图/晚响应、双版本及原请求恢复；真实嵌入浏览器核PNG、保存/发布/选择、丢写响应后重载逐字重试和100/150%布局。

## 私人消息与转述

`story.js`按source（含partId）去重授权片段，不能按相同正文合并不同来源；entry.privateParts已含裁定来源时，不再追加无source的legacy裁定正文。新消息可能有多位收件人，标题使用“指定玩家与主持可见”。canShare为实际收件授权，不能用isHost全局禁止，也不能按行动者推断新消息。公共开场为空但有privateParts仍应显示，没有内容不造公共占位。

“快速转述”不打开dialog，直接经ctx.submit冻结source+quick:true（不含text）；“手写转述”打开空textarea，关闭零提交，提交冻结source+明确text（≤1024）。快速按钮沿同一pending门禁防连击，不能绕过生命周期或换ID自动重试。失败且已有pending时，input事件不能重新启用新提交；恢复只走main原请求管线。retelling回执核精确source/partId、本人；手写核精确正文，quick核非空合法≤1024生成正文，不将源标成整条已公开；main只为旧无publication全文分享登记完整ack。原pending无text保持原字节，新文本不注入旧回执。参考`private-story-sharing.test.js`、`quick-retelling-alerts.test.js`与真实headless丢响应/重载验收，业务字段归[私人剧情](../../../docs/adventure-sessions.md#私人剧情按实际知情者交付与主动转述)。

同一Activity有非空harness叙事时，精确关联的combat条目放入details，正文优先叙事；无叙事仍显示原短报，不额外调用模型。按原activity sequence保留详情展开及summary焦点，后台刷新不可收起正在阅读的记录，不按相邻文本猜归属。

请求错误提醒使用战役列表的 `failed=true&unresolved=true`；普通请求日志保留失败审计。恢复匹配由服务端拥有，不在浏览器按同Run任意成功隐藏失败，传输恢复不代表剧情已提交。

## 战斗概览与已结算短报

1. **适用范围**：剧情战况入口、先攻/格位/单位详情和战报。`combat-reader.js`拥有只读窗口，`combat-log.js`拥有已存结果展示；不新增战斗导航、DM代投或移动入口。
2. **接口**：`ctx.read('combat-overview')`读取战斗概览，`ctx.read('board-token',{entityId})`读取实际棋盘实例；形状及权限见[工作台战斗信息](../../../docs/workbench-combat.md)。原快照、Unity DTO与工具目录不为网页读取扩充。
3. **合同**：未开战时也须读取概览，才能显示全员先攻等待。主持无角色合法；普通席位不发主持读取。概览/详情绑定campaign、timeline、version、combatId、选中实体与窗口代次。依托原看板更新，不另开轮询链；保留页签、选择、局部滚动和焦点。格位与先攻仅按权威cells/units/turnOrder呈现，不重算顺序或规则。
4. **错误处理**：读取失败暂停并显示显式重试；旧版本/错误实体拒绝。读取到比快照更新的版本时等原快照同步，不把正常竞态当成无限重试。关窗、离页、读档、新战斗清旧资料；空战况不留壳，已结束战斗保留结果但不标当前者。
5. **兼容与边界**：有`steps`按实际步骤顺序呈现`result.check/combatLog`，`initialResult`仅补未覆盖事实；无steps沿旧initialResult。新战斗从sequence1重新计数，去重必须带presentation.combatId；旧无combatId只去确切兼容副本，不跨步骤按sequence猜身份。无AI叙事仍显示已结算结果；只省略与combatLog精确相等的system生成叙事，保留作者正文和旧开战指导。
6. **验证**：`combat-overview-api.test.js`检查身份/响应与GET；`combat-story.test.js`检查无叙事、顺序、跨战斗及纯文本；`combat-reader.test.js`检查选择/等待/迟到/结束。浏览器另验真实格位、实例详情、历史阅读与100/150%布局。后端权限、隐藏单位和零副作用由`WorkbenchCombatTests`覆盖。
7. **正误例**：错误为只看本人`pendingRoll`，导致无角色DM看不到全员先攻；正确为读取主持的窄化waits，只展示等待，不修改ActingActorId冒充其他席位。当前战报末200条须称近期，更早记录沿原activity分页，不伪称整场历史。

## 安全与可用性

- 仅同源 API；后台登录后从账户列表继续战役，不读连接文件。远程要求 HTTPS，凭证不通过query/hash传递，不跟随重定向；旧Unity连接解析兼容仍核对origin。
- 剧本、用户输入、模型文字都经 `textContent`/文本节点渲染，不用 `innerHTML`。CSP 和服务端鉴权继续保留，不能因方便预览而关闭。
- 使用语义按钮、label、details/dialog 和可见焦点；确认关闭后恢复焦点。不用颜色或 hover 作为唯一说明。焦点环统一 `--focus`，颜色、字体与组件状态见 [视觉规范 V3](visual-v3.md)。
- 模态打开时页面`#notice`被遮罩挡住：`main.js report()`同时把错误放进最上层对话框标题下；无模态但右侧事项处理窗打开时写入 `.pane-alerts`（有未确认请求均附“重试原请求”）；本地表单校验不把顶栏标为“请求失败”。主导航只在主持身份变化时重建，换页后焦点留在同一局部页签，否则落到页面标题。
- 普通浮层使用 `dom.js` 的 `closeButton(label,onClose)`；`confirmDialog({title,lines,confirmText,danger})` 的右上×/原生Esc只返回false，只有具名确认返回true。关闭不执行停止、放弃等待、撤权或归档。打开确认前不要先禁用触发按钮：dialog本身令背景inert，按钮仅在真实HTTP期间禁用，否则恢复焦点会失败。
- `topbar.js` 只管理阅读/账户两个浮层：我的战役、admin用户管理、修改密码与退出归账户菜单，不保留重复战役连接面板；选择账户操作先关闭浮层。互斥打开，Esc忽略composition、229、defaultPrevented及原生open dialog；一次只关闭最上层并回到summary。正文details是内联折叠，不一律注入×。字号直接select、动画直接checkbox，保持 `dicerealm.display.v1` 存储兼容。回归见 `layers.test.js`、`readability.test.js` 与真实浏览器焦点/逐层Esc。
- 按状态减少无效控件，不隐藏业务恢复：无bitmap时地图canvas、适应/网格/测距与姓名索引均不显示（含初始化、setMarkers和clear路径）；有图时保留可发现的紧凑−/+和适应窗口，手势/快捷键作补充；有测距起点才显示清除。单纯干净纠错草稿不显示放弃，dirty/冲突仍提供显式恢复。轮询页可隐藏冗余刷新，静态页不得据此丢掉读取入口。
- 普通席位可以读到允许的进度但没有主持写表单；本人行动输入/继续/停止走窄化的 seatMutations 白名单（`adventure-act`、`adventure-continue`、`adventure-stop`），不能把所有工作台写端点放宽。审核与真正权限仍由服务端执行。
- CSS 只用 [视觉规范 V3](visual-v3.md) 的语义令牌（`:root` 外不写颜色字面量），复用任务布局，保障桌面窗口缩放与阅读放大；不要求 H5／手机布局、触屏交互或手机视口测试。不要为手机增加断点、抽屉导航或独立组件，也不为了取消该目标而大删既有通用样式。不复制组件样式或加入内联脚本绕 CSP。

[DiceRealm.Server.csproj](../../../server/DiceRealm.Server/DiceRealm.Server.csproj) 将工作台嵌入服务端构建，磁盘改 JS 不会自动更新已运行版本。验证从 `node:test` 到真实浏览器按风险选择；DOM shim 不证明布局和网络恢复。参考 [activity-render.test.js](../../../client-workbench/tests/activity-render.test.js)、[client.test.js](../../../client-workbench/tests/client.test.js)，命令见 [验证规范](../verification.md)。

## 主区导航与兼容链接

`navigation.js` 是唯一页面目录，分组描述工作类型而非权限：「本场」为 `#/story` 剧情（`story.js`，聊天记录与按需处理栏）与 `#/world` 世界记录（`world.js`）；「战役」为 `#/room` 邀请玩家（仅 host，按需共享密码，不回显密码，已有玩家仍可邀请）与 `#/saves` 存档与重开；「内容」组 `#/campaign` 剧本、`#/maps` 地图图册、`#/prompts` 提示词均由 `content-page.js` 按 host 权限分派。某组页面对当前席位全部不可见时整组不渲染。空房剧本页仍用 `initial-adventure.js`，启用后读 `adventure-reader.js`，不因直达页拆分丢掉首次设定/剧本库。旧 `content`、`prepare`、`prepare/settings` 映射 campaign，`prepare/maps` 映射 maps；不额外建立聚合页。`#/requests` 请求日志（`request-log.js`）与 `#/ai` AI 设置是账户页，仅 admin，可不选战役。旧书签按职责别名到新页面，不另建重复入口。剧情线分页读取 `activity`（50 条事件窗口，显式向前加载）；新版本重读已加载范围，更新旧根的完成回应/更正，不只追加新根。在途读取期间的新版本需合并为一次后续读取，避免看板已推进而正文漏更新。`story-progress.js` 仅主持独立轮询 `adventure-progress`，不受游戏version限制，轮询器不画顶部汇总面板；`story.js`按非空actionId与actorId双匹配，将每轮model/tool/final步骤紧随原DM正文。尚无可读activity或原根尚未分页载入时，先用run.input显示本轮玩家原文，再按运行version放独立过程消息；原根到达后合并、不重复；旧无关联字段不按姓名或最近消息猜。`succeeded`后保留并默认折叠，等待/失败保留。近期轮询仍是有界窗口；旧轮按actorId/actionId精确GET历史，成功缓存不被latest1替换。紧凑步骤按钮打开独立`story-trace-reader`宽窗口，按actor/action/number读取已存参数与结果（包括最后一个工具），不内联长正文；HTTP页签才按runId读摘要、选中请求再用publicOnly=true读详情，响应/请求/概况分开阅读，公共投影由服务端完成；不能只在DOM隐藏reasoning或透传未知原始内容。HTTP原文仅全局最近300条，过期提示缺失，不伪称没有调用。读取失败暂停并提供显式重试，dispose拒绝迟到回调。进度刷新也会改变消息高度：保留首个可见消息的稳定key和相对位置、各轮步骤列表及详情窗口的阅读位置；HTTP分页不换当前正文，刷新列表按钮独立于status文本；复用过程DOM，迟到历史读取尊重已经收起的状态，并把仍位于旧summary的焦点交给新summary；只有原本在底部才跟随，加载旧页不跳到底。剧情读取错误独立保存，不能被另一次成功进度轮询擦掉。安全授权与载荷见[业务接口](../../../docs/adventure-sessions.md#主持执行进度只读)。提示词“保存并生效”依次调用 settings-draft → settings-publish → settings-activate，改动正文时内容版本 +1。“从文件重新载入提示词”读取UTF-8 .md/.txt，仅替换编辑中提示词并保留工作方法，不自动提交；1MiB读取边界与32768字符正文上限，坏编码/空内容/控制字符拒绝且保留现稿。读取后清file input，允许同一路径修改后重新选择；文件读取和保存期间禁用整个fieldset，dispose后不得发后续publish/activate。“读取当前生效版本”才是服务端GET，不冒充磁盘重读。回归`prompt-import.test.js`与已启用战役真实浏览器导入/保存/回读。现有保存链直接调用内容API，尚无持久pending，不宣称该链已具备其他命令的丢响应恢复。请求日志只标HTTP状态，明确200不代表剧情/数据已保存；失败过滤只覆盖HTTP传输，实际结果看剧情页步骤和记录，不以供应商200推断领域提交。全局请求日志与剧情请求共用 `requestDetail` 的响应/请求/概况阅读组件，不保留纵向长正文第二套布局；请求分段用常显标题与正文，不使用箭头折叠。全局日志窗口复用trace-reader宽窗与左右独立滚动，在打开时冻结当前已加载列表，选中读取按代次拒绝迟到返回；原始JSON/复制仅在非publicOnly详情的对应页签保留。主列表筛选/分页不改变打开窗口的阅读位置。回归见 `request-log-reader.test.js`。请求体分段解析在纯函数 `request-body.js`，提示词分段在 `prompt-sections.js`（按行首 `# ` 拆分，未改动时原样拼回）。

用户2026-11-03要求的时间线：展开时用原 `adventure-step` 只读取已完成工具步骤，按 run/actor/action/number/tool 和当前战役、时间线、席位拒绝错配或迟到结果；只缓存白名单字段生成的短摘要，不自动读取模型回复或 HTTP 正文，不显示私密推理。摘要失败有独立重试，不把“工具返回”当“领域写入成功”；骰点复用服务器已保存检定，写入拒绝保留原错误与未写入状态。异步摘要补齐同样保留剧情锚点、步骤滚动及焦点。完整参数/返回仍只在原步骤详情窗读取。

首次滚底由`main.js`在异步render、replaceChildren后发`mounted`，story feed再读取真实scrollHeight；document.fonts.ready只在无wheel/pointerdown/keydown时补定位，后续poll不抢阅读。双端获物只读已保存steps.origin.changes正向inventory差额，有steps时不重复外层changes；不可解析正文或快照初次diff伪造到账。

连接后的只读adventure探测只用于能力呈现，不发模型；仅已知旧战役错误判false，其他失败保留未知。已支持的当前剧本显示来源/高级导出，不提供旧提示词包绑定或不可用二次启用；空白/旧战役仍直接进入真实输入式准备。全局「我的战役」回到账户战役列表，不导出账户会话文件。切战役仍保护原pending；退出登录撤销账户会话但保留原pending与IndexedDB持久草稿，不把退出当业务取消。

冒险确认区只有一个对应状态的继续动作；本人同意与后续继续独立，Ctrl+Enter只在非composition/229且可提交时触发，Enter仍换行。回归见 `navigation.test.js`、`prepare-render.test.js`、`adventure-render.test.js`；真实浏览器须查创建/旧链接/权限/草稿/原请求重放，不能仅通过静态字符串断言。

## 世界信息分页

世界记录的`worldMemoryCard`按人物/任务/地点/线索四个页签显示单一类别，不恢复类型下拉或全类别长列表；当前地点、剧本任务/关系概览仍独立保留。页签带`tablist/tab/tabpanel`语义、当前下划线，左右/Home/End键切换并保持焦点。关键词跨类别保留，切类从offset0通过现有kind查询，分页沿用同kind/query；近期快照不完整时先读当前分类，不能把近期数量当分类总数。无记录仍显示四页签与对应空态。在途可切类，旧响应及其finally都必须核对generation，不能覆盖新类别或解锁新请求；旧纠错控件随代次失效，草稿按原scope/memoryId保留。局部刷新保留类别与关键词，替换根后旧卡退休。回归见`world-memory-paging.test.js`，真实浏览器另核类别HTTP、空态、分页与草稿返回。

`world/memory`只读GET携带expectedVersion/query/kind/offset/limit/scope，经ctx.read和api allowlist。host管理页明确host范围；模型与Unity阅读始终public。响应必须匹配请求版本、范围、页长与nextOffset/total，末页null，不能把不完整2xx当完整世界。snapshot近期窗口不是全量；旧页记录由该页版本/revision绑定纠错，不插入或伪造ctx.snapshot.worldMemory。草稿仍走原scope+memoryId确认合同。卡片按战役/席位/版本/局部代次拒绝晚响应；输入法Enter不检索，正常Enter只做只读检索。回归见`world-memory-paging.test.js`；完整服务端合同见[世界分页](../contracts.md#17-世界信息规模化分页与原子索引)。

## 房间创建后设定与加入设置

正常create走仅name的`/accounts/campaigns`，归属与战役同次保存，成功进入战役大厅`#/live`；旧`/rooms`仅兼容。向导链接到准备页；只有服务器`content.initialSetup`为true才呈现`initial-adventure.js`。首次设定可从用户明确要求的剧本库一键启用，或保留raw文件文本手动导入；空房仍不自动选择默认故事或prompt。库请求冻结包hash及游戏版本，沿ctx.submit/pending，不增加二次确认；旧房只读库并提示新建。详细流程归[剧本库](../../../docs/adventure-library.md)。手动导入冻结requestId/版本/修订；共享确认`confirmInitialAdventure`按scope/revision清稿，不能仅在组件Promise清稿。草稿是标签页内存，有备份入口，不冒充旧作者IDB。

用户最新反馈要求持续邀请：`navigation.js`提供仅host可见的「邀请玩家」`#/room`专页，`room-settings.js`按需GET房间号与真实开启状态，并沿`ctx.submit`/pending配置共享密码或关闭新加入。已有成员或`canInvite=false`不隐藏导航；容量/接纳地点仍由后端判定。不恢复常驻剧情房间卡，打开剧情不读取room，不重建一次性邀请和席位管理第二套UI。密码不回显、成功清该次输入、未知保留原请求；关闭/换密不影响已有席位。归档只能关闭加入，不开启；离页/换scope拒绝迟到更新。协议仍见[第19节](../contracts.md#19-房间共享加入与创建后首次设定)；`room-settings.test.js`覆盖UI、权限、已确认刷新失败、pending及原请求重放。


## 群聊头像与角色阅读

`story.js`按activity.actorId绑定当前未revoked成员，不按名字匹配；剧情里的着色人名就是入口按钮（V3 叙事流不放头像），主持概览的队伍印章可显示已就绪头像。点击经`character-sheet.js`读取授权party Character，人物/状态/能力/法术/背包五类，头部HP/AC/六属性。身份设定只在授权build中读取，不借本人sheet端点补队友私密信息或可执行选项。HP/资源变化保留仍有效的分类、条目、实际滚动容器位置和焦点；撤权/离队关闭窗口。关闭按原消息sequence恢复当前DOM中的准确头像，`focus({preventScroll:true})`不能把读者送回同角色第一条发言。回归`chat-reading.test.js`及headless浏览器。

剧情页“队伍成员”按需列出未撤销且有角色者，包含尚未发言成员，复用同一角色窗与原关闭焦点。能力正文按需读公开的 `characters/{actorId}/references`，不能借本人sheet；同源名称/完整正文/分组按原feature index绑定，异步回填保留稳定entry key、分类、滚动与焦点。HP变化不重复读取固定资料，取得来源变化重读，关闭/撤权/换角色拒绝迟到响应，失败可重试。详细权限见[角色规则引用](../../../docs/client-contract.md#character-rule-references)。

用户2026-11-03要求恢复主持常驻队伍状态，替代原“不恢复常驻角色/队伍/房间卡”中的队伍限制，见协作派单 W1。它由下述只读主持概览承载；完整角色资料仍按需打开，房间卡和快捷纠错按钮不恢复。已删除的`party-dashboard.js`、`character-adjustments.js`不恢复；旧`characters/adjust`白名单及pending原请求重试保留。邀请新玩家仍由独立`#/room`页拥有。

## 剧情页主持概览

`dm-sidebar.js`仅为主持创建，队伍、当前场景私密资料与含隐藏棋子的地图使用一个只读 `GET /api/v1/campaigns/{id}/dm/overview`。角色复用 party/portrait 投影，遭遇复用 `EncounterRead`，地图复用主持 `SharedBoard.Project`（不能用按行动角色过滤的 AI 棋盘替代）。接口必须鉴权，不调用模型、不保存战役或增加版本；普通玩家403，公开快照与Unity DTO不扩充。字段和地图选择见[接口说明](../../../docs/workbench-dm-overview.md)。

初次进入读取，随后只跟随既有 `watchDashboard` 更新；不另开轮询。响应须匹配 campaign、timeline、version 和本地读取代次；换战役、读档、撤主持权限、dispose 后清除秘密与图片object URL，拒绝迟到响应。超前版本等待看板追上，旧版本或读取失败显示重试。鉴权图片复用 `ctx.read`，不把Bearer放进URL。

2026-11-07 起剧情页按 V3：导航 | 剧情 | 右侧停靠栏。右栏在「主持概览」（队伍、当前场景私密资料、只读 DM 小地图）与「事项处理窗」之间切换，处理窗非模态、不遮剧情；概览可收起并记在本机，收起后剧情占满宽度，打开事项时右栏临时出现，关闭恢复原收起状态，「← 主持概览」返回并展开概览。小地图与完整地图窗共用同一鉴权图片缓存；仅展示和放大，不能拖动棋子。队伍印章打开原角色窗并返回原入口。战斗继续保留原战况条/战况窗，不以浮窗替代 `combat-overview`。正文仍是唯一主阅读滚动，右栏与主持事项条分别滚动；更新保留阅读位置与角色入口焦点。外观见 [视觉规范 V3](visual-v3.md)。

## 剧情页提醒与按需处理栏

`createDrawerHost(container,owner,{onOpen,onClose,onBack})` 是剧情右侧的事项处理窗，与原 `createDialogHost` 分工：前者只承载审核/裁定/后果/等待掷骰/失败请求，后者继续承载角色阅读、详情和真正确认。open 接受 `{key,title,flag,render}`，render 得到 `{body,foot,errorSlot,isDisposed,close}`（foot 固定在右栏底部，如审核意见与批准/退回），替换/关闭清理旧 body、还原焦点；owner dispose 解除全局监听。Esc 忽略 IME/229/defaultPrevented，原生 dialog 与顶栏浮层优先，不借非模态栏改变背景可交互性。主页面与单项表单各自拥有生命周期，轮询列表 dispose 不能使仍打开的编辑器失效。`requestReadError` 必须转成可见提醒；选择恢复调用原日志 reload，不因成功空列表伪造其他任务完成。回归 `workspace-dialog`/`chat-reading`/`character-review`；实机还需验证在处理栏丢写响应后重载，原 pending 能逐字重试。



`createDialogHost(owner)`（`workspace-dialog.js`）拥有工作视图的独立模态，`button(label, render, options)`是可聚焦入口，`open({title,render,wide,returnFocus})`传入`{body,isDisposed,close}`。内容按需创建/读取，关闭先dispatch body dispose并使回调失效，再释放DOM并恢复入口；owner dispose关闭所有所属窗口。原生close事件排队，旧事件不得销毁新窗口或抢焦点。世界信息二级记录窗口属于父body，父关闭必须级联清理；背景不能因窗口内容增高而重排。

`pending-panel.js` 的 `createHostTasks` 在剧情顶部画「主持事项」停靠条：每条真实事项一行（角色审核、人工裁定、待落实后果、等待掷骰、本战役未恢复的请求错误），无待办时整条不渲染；选择后事项在右侧处理窗打开并替换主持概览，正在处理的那行显示朱砂选中态，关闭按原概览收起状态恢复。错误日志读取失败显示为一行并等待显式重试，后台轮询不擦除。HTTP错误可能不推进游戏version，同版本看板轮询仍读取错误。页面dispose清读取，列表替换只清旧列表的异步请求；已打开审核/裁定窗口必须绑定页面+自身弹窗生命周期，不能因列表dispose变成可点击却静默无效的表单。

审核/裁定打开时重新找当前actor/ruling及状态，不能把旧列表记录与新version拼成有效操作依据。打开后仍冻结原表单版本，外部更新不能静默重基。角色审核的“重新读取当前资料”通过冻结连接的 `liveConnection().snapshot()` 原地更新资料和版本，保留在途编辑的意见，不关闭窗口或自动提交；关闭后拒绝迟到渲染，已撤销/已审核不再提交。批准旁只说明真实已知的战斗/待投掷限制，不从 canInvite 猜其他条件；服务端仍是接纳条件权威。`renderRulingContext`/`renderStoryFollowup`的`inline:true`用于处理栏或已在模态中的内容，换section/h4而非叠加details；不改变实际读取、预览、确认及草稿合同。裁定上下文优先展示服务端按席位授权的 `ruling.reason`，缺失时才回退旧 `entry.initialResult.summary`；新公开summary是通用等待语，不能盖住主持问题。玩家收到的reason已由服务端遮蔽，UI不自行获取隐藏问题。上下文/剧情选项 GET 失败在本区提供重新读取，只重试读取并保留旁边裁定草稿，不重发写请求；仍受 loading 和窗口生命周期保护。`openCharacterReview`（处理窗）和`worldMemoryCard(...,{dialogs})`分别提供审核/精确记录纠错窗口，角色资料、来源信息仍可读，guest不得取得主持写入口。休整“重新读取条件”只重读本窗口，不用全页refresh来刷新局部条件。

裁定表单常显处理方式和给玩家的回应，来源/私密补充按需展开；来源空时以明确的主持情境判断保存，不伪造书本出处。一次发送即提交，不再弹重复确认。表单冻结打开时游戏版本并防双击；迟到成功仅清匹配草稿，已关闭表单不刷新当前视图。`tasking.groupRulings`只将未有Story/EffectsRequestId的resolved check列为必需后果，其余已完成回应不制造二次待办；剧情历史保留narrative/board_move/effects及已有角色效果check的可选追加入口。`storyMessages`显示服务端裁定回应/已存检定/已过滤私密说明，不能以没有最终模型叙事为由漏掉主持已发送的回应。回归 `ruling-editor.test.js`、`tasking.test.js`、`dm-workbench.test.js`。

提示词操作以“编辑主持要求 / AI 输入组成说明 / 查看历史请求”分开对象；“切换为全文编辑”仍是主持正文草稿，不包含按需参考资料。“查看已应用原文”只读最近读取的版本，“刷新已应用内容”才GET服务器；“保存并应用”沿原保存链。冲突采用新base并不自动合并，应明确保留草稿将覆盖新版本。

新窗口不自动提交或调用模型，×/Esc不执行命令。证明包括`character-review`、`activity-render`、`workspace-dialog`、`world-memory`、`dm-workbench`测试，以及真实浏览器打开/关闭角色卡、裁定、请求详情时焦点返回、0 POST。
