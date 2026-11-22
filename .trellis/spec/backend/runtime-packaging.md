# 本地运行包接替旧服务

1. **范围**：`scripts/package/Start-DiceRealm.ps1` 的日常端口及旧文字接线；具体操作只维护在包说明，本机AI设置合同见[AI设置与用量](ai-settings.md)。
2. **签名**：`-UseDailyPort` 仅适用于5180/5182并要求显式DataPath；`-EnableLegacyTextModel -LegacyProviderConfig` 成对指定原 `baseUrl/apiKey/textModel/imageModel` 文件。新内核仍用独立四项必需字段及原开关，可选typed思考/重试字段见包说明。
3. **合同**：默认所有供应商关闭并清理继承配置；旧TextAi只恢复原OpenAI文字映射（包括原内容准备路径），imageModel仅为配置兼容，不启用图片。新旧文字共用原目录账本和三项Text限额。接替日常服务前具体中断确认及停服完整备份由执行者完成，开关不构成自动接管/迁移/杀进程授权。
4. **拒绝**：配置重复/未知字段/错大小写/字段类型错误/超过32KiB或header非法，缺成对开关、错误日常端口/缺显式数据目录、端口已占用均在服务启动前拒绝。错误不输出配置正文；启动竞态仍验证本次child监听PID，只清理自己创建的进程。
5. **正常/兼容/拒绝**：正常为旧战役保持旧文字、新明确战役用原生供应商，读取与重开0调用；兼容原四字段旧配置和原回执；拒绝将新端口/新账本当作清零额度或将旧战役静默转换。
6. **验证**：package-launcher.mjs 用隔离数据和loopback fake覆盖两条真实HTTP路径、实际包内Pi、共用额度、模型关闭后原请求重放、配置/端口/日志安全。完整包移动/规则/竞态继续沿用可搬移烟测，不用junction烟测代替全包搬移。Windows临时目录先realpath规范化8.3/junction，再作进程所有权检查；拥有child后立即记录清理句柄，验证失败不能把遗留进程报成已清理。
7. **正误**：错误是将包的默认额度写到原日常服务，或仅开新供应商使旧故事失去文字能力；正确是先读取实际旧设置、保留原账本及明确兼容开关，并让默认新包继续离线。

打包的隔离构建根用 `npm ci --include=dev --ignore-scripts`，防止宿主 `NODE_ENV=production` 省略 TypeScript 构建依赖；发布根仍用 `--omit=dev`。不改全局环境或源码依赖。新增 native NuGet 必须从实际包提取 LICENSE/third-party notices；棋盘 BG3 图标仅记录私用来源，不把随包复制说成公开授权。

## macOS本机运行包

1. **范围**：根`Play-DiceRealm.command`只委派显式Mac包；包内`Start-DiceRealm.command`运行`scripts/package/start-macos.py`的副本。Apple Silicon服务发布为osx-arm64，普通Player必须由真实BuildPipeline生成，不能把Windows输出改扩展名；不改Windows菜单目标。
2. **签名**：`Start-DiceRealm.command [--data <持久目录>] [--port <1024..65535>] [--check-only] [--no-open]`；默认5290、`~/Library/Application Support/DiceRealm/server`。CheckOnly不启动或开UI；NoOpen只启动服务。操作说明唯一维护在Mac包说明。
3. **合同**：包内固定server/agent-host/rules/adventures，校验本地规则、Node≥22.19与ASP.NET Core Runtime10。清理继承供应商、监听和Node启动配置；dotnet命令必须显式传`--urls http://127.0.0.1:<port> --DataPath <完整目录>`，不能只设置ASPNETCORE_URLS而被URLS覆盖。新数据无供应商配置，已有operator配置/用量保持，启动/读取零模型请求。`mac-runtime.json`记录pid/started/bundle/data/origin，成功监听且health通过后原子写入；重复启动只复用监听PID、创建时间、包、数据及health全匹配者，不自动停止旧版本或未知服务。
4. **拒绝**：缺依赖/包文件、规则验证失败、非法端口均不启动；已占用且身份不符则报错，不杀进程。启动后未就绪或写记录失败只结束本次child。普通Player身份`com.dicerealm.player`，QA为独立`com.dicerealm.qa.<product小写>`；Mac应用资料目录由bundle ID决定，不能只对照company/product。构建前检查未保存场景/编译状态和不存在的输出，finally恢复产品、架构、application ID、Development、preloadedAssets及Pipeline；原无Standalone架构行时通过Editor API移除新行，不留下默认值变更。
5. **正常/基线/错误**：正常启动→同源双端，重复启动复用PID；基线新空数据零调用；错误是拿QA资料或新房间冒充原房恢复。首次从Editor迁移到Mac应用资料时先完整备份，只复制已确认来源到新目录，保留原目录与自然session；不改token/房间ID、不在每次启动重复导入覆盖。
6. **验证**：真实构建/后台实启、普通包无Pipeline、QA身份隔离、构建前后ProjectSettings一致；完整包搬出项目后验证包内Pi真实业务、继承URLS/Kestrel仍只loopback、重复PID复用、错误owner拒绝且存活、CheckOnly零启动、停止child端口释放。升级另用原自然session经原生ApiClient只读取原房间，比较源文件/用量；QA新房不替代该项。当前可执行烟测及证据见任务`10-22-live-playtest-followups/verification.md`，位于忽略目录，不把一次性PID写入产品。
7. **正误**：错误是`env["ASPNETCORE_URLS"] = origin`后直接启动，假设继承环境不能改变监听；正确是清理继承配置并传显式`[dotnet, dll, "--urls", origin, "--DataPath", data]`，最后核对实际监听owner。错误是把QA截图当普通包全流程；正确是分别报告构建、普通实启、QA交互和未验证的OS输入。

## 已安装日常入口

`scripts/start-daily.ps1 [-CheckOnly]`读取私有 `.local/daily-runtime.json` 的包路径、数据/供应商文件路径和原三项额度，不在配置内复制凭证。供应商解析、环境隔离与启动行为只由包启动器负责。服务冷启动成功才写 `.local/server-5180.json`；失败保留原元数据。

已有5180监听时要求单一PID、命令行中完整匹配DLL和数据目录参数、健康GET成功。路径前缀相同不等于匹配，其他进程或未就绪均拒绝、不杀进程；端口空闲时CheckOnly只报告配置，不启动。根CMD只委派入口，Player路径必须真实存在且无转义控制字符。

正常例：重复运行只读识别已有服务。基线例：冷启动委派全部显式开关和原额度。拒绝例：`dataPath-sibling`、错误包或两个owner不能被当成当前实例。错误做法是用Contains匹配路径前缀或在CMD生成时把反斜杠转成控制字符；正确做法是匹配完整参数并验证脚本字节与真实目标。

验证在入口测试：隔离fake启动器/进程查询测试已有实例、拒绝、CheckOnly、冷启动委派/元数据与CMD；另用实际CheckOnly只读识别日常实例。不能为了测试入口而中断用户当前游戏。

回滚：新服务成功写入后可能已把 SQLite 迁到 2 版。回滚须先停服，换回匹配的旧程序并使用一致备份；有新进度或供应商费用时先保留新状态与用量账本，不能删字段降级，也不能恢复旧额度后重复消费。

## 独立图片开关

`-EnableImages -ImageProviderConfig`成对指定；配置严格为endpoint/apiKey/model，完整HTTPS调用地址（仅loopback测试HTTP）、header密钥、有界model。不借用文字/旧imageModel字段，继承ImageAi仍清空；无已保存配置时默认关闭；图片限额始终使用ImageTotalLimit/ImageDailyLimit/ImageCampaignDailyLimit（默认-1）并沿用原账本。不能因为未传图片bootstrap开关而写入0额度，阻断之后工作台显式启用的图片服务。显式传0仍保留禁用调用语义。参考上传仍关闭，不添加隐式模型/尺寸回退。配置错误在数据创建前拒绝，不输出正文。启动结果只增加imagesEnabled，不含密钥；完整操作归包README。`package-launcher.mjs`用本机fake PNG验证独立开关、错误配置、一次外发、原请求重放、停用后读取/重放和额度，实际运行包还需搬离验证。

模型provider文件的可选thinkingLevel/includeThoughts/retryCount/retryInitialDelayMilliseconds严格校验字符串枚举、bool和整数范围；旧四字段仍有效。默认值显式写入子环境，不继承全局思考/重试设置；本机网页可按[AI设置合同](ai-settings.md)修改，远程页面不可修改。真实包回归包含缺省、覆盖和一次503后持久计次恢复。

## 统一桌面入口

1. **范围**：根 `Play-DiceRealm.cmd` 委派 `scripts/launch-dicerealm.ps1`；只协调日常或独立测试及工作台/Player打开，不复制供应商解析或启动实现。
2. **签名**：`launch-dicerealm.ps1 [-Mode Daily|Test] [-Offline] [-CheckOnly] [-NoOpen] [-ImageProviderConfig <path>]`。无Mode显示菜单；非交互检查须指定Mode。`scripts/launcher-targets.json`仅记录显式测试包路径和显示标签，不用mtime搜索；Player来自已安装日常配置的packagePath/player。
3. **合同**：Daily委派原start-daily；Test固定5191和独立持久`.local/launcher-test-data`，不清存档/账本。在线冷启动直接委派EnableModel、原供应商文件路径及不限额参数；不复制密钥；图片默认关闭，仅在线Test显式传ImageProviderConfig时委派包原EnableImages/ImageProviderConfig，不加第二层启用门槛。外层只验证文件存在并传路径，严格解析仍由包拥有。Daily/Clean/Offline拒绝该配置。CheckOnly不启动/开UI/确认收费。测试元数据成功后原子写入`.local/launcher-test-runtime.json`；已有监听核对单PID、完整DLL和--DataPath参数、元数据模式及health，不接管。客户端无启动地址参数，不改Prefs或凭证，显示需在连接设置选择测试地址。
4. **拒绝**：缺Player/包/本机安装配置提前失败；测试数据与正式目录相同/互相包含或祖先含链接拒绝；错误owner、路径前缀、无记录、模式不符、health失败不重启。启动失败不打开UI或覆盖原元数据；服务已启但写记录失败须明确报告PID，不能谎称完全没启动。
5. **正常/基线/错误**：正常菜单选择→就绪→对应工作台和Player；基线日常仍使用原配置与端口；错误是菜单选新版却打开旧服务页面，或偷偷修改原客户端连接来冒充自动切换。
6. **验证**：`scripts/tests/unified-entry.ps1` mock覆盖菜单/取消/明确同意/离线/日常委派/缺文件/重复识别/拒绝/元数据/UI顺序；`daily-entry.ps1`保留日常原合同。实际最新版离线启动、重复识别、HTTP与浏览器检查独立记录，不把mock打开Player当原生启动验收。Windows Temp可能是junction，隔离fixture先规范化Temp真实目录，不能为测试放宽产品数据保护。
7. **正误**：错误为重新启动就创建新测试数据目录以清额度，或修改候选包来隐藏版本切换；正确为固定持久测试目录、显式目标记录，旧服务/候选/正式存档都保留。


## 隔离体验入口（Clean）

`-Mode Clean [-CheckOnly] [-NoOpen]`仅作内部模拟验收命令，不在使用者菜单展示，不能交作真实AI测试环境。它委派 `scripts/start-clean-test.ps1` 打开QA Player与5199模拟工作台。Clean不依赖日常配置、不读取供应商密钥，只运行显式 `launcher-targets.json` 的cleanFixture/cleanPlayer。此模式为模拟供应商体验验证，不代表真实AI质量或连通性验收。

首次为空隔离数据，以后从私有clean-active.json指向的状态记录恢复同一临时数据库，不在重启时清存档或账本。端口占用必须核对单PID、完整exe、精确state参数和health；未知占用拒绝、不接管。新启动需验证child监听与health，再原子保存指针；失败只清理由自身创建的child。CheckOnly不启动，NoOpen不打开浏览器/Player。QA Player使用独立产品身份并传 `--dicerealm-server http://127.0.0.1:5199`，不改正式profile。

正确：固定独立origin/数据、服务就绪后打开对应双端；错误：把旧5191或旧Player当新版，或者每次启动自动删除旧数据。入口委派和菜单测试在unified-entry.ps1；真实冷启动/重复识别/停止证据在本次任务记录。关闭进程不删除测试数据，下一次由用户启动。


## 最新版真实AI测试入口

菜单1明确标注旧版日常，菜单2为 `Test` 真实AI新版双端，菜单3为同版本不加载供应商配置的启动选项；不得将模拟夹具作为用户要求的真实AI环境。`launcher-targets.json`显式拥有testPackage/testPlayer/testPort/testData/testEnableHelper，旧配置缺后3项时兼容5191和原测试数据。可选testAdventureLibrary指定已有只读剧本库；入口预检目录存在，在委派包启动器期间设置AdventureLibrary__Directory并在成功/失败后还原调用者环境，不复制剧本、不另建加载器。缺此字段沿包原默认。回归覆盖缺目录拒绝、实际委派及环境恢复。端口禁止日常5180/5182；持久数据与正式目录的重叠和链接防护保留。非默认端口记录独立launcher-test-{port}-runtime.json，已有服务核对精确DLL/data/PID/模式。

在线冷启动不再要求YES；主模型只传本机nativeProviderConfig路径，testEnableHelper为true时另传legacyProviderConfig及EnableLegacyTextModel，原包启动器映射到辅助TextAi；图片默认关闭，在线Test可显式提供独立ImageProviderConfig，不从legacy imageModel或文字模型推断。缺所需配置拒绝，不把禁用辅助伪装成配置完成。新版Test入口累计/每日/每战役限额明确为-1，不继承旧日常的小额度；原用量账本仍保留，不在启动清零；新版AI设置可以显式保存覆盖启动配置，包括图片服务；不传ImageProviderConfig不能表述为“图片关闭”。菜单3的Offline仅不加载bootstrap供应商文件，不禁用已保存设置，因此菜单及结果必须说明已保存设置仍可能生效，不能声称保证离线。启动结果imagesEnabled仍仅表示图片bootstrap开关，不作为实际服务状态。服务启动和GET配置检查不做模型请求。回归unified-entry覆盖菜单2/无重复确认/不限额/两模型路径委派/独立端口数据/Player地址匹配；真实启动仅证明服务接线，不证明供应商成功返回。


### 统一入口的测试版本切换

Windows Player更新还须比较旧/新 `DiceRealm_Data/app.info` 的company/product，两者决定 `LocalLow/<company>/<product>`，exe名称与服务origin相同并不能保证读到同一份本机资料。现有5201正式使用者资料身份是 `DiceRealm/DiceRealmExperienceQA`；`AgentScripts/PlayerBuild.cs` 保留该身份、关闭Development/Pipeline。不能因名字含QA就擅改为 `DiceRealm/DiceRealm`，该目录可能含早期测试记录。切换前核对原自然保存的session和campaign-library（只报告地址、房间/角色名，不输出token），新旧身份必须一致；有意迁移则单独设计并保护整份本机资料，不能自动跨目录导入或覆盖。只改构建身份时验证app.info匹配、原席位原生ApiClient读取成功、原本机资料不变，不把health或CheckOnly当作房间恢复证据。

用户要求升级或修复现有游玩入口时，先核正常Player实际session的origin与对应持久数据，只输出地址/ID，不输出凭证。默认保持原origin/data、替换已验证程序；不把QA专用端口/数据当作用户升级，否则“继续上次冒险”仍连接旧origin。确需新环境时明确新建/加入与继续旧房间的差别。验收须用原自然保存session只读取得原房间，并验证原生ApiClient链路；另一个QA账号、mock打开或health成功不能替代这项。升级前按停服完整备份合同操作，不改session令牌或房间ID来伪造迁移。

更新launcher-targets后，已有测试进程的归属须以原端口启动记录（PID/完整DLL/完整DataPath/typed offline）核对真实进程，不能先用新DLL判旧进程为外来服务。同版本同模式且图片配置路径相同才只读复用（旧元数据缺字段视为空路径，不读取或记录凭证）；已记录旧版本/不同模式/图片配置路径变化，CheckOnly只返回restartRequired，交互启动明确说明中断并确认一次。确认后重新核对监听owner、进程创建时间与命令行，再停止该测试进程、等端口释放并从相同隔离data启动目标包。取消、身份变化、无记录或不相关owner不停止；NoOpen不隐式接管。此为运行中断确认，不是AI启动/额度/解锁门槛；冷启动无额外确认。回归见unified-entry.ps1。
