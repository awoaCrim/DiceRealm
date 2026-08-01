# DND AI-DM 平台重构设计

> 状态：设计已确认；基础平台 Task 1-3 已完成，后续实施以 [`2026-08-02-dnd-ai-dm-rearchitecture-revised.md`](../plans/2026-08-02-dnd-ai-dm-rearchitecture-revised.md) 为唯一执行计划
>
> 设计确认范围：产品目标、核心玩法、领域边界、数据流、前端工作区、部署和安全边界均已与用户确认。

## 目标

将当前难以维护的 DND AI-DM MVP 重构为一个**本地优先、可部署公网、支持多用户和多战役的 AI-DM 跑团平台**。

目标产品面向小型私人群组：

- 每场战役约 2–8 名玩家；
- 一个服务器支持多个用户和多个战役；
- 用户使用用户名/邮箱和密码登录；
- 战役拥有者管理战役，其他成员以玩家身份加入；
- AI 是主要 DM，拥有者负责监督、审核和介入；
- 玩家通过结构化回合提交行动；
- 玩家私密信息必须严格隔离；
- 第一规则系统为 D&D 5e，但领域层保留未来扩展空间；
- 本地使用 SQLite，公网部署使用 PostgreSQL；
- 用户自行配置 OpenAI-compatible AI Provider；
- 战役和用户资料默认私有，通过邀请加入；
- 拥有者和玩家在同一个 Web 应用中进入不同工作区；
- 第一阶段以桌面端为主，暂不以移动端为目标。

## 不变的产品核心

一场战役是一个长期保存的游戏世界，包含：

- 玩家和角色；
- 场景、NPC、地点和任务；
- 回合与玩家行动；
- 结构化战斗；
- 公开、玩家私密和拥有者专属日志；
- AI 运行记录；
- 规则资料和世界书；
- 自动存档和手动命名存档。

## 第一阶段不做的事情

以下能力不属于第一阶段交付范围：

- 用户级完整战役导出/导入；
- 跨服务器迁移；
- 自动云备份和多区域灾备；
- 内容社区、公开搜索和市场；
- 复杂组织/团队权限；
- 多主持人权限；
- 地图、网格、棋子和完整虚拟桌面；
- 微服务、Redis、Kubernetes、分布式任务队列；
- 第三方 OAuth；
- 移动端专用体验。

数据模型需要保留版本字段和迁移边界，使这些能力未来可以增加，而不是锁死设计。

---

## 一、核心用户流程

### 1. 创建战役

创建向导只要求最小信息：

- 战役名称；
- 规则版本；
- AI Provider；
- 预计玩家人数；
- 邀请信息。

进入战役后再逐步完善：

- 世界设定；
- 规则资料；
- AI 行为和提示词；
- 玩家角色；
- NPC、地点、任务和战斗内容。

### 2. 角色创建和审核

玩家自行创建角色，AI 提供辅助，拥有者最终确认。

角色状态：

```text
draft
pending_review
approved
rejected
archived
```

未处于 `approved` 状态的角色不能参加正式回合。

### 3. 玩家行动和回合锁定

```text
玩家编辑行动
  → 保存本地草稿
  → 提交行动
  → 服务端校验身份、角色和回合
  → 更新玩家行动
  → 返回提交进度
  → 最后一名必需玩家提交
  → 自动锁定整个回合
  → 生成 AI 结算任务
```

锁定前：

- 玩家可以修改自己的行动；
- 只能修改自己的内容；
- 玩家实时看到其他成员的提交进度，但看不到行动正文。

锁定后：

- 所有行动不可修改；
- 服务端记录锁定时间和提交顺序；
- 回合只能通过 AI 结算或拥有者处理流程前进。

### 4. AI 结算

```text
TurnLocked
  → BuildContext
  → StartAiRun
  → 公开叙事流式预览
  → 接收完整结构化结果
  → Schema 校验
  → 规则校验
  → 可见性校验
  → 状态冲突检查
  → 数据库事务
  → 创建自动存档
  → 发布正式公开事件
  → 发布玩家私密事件
  → 进入下一回合
```

AI 输出必须结构化：

```ts
interface TurnResolution {
  publicNarrative: string;
  privateUpdates: Array<{
    playerId: string;
    content: string;
  }>;
  diceResults: DiceResult[];
  stateChanges: StateChange[];
  interactionRequests: InteractionRequest[];
}
```

AI 不得直接写数据库，也不能用一份包含所有秘密的完整文本再由前端隐藏内容。

### 5. AI 失败

```text
AI 生成失败
  → 保留已锁定行动
  → 保留最近一次成功存档
  → 丢弃未完成公开预览
  → Turn = needs_owner_attention
  → 拥有者重试或介入
```

失败时不能：

- 自动进入下一回合；
- 写入半截正式日志；
- 应用部分状态变化；
- 重复扣除资源；
- 创建错误的正式存档。

### 6. 存档

每次成功结算后自动生成存档，拥有者也可以手动创建命名存档。

存档至少关联：

- 战役版本；
- 当前回合；
- 角色状态；
- 世界状态；
- 战斗状态；
- 公开/私密日志索引；
- 规则版本；
- AI 配置版本。

恢复存档时：

- 选中的存档成为战役当前状态；
- 存档后的历史不物理删除；
- 后续历史标记为 `superseded`；
- 恢复动作写入系统事件；
- 所有在线成员收到实时通知；
- 不创建分支战役。

---

## 二、领域架构

采用**模块化单体**，不在第一阶段拆分微服务。

```text
平台模块
├── Identity
├── Campaign
├── Character
├── World
├── Turn
├── Combat
├── Rules
├── AiRuntime
├── Visibility
├── Archive
└── Realtime
```

### Identity

负责：

- 注册、登录、退出；
- 密码哈希；
- 会话过期和撤销；
- 登录失败限流；
- 当前用户身份。

### Campaign

负责：

- 战役创建和设置；
- 战役拥有者；
- 战役成员；
- 邀请和加入；
- 战役状态；
- 规则版本与 AI 配置绑定。

第一阶段角色只有：

```text
owner
player
```

### Character

负责：

- 角色草稿；
- AI 辅助创建；
- 角色审核；
- 角色卡；
- 派生值；
- 角色资源和装备；
- 角色修改审计。

### World

负责：

- 场景；
- NPC；
- 地点；
- 任务；
- 世界事实；
- 世界书；
- 事实的公开范围和已知玩家。

结构化事实应支持类似 `knownBy` 的概念：一个事实可以存在于完整世界状态中，但只对拥有者或指定玩家可见。

### Turn

负责：

- 回合状态机；
- 玩家行动；
- 提交顺序；
- 最后一名玩家提交后的自动锁定；
- AI 结算生命周期；
- 回合完成和下一回合创建。

Turn 不负责 Prompt 构建和 Provider 细节。

### Combat

负责：

- 遭遇；
- 先攻；
- HP、AC 和临时 HP；
- 动作、附赠动作、反应和移动；
- 攻击、伤害、豁免和法术目标；
- 状态效果；
- 敌人和 NPC 战斗状态。

### Rules

负责：

- D&D 5e 规则版本；
- 角色选项；
- 法术、装备、怪物和状态；
- 规则来源与许可证；
- 规则检索；
- 用户导入资料的审核。

规则内容分为：

```text
PlatformLicensedContent
OpenContent
UserOwnedContent
```

每个来源保存来源名称、版本、许可证、授权范围、哈希和适用战役。

### AiRuntime

负责：

- Provider 配置；
- API Key 服务端存储；
- Prompt 构建；
- 上下文包；
- 流式生成；
- 结构化结果解析；
- Schema 校验；
- AI 运行记录；
- 重试。

### Visibility

负责唯一的可见性策略：

```text
public
player_private
owner_only
```

所有 HTTP 查询、AI 上下文和实时事件必须经过同一套策略。

### Archive

负责：

- 自动存档；
- 手动命名存档；
- 存档元数据；
- 存档恢复；
- 历史状态标记。

### Realtime

负责：

- SSE 连接；
- 断线重连；
- 事件去重；
- 事件可见性投影；
- 连接状态。

---

## 三、应用层和基础设施边界

依赖方向：

```text
HTTP / SSE
  ↓
Application Commands / Queries
  ↓
Domain Modules
  ↓
Ports
  ├── DatabaseTransaction
  ├── CampaignRepository
  ├── CharacterRepository
  ├── AiProvider
  └── EventPublisher
  ↓
Infrastructure
  ├── SQLite Adapter
  ├── PostgreSQL Adapter
  ├── SSE Adapter
  └── OpenAI-compatible Provider Adapter
```

路由层只负责：

- 解析请求；
- 调用命令或查询；
- 转换统一错误；
- 返回响应。

路由层不能直接：

- 拼 SQL；
- 判断回合状态机；
- 组装 AI Prompt；
- 自行裁剪玩家数据；
- 修改多个领域表。

数据库事务由应用服务和领域模块统一控制。

第一阶段可以采用：

- 业务状态表；
- 不可变领域事件表；
- Outbox 表；
- 存档快照表。

不采用完整 Event Sourcing，但保留事件审计和状态重建所需的信息。

---

## 四、实时事件

实时通道推送领域事件，而不是原始数据库行：

```ts
type CampaignEvent =
  | { type: 'player.joined'; campaignId: string; playerId: string }
  | { type: 'turn.action_submitted'; turnId: string; playerId: string }
  | { type: 'turn.locked'; turnId: string }
  | { type: 'ai.preview.started'; runId: string }
  | { type: 'ai.preview.delta'; runId: string; text: string }
  | { type: 'ai.preview.failed'; runId: string }
  | { type: 'turn.resolved'; turnId: string; archiveId: string }
  | { type: 'combat.updated'; encounterId: string }
  | { type: 'interaction.requested'; requestId: string };
```

事件分发流程：

```text
完整领域事件
  → Owner Projection
  → Player Projection(playerId)
  → SSE
```

玩家不会因为订阅实时通道而获得拥有者事件。

---

## 五、前端信息架构

统一 Web 应用，按身份进入不同工作区：

```text
/login
/register
/campaigns
/campaigns/new

/campaigns/:campaignId/owner
/campaigns/:campaignId/owner/turn
/campaigns/:campaignId/owner/combat
/campaigns/:campaignId/owner/characters
/campaigns/:campaignId/owner/world
/campaigns/:campaignId/owner/rules
/campaigns/:campaignId/owner/ai
/campaigns/:campaignId/owner/archives

/campaigns/:campaignId/player
/campaigns/:campaignId/player/story
/campaigns/:campaignId/player/character
/campaigns/:campaignId/player/inventory
/campaigns/:campaignId/player/combat
```

### 拥有者工作区

采用 NarrativeEngine-P 的叙事工作台思路，结合 Fari 的结构化卡片和 Dungeoneer 的战斗控制台：

```text
OwnerShell
├── CampaignHeader
├── CampaignSidebar
├── OwnerMainPanel
└── OwnerInspector
```

- 顶部：战役名称、回合、AI 状态、实时连接、存档和设置；
- 左侧：概览、回合、战斗、玩家与角色、世界、规则、AI、存档；
- 中央：剧情、玩家行动、AI 流式预览、结构化结算和战斗；
- 右侧：玩家状态、角色审核、NPC/地点/任务、待确认交互和 AI 调试。

### 玩家工作区

```text
PlayerShell
├── CampaignHeader
├── PlayerMainPanel
└── PlayerInspector
```

- 中央：公开剧情、公开战斗结果、AI 公开预览和本轮行动；
- 右侧：自己的角色、HP/AC/状态、背包和待确认交互；
- 不挂载拥有者 Prompt、其他玩家行动、完整 AI 上下文和隐藏世界事实。

### 前端模块

```text
client/src/
├── app/
├── features/
│   ├── auth/
│   ├── campaigns/
│   ├── owner/
│   │   ├── overview/
│   │   ├── turn/
│   │   ├── combat/
│   │   ├── characters/
│   │   ├── world/
│   │   ├── rules/
│   │   ├── ai/
│   │   └── archives/
│   └── player/
│       ├── story/
│       ├── action/
│       ├── character/
│       ├── inventory/
│       └── combat/
├── entities/
├── shared/
└── api/
```

每个 feature 负责自己的 API、查询、变更、组件和测试。

### 状态分层

服务端状态：使用 Query Cache 管理战役、玩家、角色、回合、战斗、存档和 AI 运行。

实时状态：由独立的 `RealtimeSession` 接收领域事件，去重后更新 Query Cache。

本地状态：只保留当前 tab、drawer、表单草稿、modal、未提交行动和 AI 临时预览。

不再维护一个包含完整战役状态的超级全局 Store。

### UI 状态要求

每个异步区块都必须定义：

```text
idle
loading
ready
empty
error
retrying
realtime-disconnected
locked
waiting-for-players
ai-generating
```

使用按 feature 划分的错误边界，单个战斗面板出错不能让整个玩家页面白屏。

---

## 六、安全和隐私

### 认证

- 用户名/邮箱 + 密码；
- 密码安全哈希；
- 服务端会话；
- 会话过期和撤销；
- 登录失败限流；
- 错误信息脱敏。

### 权限

每个命令和查询都经过：

```text
认证
  → 是否属于战役
  → owner/player 判断
  → 资源访问权限
  → VisibilityPolicy
```

不能依赖前端隐藏按钮来实现权限。

### AI Key

- 只在服务端保存；
- 前端只看到 Provider、模型和脱敏状态；
- 日志不写入 API Key；
- 不同战役可以使用不同 Provider。

### 玩家上下文

```text
OwnerContext
  → 完整状态、所有行动和调试信息

PublicContext
  → 公开场景、公开日志和公开战斗信息

PlayerContext[playerId]
  → 公共信息 + 该玩家自己的私密信息
```

---

## 七、数据库和部署

本地模式：

```text
React/Vite + Node API + SQLite
```

公网模式：

```text
React/Vite + Node API + PostgreSQL
```

通过数据库端口隔离实现：

```text
DatabasePort
├── SqliteDatabaseAdapter
└── PostgresDatabaseAdapter
```

业务层不使用 SQLite 特有语法，不依赖具体数据库驱动。

第一阶段不引入 Redis 或微服务；实时事件先使用单进程事件总线、Outbox 和 SSE。未来替换基础设施时保持领域事件接口不变。

---

## 八、迁移策略

当前仓库存在多个分支、多个工作树和大量未提交修改。重构开始前必须建立清晰基线。

### 阶段 0：基线整理

- 保存所有未提交修改；
- 创建唯一 `main`；
- 明确进入新基线的提交；
- 保留旧实现作为迁移参照；
- 不使用 `git add .`；
- 不覆盖用户现有工作。

### 阶段 1：基础平台

- 用户、会话和密码；
- 战役和成员；
- SQLite/PostgreSQL 数据访问接口；
- 统一错误模型；
- 领域事件和实时连接。

### 阶段 2：核心跑团

- 角色创建和审核；
- 玩家行动；
- 回合锁定；
- 结构化 AI 结算；
- 公开/私密结果。

### 阶段 3：战斗和存档

- 先攻；
- HP、AC、状态和资源；
- 战斗回合；
- 自动/手动存档；
- 存档恢复。

### 阶段 4：规则和 AI 平台

- 授权规则库；
- 规则版本；
- 世界书；
- 记忆召回；
- Provider 管理；
- AI 运行记录。

### 阶段 5：新前端工作区

- 账号和战役列表；
- 拥有者工作区；
- 玩家工作区；
- 实时状态；
- 错误恢复；
- 桌面端完整验收。

每个阶段都必须提供一条可运行的垂直流程，不做大量孤立页面。

---

## 九、测试策略

### 领域测试

- 回合锁定；
- 最后一名玩家提交；
- 行动修改权限；
- AI 结构化结果校验；
- 可见性裁剪；
- 战斗状态变更；
- 存档创建和恢复；
- 事件去重。

### API 集成测试

- 注册和登录；
- 创建和加入战役；
- owner/player 权限隔离；
- 角色创建和审核；
- 提交行动；
- AI 结算；
- 存档恢复；
- SSE 事件。

### 前端测试

- 工作区路由隔离；
- 行动提交和修改；
- 回合锁定后的 UI；
- AI 流式预览失败；
- 断线重连；
- 空状态和错误恢复；
- 角色审核；
- 战斗状态展示。

### 浏览器验收流程

```text
注册
  → 创建战役
  → 邀请玩家
  → 玩家创建角色
  → 拥有者审核
  → 两名玩家提交行动
  → 自动锁定回合
  → AI 流式生成
  → 结构化结算
  → 创建存档
  → 玩家看到各自可见结果
```

---

## 十、成功标准

重构后的系统必须能够：

1. 注册和登录；
2. 创建长期战役；
3. 配置用户自己的 AI Provider；
4. 邀请玩家加入；
5. 玩家创建角色；
6. 拥有者审核角色；
7. 多名玩家提交本轮行动；
8. 最后一名玩家提交后自动锁定；
9. AI 流式生成公开叙事；
10. 校验结构化 AI 结果；
11. 应用角色、世界和战斗状态；
12. 创建自动存档；
13. 向不同玩家发布不同可见内容；
14. AI 失败时停在拥有者处理状态；
15. 从存档恢复并继续战役；
16. 在单个面板出错时保持整个工作区可用。

---

## 十一、参考项目

详细源码调研见：

```text
docs/research/similar-repositories.md
```

UI 和架构参考组合：

- NarrativeEngine-P：叙事工作台、上下文抽屉、流式剧情；
- Fari：结构化场景、标签页、角色卡和玩家管理；
- boluo：房间/成员导航和权限状态；
- Dungeoneer：先攻和战斗控制台；
- SillyTavern：世界书和 Prompt 编排理念，不复制代码；
- agnai：多用户聊天壳和侧面板组织方式，不复制其重型基础设施。

所有第三方代码、规则内容、字体和素材在实际采用前必须单独审计许可证。本设计只吸收产品和架构理念，不授权直接复制代码或受限制内容。
