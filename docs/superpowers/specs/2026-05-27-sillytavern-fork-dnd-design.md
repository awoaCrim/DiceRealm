# SillyTavern Fork DND 多人跑团设计

## 目标

以 SillyTavern 作为主体应用进行改造，保留其预设、角色卡、世界书、Prompt 管理、上下文预览、模型调用和聊天式日志体验，并在其基础上加入多人 DND 跑团能力。

最终系统需要支持：

- DM 创建 DND 房间。
- 每位玩家获得专属随机 token 链接。
- 玩家页面只显示该玩家可见的信息。
- DM 可选择 SillyTavern 预设、世界书和角色卡资源。
- AI-DM 按回合处理所有玩家行动。
- 玩家间互动必须由目标玩家确认，AI 不能替玩家决定。
- 后端强制执行信息隔离，避免通过 API、世界书或 Prompt 泄露私密信息。

## 总体架构

主应用切换为 SillyTavern fork。当前 MVP 不再作为最终主架构，但其 DND 领域模型、信息隔离服务、回合引擎和测试用例可迁移到 fork 中。

系统分为两层：

1. SillyTavern 原生资源层。
2. DND 多人运行层。

SillyTavern 原生资源层负责：

- 角色卡管理。
- 世界书 / World Info 管理。
- Prompt preset / instruct / context template 管理。
- 模型连接配置。
- 上下文预览。
- 扩展体系。

DND 多人运行层负责：

- 房间。
- 玩家 token。
- 回合。
- 行动。
- 玩家间互动确认。
- public/private/admin 日志。
- 玩家可见状态裁剪。
- AI-DM 结构化回合处理。

## 数据与模块

### SillyTavern 原生资源层

#### 角色卡

继续支持 SillyTavern character card 数据结构。角色卡既可以作为 SillyTavern 原生聊天角色，也可以被绑定到 DND 玩家。

DND 玩家页面显示被分配角色卡的公开部分。隐藏字段、DM 备注或扩展字段是否可见，必须由 DND visibility service 判定。

#### 世界书

继续使用 SillyTavern World Info / Lorebook 结构。DND 房间可以绑定一个或多个世界书。

回合处理时根据以下上下文触发世界书：

- 房间世界设定。
- 公开日志。
- 本轮行动摘要。
- 在生成某玩家私密更新时，可额外使用该玩家私密上下文触发仅该玩家可见的条目。

世界书条目不能绕过信息隔离直接暴露给所有玩家。

#### 预设

继续使用 SillyTavern prompt preset / instruct / context template 体系。DND 房间可选择当前启用预设。

AI-DM 构造请求时，预设作为 Prompt 结构的基础，但必须追加 DND 强约束：

- 不替玩家做决定。
- 不泄露私密信息。
- 玩家间强制互动必须创建确认请求。
- 输出必须可解析为结构化结果。

#### 上下文预览

扩展 SillyTavern prompt/context preview，让 DM 可以查看最终 AI-DM 请求。

预览必须标注：

- 预设注入内容。
- 世界书注入内容。
- 公共上下文。
- 玩家私密上下文。
- 输出格式约束。

### DND 多人运行层

新增 DND 专用模块，不直接污染 SillyTavern 原有单人聊天逻辑。

#### dndRooms

字段包括：

- 房间 ID。
- 房间名称。
- 世界设定。
- 当前回合。
- 房间状态。
- 绑定的 SillyTavern 预设。
- 绑定的 SillyTavern 世界书。
- 创建时间。

#### dndPlayers

字段包括：

- 玩家 ID。
- 房间 ID。
- 玩家名称。
- 随机长 token。
- 绑定角色卡 ID。
- 在线状态。
- 创建时间。

#### dndTurns

字段包括：

- 回合 ID。
- 房间 ID。
- 回合编号。
- 状态：等待行动、处理中、等待互动确认、完成、需要 DM 处理。
- 开始时间。
- 结束时间。

#### dndActions

字段包括：

- 行动 ID。
- 房间 ID。
- 回合 ID。
- 玩家 ID。
- 行动文本。
- 提交时间。
- 状态。

行动必须按提交时间排序传入 AI-DM。

#### dndInteractions

字段包括：

- 互动 ID。
- 房间 ID。
- 回合 ID。
- 来源玩家。
- 目标玩家。
- 互动类型。
- 给目标玩家的确认问题。
- 目标玩家回应。
- 状态。
- 创建时间。

当一个玩家行动会强制影响另一个玩家的选择、资源、身体、秘密或行动结果时，AI-DM 必须创建互动确认请求，而不是替目标玩家决定。

#### dndLogs

日志分为：

- public：所有玩家可见。
- private：仅指定玩家可见。
- admin/debug：仅 DM 可见。

玩家 API 永远不能返回其他玩家 private 日志或 admin/debug 日志。

## 路由与页面

### DM 页面

在 SillyTavern 中新增 DND 管理入口，例如 `/dnd` 或左侧扩展面板中的 “DND Rooms”。

DM 页面能力：

- 创建房间。
- 选择或创建世界设定。
- 选择 SillyTavern 预设。
- 绑定 SillyTavern 世界书。
- 添加玩家。
- 给玩家分配角色卡。
- 生成玩家专属链接。
- 查看玩家提交状态。
- 查看 public/private/admin 日志。
- 手动推进回合。
- 预览最终 AI-DM prompt。
- 查看 AI 输出原文、解析结果和错误。

### 玩家页面

玩家页面使用独立轻量路由，例如 `/dnd/player/:token`。

玩家只能看到：

- 自己的角色卡。
- 当前回合状态。
- 公开日志。
- 自己的私密故事。
- 自己是否已提交行动。
- 等待哪些玩家提交。
- 自己需要确认的互动请求。
- 行动输入框。

玩家不能看到：

- SillyTavern 全局资源管理。
- 其他玩家角色私密字段。
- 其他玩家行动文本。
- DM debug 信息。
- 完整 prompt。

## 回合流程

1. DM 创建 DND 房间。
2. DM 选择预设、世界书和世界设定。
3. DM 添加玩家。
4. DM 为玩家绑定角色卡。
5. 系统为每位玩家生成专属 token 链接。
6. 玩家打开链接，仅看到自己可见状态。
7. 玩家提交行动。
8. 后端记录行动文本和提交时间。
9. 所有玩家提交后，DM 点击“处理本回合”。
10. AI-DM prompt builder 加载：
    - 房间启用预设。
    - DND 强约束。
    - 房间世界设定。
    - 触发的世界书条目。
    - 玩家角色卡公开部分。
    - 公开日志。
    - 本轮行动，按提交时间排序。
    - 待处理互动。
    - 输出格式约束。
11. AI 返回结构化 JSON：
    - publicLog。
    - privateUpdatesByPlayer。
    - interactionRequests。
    - ruleResults。
12. 后端保存 publicLog 为 public 日志。
13. 后端保存 privateUpdatesByPlayer 为对应玩家 private 日志。
14. 后端保存 interactionRequests 为目标玩家待确认请求。
15. 如果存在互动请求，房间进入等待互动确认状态。
16. 目标玩家回应后，DM 可再次处理。
17. 处理完成后进入下一回合。

## 与 SillyTavern 聊天系统的关系

首版不直接复用 SillyTavern 普通单人聊天窗口作为玩家页面。

原因：

- 普通聊天窗口天然偏向完整上下文。
- 多人信息隔离需要专门 API。
- 玩家页面必须轻量、token 化、安全。

DM 侧尽量复用 SillyTavern 资源和体验：

- 资源选择器。
- 角色卡管理。
- 世界书管理。
- Prompt preset 管理。
- 模型连接配置。
- Prompt preview。
- 插件/扩展机制。

玩家侧使用 DND 专用隔离页面。

## AI Provider 与输出解析

优先复用 SillyTavern 现有模型配置和 generation/provider 通道。

DND 层新增 adapter：

- 输入：结构化 DND prompt。
- 调用：SillyTavern 现有 generation/provider。
- 输出：解析为 DND 结构化结果。
- 失败：保存原始输出和错误到 admin/debug 日志。

AI 输出必须是结构化 JSON，字段为：

- publicLog。
- privateUpdatesByPlayer。
- ruleResults。
- interactionRequests。

解析失败时：

- 不推进回合。
- 房间进入需要 DM 处理状态。
- 保存原始 AI 输出。
- DM 可重试或手动修正。

后续可加入 JSON repair，但首版不依赖自动修复。

## 信息隔离规则

信息隔离由 DND 后端强制执行，而不是依赖前端隐藏。

规则：

- 玩家 API 必须通过 visibility service。
- 玩家 API 不返回其他玩家 private 日志。
- 玩家 API 不返回 admin/debug 日志。
- 玩家 API 不返回其他玩家未公开行动文本。
- 玩家 API 不返回其他玩家角色私密字段。
- 全局日志只包含公开事件和元信息。
- Prompt builder 分公共上下文和玩家私密上下文。
- 世界书触发分公共扫描和私密扫描。
- Prompt preview 必须标注注入内容的可见范围。

AI-DM 可以在处理整轮时看到本轮行动，但输出必须分发到正确可见范围。

## 迁移策略

### 阶段 1：引入 SillyTavern 代码底座

- 拉取或放入 SillyTavern 源码。
- 确认启动、构建和测试方式。
- 不先改核心逻辑。
- 标记接入点：角色卡、世界书、预设、模型调用、Prompt 构建、上下文预览。

### 阶段 2：新增 DND 多人运行层

- 在 SillyTavern 项目内新增 DND 后端模块。
- 实现房间、玩家 token、回合、行动、日志和信息隔离 API。
- 先保证核心 DND 流程可运行。

### 阶段 3：接入 SillyTavern 资源

- 房间选择 SillyTavern 预设。
- 房间绑定 SillyTavern 世界书。
- 玩家绑定 SillyTavern 角色卡。
- AI-DM prompt builder 使用 SillyTavern 资源，但必须经过 DND 隔离规则过滤。

### 阶段 4：接入 SillyTavern 模型调用

- 改用 SillyTavern 现有 generation/provider 配置。
- 增加 DND adapter。
- 解析 AI 输出为结构化回合结果。

### 阶段 5：整合 UI

- 在 SillyTavern 管理界面加入 DND 房间入口。
- DM 控制台使用 SillyTavern 风格 UI。
- 玩家页面保持 DND 专用隔离页面。

## 风险与控制

### 上游体量风险

SillyTavern 代码量大，直接改核心容易失控。

控制方式：

- DND 代码尽量独立目录。
- 优先通过 adapter 接入原能力。
- 避免大规模修改核心文件。

### 信息隔离风险

SillyTavern 原始上下文不是多人隔离设计。

控制方式：

- 玩家 API 强制走 visibility service。
- Prompt builder 分公共和私密上下文。
- 测试断言玩家 A 看不到玩家 B 私密内容。

### Prompt 泄露风险

世界书、角色卡和预设可能包含私密内容。

控制方式：

- 角色卡字段分公开/私密。
- 世界书触发分公共扫描和玩家私密扫描。
- Prompt preview 标注来源和可见范围。

### AI 输出不稳定风险

AI 可能不返回合法 JSON。

控制方式：

- 强制输出格式预设。
- 解析失败时保存原始输出。
- DM 可重试或手动修正。
- 首版不自动推进失败回合。

### 上游更新冲突风险

直接 fork 改造会影响后续合并上游。

控制方式：

- DND 模块独立。
- 修改上游文件时集中在少量入口。
- 记录所有接入点。

## 测试策略

必须覆盖：

- 创建 DND 房间后可生成 DM 页面。
- 每个玩家得到唯一 token。
- token 页面只能看到该玩家数据。
- SillyTavern 角色卡能绑定到玩家。
- 玩家页面显示对应角色卡。
- 房间绑定世界书后，本轮行动命中关键词时注入 prompt。
- 房间绑定预设后，AI-DM prompt 使用该预设。
- 玩家 A 看不到玩家 B 私密日志。
- 玩家 A 看不到玩家 B 私密角色字段。
- 全局日志不包含私密行动文本。
- 行动按提交时间排序。
- 所有玩家提交前不能处理。
- AI 输出 public/private/interaction 三类结果。
- 玩家间互动不由 AI 直接决定目标玩家反应。
- 目标玩家回应后才能进入下一次 AI 裁定。
- AI 输出非法 JSON 时，DM 能看到原始输出和错误，房间进入需要处理状态。

## 成功标准

首个可用版本完成时，应满足：

- SillyTavern fork 可启动。
- DM 可创建 DND 房间。
- DM 可添加玩家并生成玩家链接。
- 玩家可通过 token 页面提交行动。
- 后端等待所有玩家行动后处理回合。
- AI-DM 使用 SillyTavern 预设、世界书、角色卡资源构造 prompt。
- public/private/admin 信息隔离正确。
- 玩家间互动需要目标玩家确认。
- Prompt preview 可用于审计最终 AI 请求。
- 测试覆盖核心隔离、回合处理和资源接入路径。
