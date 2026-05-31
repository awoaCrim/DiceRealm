# 全局实时配置设计

## 背景

当前系统已经将 SillyTavern 角色卡、世界书和预设包导入到独立应用的全局资源库，但配置选择仍然有明显的房间维度：房间保存 `ai_config_json`，原生预设和原生世界书挂在房间下，ST 剧本卡/世界书/预设包通过 `room_*_bindings` 绑定到具体房间。

新的产品要求是：配置应该在创建房间之前就存在，属于全局配置，不区分多个房间使用不同配置。房间必须实时使用当前全局配置，而不是在创建时复制或绑定一份配置快照。

## 目标

- 将 AI 约束、原生提示词预设、原生世界书、ST 剧本卡选择、ST 世界书选择和 ST 预设包选择统一为全局配置。
- 创建房间时不再填写或保存房间专属 AI-DM 指令、AI 约束或资源绑定。
- 房间的 Prompt Preview 和回合处理实时读取当前全局配置。
- 修改全局配置后，所有房间下一次 Prompt Preview 和下一次处理回合都使用新配置。
- 已经写入日志、已提交行动、已生成 AI 结果等房间历史数据不被全局配置变更回写或重算。
- 保留 SillyTavern 资源导入能力和 ST-compatible prompt 构建方式。

## 非目标

本轮不实现：

- 多个全局配置 profile。
- 房间选择不同配置。
- 创建房间时锁定配置版本。
- 自动重写既有房间日志或已处理回合。
- 删除旧 room-scoped 表的物理迁移清理；首版可以停止使用旧表，后续再做清理。
- 手机端专项布局。

## 核心规则：房间实时使用全局配置

房间不保存配置快照。以下操作每次执行时都读取当前全局配置：

- `GET /api/admin/rooms/:roomId/ai-prompt-preview`
- `POST /api/admin/rooms/:roomId/process-turn`
- 管理页展示 AI 约束、预设、世界书和资源启用状态

全局配置变更后：

- 已打开的房间管理页刷新或收到事件后展示新配置。
- 同一个房间下一次 Prompt Preview 使用新配置。
- 同一个房间下一次处理回合使用新配置。
- 旧日志、旧 AI generation、旧 actions 不会被修改。

这意味着全局配置是运行时输入，房间是运行时状态容器。

## 数据模型

### 新增 `global_config`

系统只有一行全局配置，固定 `id = 'default'`。

字段：

- `id`
- `ai_config_json`
- `active_script_card_id`：可为空，引用 `script_cards.id`
- `active_preset_package_id`：可为空，引用 `prompt_preset_packages.id`
- `created_at`
- `updated_at`

`ai_config_json` 保存当前全局 AI 约束。`active_script_card_id` 和 `active_preset_package_id` 保存当前启用的 ST 剧本卡和 ST 兼容预设包。

### 新增 `global_world_book_bindings`

保存当前全局启用的 ST 资源世界书列表。

字段：

- `world_book_id`
- `enabled`
- `order_index`
- `created_at`

所有房间共享这组世界书选择。Prompt 构建时按 `order_index` 读取启用项。

### 新增全局原生提示词预设表

新增全局原生提示词预设表，不复用旧 `prompt_presets.room_id` 语义。

`global_prompt_presets` 字段：

- `id`
- `name`
- `description`
- `is_active`
- `created_at`
- `updated_at`

`global_prompt_blocks` 字段：

- `id`
- `preset_id`
- `name`
- `role`
- `position`
- `enabled`
- `order_index`
- `content`

系统只维护一组全局原生预设。默认强约束预设只创建一次，不再为每个房间创建。

### 新增全局原生世界书表

新增全局原生世界书表，不复用旧 `world_books.room_id` 语义。

`global_world_books` 字段：

- `id`
- `name`
- `description`
- `enabled`
- `created_at`
- `updated_at`

`global_world_book_entries` 字段：

- `id`
- `world_book_id`
- `title`
- `keys_json`
- `secondary_keys_json`
- `content`
- `enabled`
- `constant`
- `selective`
- `priority`
- `position`
- `created_at`
- `updated_at`

原生世界书和导入的 ST 世界书仍是两类来源：原生世界书用于本应用内创建；ST 世界书来自资源库导入。两类世界书都由全局配置统一启用和参与 Prompt 构建。

### 停止使用 room-scoped 配置字段/表

以下内容不再作为运行时配置来源：

- `rooms.ai_config_json`
- `room_script_bindings`
- `room_world_book_bindings`
- `room_preset_bindings`
- 旧 `prompt_presets` / `prompt_blocks`
- 旧 `world_books` / `world_book_entries`

这些旧字段和表可以暂时保留，避免一次性破坏数据库兼容性。运行时代码必须从新的全局配置和全局原生表读取。

## 房间创建流程

创建房间只创建运行态实例。前端创建房间表单只保留：

- 房间名称

后端 `POST /api/admin/rooms` 不再接收 `worldInfo` 或 `systemPrompt` 作为配置输入。

创建房间时仍可以创建第一条公开日志作为开场，但开场内容来自当前全局配置：

1. 如果全局主剧本卡存在且 `firstMes` 非空，使用 `firstMes`。
2. 否则如果全局主剧本卡存在且 `scenario` 非空，使用 `scenario`。
3. 否则写入一条默认提示，说明尚未配置主剧本卡。

这条开场日志是历史记录。创建后如果全局剧本卡改变，不回写已创建的开场日志；但后续 Prompt Preview 和处理回合会实时使用新的全局剧本卡。

## 后端服务边界

### `globalConfigService`

新增服务负责全局配置读写：

- 确保默认全局配置存在。
- 读取全局 AI config。
- 更新全局 AI config。
- 设置/清除全局主剧本卡。
- 设置/清除全局 ST 预设包。
- 替换全局世界书绑定列表。
- 读取完整全局配置快照。

全局配置快照应包含：

- `aiConfig`
- `globalPresets`
- `globalWorldBooks`
- `globalWorldBookEntries`
- `activeScriptCardId`
- `globalWorldBookBindings`
- `activePresetPackageId`
- 全局资源库列表

### Prompt Preview / Turn Processing

`buildRoomPromptPreview(db, room)` 保留 `room` 参数，因为房间运行态仍然提供玩家、行动、日志和回合状态。但函数内部不再读取 room binding 或 `room.aiConfig`。

新的输入组合：

- 房间运行态：`room`、players、actions、public logs、interactions、turn。
- 当前全局配置：AI config、原生 prompt blocks、原生 world book entries、active script card、active ST preset package、active imported world book entries。

构建模式：

1. 如果全局配置启用了 ST 预设包，使用 `sillytavern-compatible`。
2. 否则使用原生 prompt builder。
3. 两条路径都使用全局 AI config 渲染最终 DND 输出契约。

`processTurnActions` 接收的 `aiConfig` 也必须来自全局配置。

## API 设计

### 全局配置 API

新增：

```http
GET /api/admin/config
PUT /api/admin/config/ai-config
POST /api/admin/config/presets
PUT /api/admin/config/presets/:presetId
POST /api/admin/config/presets/:presetId/activate
POST /api/admin/config/world-books
POST /api/admin/config/world-books/:worldBookId/entries
PUT /api/admin/config/world-books/:worldBookId/entries/:entryId
PUT /api/admin/config/script-card
DELETE /api/admin/config/script-card
PUT /api/admin/config/resource-world-books
PUT /api/admin/config/preset-package
DELETE /api/admin/config/preset-package
```

`GET /api/admin/config` 返回完整全局配置和资源库快照，用于配置页渲染。

`PUT /api/admin/config/resource-world-books` 使用替换语义，提交完整启用的 ST 资源世界书列表和排序。原生世界书通过 `/api/admin/config/world-books` 系列接口创建和编辑。

### 房间 API

保留：

```http
POST /api/admin/rooms
GET /api/admin/rooms/:roomId
POST /api/admin/rooms/:roomId/players
POST /api/admin/rooms/:roomId/process-turn
GET /api/admin/rooms/:roomId/ai-prompt-preview
```

变更：

- `POST /api/admin/rooms` 只接收 `{ name }`。
- `GET /api/admin/rooms/:roomId` 返回房间运行态，同时可以附带当前全局配置快照，方便管理页 keep-mounted tabs 使用。
- `GET /api/admin/rooms/:roomId/ai-prompt-preview` 仍以 roomId 定位运行态，但配置来自全局。

停止使用或兼容期保留但前端不再调用：

```http
GET /api/admin/rooms/:roomId/ai-config
PUT /api/admin/rooms/:roomId/ai-config
GET /api/admin/rooms/:roomId/resource-bindings/*
PUT /api/admin/rooms/:roomId/resource-bindings/*
DELETE /api/admin/rooms/:roomId/resource-bindings/*
```

## 前端信息架构

### 首页

首页创建房间卡片只显示：

- 房间名称
- 创建房间按钮

首页应提示：配置在全局配置页中维护，所有房间实时使用当前全局配置。

如果没有主剧本卡或预设，仍允许创建房间，但提示管理员先配置全局资源。

### 管理页

管理页继续以某个房间为入口，但标签含义调整：

- `总览`：房间运行态，玩家、行动、日志、AI 错误、处理回合。
- `AI 约束`：编辑全局 AI 约束，文案明确“所有房间实时使用”。
- `资源`：导入全局资源，并设置全局主剧本卡、全局 ST 世界书、全局 ST 预设包。
- `预设`：管理全局原生提示词预设和提示词块。
- `世界书`：管理全局原生世界书和条目。

原 `RoomResourceBindingsPanel` 改为 `GlobalResourceConfigPanel`，不再接收 `roomId`。组件内部维护 dirty refs，避免后台刷新覆盖未保存选择。

### Prompt Preview

Prompt Preview 显示当前房间运行态如何与当前全局配置组合：

- 当前模式：`native` 或 `sillytavern-compatible`。
- 当前全局主剧本卡。
- 当前全局 ST 世界书绑定。
- 当前全局 ST 预设包。
- 动态槽位。
- 世界书命中。
- 最终 prompt blocks。
- DND 输出契约。

## 事件与刷新

全局配置变更会影响所有房间。首版可以采用简单策略：

- 保存全局配置后，当前管理页主动 refresh。
- 后端发布全局配置更新事件时，可以复用现有 room update 机制先通知当前房间。
- 不要求所有已打开房间页面立即通过 SSE 自动刷新；但下一次手动刷新、tab 切换触发 refresh、保存操作后的 refresh 必须读取最新全局配置。

如果要严格实时 UI，同步增强可增加全局事件：

```text
global-config-updated
```

但运行时实时性不依赖 UI 事件；Prompt Preview 和 process-turn 每次请求都会读取数据库中的当前全局配置。

## 错误处理

- 设置全局主剧本卡时，如果 `scriptCardId` 不存在，返回 404。
- 设置全局 ST 预设包时，如果 `presetPackageId` 不存在，返回 404。
- 设置全局 ST 世界书列表时，只要其中一个 `worldBookId` 不存在，返回 404，且不部分保存。
- 删除已被全局配置选中的资源时，必须清空对应全局选择或通过外键级联使选择失效；API 返回后的全局配置快照不能引用不存在的资源。
- 保存全局 AI config 失败时，前端保留用户草稿，不用旧配置覆盖。
- Prompt Preview 如果全局配置缺少可选资源，不失败，而是返回 warning。

## 迁移策略

首版迁移以安全和可回滚为优先：

1. 创建 `global_config` 和 `global_world_book_bindings`。
2. 如果 `global_config.default` 不存在，初始化为 `defaultAiConfig`。
3. 如果数据库中已有房间，允许从最近更新或最近创建的房间复制一次 AI config 和 active 原生预设作为初始全局配置。
4. 如果存在 room resource binding，可以选择任意一个已有绑定作为初始全局选择；没有绑定则为空。
5. 后续运行时只读取全局配置，不再读取 room-scoped 配置。
6. 旧表保留，不在本轮删除。

这是一次迁移起点，不提供多房间配置差异保留，因为新要求明确不区分多个房间用不同配置。

## 测试策略

### 后端测试

覆盖：

- `POST /api/admin/rooms` 只需要房间名。
- 创建房间时 opening log 来自当前全局主剧本卡。
- 更新全局 AI config 后，既有房间的 Prompt Preview 使用新 AI config。
- 更新全局主剧本卡后，既有房间下一次 Prompt Preview 使用新剧本卡。
- 更新全局 ST 世界书绑定后，所有房间 Prompt Preview 使用同一组世界书。
- 更新全局 ST 预设包后，所有房间切换到同一 ST-compatible 模式。
- `process-turn` 使用当前全局配置，而不是房间创建时的配置。
- 删除不存在资源或绑定不存在资源返回 404。
- 旧 room-scoped binding 不影响新 prompt 构建。

### 前端测试

覆盖：

- 首页创建房间表单不再显示 `世界信息` 和 `AI-DM 指令`。
- 管理页 AI 约束 tab 文案说明全局实时生效。
- 资源 tab 显示 `全局资源配置`，不再显示 `房间资源绑定`。
- 切换标签页不清空未保存的全局资源选择。
- 保存全局 AI config 调用新的 `/api/admin/config/ai-config` helper。
- 保存全局资源配置调用新的 config helper。
- Prompt Preview 仍能显示 ST-compatible 结构。

### 手工验证

实现后验证：

1. 在没有房间时导入 ST 剧本卡、世界书和预设包。
2. 设置全局主剧本卡、全局世界书、全局 ST 预设包。
3. 创建房间，确认无需填写世界信息或 AI-DM 指令。
4. 打开 Prompt Preview，确认使用当前全局配置。
5. 修改全局 AI 约束，回到同一房间 Prompt Preview，确认立即使用新内容。
6. 修改全局主剧本卡或 ST 预设包，回到同一房间 Prompt Preview，确认立即切换。
7. 创建第二个房间，确认两个房间使用同一全局配置。
8. 提交玩家行动并处理回合，确认 process-turn 使用当前全局配置。

## 完成标准

- 配置不再按房间区分。
- 房间创建前即可配置全局 AI 约束、资源、预设和世界书。
- 房间 Prompt Preview 和回合处理实时读取当前全局配置。
- 创建房间不再提交 AI-DM 指令或房间专属世界信息。
- ST 兼容导入和 prompt_order 处理继续可用。
- 旧房间历史数据不会因为全局配置变更被回写。
- 测试、typecheck、build 和浏览器验证通过。
