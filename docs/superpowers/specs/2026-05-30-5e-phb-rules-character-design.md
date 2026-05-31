# 5e PHB 规则抽取、角色构筑与资源维护设计

状态：设计已批准  
日期：2026-05-30

## 背景

当前项目已有 AI-DM、房间、玩家、日志、世界书、提示词预设、资源导入和基础角色卡能力，但角色卡仍是简单 starter sheet，规则系统也主要是原始规则源导入。下一阶段目标是参考本地 `5eDnD_玩家手册PHB_中译v1.72版.pdf` 优化系统，让玩家能按 5e 流程构筑角色卡，并让 AI-DM 在运行中持续参考 5e 规则。

本设计采用本地私有 PHB PDF 抽取方案：PHB 内容不写入源码、不提交到 git、不作为默认种子数据，而是由本地导入流程抽取为待审核草稿，经管理台审核后进入本地 SQLite 数据库。第一版角色选项数据完全来自 PHB PDF 抽取结果；系统只启用已审核且足以完成 1 级角色创建和核心资源维护闭环的数据子集。

## 目标

1. 从本地 PHB PDF 半自动抽取规则世界书条目、角色选项和资源规则草稿。
2. 管理员逐项审核抽取结果，未审核内容不会影响玩家端或 AI-DM。
3. 新增全局 Embedding 接口配置，用语义检索触发 5e 规则条目。
4. 玩家端提供 1 级角色创建向导，表单为主，AI 负责建议和审核。
5. 正式角色卡保存结构化 5e 数据，支持核心资源维护。
6. AI-DM 可自动写入角色资源变化，但必须经过服务端校验、记录日志，并支持管理台回滚。
7. 规则注入对玩家静默；玩家端只展示简短规则摘要。

## 非目标

1. 不在第一版实现完整 D&D Beyond 级别的所有规则自动化。
2. 不把 PHB PDF 或完整抽取内容提交到仓库。
3. 不让 AI 绕过已审核选项库凭空生成正式角色选项。
4. 不把 Embedding 配置混入现有 Chat AI 接口配置。
5. 不在第一版强制把角色卡拆成大量关系表；复杂 sheet 仍以 JSON 为主，审计和检索对象单独建表。

## 总体方案

采用“PHB 抽取管线 + 分阶段启用核心闭环”的方案。

```text
本地 PHB PDF
  -> PDF 文本/章节抽取
  -> AI/规则解析为草稿
  -> 管理台逐项审核
  -> 启用为：
       1. 角色选项库
       2. 规则世界书条目
       3. 资源/恢复规则
       4. 语义检索索引
```

运行时有三条主链路：

1. 玩家端角色创建链路：玩家通过向导选择种族、职业、背景、属性、熟练项、装备和法术；所有正式可选项都来自已审核 PHB 抽取结果；AI 只提供建议和审核。
2. 游戏中角色维护链路：角色卡保存结构化资源；玩家、管理员、系统或 AI-DM 的资源修改都写入审计日志；AI-DM 自动修改必须经过服务端校验。
3. AI-DM 规则记忆链路：根据当前场景、玩家行动和角色状态进行关键词与语义检索；命中规则静默注入 prompt；玩家端只展示简短规则摘要。

## PHB 抽取与审核

### 抽取实体

第一版抽取三类核心实体。

#### RuleEntryDraft

用于生成规则世界书条目。字段包括：

- 标题
- 分类
- 关键词
- 规则正文摘要
- 适用场景
- 优先级
- 来源定位，例如页码或章节文本范围
- 审核状态

示例分类：攻击检定、豁免、休息、施法、熟练、装备、条件、移动、技能检定。

#### CharacterOptionDraft

用于生成角色构筑选项。字段包括：

- 选项类型：`species`、`class`、`background`、`skill`、`equipment`、`spell`、`language`、`proficiency`
- 名称
- 摘要
- 规则数据 JSON
- 前置条件 JSON
- 来源定位
- 审核状态

第一版角色选项完全由这些草稿审核后生成，不能使用手写内置 PHB 选项替代。

#### ResourceRuleDraft

用于生成资源、消耗、恢复和限制规则。字段包括：

- 资源类型
- 初始化规则
- 消耗规则
- 短休恢复规则
- 长休恢复规则
- 上限规则
- 相关职业/装备/法术/条件
- 来源定位
- 审核状态

示例资源：HP、临时 HP、生命骰、法术位、职业资源、弹药、消耗品、货币、条件状态。

### 审核规则

- 所有抽取草稿默认进入 `pending`。
- `pending` 内容不会进入玩家角色向导、规则注入或资源自动化。
- 管理员可将草稿改为 `approved` 或 `rejected`。
- `approved` 草稿生成正式角色选项、规则条目或资源规则。
- `rejected` 草稿保留原因，方便重新抽取或人工修正。
- 角色选项也必须逐项审核；如果某个职业、法术或装备未审核，玩家端不能选择它。

### 本地私有数据边界

PHB PDF 和从中抽取的完整内容都属于本地私有数据：

- 不提交到 git。
- 不写入源码常量。
- 不作为默认 seed。
- 默认只存入本地 SQLite。
- 如果未来支持导出，需要明确标记为本地私有规则包。

## Embedding 与语义检索

新增全局 Embedding 接口配置，独立于现有 Chat AI 接口：

```text
provider
baseUrl
apiKey
model
dimensions 可选
```

用途：

1. 为已审核规则世界书条目生成向量。
2. 为当前场景、玩家行动和角色状态生成查询向量。
3. 检索相关 5e 规则。
4. 把高相关规则静默注入 AI-DM prompt。

第一版检索策略：

- 关键词命中保留，用于明确术语。
- 语义检索为主，用于自然语言行动。
- 排序综合 embedding 相似度、条目优先级、启用状态、条目类型和当前上下文相关性。
- Embedding API 失败时，条目标记为未索引；关键词检索仍可用。

## 玩家端角色创建向导

玩家端是角色创建主入口，管理台负责查看和修正。

第一版只支持 1 级角色创建。向导步骤：

1. 基本信息：角色名、简短概念。
2. 种族选择。
3. 职业选择。
4. 背景选择。
5. 属性值：先支持手动填入与基础合法性提示。
6. 熟练项选择。
7. 装备选择。
8. 法术选择：只对有施法能力的 1 级职业开放。
9. AI 审核：检查缺项、明显非法组合、资源初始化问题。
10. 玩家确认：确认后成为正式角色卡。

AI 可以解释选项、推荐适合角色概念的选择、审核当前草稿并给出修正列表。AI 不可以未经玩家确认自动完成角色创建，也不可以使用未审核草稿或凭空生成的选项创建正式角色。

## 角色卡与资源维护

现有 `CharacterSheet` 需要扩展为结构化 5e sheet。第一版仍可存入 `characters.sheet_json`，但结构应覆盖：

```text
identity
abilities
proficiencies
combatStats
hitPoints
hitDice
savingThrows
skills
equipment
inventory
spells
classFeatures
resources
conditions
notes
```

第一版必须闭环的资源：

- 当前 HP / 最大 HP
- 临时 HP
- AC
- 生命骰
- 法术位
- 弹药
- 消耗品
- 货币
- 条件状态
- 短休恢复
- 长休恢复

负重字段需要预留并可展示基础值；完整负重计算可以在后续阶段扩展。

## AI-DM 自动资源写入

AI-DM 每回合输出除了叙事内容，还可以包含结构化角色变更：

```text
characterResourceChanges:
  - characterId
  - path
  - before
  - after
  - reason
  - ruleRefs
```

服务端处理规则：

1. 校验 `characterId` 属于当前房间。
2. 校验 `path` 是允许修改的角色字段。
3. 校验数值范围，例如 HP 不低于 0，当前资源不超过允许上限。
4. 校验 `before` 与当前数据库状态一致，避免覆盖并发修改。
5. 写入角色卡。
6. 记录资源变更日志。
7. 通过房间更新通知玩家端刷新。

非法变更不写入角色卡，并记录 AI 输出错误，避免破坏角色数据。

## 变更日志与回滚

新增角色资源变更审计表：

```text
character_resource_changes
  id
  roomId
  characterId
  actorType: ai_dm | player | admin | system
  actorId
  changeType
  patchJson
  beforeJson
  afterJson
  reason
  ruleRefsJson
  createdAt
  revertedAt
  revertedBy
```

管理台能力：

- 查看最近角色变更。
- 查看 AI-DM 修改原因。
- 查看关联规则条目。
- 回滚单条变更。
- 手动修正角色卡。

玩家端能力：

- 查看当前资源状态。
- 查看最近变更的简短提示。
- 查看简短规则摘要。
- 不展示完整隐藏规则上下文。

## Prompt 与规则注入

AI-DM prompt 构建新增规则上下文阶段：

```text
基础系统 prompt
+ 当前预设
+ 房间/世界信息
+ 角色状态摘要
+ 语义检索命中的 5e 规则条目
+ 当前玩家行动
+ 输出格式要求
```

规则注入要求：

- 对玩家静默。
- 带规则条目 ID，方便日志追踪。
- 限制 token 数。
- 优先注入与当前行动、角色资源、法术、战斗状态相关的规则。
- 玩家端只展示简短摘要，例如“本次行动参考了攻击检定与熟练加值规则”。

## 后端模块

建议新增或扩展以下服务：

```text
server/src/services/phbExtractionService.ts
server/src/services/ruleEntryService.ts
server/src/services/embeddingService.ts
server/src/services/ruleRetrievalService.ts
server/src/services/characterBuilderService.ts
server/src/services/characterResourceService.ts
server/src/services/characterAuditService.ts
```

现有模块调整：

- `rulesService.ts`：从简单 `rule_sources` 导入扩展为规则条目和审核工作流。
- `characterService.ts`：从 starter character 改为创建、读取、保存结构化角色草稿和正式角色。
- `aiContextBuilder`：增加规则检索结果和角色资源摘要。
- `aiProvider.ts`：保持 Chat provider 职责，不混入 embedding。
- 新增 embedding provider 抽象，独立测试连接和请求流程。

## 数据库设计方向

新增表：

```text
phb_extraction_jobs
phb_extraction_drafts
rule_world_book_entries
rule_entry_embeddings
character_option_drafts
character_options
resource_rule_drafts
resource_rules
embedding_provider_config
character_resource_changes
```

保留现有 `characters` 表，但扩展 `sheet_json` 内容。复杂角色卡继续以 JSON 保存，审核、检索、embedding 和变更日志这些需要查询的对象单独建表。

## 前端设计

### 玩家端

新增角色构筑区域：

```text
角色创建向导
  - 当前步骤
  - 表单选择
  - AI 建议
  - 规则摘要
  - 问题列表
  - 确认角色
```

角色确认后展示：

```text
角色概览
资源面板
装备/消耗品
法术/法术位
状态条件
最近变更
```

### 管理台

资源管理页扩展为：

```text
PHB 导入
抽取任务
草稿审核
规则世界书
角色选项库
Embedding 配置
角色变更日志
角色修正/回滚
```

## 错误处理

- PDF 无法读取：抽取任务失败并显示原因，不影响已有规则库。
- 抽取结果缺字段：草稿进入需要修正状态，不可启用。
- Embedding API 失败：条目标记为未索引，关键词检索仍可用。
- AI-DM 输出非法资源变更：拒绝写入，记录错误，不破坏角色卡。
- 回滚失败：不做部分回滚，返回明确错误。

## 测试策略

### 后端测试

- PHB 抽取草稿 schema 校验。
- 草稿审核流：`pending -> approved`、`pending -> rejected`。
- 只有 `approved` 内容可被玩家端和 AI-DM 使用。
- Embedding 配置保存和测试连接。
- 规则检索排序。
- 角色构筑合法性校验。
- AI-DM 资源写入。
- 资源变更回滚。
- 非法 patch 拒绝。

### 前端测试

- 玩家端角色向导。
- AI 审核结果展示。
- 资源面板展示。
- 管理台草稿审核。
- Embedding 配置保存和测试连接反馈。
- 回滚按钮行为。

### 端到端黄金路径

1. 导入 PHB PDF。
2. 抽取角色选项和规则草稿。
3. 审核启用若干 1 级角色选项。
4. 配置 embedding。
5. 玩家创建 1 级角色。
6. 玩家提交行动。
7. AI-DM 检索规则并处理回合。
8. AI-DM 自动修改 HP 或资源。
9. 玩家端看到资源变化和简短规则摘要。
10. 管理台查看日志并回滚一次变更。

## 实施分期

### 第一期：规则和选项抽取与审核基础

- PHB 抽取任务表。
- 草稿表。
- 管理台审核 UI。
- approved 规则条目和角色选项库。
- 数据来源闭环先于角色创建闭环完成。

### 第二期：Embedding 与规则注入

- 全局 Embedding 配置。
- 条目向量化。
- 语义检索。
- AI-DM prompt 静默注入。
- 玩家端规则摘要。

### 第三期：玩家端 1 级角色构筑

- 角色创建向导。
- 从 approved PHB 选项读取数据。
- AI 建议和审核。
- 玩家确认角色。

### 第四期：结构化资源维护

- 角色资源模型。
- 短休和长休。
- 消耗品、弹药、法术位、HP。
- AI-DM 自动写入。
- 变更日志。

### 第五期：管理台修正与回滚

- 角色变更日志视图。
- 单条变更回滚。
- 管理员手动修正。
- 资源变更审计视图。

## 设计结论

本设计采用本地 PHB PDF 抽取生成数据、管理台审核启用、玩家端表单构筑、AI 辅助审核、embedding 规则检索和 AI-DM 可审计资源写入的方案。它满足以下已确认方向：

- 角色选项来自 PHB PDF 抽取。
- PHB 作为世界书式规则来源。
- 规则静默注入 AI-DM。
- 玩家端主导角色创建和维护。
- AI 辅助而非替代玩家确认。
- 资源系统按完整方向设计，但分期落地。
- AI-DM 可自动写入资源，但必须可追踪、可回滚。
