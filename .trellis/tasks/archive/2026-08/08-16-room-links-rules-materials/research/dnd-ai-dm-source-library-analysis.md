# DND AI DM 项目来源库分析

> 分析日期：2026-08-16
>
> 来源：已登录 ChatGPT Project `DND AI DM` 的“来源”页，以及当前 DiceRealm 仓库代码。

## 1. 结论

这个来源库的价值不在于提供一套可以直接照抄的数据模型，而在于反复确认了一个架构主线：

> **资源库、运行时状态、AI 请求上下文、状态裁定和叙事输出必须分层，并且每一层都要有明确的权限与权威边界。**

来源中的设计已经形成较稳定的方向，但仍属于高质量架构讨论，不是可直接执行的实现规范。当前最应该沉淀的是少数跨模块协议，而不是继续增加更多页面或更多世界书类型。

## 2. 来源库实际结构

来源页显示 14 个条目：

- 世界书混合检索架构
- 世界书与上下文分层
- 对话驱动场景叙事设计
- 玩家主权协议设计
- 事实提取与来源追踪
- 锁定 AI 与规则分权
- 构建分层存档机制
- 玩家知识同步机制设计
- 剧情信息权限设计
- 玩家角色工作区设计
- 叙事轮状态机制
- 日常战斗分离架构
- 构建结构化战斗体系
- 统一角色数据模型

但这些不是 14 份相互独立的设计文档。实际读取结果显示：

1. 前一组条目主要指向同一个“世界书 / Prompt / Hybrid Retrieval”根对话；
2. 后一组条目主要指向同一个“AI 权限 / 裁定 / 状态 / 技术栈”根对话；
3. 部分条目只是同一根对话不同消息的 deep link 或分支标题；
4. 打开来源时经常返回整段根对话，而不是只返回标题对应的那一段。

因此当前来源库存在明显的**重复计数和主题标签伪独立**问题。以后不能把 14 个条目直接当成 14 个独立知识源参与检索，否则会放大重复内容，并让来源追踪产生虚假的独立证据感。

另外，原始讨论中出现了《诡秘之主》素材、角色文件名和 SillyTavern 截图。这些内容被明确声明为参考材料，不能混入当前 D&D 世界观。这个边界必须在数据命名空间、导入集合、检索索引和默认绑定层同时实现，而不能只依赖提示词提醒。

## 3. 来源中最稳定的架构决策

### 3.1 资源库不等于 Prompt

来源反复强调：

```text
Resource Library
  -> Binding / Scope / Permission
  -> Retrieval
  -> Context Planner
  -> Token Budget
  -> AI Request Envelope
  -> Provider Adapter
```

世界书、角色资料、规则资料、Voice/Style、战役背景是长期资源；当前 Runtime、当前 Scene、上一轮事实、玩家输入和已裁定结果是运行时上下文。资源不能因为存在于库中就整体进入模型请求。

这是来源库最重要、也最值得固化为规范的一条原则。

### 3.2 世界知识、战役计划、运行状态必须分开

来源建议将内容拆成至少五类：

- `Ruleset`：可执行的规则、公式、状态效果、行动经济；
- `Setting / Lore`：世界、地点、派系、历史、文化；
- `Campaign Blueprint`：可能发生的章节、事件、NPC 计划和条件节点；
- `Campaign Runtime`：当前时间线实际已经发生的状态；
- `Character Template / Instance`：角色模板与本次战役中的实例状态。

其中：

- “第三章将发生政变”是蓝图中的条件化计划，不是已经发生的事实；
- “老板已经死亡”是 Runtime 事实，应覆盖“老板正在经营旅店”的静态世界资料；
- D&D 机械规则不能主要依赖一篇规则文本让模型临场解释，而应落到规则数据、规则引擎、骰子与状态机。

### 3.3 世界书应是 Knowledge Model，不是大 JSON 或 Prompt 片段

推荐结构：

```text
Worldbook
  -> KnowledgePack
    -> KnowledgeEntry
      -> optional DocumentChunk
```

`KnowledgeEntry` 的稳定字段方向包括：

- stable ID、pack/version；
- type、title、aliases、tags、keywords；
- `brief / summary / full` 多级内容；
- scope、visibility、usableBy、authority；
- location/character/faction relations；
- activation policy、temporal validity、priority；
- source/provenance 和 token estimate。

世界书只描述“世界是什么”，不能承载“第 20 轮必须发生什么”这类剧情脚本。后者应属于 Campaign Blueprint、Quest、Event 或 Clock。

### 3.4 检索必须先过滤，再召回

来源给出的检索顺序基本一致：

```text
Hard Scope / Permission Filter
  -> Direct Binding
  -> Entity Relation
  -> Alias / Keyword / FTS
  -> Vector Retrieval
  -> Deterministic Rerank
  -> brief / summary / chunk selection
  -> Token Budget
  -> Context Block
```

关键边界：

- `Visibility` 和 `ActorKnowledge` 是硬过滤，不是 relevance 分数；
- `Authority` 决定事实冲突时信谁，不等于相关性；
- Runtime 的当前事实不能被高向量相似度的静态世界书覆盖；
- NPC 的可检索知识集合必须先限制为公共知识、该 NPC 已知事实和该 NPC 的信念，再做 FTS/向量召回；
- 向量检索用于补足关键词无法覆盖的历史、文化和长文档语义，不应替代当前场景、实体关系等确定绑定。

第一版建议先使用结构化绑定、关系、aliases、SQLite FTS5、预算和 Trace；向量和神经 reranker 延后到真实数据证明需要时再加入。

### 3.5 Prompt Preset、Context Run、Request Preview、Trace 要分开

来源对 DM 调试工作台的概念拆分很清楚：

- `Context Preset`：定义有哪些块、顺序、启用状态、预算、必选/可编辑属性；
- `Context Run`：本次请求解析出来的实际块和内容；
- `Request Preview`：Provider 真正收到的渲染后请求；
- `Context Trace`：为什么选中、为什么过滤、用了多少 token、为什么丢弃。

DM 可以编辑“当前请求”，但编辑范围必须显式区分：

- Request Override：仅本次请求；
- Scene Override：当前场景临时有效；
- Preset Patch：修改未来请求的上下文编排；
- Source Edit：产生新的知识包版本；
- GM State Override：真正修改世界状态，必须走审计事件和 StateRevision。

此外，来源建议支持冻结请求后编辑并重跑：保持同一个 StateRevision、ActionIntent 和已裁定结果，不重新掷骰。这是很有价值的 Owner 调试能力，但应放在基础状态协议稳定之后。

### 3.6 Narrator、Referee、Rules/Dice 是三个权威

来源中最明确的安全边界是：

```text
Player Input
  -> Intent Parser
  -> Adjudication / Referee
  -> Difficulty / RollPlan lock
  -> Dice Service
  -> Outcome / Effects
  -> State Transaction
  -> Narrator
```

- Narrator 负责理解表达、扮演 NPC、描述已经裁定的结果；
- Referee/Adjudication 决定是否需要检定、检定类型和难度层级；
- Rules/Dice Engine 负责确定性规则计算和实际骰点。

主 Narrator 不应决定是否投骰、DC、骰点、机械结果或替玩家行动。Referee 也不应看到未来剧情、作者希望玩家成功等信息。难度应先锁定，再生成 RollPlan，再投骰；投骰后不能为了叙事修改难度。

### 3.7 所有权威状态变更应收敛到统一 Effect / Event / Revision 流

来源建议将各种状态变化统一为 `GameEffect[]`，由 `EffectExecutor` 校验并写入 Runtime，同时产生 EventLog 和 StateRevision，再由 Fact Projection 生成供上下文和 UI 使用的摘要。

尤其重要的是：Fact 不应主要由 AI 读叙事文本后猜出来，而应从已经提交的 Event、Effect、KnowledgeSync 和 WorldTick 编译出来。

### 3.8 Scene、Time、Condition、Failure Protocol 是缺失的中间骨架

来源认为当前系统还必须正式建立：

- `SceneRuntime / ActorPresence / PartyGroup`：谁在哪里、谁能看见/听见什么、私密剧情属于哪个场景；
- `WorldClock / Duration / ScheduledEvent / Deadline / Rest / Travel`：叙事轮不是固定六秒，时间推进需要独立模型；
- `ConditionEngine`：Quest、Scene Trigger、Faction Clock、NPC Goal、Combat Phase 共享条件表达式；
- `requestId / actionId / expectedStateRevision / attempt`：拒绝过期 AI 结果，防止重试重复提交和旧结果覆盖新状态；
- GM Command、Override Event、审计理由：Owner 修状态不能绕过 EventLog/Revision。

## 4. 与当前仓库的主要差距

当前代码已经有一些可靠基础：

- `AiContextBuilder` 是明确的 Prompt 构造入口；
- AI 输出有 Zod/contract 校验、稳定 ID 校验、服务端权威骰子/先攻约束；
- `StateChangeMaterializer` 已经对角色、世界事实、任务和战斗变化做白名单校验，并在事务中正式应用；
- AI resolution 已经采用 claim、外部 provider 调用、formal apply 的分阶段模式；
- 当前任务已经删除 metadata-only 的规则来源登记链路，并只保留窄化的 legacy cleanup bridge。

但来源中设想的系统还没有全部落地：

1. `AiContextBuilder` 目前仍直接加载战役、已批准角色、世界事实、行动和战斗摘要，尚不是按权限、绑定、关系、检索和预算拆分的 `ContextPlanner`；
2. 尚未形成独立的 `Worldbook / KnowledgePack / KnowledgeEntry / DocumentChunk` 领域和版本化检索索引；
3. 尚未看到名为 `GameEffect` 的统一跨领域效果协议。现有 `StateChangeMaterializer` 是一个重要前身，但仍主要围绕 AI 结算字段和具体表更新；
4. Scene/Presence/Party split、WorldClock/Scheduler、统一 ConditionEngine、GM Override 协议还没有成为贯穿系统的公共契约；
5. 当前项目的 `Rules` 语境必须和已删除的规则资料 metadata registry 区分：未来的 Ruleset 应是可执行规则契约/引擎，不应重新引入 `platform_rule_sources`、`contentHash` 或“登记外部规则文件”的占位链路。

## 5. 来源库中需要警惕的问题

### 5.1 设计范围过宽

来源同时讨论世界书、Prompt Preset、检索、战斗、社交裁定、知识同步、分队、时间、任务、经济、成长、GM Console、断线恢复和技术栈。它适合作为架构地图，不适合作为一次性开发清单。

### 5.2 概念命名尚未冻结

`Narrator / Main AI`、`Referee / Adjudicator`、`Runtime / State`、`Worldbook / KnowledgePack`、`Campaign Blueprint / Quest / Event` 在不同段落有重叠。实施前需要一个小型 domain glossary 和一份权威 contract，否则会出现同一概念多套 JSON。

### 5.3 来源内容存在重复和“引用自己”的问题

对话中经常用其他来源标题作为论据，且同一内容在多个分支重复。来源库不应把这些引用当成外部独立证据；应先按根对话、消息 ID、主题和版本去重。

### 5.4 研究判断和项目事实混在一起

例如技术栈、SQLite 边界、SillyTavern 行为、D&D SRD 版本和许可等内容需要在实现前单独核查，并记录具体版本/链接。它们不能只因为出现在 ChatGPT 对话里就成为产品事实。

### 5.5 “实时编辑请求体”容易越权

如果没有 Override Scope，DM 改 Prompt 可能被误认为直接修改 Runtime；如果没有 Freeze/Re-run 语义，重跑可能重新掷骰或覆盖新 Revision。这个功能必须晚于状态与审计协议。

## 6. 推荐的实施优先级

### v0.1：先固定权威边界

1. 冻结 domain glossary 和 AI task contracts；
2. 保持 `AiContextBuilder` 作为临时 seam，但将 context 分为 policy、input、runtime、resolution、audience 等明确区块；
3. 固化 `expectedStateRevision`、idempotency、stale-result rejection、claim/replay；
4. 将现有白名单状态变化逐步收敛为可审计的 Effect/Command → Transaction → Event → Revision；
5. 保持玩家/Owner knowledge projection 和 AI context visibility 由服务端硬过滤；
6. 明确 Ruleset 是可执行规则契约，不恢复已删除的规则资料 registry。

### v0.1 后半：最小 Knowledge/Retrieval

1. `KnowledgePack`、`KnowledgeEntry`、版本与稳定 ID；
2. scope、visibility、usableBy、ActorKnowledge、authority；
3. aliases/tags/relations；
4. SQLite FTS5 + deterministic ranking；
5. `ContextTrace` 和 token budget；
6. brief/summary/full 三档内容；
7. 先不引入向量数据库和神经 reranker。

### v1：上下文工作台和运行骨架

1. Context Preset / Context Run / Request Preview / Trace；
2. Request/Scene/Preset/Source/GM State 五类 override；
3. SceneRuntime、ActorPresence、Party split/merge；
4. WorldClock、Scheduler、Duration、Rest、Travel；
5. ConditionEngine；
6. 冻结请求、同 Revision 重跑、最终请求 Diff。

### Later：规模化检索与高级运营

- Entry/chunk embedding；
- Hybrid Retrieval 的语义补召回；
- Feature reranker 或 cross-encoder；
- 大规模后台 WorldTick；
- 多 Campaign / 多实例数据库扩展；
- 完整 GM Console、Replay/Trace 分析和自动评测。

## 7. 当前不建议做的事情

- 不要把 SillyTavern 的 World Info 直接当作 DiceRealm 的核心数据模型；
- 不要先做向量数据库、神经 reranker 或整套 RAG 平台；
- 不要把完整世界书、全部角色卡或完整历史聊天塞入每次 Prompt；
- 不要让世界书条目自己决定 Prompt 插槽；
- 不要把未来剧情计划当 Runtime 事实；
- 不要让 Narrator、Referee 或世界书文本直接改权威状态；
- 不要重新建立 metadata-only 的规则来源登记功能；
- 不要在 Scene、Time、Effect、Revision 和失败恢复协议未定之前继续横向扩展大量 UI 功能。

## 8. 最终判断

这个来源库已经足够支持 DiceRealm 的架构方向判断，但还不能直接作为实现规格。应把它整理成四类正式文档：

1. **Domain Glossary**：冻结概念和边界；
2. **Authority & Visibility Contract**：谁能决定什么、谁能看到什么；
3. **Context/Retrieval Contract**：如何从资源生成一次请求；
4. **State Mutation & Revision Contract**：如何从行动生成 Effects、Events、Facts 和 Revision。

真正的下一步不是继续增加“世界书功能”，而是把这四份契约和当前代码对齐。这样来源库中的大量好想法才能变成可测试、可回放、不会泄漏秘密且不会被 AI 越权修改的 DiceRealm 运行时。
