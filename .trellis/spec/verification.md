# 验证与交付

## 选择与改动匹配的证据

验证真实行为，不把「新增函数就配一个镜像测试」或固定覆盖率作为质量标准。先执行最小相关测试；公共契约、存储、权限、重试或共享状态发生变化时，扩大到相关集成和消费者。测试通过且代码未变化时，不重复同一套检查。

| 改动 | 最小有效验证 | 何时扩大 |
|---|---|---|
| 纯规范/流程文档 | 链接、源码引用、模板残留、入口一致性；工作流解析 | 改了脚本才运行对应脚本测试 |
| Domain 规则 | 固定骰子/时钟的结果与边界断言 | 影响保存/权限时补真实 HTTP、重启 |
| 命令、事务、迁移 | 临时数据目录的 HTTP、重放、并发、失败回滚 | 公共快照/协议改变时检查双端 |
| Unity Core | DotNetCheck + 受影响纯逻辑测试 | DTO/引擎行为必须真实 Editor |
| Unity UI/API | 相关 EditMode、真实 Editor 编译和交互 | 输入法/窗口/键鼠需原生 Player 证据 |
| 工作台逻辑 | 相关 `node:test` | DOM、布局、焦点、网络恢复需真实浏览器 |

## 已有命令

从项目根执行；服务端测试是自定义控制台 runner，不是 `dotnet test`：

```bash
# Harness真实进程测试需要先准备固定Node依赖（不使用供应商）
npm --prefix agent-host ci --ignore-scripts
npm --prefix agent-host run build
npm --prefix agent-host run typecheck
npm --prefix agent-host test
# 全部服务端组；按任务风险选择是否运行全部
dotnet run --project tests/DiceRealm.Tests -c Release
# 名称子串过滤，不匹配会失败
dotnet run --project tests/DiceRealm.Tests -c Release -- --filter continuity
# 编译真实 Unity Core 源码并运行无引擎 invariants
dotnet run --project client-unity/Tools/DotNetCheck -c Release
# 工作台全部测试；无需添加 npm 依赖
npm --prefix client-workbench test
# 只运行一个工作台文件
node --test client-workbench/tests/activity.test.js
```

Unity 先加载 unity-pipeline skill，发现并使用已连接 Editor，不猜端口或另开同一工程：

```bash
unity command run_tests --mode editor --filter DiceRealm.EditMode --filter_type assembly --project-path ./client-unity --format json
```

Unity 主线程异步测试不能用 NUnit `Assert.ThrowsAsync`、`.Wait()` 或 `.Result` 同步等待依赖 UnityWebRequest 回调的 Task，否则 Editor 主线程会死锁。使用测试 runner 支持的 `async Task`，`await` 操作后自行断言异常；循环 HTTP 夹具的断言失败须返回明确错误并在收尾抛出，不能让客户端空等。回归实现见 `AdventureBusinessSyncTests.Rejects` 与该文件的 `Host`。Editor 无响应时先记录证据；取消命令同样可能依赖主线程，不能反复轮询假装有进度，非本任务创建的实例重启须明确授权。

后台原生单行输入验收需区分两个事件源：`InputSystem.QueueStateEvent`本身不会产生uGUI `InputField`所消费的legacy `Event.PopEvent`。若通过引擎队列驱动，legacy KeyDown必须在正常Dynamic更新中与`wasPressedThisFrame`同帧被消费；不能调用业务提交方法或人为`InputSystem.Update`冒充真实链。监听/hook只属隔离QA并在finally移除，核对服务端精确输入次数和草稿确认状态；此证据不等同OS键盘/IME。依据`AdventureHud.LateUpdate`、`UiActionInputField`与原生补验。

工具返回任务句柄时继续取得最终结果，不把「任务已提交」当通过。测试名、筛选器和脚本是否适用先查当前源码；例如部分早期 `AgentScripts` 依赖已移除的默认剧本，不能未经检查重新运行。

Harness必须同时验证真实Node/Pi/MCP与fake故障注入；不能只把本地函数命名为MCP后报告通过。涉及schema转发要覆盖对象键重排、值/数组改变拒绝、前后空白prompt、同批停止与恢复重建。

游戏端 UI 的整体验收必须在正常客户端、真实服务、真实模型组成的可游玩环境中连续操作，检查整页视觉层级、可读性、动作可发现性、反馈时机与实际游戏节奏。采用独立房间/存档保护用户正在游玩的进度，不用内存DTO、脚本模型或静态页面拼图替代产品验收。截图只保留能判断真实问题的关键状态并实际查看；“0截断”、截图数量和接口成功都不能证明界面好用。

`ui-tour.py`与EditMode/PlayMode仍可按改动风险定位布局/契约回归，不再把全页面夹具截图作为每次发布的必跑流水线。`AgentScripts/PlayerBuild.cs`构建新输出后，优先用普通Player走通受影响的完整游玩流程。用户要求实测时，测试环境的通过结果仅作为定位证据，不作为最终接受依据。运行方法见 scripts/qa/README.md。

主持工作台按 PC 桌面验证布局、键鼠、窗口缩放和阅读放大，不将 H5／手机适配或手机视口截图列为必需验收。额外做过的窄视口观察只保留为历史观察，不改变产品范围。

服务端/测试项目启用 warnings-as-errors；客户端 Core 检查使用 C# 9，不能以 .NET 10 编译器可接受为由加入 Unity 不支持的语言/API。当前工作台没有 TypeScript/lint 构建链，不报告不存在的检查已经通过。

## 启动与建卡真实流程

涉及启动地址、本机联网、建卡或房间加入的修复，必须在独立端口/数据/原生Player身份中，走真实浏览器设置房间密码→原生Player从空稿按实际适用步骤完整建卡→复核采用→输入房间号密码提交→主持批准→Player显示批准。业务写入只能由实际UI交互触发；不得预填build/session、插入完整草稿或用HTTP直接创建/加入冒充流程。中途失败先保留证据，修复后允许继续UI自然保存的草稿，并说明重启边界。Editor GET、curl、mock与自动回归是补充，不代替Windows Player实际网络栈。

同时检查保存后重开、关闭加入、显式更换/取消密码；状态由服务器结果驱动，密码不回显。系统代理问题要用实际Player连接端点确认，不能凭NO_PROXY存在即宣称生效。报告原始失败、最终成功、未覆盖情形与用户现场是否已切换。

## 隔离与保护

- 测试使用独立目录、端口、明确导入的夹具与 fake/offline provider。确认没有文本或图片实际外发；不要将自动化指向已配置付费供应商的日常服务。
- 不覆盖正在运行进程的构建输出，不自动杀占用端口的未知进程。工作台是服务端嵌入资源，正式页面验收要基于更新后的服务端构建，不只看磁盘 JS。
- 操作 Editor 前记录当前连接、草稿、Play Mode、场景和显示设置；结束后还原本次改变。不要用旧检查点覆盖用户后来产生的改动。
- 临时验证脚本放非发布目录；需要复用的回归收敛进现有测试入口。密钥、连接文件、存档和含私密内容的截图/日志不公开。
- 数据备份/恢复遵守 [存储规范](backend/database-guidelines.md)，阅读导出不是可恢复备份。

## 证据标准

JSON 安全断言检查解析后的字段集合，不在整串 JSON 中排除 `dc` 等短子串：合法随机 request/roll ID 也可能含这些字符，导致误报。回归例子为 `ContextualRollTests.OnlyBackendDemandOpensThePanelAndOnlyConfirmationSendsTheBoundId`，使用含 `dc` 的合法 ID，并断言只发送四个允许字段。

一次行为修复至少让回归测试在该行为被撤回时失败。高风险命令同时检查「没有发生什么」：未重复掷骰、扣费、扣资源、写事件或泄露权限。

明确区分纯逻辑、DOM 替身、Editor 回调、真实浏览器和原生键鼠验收。截图证明显示，不单独证明状态已持久化；构建成功不证明中文输入法可用。阻塞项据实记录，不用模拟回调冒充实体输入。

UI 美术/Prefab 改动同时验证实际资产引用、可编辑属性不被运行时覆盖，以及真实 Game View 合成画面。RectTransform 在屏幕内不等于文字可见：装饰层仍可能盖住控件。Editor静态预览期间暂时禁用并在Cleanup恢复原BaseInputModule，避免实时桌面输入关闭菜单或拖移窗口而生成假通过截图；验菜单时先断言目标仍存在，不能只统计0截断。该隔离只用于静态截图，真实InputSystem交互另在后台Player验证。覆盖窄屏、主分辨率、宽屏、阅读放大、无图和待处理状态；仅用带明确标签的隔离夹具，不能把校准图宣称为产品地图美术。素材制作的付费请求与游戏服务的模型调用分别计数。

批处理Editor的输入/布局测试先记录并设置有效桌面Game View尺寸（如1920×1080），结束恢复原尺寸索引；默认小视口可能让HUD输入不可见，不能据此修改产品的受支持桌面布局，也不能用固定帧数替代滚动结果观察。

Unity 测试后检查 ProjectSettings 与本轮基线；测试运行器可能清掉 Input System 的 preloadedAssets。只通过 Editor API 恢复本轮确认的原值，不整文件覆盖其他修改；构建前保留原输入配置。

交付记录范围、运行的命令/结果、产物位置和剩余限制；不把历史通过数写成永久门槛。任务验收满足后按 项目约定 自主归档；存在必需未完成项则保留任务并说明。

## 参考入口

- [服务端测试 runner](../../tests/DiceRealm.Tests/Program.cs)、[测试 Host/替身](../../tests/DiceRealm.Tests/Support.cs)
- Core 检查工程、EditMode、PlayMode
- [工作台清单](../../client-workbench/package.json)、[工作台测试](../../client-workbench/tests/)


## 可搬移服务包

修改打包或包启动时，使用全新输出和独立数据，隔离npm开发构建与按锁生产安装，不替换源码dist/node_modules或旧包。语法/publish成功只验证构建；实际搬到项目目录外，显式从包内JS启动Pi/MCP，经业务创建/行动API调用包外fake供应商，再检查重开/原回执零新增请求。默认启动必须在继承假的在线环境时仍不外发，端口冲突不能杀其他服务；后台成功须核对监听PID，测试应覆盖预检后被其他健康服务抢占的窗口。路径边界按目录本身/分隔符后代判断，不能误拒绝agent-host-data等兄弟目录。日志/包里不含真实key或存档。许可清单来自实际包而非猜测，缺正文/项目许可需明确保留为公开再分发前复核，不把本地验证冒充正式发行。

大型Windows包复制优先可靠的目录复制工具并记录阶段/校验；不要把fixture复制耗时或错误页面路径当成内核模型失败。工作台由`/workbench/`托管，根`/`不是页面。真实供应商检查需要明确调用授权并记录实际请求与结果，不据此恢复用户已取消的应用额度或重复确认；具体运行合同见[AI设置](backend/ai-settings.md)。fake烟测、健康检查和包启动不得复用收费配置。

日常接替启动器的定向验证使用 `node scripts/tests/package-launcher.mjs --package <实际包绝对目录> --report <不存在的JSON绝对路径>`：仅loopback fake与新临时数据，不读取真实密钥，不杀原日常服务；包含实际旧输入与新Pi路径、共用额度、禁用模型重开重放及显式端口拒绝。脚本保留临时目录用于失败调查，不能将其短名路径直接与进程展开后的长路径比较。新模型观察窗口需覆盖启动器既有运行期限，不能以短于产品期限的轮询假定其卡死，也不能因此扩大产品超时。


## 不抢用户焦点的后台Player验收

用户明确要求“别抢我焦点”：后续验收默认在后台完成，不激活/切换前台窗口、不移动系统鼠标、不向用户桌面发送按键，也不改剪贴板或输入法；不要求用户让出桌面。可用独立非输入Windows desktop运行专用Development Player，由项目已有Unity Pipeline调用真实uGUI/InputSystem，工作台使用headless真实浏览器。使用`scripts/qa/README.md`记录的入口；QA构建器在Assets外，临时开启Pipeline并恢复Editor设置，不能给正式包启用测试控制接口。

后台UI依然必须从空白控件逐步触发业务，不能写入完整build/session或绕UI直接HTTP创建/加入/审批。先核QA产品身份、控件可用与遮挡，操作后检查目标状态；pointer event发送成功不等于业务成功，写操作不盲重试。截图取Player渲染帧，不截用户屏幕。

报告分别注明真实Player网络/服务器持久、程序化uGUI/InputSystem与headless DOM；不将这些说成OS键鼠或中文IME验收。没有长文/多成员的场景不证明分页/长队伍。仅停止本次精确身份进程，保留隔离存档；统计等服务退出再读，不干扰Windows原子写入。
