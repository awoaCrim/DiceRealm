# AI 接口配置与预设统一设计

## 背景

当前项目已经把房间运行时状态与全局配置分离：房间实时读取全局剧本卡、世界书、ST 预设包和默认提示词配置。但现有实现仍保留了两个容易混淆的概念：

- `AI 约束`：以 `AiConfig` / `global_config.ai_config_json` 表示，前端有独立标签页。
- `预设`：以全局 prompt preset / prompt blocks 表示，前端也有独立标签页。

用户已确认：AI 约束和预设应是同一个东西，并且要从底层完全并入预设体系。与此同时，系统还需要能在管理台配置外部 AI API 入口，而不是只能通过环境变量配置 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`。

## 目标

1. 新增全局 AI 接口配置，让管理台可以保存并测试模型服务入口。
2. 从数据模型、服务层、运行时 prompt 构建和前端 UI 上移除独立的“AI 约束”产品概念。
3. 让全局预设及其提示词块成为唯一可编辑 prompt 规则来源。
4. 保持“房间实时使用全局配置”：既有房间下一次 preview / process-turn 立即使用当前 AI 接口配置和当前启用预设。

## 非目标

- 不把 API Key 加密存储；本项目是本地应用，按用户选择直接保存到本地 SQLite。
- 不引入多租户、多用户权限或远程密钥管理。
- 不重新设计 ST 资源导入格式。
- 不保留独立的 AI 约束编辑入口。

## 管理台结构

管理台标签页调整为：

- `总览`
- `AI 接口`
- `资源`
- `预设`
- `世界书`

### AI 接口

`AI 接口` 只配置模型服务连接，不包含任何 prompt、规则或约束内容。

字段：

- Provider：`mock` 或 `openai-compatible`
- API Base URL
- API Key
- Model

操作：

- 保存配置
- 测试连接

`mock` provider 不要求 `baseUrl`、`apiKey`、`model`。`openai-compatible` provider 要求三者非空，并要求 `baseUrl` 是合法 URL。

### 预设

`预设` 成为唯一 prompt 配置入口，承载原“AI 约束”的所有内容。

默认强约束预设由提示词块组成，包括：

- 核心规则
- 玩家自主权规则
- 信息隔离规则
- 玩家互动规则
- 叙事风格规则
- 输出格式规则

用户通过预设页编辑、折叠/展开、新增、启用提示词块。Prompt Preview 放在预设页中触发，因为 preview 验证的是当前预设和资源如何构建最终 prompt。

## 数据模型

### AI 接口配置

新增全局 AI provider 配置，建议保存到 `global_config` 单例行的新 JSON 字段，例如 `ai_provider_config_json`：

```ts
interface AiProviderConfig {
  provider: 'mock' | 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  model: string;
}
```

默认值：

```ts
{
  provider: 'mock',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini'
}
```

选择 JSON 字段的原因：

- 与现有 `global_config` 单例模式一致。
- 配置项数量少，整体读写，不需要单独查询或复杂索引。
- 后续如果增加 temperature 等服务连接参数，可以兼容扩展。

### 预设作为唯一 prompt 规则来源

`global_prompt_presets` 和 `global_prompt_blocks` 成为运行时 prompt 规则的唯一可编辑来源。

`global_config.ai_config_json` 不再作为 preview / process-turn 的运行时真源。它只能作为旧数据迁移来源或短期兼容字段存在。

## 后端 API

新增接口：

```http
GET /api/admin/config/ai-provider
PUT /api/admin/config/ai-provider
POST /api/admin/config/ai-provider/test
```

### GET /api/admin/config/ai-provider

返回当前保存的 `AiProviderConfig`。

### PUT /api/admin/config/ai-provider

请求体：

```json
{
  "provider": "openai-compatible",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "gpt-4o-mini"
}
```

保存成功后返回标准化后的 `AiProviderConfig`。

校验规则：

- `provider` 必须是 `mock` 或 `openai-compatible`。
- `provider=mock` 时允许 `baseUrl`、`apiKey`、`model` 为空。
- `provider=openai-compatible` 时，`baseUrl`、`apiKey`、`model` 必须非空。
- `baseUrl` 必须可被 `new URL()` 解析。

### POST /api/admin/config/ai-provider/test

使用请求体里的配置测试连接；如果请求体为空，则使用已保存配置。

测试请求使用 OpenAI-compatible chat completions 端点，发送最小消息并要求严格 JSON 响应。测试成功返回：

```json
{ "ok": true }
```

测试失败返回 400 或 502 JSON 错误，不改变房间状态，不写入 `ai_generations`。

## 服务层设计

新增服务函数：

```ts
function getGlobalAiProviderConfig(db: AppDatabase): AiProviderConfig;
function updateGlobalAiProviderConfig(db: AppDatabase, input: AiProviderConfig): AiProviderConfig;
function normalizeAiProviderConfig(input: unknown): AiProviderConfig;
function createAiProviderFromConfig(config: AiProviderConfig): AiProvider;
function testAiProviderConfig(config: AiProviderConfig): Promise<void>;
```

`createApp()` 不再在启动时创建固定 `aiProvider`。`process-turn` 每次执行时从数据库读取当前 AI provider config，再创建 provider。

这样可以保证：

- 修改 AI 接口配置后，不需要重启服务。
- 既有房间下一次处理回合立即使用新配置。
- `ai_generations.provider` 记录实际使用的 provider 名称。

## Prompt 构建运行时

### Native prompt

`buildTurnPrompt()` 不再接收 `aiConfig`。它接收当前启用全局预设的 `promptBlocks`，并按注入位置构建 prompt。

所有用户可编辑规则来自 `promptBlocks`。

### ST-compatible prompt

`buildSillyTavernPromptPreview()` 不再接收 `aiConfig`。它继续读取：

- 当前全局 ST 预设包
- 当前全局剧本卡
- 当前全局资源世界书绑定
- 房间运行时状态
- DND 运行时槽位

用户可编辑的规则和顺序由 ST 预设包 / 全局预设体系负责。

### DND 强制底线

系统仍需要不可关闭的引擎保护，用于保证：

- 严格 JSON 输出
- 信息隔离
- 玩家自主权
- 玩家互动确认

这部分不再叫“AI 约束配置”，也不来自 `AiConfig`。它是引擎级固定契约，可以继续以 `dndOutputContract` 运行时块注入。用户可编辑的规则表达全部在预设块里，系统底线作为不可关闭的安全契约保留。

## 迁移与兼容

1. 保留 `global_config.ai_config_json` 字段，避免破坏已有数据库。
2. 初始化默认全局预设时，如果默认预设不存在，可以用旧 `ai_config_json` 生成默认 blocks。
3. 生成后，preview / process-turn 只读取启用的全局预设 blocks，不再读取 `ai_config_json`。
4. 前端删除 `AI 约束` 标签页和 `saveGlobalAiConfig()` 调用。
5. 后端旧 `/api/admin/config/ai-config` 可以短期保留用于兼容测试，但不再作为产品入口；如果保留，其行为必须同步到默认预设 blocks，而不能写一个独立运行时配置。
6. 旧 `/api/admin/rooms/:roomId/ai-config` 属于房间配置时代的兼容接口，新前端不调用，后续可清理。

## 错误处理

- AI provider 配置校验失败返回 400 JSON。
- 测试连接失败返回 JSON 错误，不影响房间状态。
- process-turn 调用外部 provider 失败时沿用现有行为：房间和当前回合进入 `needs_admin_attention`，错误写入 `ai_generations.error`。
- API Key 明文保存和回显是本次用户选择的行为；UI 用 password input 呈现，但不会隐藏响应字段。

## 测试策略

### 后端集成测试

- 默认 AI provider 配置为 `mock`。
- `PUT /api/admin/config/ai-provider` 能保存并返回标准化配置。
- `openai-compatible` 缺少 `baseUrl`、`apiKey` 或 `model` 返回 400。
- 修改 AI provider 配置后，既有房间下一次 process-turn 使用新 provider 配置。
- preview / process-turn 不再依赖 `global_config.ai_config_json`。
- 默认强约束预设能从旧 `ai_config_json` 初始化一次。
- 旧 `/config/ai-config` 如保留，必须同步默认预设 blocks，而不是创建第二套运行时真源。

### 前端测试

- 管理台不再显示 `AI 约束` 标签。
- 管理台显示 `AI 接口` 标签。
- AI 接口页能编辑 provider / baseUrl / apiKey / model。
- AI 接口保存和测试失败使用统一错误提示。
- 预设页显示默认强约束 blocks。
- Prompt Preview 从预设页触发。
- 前端不再调用 `saveGlobalAiConfig()`。

### 浏览器验证

- 打开管理台，确认标签页为 `总览` / `AI 接口` / `资源` / `预设` / `世界书`。
- 在 `AI 接口` 配置 mock provider 并保存。
- 在 `预设` 修改一个提示词块，保存后 preview 包含修改内容。
- 创建房间并提交玩家行动，process-turn 使用当前保存的 AI provider 配置。
- 切换到 openai-compatible 的无效配置时，测试连接显示错误且不影响房间状态。

## 完成标准

- 产品概念中没有独立的“AI 约束”入口。
- 运行时 prompt 规则只来自启用预设的提示词块和引擎固定契约。
- AI 接口配置可以在管理台保存，并实时影响既有房间下一次 process-turn。
- 现有测试、类型检查、构建和浏览器主流程验证全部通过。
