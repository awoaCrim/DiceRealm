# 本地开发与运行

> 当前源码/交付包/运行服务的区别见 [当前状态](current-status.md)。Harness 需要额外构建 `agent-host` 并明确启用，配置与隔离验证见 [Harness 运行指南](harness-runtime.md)；旧输入服务的 TextAi 配置不会自动启用 Harness。

> 新战役不自动套用探索剧本和探索提示词；战斗主持已内置默认稿，自定义稿优先。下文涉及雾港、灯塔、巡守等固定内容的部分是旧版回归场景记录，不是启动默认值。当前入口、数据格式和限制以 [剧本与提示词导入](content-import.md) 为准；检定、资源、存档和权限规则仍由服务端执行。


---

### 本机已安装的日常入口

macOS 从项目根 `Play-DiceRealm.command` 启动 `artifacts/experience-20261104/macos/`，工作台为 `http://127.0.0.1:5290/workbench/`。正式数据与源码分开保存，具体参数和停止方式见 Mac 包说明。当前视觉改造的 QA 入口见交接文档，不通过正式存档验收。

旧 Windows 日常脚本和打包源码仍保留，但本机没有 `Play-DiceRealm.cmd` 或有效的 `.local/daily-runtime.json`；不能把旧菜单、5180/5182配置当作当前已安装环境。2026-11-05 已清除旧构建和备份，需使用时按下文从源码重新构建独立包。

以下是开发/另建隔离环境的方法，不要在正式数据目录运行测试。

### 独立运行包（新内核）

本地目录包可从项目外运行，不依赖源码路径。构建命令（开发机需 .NET10 SDK、Node/npm、PowerShell7；安装依赖不运行 lifecycle scripts）：

```powershell
pwsh -NoProfile -File ./scripts/package-harness.ps1 -OutputDirectory ./artifacts/MyDiceRealmPackage
# 从生成目录离线启动；默认 http://127.0.0.1:5190/workbench/
pwsh -NoProfile -File ./artifacts/MyDiceRealmPackage/Start-DiceRealm.ps1
```

目标机器只需 PowerShell7、.NET10 **ASP.NET Core Runtime**、Node>=22.19；不需要 SDK/npm。已有输出目录/ZIP拒绝覆盖，默认不含密钥、数据、默认故事或提示词。`-SkipArchive` 只省略ZIP，不省略目录包。运行脚本使用自己的目录和独立 data，默认拒绝5180/5182，始终拒绝占用端口及继承的在线配置；完成日常停服备份后可显式 `-UseDailyPort`，保留旧文字服务用 `-EnableLegacyTextModel -LegacyProviderConfig`，详见包说明。新冒险只有显式 `-EnableModel -ProviderConfig <文件>` 才启用。配置恰好包含 `baseUrl/apiKey/endpoint/model`，端点为 `gemini` 或 `openai-chat`，详细前缀、额度、备份和许可说明见包说明。

AI 接口由主持工作台「系统设置与 AI」页（API `/api/v1/operator/ai-settings`，仅本机操作员）或文件/环境变量配置，详见 [AI 设置规范](../.trellis/spec/backend/ai-settings.md)；模型名不决定协议，主模型与辅助模型均可选 `openai-chat` 或 `gemini`。供应商额度 `ProviderLimits` 默认 −1（不限），0 关闭调用。原有 `scripts/start-server.ps1` 是下文的旧 TextAi/ImageAi 本机启动脚本，不用它启动新包。

### 启动服务端

使用 .NET 10 SDK，从仓库根执行：

```bash
dotnet run --project server/DiceRealm.Server
```

默认监听 `http://127.0.0.1:5180`，健康检查是 `GET /health`。没有配置文本服务时，返回 `textMode: offline`。场景资源返回旧的已完成图片或 `removed / scene_generation_removed`，不建立生图任务。健康检查声明 `sceneGeneration:false`、`imagePurpose:maps`。地图保存不生图，未配置供应商时保留草稿并拒绝生成。

默认数据目录是服务端进程当前工作目录下的 `data`，使用上述 `dotnet run` 时通常位于 [服务端工程](../server/DiceRealm.Server/) 内。建议用绝对 `DataPath` 明确指定位置，尤其是发布后运行或容器部署。本机 AI 服务使用仓库忽略目录 `.local/playable-save`，监听 5180；离线服务监听 5182，使用独立的 `.local/content-import-save`。5182仅是历史离线安排，不保证当前版本或是否运行。它们与默认开发存档分开，保留各自数据与供应商配置。运行前核对实例、二进制与 DataPath，不会替旧战役选择剧本。

PowerShell 示例：

```powershell
$env:DataPath = 'G:/DiceRealmData'
```

```powershell
dotnet run --project server/DiceRealm.Server
```

Bash 示例：

```bash
DataPath=/absolute/path/to/dicerealm-data dotnet run --project server/DiceRealm.Server
```

不要让多个服务实例共享同一目录。启动时的排他文件句柄用于阻止多写入者，不扫描或杀死其他进程。

以下是旧 TextAi/ImageAi 开发启动方法，**不是当前日常入口**；不要用它替换日常服务。隔离环境已有供应商配置时，旧 启动脚本 的用法为：

```powershell
./scripts/start-server.ps1
```

它读取被 Git 忽略的 `.local/secrets/provider.json`，只通过子进程环境传入密钥，不把密钥放进命令行或启动日志。配置形状为 `baseUrl`、`apiKey`、`textModel`、`imageModel`；不要提交这个文件。脚本默认使用既有演示存档和本机 5180 端口，端口被占用时拒绝启动，不自动杀进程。

脚本默认每次文本调用最多 30 秒、每次生图最多 180 秒、地图每次确认最多外发一次，失败和超时不自动重试。参考图外发保持关闭。`-Offline` 可显式使用离线模式；`-Background` 后台运行，状态保存在忽略目录 .local，日志保存在 artifacts。`-NoBuild` 只用于已有最新构建时。`-Configuration Debug` 可将离线开发构建与正在运行的 Release 实例分开。

---

### 文本 AI

旧 TextAi 适配器使用 OpenAI-compatible `chat/completions`（Harness 与辅助模型另可选 Gemini，见上），供应商必须支持 `response_format: json_object`、`messages` 和 `max_tokens`。旧自然行动最多涉及一次意图提取和一次叙事；新 [理解流程](action-understanding.md) 的首次描述和前两次补充各可请求一次理解，选择后复用既有叙事，第三次仍需补充则直接转裁定。各调用都有服务端超时与额度计数；按钮行动跳过意图提取。`TextAi__TimeoutSeconds` 默认 8 秒，可配置为 1..45 秒；客户端行动请求允许 120 秒，覆盖两次调用和传输余量，普通查询仍为 30 秒。

配置 `TextAi__ApiKey` 和 `TextAi__Model`，需要时配置 `TextAi__Endpoint`。模型名称由供应商提供，本项目不默认选购或调用任何模型。两项只填一项会启动失败，防止误以为 AI 已启用。

PowerShell 中以占位说明变量，不要把真实密钥写进项目文件：

```powershell
$env:TextAi__Model = '<供应商支持的模型 ID>'
```

```powershell
$env:TextAi__ApiKey = '<从本机秘密存储注入>'
```

密钥只在服务端存在，不传入 Unity、不进入战役快照。服务端重启后配置生效。[.env.example](../.env.example) 只是变量说明，程序不会自动读取这个文件。

新 AI 理解只返回服务端候选 ID、问题或转裁定；候选确认后仍校验角色、来源和冻结版本，详情见 [行动理解](action-understanding.md)。原系统提示词仍由作者导入；旧 kind/target 提示词仅提供受限兼容，不被程序自动改写。AI 叙事不是事实来源，界面会区分 `ai`、`offline`、`fallback`、`quota`；模型即使输出了不可靠的文字，也没有写状态的接口。当前过滤不能证明自由文本永不矛盾，发布前需要供应商质量评测和更严格的叙事约束。

---

### 图片 AI

配置 `ImageAi__ApiKey`、`ImageAi__Model`，以及可选的 `ImageAi__Endpoint`。它们不复用文本模型密钥和模型 ID。

当前适配器使用 OpenAI-compatible JSON 生成与 multipart 编辑接口，请求地图描述中的 `size: <width>x<height>`，读取 PNG base64。默认发送 `response_format: b64_json`，可通过 `ImageAi__SendResponseFormat=false` 省略。参考编辑必须同时配置 `ImageAi__EditsEndpoint` 和 `ImageAi__AllowReferenceUpload=true`，否则已登记参考图不会上传到供应商。不同图片模型参数并不统一，实际兼容性需要专门验收。当前不下载供应商返回的任意 URL，也不自动跟随重定向。

任务来自明确确认的独立地图规格，保存用户提示原文、请求尺寸、网格比例尺和参考图哈希。每次确认最多外发一次，失败与超时不自动重试；重启时发现中断的 `generating` 地图会标为失败，不再次发送可能已经计费的请求。尚未外发的 `pending` 任务仍由后台处理。新一次生成必须由主持人确认，过期任务不能覆盖它。成功图片按内容哈希保存，相同规格与供应商身份可复用缓存；本地幂等不能保证外部供应商恰好计费一次。

浏览器主持工作台 `/workbench/` 的「地图图册」页提供描述导入、尺寸、网格、比例尺、确认生成和发布。已发布玩家图可在 Unity 浏览；图片请求带席位鉴权，不使用公开哈希路由。配置、外部参考 PNG 登记与限制见 [地图指南](maps.md)。场景生图和预生成已停止，历史验证记录不代表它们仍可调用。地图自动化使用本机测试图与替身，没有进行真实大尺寸质量验收；不要对真实供应商运行测试脚本。对象存储、缓存淘汰和完整公网防护仍未实现。

---

### 存档和恢复

每个战役使用独立 SQLite 数据库保存角色、场景、世界事实与待裁定状态，并在索引表保存完整事件和席位级幂等回执。状态、事件和回执在一个事务中提交，成功后才返回响应。普通快照加载最近 100 个事件；旧事件按序号分页，旧请求按键重放，没有每战役 10000 次行动的原型上限。

服务端只保存战役 token 的 SHA-256。Unity 的 `Application.persistentDataPath` 内会保存本机 bearer token 和待确认请求，应按凭证保护，不能提交到仓库。旧战役凭证副本保存在本机 `sessions` 子目录，UI 可继续最近存档或从本机目录选择其他战役。没有账号恢复机制，丢失本机 token 不能由角色名字恢复权限。

备份前先正常停止服务端，使用 备份脚本 复制完整数据与额度账本，并单独保护 Unity 本机会话。读取上一版 Unity 原型 JSON 时会授权后导入，原文件保留；不提供旧网页数据库迁移。不要在服务端运行时编辑存档，也不要把保留的旧 JSON 当成当前权威数据。

内容创作草稿与提示词版本的操作见 [内容指南](content-import.md)。隔离试跑有独立数据库、凭证和事件，服务端永久禁止其文本与图片模型调用；即使主服务已配置真实供应商也不会调用。试跑不覆盖正式战役。旧高级表单的标签页草稿关页前应导出；[输入式准备](input-preparation.md) 和 [Harness 工作区](harness-workspace.md) 已各自持久保存本地草稿。持久化仍不等于跨设备备份或自动服务端提交，清除浏览器站点数据前应显式导出需要保留的内容。

Unity「历史 / 回顾」支持固定截止点分页、确定性回顾、阅读副本导出和可恢复归档。备份、恢复、迁移限制与验证见 [长期历史与存储](history-and-storage.md)。

---

### Unity 与 Pipeline

工程位于 client-unity，由 Unity CLI 官方 2D 模板创建。本机实际安装的 Editor 是 `6000.3.24f1`，Pipeline 版本固定在 manifest.json。项目 skill 包含已验证的连接、编译和截图用法。

本机安装目录已从不可写的旧位置调整为 `G:/Users/admin/Unity/Editors`，下载缓存为 `G:/Users/admin/Unity/Downloads`。这些是机器配置，不作为项目在其他机器上的硬编码路径。

当前导入链路使用 浏览器导入脚本 和 Editor 的 ContentImportLoop，仅连接离线 5182。浏览器显式导入测试目录中的回归夹具，再由真实 Unity 验证行动和路线。测试夹具不会随服务器成为默认内容。旧 PlayLoop 依赖已移除的默认故事，只保留为历史记录。

Windows Development Player 构建目标为 `StandaloneWindows64`，构建结果在忽略目录 `artifacts/player`。Player 构建不启用 Pipeline 运行时服务，Editor 自动化仍然可用。当前 Player 允许开发版 loopback HTTP，正式发布需要 HTTPS 与相应安全配置。

---

### 联网边界

该版本不是可以直接公网部署的联机服务。虽然客户端和服务器已分离，并使用 capability token 和乐观版本控制，已具备独立角色邀请、席位权限与轮询同步；尚无账号系统、HTTP 限流、每用户创建额度、WebSocket 广播或多服务副本。

新地图通过席位鉴权下载，主持人图、提示词、参考列表和未发布玩家图不向普通队员开放。旧场景图片保留历史公开哈希 URL，不要将其当成私有素材存储。参考 PNG 外发还需单独开启服务端许可。公网部署仍需要 TLS、账号与会话管理、限流、内容审查、用户级滥用防护和运维审计，不能仅将监听地址改成 `0.0.0.0`。

---

### 验证命令

服务端规则、事务、HTTP 与资源检查：

```bash
dotnet run --project tests/DiceRealm.Tests
```

客户端无引擎契约检查：

```bash
dotnet run --project client-unity/Tools/DotNetCheck -c Release
```

Unity EditMode：

```bash
unity command run_tests --mode editor --filter DiceRealm.EditMode --filter_type assembly --project-path ./client-unity --format json
```

本地 MCP 规则取证需要已安装 Python 的 `mcp`、`httpx` 等 vendor 依赖：

```bash
python scripts/verify_rules.py
```

完整结果写入忽略目录 `artifacts/rule-evidence`，不将完整商业规则文本随项目再分发。


---

### 离线战斗开发

默认演示服务可能启用真实模型。战斗开发使用独立端口、数据目录和 Debug 构建；运行前确认该端口空闲，已有实例不能直接覆盖其二进制。

```powershell
./scripts/start-server.ps1 -Offline -Background -Configuration Debug -Port 5182 -DataPath ./.local/combat-save
```

确认 `http://127.0.0.1:5182/health` 返回 `textMode=offline`。旧 CombatLoop 依赖默认遭遇，当前不再直接适用；导入遭遇的自动化覆盖由 [ContentTests](../tests/DiceRealm.Tests/ContentTests.cs) 提供。不要将批量游玩测试指向启用付费供应商的 `5180`，也不要覆盖已在运行的离线实例。

战斗按钮不调用 AI，也不按每个回合新建场景图片。离线测试结束后，可通过 LiveAiPreview 恢复已验证的 AI 战役与现有图片，只读取快照，不触发新行动。
