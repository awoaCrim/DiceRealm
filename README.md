# DiceRealm

在浏览器里和朋友玩 D&D 2024 冒险。玩家用自然语言说自己要做什么，AI 主持描写世界和人物；检定、战斗、法术、资源和存档由服务端按规则执行，AI 不能改数值。

- 玩家页 `/play/`：输入房间号和共享密码加入，选职业、起名字就能建好角色（也可以八步详细建卡）；冒险、投掷、角色窗、冒险手记和战斗棋盘都在这一页。
- 主持工作台 `/workbench/`：账户、房间、剧本库、邀请玩家、审核角色、查看剧情与战斗、AI 设置和请求日志。
- 人工主持只在需要时介入：批准新角色、处理疑难裁定、纠正 AI 的错误。

文档从 [当前状态](docs/current-status.md) 和 [文档索引](docs/README.md) 开始；开发约束在 [.trellis/spec](.trellis/spec/index.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `server/DiceRealm.Server` | .NET 10 权威服务端：规则、战役存储（SQLite）、AI 主持调度与 HTTP API，并托管两个网页 |
| `client-workbench/` | 两个网页（无构建步骤的原生 ES 模块）：`play.html` + `src/play/` 是玩家页，其余是主持工作台 |
| `agent-host/` | AI 主持的执行进程（Node，Pi SDK + MCP 工具），由服务端按需启动 |
| `content/` | 原创示例剧本《雨桥失信》与主持提示词 |
| `schemas/` | 剧本、地图、提示词等 JSON 格式 |
| `tests/` | 服务端规则与 HTTP 集成测试；也为浏览器巡检提供测试房间 |
| `scripts/qa/play-tour.mjs` | 玩家页浏览器巡检（无头 Chrome） |
| `docs/` | 协议与使用说明 |

早期的 Unity 玩家端已停止开发，玩家端改为 `/play/`；这个公开仓库不包含 Unity 工程。部分文档仍保留当时的记录。

## 运行

需要 .NET 10 SDK 和 Node ≥ 22.19。

```bash
npm --prefix agent-host ci --ignore-scripts
npm --prefix agent-host run build

export Harness__Enabled=true
export Harness__AgentHostPath="$PWD/agent-host/dist/main.js"
export Accounts__InitialAdminPassword='自己设一个 8 位以上的密码'
dotnet run --project server/DiceRealm.Server
```

服务默认只监听 `http://127.0.0.1:5180`，数据默认在 `server/DiceRealm.Server/data/`（已被 git 忽略；可用 `DataPath` 指定其他目录）。

1. 打开 `http://127.0.0.1:5180/workbench/`，用 `admin` 和上面的密码登录。没设密码时，首次启动会随机生成一个，只在日志里显示一次。
2. 在「AI 设置」填入文字模型（Gemini 或 OpenAI 兼容接口）。不配置就不会调用任何付费模型，AI 主持也不会回应。
3. 新建房间，在「剧本与提示词」的剧本库启用《雨桥失信》，再到「邀请玩家」设置共享密码。
4. 玩家打开 `http://127.0.0.1:5180/play/`，输入房间号和密码，建好角色加入；主持在剧情页批准后就能开始。

其他配置（模型思考档位、调用上限、本地中文规则库、地图生图）见 [运行与工具](docs/harness-runtime.md) 和 [本地开发与运行](docs/development.md)。服务只为本机设计，不要直接暴露到公网；远程多人需要自己配置 HTTPS 反向代理。

## 测试

```bash
dotnet run --project tests/DiceRealm.Tests                  # 服务端，约 550 组，不调用真实模型
dotnet run --project tests/DiceRealm.Tests -- --filter accounts   # 只跑名称包含该文字的组
cd client-workbench && npm test                             # 网页逻辑（node --test）
npm --prefix agent-host test
```

玩家页巡检：先让测试项目起一个测试房间，再用无头 Chrome 走一遍，截图和控制台错误写到输出目录。`CHROME` 指向 Chrome 或 Chromium 可执行文件；测试房间在出现 `<状态文件>.stop` 时退出。

```bash
dotnet run --project tests/DiceRealm.Tests -- --play-browser /tmp/tour.json &
CHROME=/path/to/chrome node scripts/qa/play-tour.mjs /tmp/tour.json /tmp/tour-out
touch /tmp/tour.json.stop
```

战斗巡检用 `--play-combat-browser`（可加 `wizard`、`caster`、`party`），巡检脚本加对应的 `--combat`、`--wizard`、`--caster`、`--party`；`--play-browser` 配 `--join` 走新玩家加入。

## 许可与内容

本项目代码暂未附带开源许可证。规则数据只含机制、名称、简短摘要与校验用散列，不包含规则书全文；完整中文规则文本只在本机配置（见 [本地中文核心规则库](docs/local-chinese-rules.md)）。D&D 及相关名称属于 Wizards of the Coast。字体为 Source Han Sans / Serif（SIL OFL，许可文本在 `client-workbench/fonts/`）。
