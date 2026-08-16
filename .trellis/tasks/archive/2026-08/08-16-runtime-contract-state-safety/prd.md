# 运行时协议与状态一致性

## Goal

建立 DiceRealm 第一阶段的 Runtime Contract & State Safety 基础层。第一阶段不做世界书系统、不做 AI 多模型编排，而是先把玩家行动、AI 上下文、结构化结果、状态校验和权威写入之间的边界固定下来，防止 AI 输出直接等同于游戏事实或数据库修改。

## User Value

当同一个战役出现并发行动、AI 延迟、客户端重试、私密知识或状态变化时，系统必须能够明确回答：

- 玩家实际提交了什么；
- AI 只是提出了什么建议；
- 哪些内容被允许进入 AI 上下文；
- 哪些内容被权限过滤；
- 这次 AI 结果基于哪个状态版本；
- 结果为什么被接受或拒绝；
- 同一个结果是否可能被重复应用。

## Confirmed Scope Decisions

- 建立新的独立 Trellis 任务，不继续扩展 `08-16-room-links-rules-materials`。
- 第一阶段保持一次主 AI 调用；内部 contract 可以拆分，但不实现多模型 orchestration。
- `AiContextBuilder` 先从直接拼 Prompt 演进为构造结构化 `ContextBlock`，再由 renderer 生成 Provider 消息。
- 第一阶段建立 `Authority`、上下文语义的 `Visibility`、`sourceRefs` 和最小 `ContextTrace`。
- 第一阶段完成 `expectedStateRevision`、stale-result rejection、`actionId`/`executionId` 或等价幂等闭环。
- `StateChangeMaterializer` 只接受受控的结构化 StateChange，不允许 AI 通过任意实体/字段 patch 直接获得持久化写权限。
- Ruleset 第一阶段只做稳定身份和版本标识，不实现完整 D&D 规则引擎，不恢复规则资料 registry。
- 世界书第一阶段最多使用测试 fixture 验证 Context 进入、过滤和 trace，不建立完整 Worldbook 持久化系统。
- 第一阶段不实现 Worldbook UI、Context Inspector UI、Vector DB、Embedding、Reranker、GM Console、Scene 分队、WorldClock、完整 D&D rules engine 或多模型 pipeline。

## Requirements

### R1. Domain contracts

定义并导出跨模块长期使用的核心 contract：

- `ActionIntent`
- `ResolvedOutcome`
- `NarrativeOutput`
- `StateChange`
- `ContextBlock`
- `Authority`
- 上下文语义的 `Visibility`
- `StateRevision`

Contract 必须区分：

- 玩家输入；
- AI 的 interpretation/proposal；
- 规则或服务端确定的 resolved fact；
- 允许进入上下文的内容；
- 允许持久化的状态变化。

### R2. Structured Context

`AiContextBuilder` 必须先产生结构化 ContextBlock，再由 renderer 生成现有 `AiPrompt.messages`。

每个重要 block 至少能够表达：

- block type；
- content；
- source reference；
- authority；
- context visibility；
- priority；
- estimated token 数（如果可以安全计算）。

第一阶段至少覆盖：

- system/rules policy；
- campaign/runtime state；
- scene/actor state（当前已有数据能表达的范围内）；
- actor knowledge 或已知事实；
- recent action/input；
- output contract。

不得改变现有 Provider 的单次调用形态：仍由一条结构化 prompt 交给一个 Provider 调用。

### R3. Authority and Visibility

`Authority` 表示信息在游戏事实体系中的权威程度，例如：

```text
SYSTEM / RULESET / CAMPAIGN / GM / WORLD / SCENE / ACTOR / AI_INFERRED
```

上下文语义的 `Visibility` 表示允许哪些受众知道，例如：

```text
SERVER_ONLY / GM_ONLY / ACTOR_PRIVATE / PARTY / CAMPAIGN / PUBLIC
```

两者不得合并成一个字段。

现有 turn entry/world fact 的持久化可见性值（`public`、`player_private`、`owner_only`）必须保持兼容；第一阶段不得通过重命名或扩大既有枚举破坏现有 Player/Owner 投影契约。需要在 Context boundary 做明确映射。

### R4. Context filtering and trace

上下文构造必须在 Provider 调用前执行确定性过滤：

- 不因服务器知道某信息就自动让角色知道；
- 被 Visibility 拒绝的内容不得进入 Provider messages；
- 每个重要 block 能通过 `sourceRefs` 回溯来源；
- 最小 `ContextTrace` 至少记录 `actionId`、`blockId`、`sourceRef`、`included` 和 `reason`；
- trace 可以随 AI run 的 owner-safe context 一起保存，但不得保存 Provider 原始敏感内容或凭据。

### R5. Revision and idempotency

`StateRevision` 定义为 Campaign 当前权威运行时状态的单调提交版本，使用独立的 state-head，不借用 Campaign metadata、Outbox sequence 或 AI-run sequence。

持久化结构必须包含：

- `platform_campaign_state_heads`：每个 campaign 一个当前 revision head；
- `platform_campaign_state_revisions`：append-only revision ledger，记录 `mutationId`、`causeType`、`causeId` 和生成时间；
- `platform_ai_runs.expected_state_revision`：AI claim 时固定的输入版本；
- `platform_ai_runs.applied_state_revision`：formal apply 成功后写入的结果版本。

一次 AI 执行必须绑定启动时的状态版本。formal apply 使用数据库事务内的 compare-and-swap：只有当前 head 仍等于 `expectedStateRevision` 时，才允许推进 revision 并写入正式状态。

同一逻辑 authoritative mutation 无论修改多少业务表，只推进一次 revision；该事务产生的 entries、archive、outbox、audit 和其他状态变化共享同一个 `appliedStateRevision`。

同一行动在网络重试或 Provider 重放时不得重复应用。系统必须保留稳定的 `actionId`、`executionId`/`mutationId` 和幂等约束，至少能够区分：

- 同一个逻辑行动；
- 同一行动的不同执行尝试；
- 已完成执行的 replay。

AI claim 如果把 turn 从 `locked` 改成 `resolving`，该变化属于权威 Runtime mutation，必须在 claim 事务中推进一次 revision；Provider 使用的 ContextRun 必须记录 claim 后的 revision。

Archive restore 只能从历史快照恢复内容，不能把 live revision 回退到旧值。恢复操作本身产生新的 mutation 和新的 revision。旧版本 AI run 如果没有 `expected_state_revision`，必须视为 legacy run，只能展示和审计，不允许 formal apply。

### R6. StateChange boundary

`StateChangeMaterializer` 必须成为 AI proposal 与持久化状态之间的明确边界：

```text
AI output
  → server/domain validation
  → controlled StateChange
  → materializer validation
  → authoritative transaction
  → commit or reject
```

不得允许任意 `{ entity, field, value }` 或未受约束的 JSON patch 直接穿透到 repository。现有 character/world/quest/combat 能力应逐步收敛到有明确 kind、目标归属和字段白名单的结构化变化。

### R7. Single-call result separation

一次主 AI 调用的输出在逻辑上必须能区分：

- ActionIntent / interpretation；
- ResolvedOutcome；
- NarrativeOutput；
- proposed StateChange。

但第一阶段不要求这些逻辑对象对应多个 Provider 请求。服务端必须在正式应用前完成 schema、campaign ownership、visibility、revision 和 state-change 校验。

### R8. Ruleset compatibility

第一阶段只把 Ruleset 作为稳定的 ID/version 传递，例如 `dnd5e:2014` 这类形式；不实现完整规则数据、不建立外部规则来源登记表、不恢复 `platform_rule_sources` 或 content hash 链路。

### R9. Scope isolation

第一阶段的测试 fixture 只验证协议、过滤、trace、revision 和幂等，不导入真实 D&D 内容或 LOTM 内容。不同项目/世界资料必须保持 namespace 和默认检索集合隔离。

## Out of Scope

- Worldbook / KnowledgePack 的正式持久化系统；
- 真实 D&D 规则内容导入和完整规则引擎；
- 向量检索、Embedding、Reranker、Vector DB；
- Context Inspector、Prompt Preset 和 GM Console UI；
- Intent/Referee/Narrator 的多模型调用链；
- Scene 分队、ActorPresence、WorldClock、Travel、Rest、ConditionEngine；
- 完整 GameEffect 覆盖所有领域；本阶段只建立 StateChange 边界和可演进接口；
- 恢复已删除的规则资料登记、`platform_rule_sources` 或 metadata-only source registry。

## Acceptance Criteria

- [ ] contracts 包导出核心运行时 contract，并通过 shared contract tests 验证有效/无效输入边界。
- [ ] `AiContextBuilder` 返回结构化 blocks/context trace，并仍能渲染为现有单次 Provider `AiPrompt`；system message 仍只出现一次。
- [ ] Context block 的 Authority 与 Context Visibility 独立存在；现有 turn entry/world fact Player/Owner visibility contract 不回退。
- [ ] fixture 中的 GM-only/actor-private 信息不会因为存在于服务器或 owner context 中而进入不允许的 Provider context。
- [ ] 每个纳入或过滤的核心 block 都能产生稳定的 `sourceRef` 和 included/dropped reason。
- [ ] AI run 在 claim 时固定 expected revision；formal apply 前 revision 变化会 fail closed，且不写入 entries、state changes、archive 或 next turn。
- [ ] 同一逻辑行动的重复 execution/replay 不会重复扣血、写入事实、创建 entries 或推进 turn。
- [ ] StateChange 不再依赖未约束的任意 JSON patch；未知 kind、跨 campaign target、非法字段和不允许的 mutation 均 fail closed。
- [ ] 一次 Provider 调用仍能完成现有 turn resolution 主流程；不引入多模型 orchestration。
- [ ] Ruleset 仅作为稳定身份/version 参与 context 和 contract，不产生规则资料 registry 或真实规则内容导入。
- [ ] 具有至少一个完整场景 fixture：服务器知道某 NPC 的秘密、玩家只有相反的角色认知；系统正确过滤并留下 trace。
- [ ] `npm test -- --maxWorkers=1`、`npm run typecheck`、`npm run build` 和 `git diff --check` 通过；新增测试使用临时数据库，不读取仓库根目录数据库。

## Closed Planning Decisions

- `StateRevision` 使用独立的 `platform_campaign_state_heads` 作为当前真值，不写入 `campaigns` metadata，也不复用 Outbox/AI-run sequence。
- 同时建立 append-only `platform_campaign_state_revisions` ledger，用于 mutation provenance、幂等约束和审计。
- 增加 `015_campaign_state_revision.sql`，初始化现有 campaign 的 revision head 为 `0`；`0` 表示引入协议时的 legacy baseline，不试图伪造历史 revision。
- 旧 `platform_ai_runs.expected_state_revision` 保持 `NULL`，不回填为 `0`；这类旧 run 不允许 formal apply。
- 使用统一的 `CampaignMutationCoordinator`/等价内部边界，在同一事务内完成 expected revision 校验、CAS 推进、ledger 写入和业务 mutation。
- 一个逻辑 authoritative transaction 无论修改多少表只推进一次 revision。
- Archive restore 永不回退 live revision；恢复旧快照后继续使用新的 revision。
- 第一阶段保留 Outbox sequence、AI-run sequence、Archive version 等各自独立的语义；后续可以让 Outbox event 关联 `stateRevision`，但不能让它兼职。

没有剩余阻塞性产品决策。技术实现必须在 `design.md` 中明确 migration、旧数据库启动边界和所有权威 mutation 入口的盘点方式。
