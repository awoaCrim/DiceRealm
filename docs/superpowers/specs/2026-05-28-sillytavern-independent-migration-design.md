# SillyTavern 一次性迁移与独立运行设计

## 背景

当前 DND AI DM 系统以独立的 `server/` + `client/` 应用为产品主线。`SillyTavern/` 只作为一次性数据来源和格式参考，不作为运行时依赖。

本设计目标是把可复用的 SillyTavern 资源迁移进独立系统：角色卡、世界书和预设。聊天记录、日志历史和 SillyTavern 运行时逻辑不迁移。

## 目标

- 管理员可以通过后台上传 SillyTavern 资源文件。
- 导入资源先进入全局资源库，不直接修改房间内容。
- 房间通过绑定关系选择主剧本卡、世界书和 ST 兼容预设包。
- 运行时 Prompt 构建模仿 SillyTavern 的槽位化处理方式。
- 系统最终仍强制 DND 回合引擎所需的结构化输出、信息隔离和玩家自主权规则。
- 完成迁移能力后，运行时不依赖 `SillyTavern/` 目录或 SillyTavern 代码。

## 非目标

本轮不实现：

- PNG 角色卡解析。
- 聊天/日志历史导入。
- 从本机 SillyTavern 数据目录直接读取资源。
- 完整 SillyTavern 世界书 token budget、递归扫描、概率触发和深度注入。
- 多剧本卡复杂叠加。
- 把 ST 角色卡自动转换为玩家角色卡。
- 把 `system_prompt` / `post_history_instructions` 自动混入剧本或预设。
- 切换 AI provider 到 Anthropic SDK。

## 核心设计原则

### 资源保持结构化

导入资源不拍平成房间字段，也不覆盖当前房间日志、世界信息或 AI 约束。资源保留原始结构和 `raw_json`，绑定到房间后只参与生成前的上下文构建。

### ST 角色卡在本项目中是剧本卡

SillyTavern character card 在本系统中不代表玩家角色卡，而是剧本、场景、NPC/势力风格和示例叙事的来源。

字段映射：

| ST 字段 | 本项目含义 |
|---|---|
| `description` | 剧本/背景描述 |
| `personality` | 叙事基调、NPC/势力风格 |
| `scenario` | 当前主场景 |
| `first_mes` | 可选开场种子，不自动写入日志 |
| `mes_example` | 示例叙事/示例对话槽位 |
| `creator_notes` | 默认 DM/AI 可见，不向玩家公开 |
| `character_book` | 导入为关联世界书 |
| `system_prompt` | 首版只保留在 `raw_json` |
| `post_history_instructions` | 首版只保留在 `raw_json` |

### AI 约束属于预设和 DND 兜底契约

剧本卡不承载 AI 约束。ST 预设包负责导入通用 prompt、context、instruct、sysprompt 和 reasoning 配置。DND 引擎最终追加不可关闭的输出契约，保证结构化响应、信息隔离、玩家自主权和互动确认。

## 数据模型

### `script_cards`

全局剧本卡库，用于保存从 ST 角色卡导入的剧本资源。

核心字段：

- `id`
- `name`
- `description`
- `personality`
- `scenario`
- `first_mes`
- `mes_example`
- `creator_notes`
- `visibility_notes`
- `source_type`: `sillytavern_character`
- `raw_json`
- `created_at`
- `updated_at`

### `resource_world_books`

全局世界书库。

核心字段：

- `id`
- `name`
- `source_type`
- `raw_json`
- `created_at`
- `updated_at`

### `resource_world_book_entries`

全局世界书条目。

核心字段：

- `id`
- `world_book_id`
- `keys_json`
- `secondary_keys_json`
- `content`
- `enabled`
- `constant`
- `priority`
- `order_index`
- `position`
- `raw_json`

首版激活逻辑：

- `enabled = false` 时跳过。
- `constant = true` 时直接激活。
- `keys` 命中扫描文本时激活。
- 存在 `secondaryKeys` 时，主键和副键都命中才激活。
- 激活条目按 `priority`、`order_index`、导入顺序排序。

### `prompt_preset_packages`

全局 ST 兼容预设包库。

核心字段：

- `id`
- `name`
- `source_type`: `sillytavern_preset_package`
- `openai_settings_json`
- `context_template_json`
- `instruct_template_json`
- `sysprompt_json`
- `reasoning_template_json`
- `raw_json`
- `created_at`
- `updated_at`

ST `OpenAI Settings` 是主文件。`context`、`instruct`、`sysprompt`、`reasoning` 是同一个 package 的可选组成部分。

### 房间绑定表

#### `room_script_bindings`

首版一个房间只绑定一个主剧本卡。

- `room_id`
- `script_card_id`
- `binding_type`: `main`
- `enabled`
- `created_at`

#### `room_world_book_bindings`

房间可绑定多个全局世界书。

- `room_id`
- `world_book_id`
- `enabled`
- `order_index`

#### `room_preset_binding`

房间绑定一个当前 ST 兼容预设包。

- `room_id`
- `preset_package_id`
- `enabled`

## 导入流程

### ST 角色卡导入

管理后台上传 ST character card JSON。后端解析后创建 `script_cards`。

导入规则：

- `description/personality/scenario/first_mes/mes_example/creator_notes` 写入剧本卡字段。
- `system_prompt/post_history_instructions` 不写入业务字段，只保留在 `raw_json`。
- 如果存在 `character_book`，创建一个 `resource_world_books` 和对应 `resource_world_book_entries`。
- 缺失非关键字段时允许导入并返回 warning。
- 导入后不自动绑定房间，也不写入开场日志。

### ST 世界书导入

管理后台上传 ST world info JSON。后端创建 `resource_world_books` 和 `resource_world_book_entries`。

首版支持字段：

- `keys`
- `secondaryKeys`
- `constant`
- `enabled`
- `priority/order`
- `content`

未支持字段保留在 `raw_json` 并返回 warning。

### ST 预设包导入

管理后台提供多个上传字段：

- `openAiSettings`：必填。
- `contextTemplate`：可选。
- `instructTemplate`：可选。
- `sysprompt`：可选。
- `reasoningTemplate`：可选。

后端把这些文件合并成一个 `prompt_preset_packages`。导入结果返回 prompt 数量、是否存在 `prompt_order`、包含的模板类型和兼容性 warning。

## 后端 API

所有接口挂在 `/api/admin` 下。

### 全局资源库 API

剧本卡：

```http
GET /api/admin/resources/script-cards
POST /api/admin/resources/script-cards/import/sillytavern
GET /api/admin/resources/script-cards/:scriptCardId
DELETE /api/admin/resources/script-cards/:scriptCardId
```

世界书：

```http
GET /api/admin/resources/world-books
POST /api/admin/resources/world-books/import/sillytavern
GET /api/admin/resources/world-books/:worldBookId
GET /api/admin/resources/world-books/:worldBookId/entries
DELETE /api/admin/resources/world-books/:worldBookId
```

预设包：

```http
GET /api/admin/resources/preset-packages
POST /api/admin/resources/preset-packages/import/sillytavern
GET /api/admin/resources/preset-packages/:presetPackageId
DELETE /api/admin/resources/preset-packages/:presetPackageId
```

### 房间资源绑定 API

主剧本卡绑定：

```http
GET /api/admin/rooms/:roomId/resource-bindings/script
PUT /api/admin/rooms/:roomId/resource-bindings/script
DELETE /api/admin/rooms/:roomId/resource-bindings/script
```

世界书绑定：

```http
GET /api/admin/rooms/:roomId/resource-bindings/world-books
PUT /api/admin/rooms/:roomId/resource-bindings/world-books
```

预设包绑定：

```http
GET /api/admin/rooms/:roomId/resource-bindings/preset-package
PUT /api/admin/rooms/:roomId/resource-bindings/preset-package
DELETE /api/admin/rooms/:roomId/resource-bindings/preset-package
```

### Prompt Preview 增强

现有接口继续保留：

```http
GET /api/admin/rooms/:roomId/ai-prompt-preview
```

响应扩展为包含调试结构：

```ts
{
  mode: 'native' | 'sillytavern-compatible';
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  slots: Array<{
    key: string;
    source: string;
    content: string;
  }>;
  worldBookMatches: Array<{
    worldBookId: string;
    entryId: string;
    keys: string[];
    reason: 'constant' | 'primary-key' | 'primary-and-secondary-key';
    position: 'before' | 'after';
  }>;
  promptBlocks: Array<{
    identifier: string;
    source: 'st-preset' | 'runtime-slot' | 'dnd-contract' | 'native-preset';
    role: string;
    content: string;
  }>;
  warnings: string[];
}
```

## 运行时 Prompt 构建

### 构建模式选择

每次处理回合时：

1. 如果房间绑定了 ST 预设包，使用 `sillytavern-compatible` 构建器。
2. 否则使用当前已有原生 `buildTurnPrompt()` 逻辑。
3. 两条路径最后都追加 DND 必需输出契约。

### 构建器输入

ST-style 构建器收集：

- 当前房间信息。
- 玩家与角色卡。
- 本轮玩家行动。
- 公开日志。
- 必要的私密上下文摘要。
- 未完成互动请求。
- 房间绑定的主剧本卡。
- 房间绑定的世界书。
- 房间绑定的 ST 预设包。
- DND 必需输出契约。

### 运行时槽位

| ST 槽位 | 本项目来源 |
|---|---|
| `main` | ST OpenAI Settings 的 main prompt 或 sysprompt 内容 |
| `worldInfoBefore` | 激活的 before 世界书条目 |
| `worldInfoAfter` | 激活的 after 世界书条目 |
| `charDescription` | 主剧本卡 `description` |
| `charPersonality` | 主剧本卡 `personality` |
| `scenario` | 主剧本卡 `scenario` |
| `dialogueExamples` | 主剧本卡 `mes_example` |
| `chatHistory` | DND 公开日志、必要规则结果、可见行动摘要 |
| `personaDescription` | 首版不映射，后续可用于玩家角色摘要 |
| `jailbreak` | ST preset 中如存在则保留，但不替代 DND 兜底契约 |

DND 专用槽位：

- `dndTurnState`
- `dndPlayerActions`
- `dndPendingInteractions`
- `dndOutputContract`

### 世界书扫描

世界书扫描文本由以下内容组成：

1. 房间公开设定。
2. 最近公开日志。
3. 本轮玩家行动。
4. 当前主剧本卡的 `description/scenario`。
5. 必要的互动请求摘要。

激活后的条目根据 `position` 注入：

- `before` → `worldInfoBefore`
- `after` → `worldInfoAfter`

高级 ST 注入位置首版不执行，只保留在 `raw_json`。

### 应用 ST OpenAI Settings

如果房间绑定了 ST 预设包，构建器读取 `prompts` 和 `prompt_order`：

1. 根据 `prompt_order` 决定最终 prompt block 顺序。
2. 遇到 ST marker prompt 时，用运行时槽位替换。
3. 遇到普通 prompt 时，保留原始内容。
4. 遇到未知 prompt identifier 时，作为普通 prompt block 保留。
5. 空槽位对应的 block 可以跳过，避免生成空提示。

### 应用 context template

如果导入了 ST context 模板，使用其中的 `story_string` 组织故事上下文。

模板变量映射：

- `{{description}}` → 剧本卡 `description`
- `{{personality}}` → 剧本卡 `personality`
- `{{scenario}}` → 剧本卡 `scenario`
- `{{wiBefore}}` → `worldInfoBefore`
- `{{wiAfter}}` → `worldInfoAfter`
- `{{system}}` → system/main 内容

如果没有 context 模板，使用默认 ST-like 顺序：

1. system/main
2. worldInfoBefore
3. scriptDescription
4. scriptPersonality
5. scenario
6. worldInfoAfter
7. exampleMessages
8. chatHistory
9. DND turn state
10. DND output contract

### 应用 instruct template

如果导入了 ST instruct 模板：

- 用它决定 user/assistant/system 的包装语义。
- 对 OpenAI-compatible chat completions，优先转换为标准 `messages`。
- ChatML 这类纯文本包装可保留为消息内容中的文本格式。

首版目标是保留语义和顺序，不复刻 ST instruct 的全部边缘行为。

### 应用 sysprompt 与 reasoning

sysprompt：

- 作为系统内容块参与 `main/system` 槽位。
- 不覆盖 DND 输出契约。
- 如果 OpenAI Settings 里已有 `main`，两者按预设顺序合并。

reasoning：

- 保留 `prefix/suffix/separator` 配置。
- 首版用于 Prompt Preview 和最终 prompt 包装。
- 不混入剧本卡或世界书。

### DND 输出契约

最终无论 ST 预设如何排列，都追加不可关闭的 DND 输出契约，保证：

- 返回严格 JSON。
- 字段可被后端解析。
- 公开叙事和玩家私密更新分离。
- 不替玩家做决定。
- 需要互动确认时创建 interaction request。
- 不泄露其他玩家私密行动或隐藏信息。

## 前端管理界面

### 全局资源库 / 导入区域

该区域不依附具体房间。

包含：

- 剧本卡导入卡片和列表。
- 世界书导入卡片和列表。
- ST 预设包导入卡片和列表。

每个导入卡片显示导入结果、warning 和错误。每个列表支持查看详情和删除。

### 房间资源绑定区域

该区域放在具体房间管理页中。

包含：

- 主剧本卡绑定：从全局剧本卡选择一个，支持绑定和解绑。
- 世界书绑定：从全局世界书选择多个，支持启用/禁用和排序。
- ST 预设包绑定：从全局预设包选择一个，支持绑定和解绑。

说明文案必须明确：绑定资源只影响 AI 上下文构建，不会自动写入房间日志或开场消息。

### Prompt Preview 增强

Prompt Preview 展示：

- 当前构建模式：`native` 或 `sillytavern-compatible`。
- 当前绑定资源。
- 动态槽位内容。
- 世界书命中详情。
- 使用的 ST prompt order。
- 每个最终 prompt block 的来源。
- 最终发送给 AI provider 的 messages。
- 最终追加的 DND 输出契约。

## 错误处理

### 文件格式错误

导入接口返回明确错误：

- 文件不是 JSON。
- 缺少该导入入口所需的基本结构。
- 文件类型和导入入口不匹配。

### ST 字段不完整

不直接失败，尽量导入并返回 warning。例如：

- 剧本卡缺少 `scenario`：允许导入，提示场景为空。
- 世界书条目没有 keys 且不是 constant：允许导入，但提示默认不会激活。
- 预设没有 `prompt_order`：允许导入，并使用默认顺序。

### 不支持字段

保留在 `raw_json` 并返回 warning。例如：

- 世界书递归扫描设置。
- token budget。
- 高级注入位置。
- 概率触发。
- ST 扩展字段。

## 测试策略

### 后端测试

覆盖：

- ST 角色卡导入为 `script_card`。
- ST 角色卡字段映射正确。
- `system_prompt/post_history_instructions` 只进入 `raw_json`。
- 内嵌 `character_book` 导入为世界书。
- ST 世界书基础字段保存和排序正确。
- 无 keys 且非 constant 的世界书条目不会自动激活。
- ST 预设包可合并 OpenAI Settings、context、instruct、sysprompt、reasoning。
- `prompts`、`prompt_order` 和未知 prompt identifier 不丢失。
- 房间绑定 ST 预设包时使用 `sillytavern-compatible` 模式。
- 未绑定 ST 预设包时继续使用 `native` 模式。
- 动态槽位、世界书命中、ST prompt order 和 DND 输出契约都进入最终构建结果。

### 前端测试

覆盖：

- 各导入区能选择文件并展示成功、失败和 warning。
- 导入成功后刷新全局资源列表。
- 房间可以绑定/解绑主剧本卡。
- 世界书绑定可以保存启用状态和顺序。
- ST 预设包绑定后 Prompt Preview 显示 `sillytavern-compatible`。
- Prompt Preview 能展示动态槽位、世界书命中、prompt block 来源和最终 messages。

### 手工端到端验证

使用现有 ST 示例数据验证：

1. 上传 `DND DM.json` 作为 OpenAI Settings。
2. 上传 `Default.json` context。
3. 上传 `ChatML.json` instruct。
4. 上传 `DND Dungeon Master.json` sysprompt。
5. 上传 `OpenAI Harmony.json` reasoning。
6. 上传一个 ST 角色卡 JSON 作为剧本卡。
7. 上传或从角色卡内导入世界书。
8. 在某个房间绑定主剧本卡、世界书和 ST 预设包。
9. 打开 Prompt Preview，确认 ST-style 模式、槽位替换、世界书命中、prompt order 和 DND 输出契约。
10. 提交一轮玩家行动，确认 AI 响应仍能被后端解析。

## 风险与缓解

### ST 预设格式变化多

缓解：首版只保证核心字段，未识别字段全部保留在 `raw_json`，导入时返回 warning，并通过 Prompt Preview 暴露最终构建结果。

### ST 世界书算法复杂

缓解：首版实现基础激活和排序，不声称 100% 兼容。数据模型保留原始字段，为后续增强留空间。

### DND 输出契约被普通 ST 预设稀释

缓解：DND 输出契约不可关闭并最终强制追加。解析失败时保留原始 AI 响应和错误，便于调试。

### 剧本卡和玩家角色卡概念混淆

缓解：UI 中统一称为“剧本卡”，导入入口说明“从 ST 角色卡导入为剧本卡”，不自动创建玩家角色，也不自动写入开场日志。

### 原生 prompt 系统与 ST 兼容系统并存

缓解：运行时明确显示 `native` / `sillytavern-compatible` 模式。只有房间绑定 ST 预设包时才进入 ST-style 构建器。

## 完成标准

实现完成后应满足：

- 独立系统运行时不依赖 `SillyTavern/`。
- 管理员可以手动上传 ST 角色卡、世界书和预设包。
- 导入资源先进入全局库。
- 房间通过绑定关系使用资源。
- ST 预设顺序和槽位处理方式被尽量保留。
- DND 回合引擎仍强制结构化输出、信息隔离和玩家自主权。
- Prompt Preview 能解释最终 prompt 的来源和构建过程。
