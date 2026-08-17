# Narrative Runtime & Fact Memory

## Goal

把“这一轮已经发生了什么、同轮后续玩家能看到什么、下一轮每个角色分别记得什么”做成可持久化、可审计、可按 audience/actor 投影的运行时闭环。

本 task 不把长期知识库一次性做完，而是先建立稳定主链：

```text
NarrativeRound
  -> Round Participants
  -> NarrativeDecision
  -> 单个决策结算
  -> WorkingFacts
  -> 后续同轮决策读取 WorkingFacts
  -> Round Close
  -> Fact Provenance / Validation
  -> immutable RoundFactSet
  -> minimal ProjectedRoundSummary
  -> 下一轮 Context
```

用户价值：后续 Worldbook、私密剧情、关系、任务、长期 NPC 行为和 RAG 可以依赖明确的运行时事实来源与角色知识边界，而不是依赖上一轮 raw action、Narration prose 或 Owner 全知摘要。

## 已确认的仓库约束

- `platform_turns` 当前承担“大轮”容器；`platform_actions` 保证每个玩家每轮一条 action，行动顺序由 `submitted_at ASC, id ASC` 确定。
- 当前 semantic resolution 把一个 Turn 的全部 Intent 放进同一事务；`MechanicalResolutionService.resolveIn()` 在事务内维护 working state，任一后续 Intent 失败会回滚整次机械提交。
- `CampaignMutationCoordinator` 是唯一的 StateRevision / mutation ledger seam；权威写入和 Outbox 事件必须在同一事务内完成。
- `platform_turn_entries` 是叙事/私密更新/骰子展示记录，不是长期事实库，也没有事实 provenance 或角色认知模型。
- `platform_world_facts` 是 Owner 写入的持久世界事实，已有 visibility/knownBy 投影，但不能表达 NarrativeRound provenance 或“角色知道/相信/怀疑”。
- `AiContextBuilder` 已有 actor/audience 过滤和 `ContextTrace`，但当前仍会在旧 intent stage 中提供整轮 submitted actions；本 task 需要为 decision-scoped context 建立只带当前输入、前序 WorkingFacts 和上一轮投影的路径。
- Archive restore 会 supersede later runtime history；新 round/fact 数据必须带 active/superseded 语义，作废分支不得进入 active context。

## 已锁定的产品与范围决策

### 本 task 完整实现

- `NarrativeRound` 真实 Runtime 对象、participant 集合、round 生命周期和 close 条件。
- `NarrativeRoundParticipant` 与每位玩家每轮一次的 `NarrativeDecision` lifecycle。
- 一个 Decision 一次独立的 claim/apply transaction；后续 Decision 基于前序已提交结果继续结算，不持有跨整轮的长事务。
- 持久化 `WorkingFacts`、可见性投影、来源和 state revision provenance、重复执行保护。
- `FactProvenance`、server/runtime fact 与 AI candidate 的分层和验证状态。
- 显式、幂等的 Round close 与不可变 `RoundFactSet`。
- 最小可运行的 `ProjectedRoundSummary`，支持 `party visible`、`actor private`、`gm/server only`，并真正接入下一轮 `AiContextBuilder`。

### 本 task 只定义 seam

- `RuntimeFactRepository`：接口、promotion command/result、provenance shape；不实现完整长期库、去重、supersede graph 或 retrieval。
- `ActorKnowledgeRepository`：知识投影/update proposal/query port；不实现 belief/certainty/rumor/misunderstanding/propagation。
- `NarrativeFactExtractor`：candidate extraction interface；不新增 FactCompiler Provider orchestration。
- `RoundCloseContributor` / `WorldTickHook`：close-time contributor seam；不实现 NPC 后台模拟、WorldClock、天气、派系时钟、旅行或 deadline。

### 明确不实现

- Worldbook、FTS、embedding、vector search、RAG、rerank。
- 完整 Relationship、Quest promotion、KnowledgeSync UI、WorldClock、完整 Combat Runtime 重构或完整 GM Console。
- 自动把所有历史 `platform_turn_entries` 转成长期 RuntimeFact。
- 允许 Narrative Provider 直接写 authoritative RuntimeFact。
- Historical Narration Request Snapshot hardening；该项仍是上一阶段的非阻塞后续增强。
- 与本 task 无关的完整 UI；服务端投影和测试所需的最小 contract/API seam 除外。

## Requirements

### R1. NarrativeRound 是唯一 authoritative round 状态源

- 为每个 active Turn 建立一对一 `NarrativeRound` Runtime 对象；MVP 兼容保留 `platform_turns` 和现有 API，但不再把 `platform_turns.status` 作为独立业务状态源。
- Round authoritative lifecycle 至少表达 `collecting/ready/processing/needs_owner_attention/closed`、当前处理位置、参与者、关闭时间和 provenance。
- 所有 live round 状态迁移经过 Round service + `CampaignMutationCoordinator`；`platform_turns` 只作为同事务内的兼容镜像/旧 DTO 投影。
- 同一 campaign 不允许同时存在两个 active round；作废 round 不得被普通 active 查询读取。

### R2. Participants 与 Decision lifecycle

- 每个 participant 一轮最多一个有效主要 Decision；Decision 关联原始 action/actor，但后续 context 不能把前序 raw action 当作记忆。
- 处理顺序固定为现有 `submitted_at ASC, id ASC`，除非未来另行引入 initiative/priority。
- Decision 至少支持 `waiting/submitted/processing/resolved/skipped/needs_owner_attention`；Round 只有所有必需 Decision `resolved` 或 Owner 明确 `skipped` 后才能 close。
- Decision claim、provider retry、mechanical apply 和 duplicate replay 必须使用稳定 execution/idempotency identity；重复调用不能重复掷骰、应用 effect、写 WorkingFact 或推进 lifecycle。

### R3. Sequential Resolution 与持久化 WorkingFacts

- A Decision 完成 authoritative apply 后立即提交 StateRevision 和 WorkingFacts；B Decision 在自己的短事务中读取 A 已提交的 runtime state 与可见 WorkingFacts。
- 后续 Decision context 只能由以下部分组成：`Stable Runtime + Previous Round Projection + Current Round WorkingFacts + Current Player Input`。
- 后续玩家看不到前序玩家 raw action body、raw Provider conversation、Narration prose 或不属于其 audience 的 private fact。
- WorkingFact 必须持久化，拥有稳定 id、round/decision/action 来源、产生阶段、visibility/audience、authority/validation status 和 state revision；服务重启后仍能恢复本轮因果链。
- provider 在本 task 的 decision path 只解释当前 action；机械结果、状态 mutation 和 WorkingFact authoritative 写入仍由 server 完成。

### R4. Fact authority 与 provenance

- Fact authority 至少区分：`server_mechanical`、`runtime_state`、`event_evidence`、`ai_candidate`。该枚举与现有 Context `Authority` 分开，不能混用。
- Evidence/source 至少支持：`state_transaction`、`mechanical_resolved_outcome`、`narrative_decision`、`narration_result`、`turn_or_narrative_event`、`gm_authored`。
- 每个 WorkingFact/RoundFact 都能追溯到 round、decision/action、execution/outcome、event 或 StateRevision；自然语言本身不能替代 provenance。
- `ai_candidate` 必须以 candidate/pending/rejected 状态保存；不能绕过验证直接写 authoritative RuntimeFact。Narration 结果只能作为 statement/evidence/candidate 来源，不能自动成为 objective mechanical truth。

### R5. Round close 与 immutable RoundFactSet

- Round close 是显式短事务，只有完成条件满足或 Owner 已明确处理所有阻塞 Decision 时才允许执行；首次 close 通过 coordinator 正常推进一个 StateRevision。
- close 只整理已提交的 WorkingFacts、机械 outcome、typed events、GM-authored source 和现有结构化结果；不得重新掷骰、重新应用 effect、重新执行前序 Decision 或修改历史 StateRevision。
- 每个 active Round 最多产生一个 immutable `RoundFactSet`；重复 close 返回既有结果，不新增 revision、不新增事实、不创建第二个 next round。
- RoundFactSet 覆盖本轮确定性 state/world/item/location 变化、discoveries、statements/claims、knowledge-relevant observations、event/quest 相关事实和 unresolved/candidate facts；长期 promotion 不在本 task 内完成。

### R6. Minimal ProjectedRoundSummary 与下一轮 Context

- `projectRoundFacts(roundFactSet, audience/actor)` 必须是可重放、server-owned 的投影，至少支持：`party`、`actor_private`、`gm_only`、`server_only`。
- projection 结果明确区分 world truth、actor-scoped private observation 和 AI candidate；不能返回 Owner 全量事实给所有 actor。
- 下一轮 `AiContextBuilder` 必须真正加入上一已关闭 Round 的 `previous_round_summary` block，并在当前 round 的 decision context 中加入当前 WorkingFacts；不得复用上一轮 raw conversation/action history。
- 纵向验收必须成立：C 的 `actor_private` secret 在 Round N close 后只进入 C 的 Round N+1 context，不进入 A/B；party fact 则按 party 规则进入可见 actor context。

### R7. Archive、rollback 与 compatibility

- 新 round、decision、WorkingFact、RoundFactSet 查询默认排除 `superseded_at IS NOT NULL`；archive restore 必须按 round/turn watermark supersede later branch，并恢复快照内 active round/facts。
- active next context 不能读取被 restore 作废的 RoundFactSet，即使其原始 AI run、turn entry 或 state revision 仍在审计表中。
- legacy Turn/AI records 保持可读；新 live round path 不得把旧 legacy run 的缺失 revision 当作可应用权威状态。

## 端到端验收场景

三个玩家 A、B、C，Round N 初始状态包含 `door.closed`，carriage location 未知：

1. A 的 Decision 完成后，server commit 结构化结果并持久化 `door.open`、A moved 等 WorkingFacts。
2. B 随后请求 Context：能看到 `door.open` 等 audience-allowed structured facts，但看不到 A raw input、A narration prose 或 private data。
3. C 在本轮产生 `secret_fact`，visibility 为 `actor_private(C)`；该事实可追溯到 C 的 Decision、execution/outcome/event 和 applied StateRevision。
4. Round close 生成一个 immutable RoundFactSet；重复 close 幂等。
5. Round N+1 的 projected context 满足：A/B 不含 `secret_fact`，C 含 `secret_fact`；party-visible facts 按 audience 进入对应 context。
6. 所有 active facts 都能追到 source decision/outcome/event/revision；archive restore 后作废分支不再进入下一轮 context。

## Acceptance criteria

- [ ] 一个 active Turn 可以关联并读取唯一 NarrativeRound、participants、Decision 状态、确定性顺序和 close 状态。
- [ ] 新 round path 中两个 Decision 按确定性顺序逐个结算；第二个能读取第一个已提交 WorkingFact，但看不到第一个 raw action body/private prompt。
- [ ] WorkingFacts 在临时 SQLite 重启/重新打开后仍存在，包含 source、audience、execution 和 applied StateRevision provenance。
- [ ] 每个 Decision 使用独立短事务推进；后续 Decision 失败只回滚自身未提交写入，不回滚前序已提交 WorkingFacts/StateRevision；该失败会阻止 Round close 并进入 Owner attention。
- [ ] server mechanical/runtime facts、event evidence 和 AI candidate 在 contract、存储状态、写入路径上可区分；AI candidate 不能直接成为 authoritative RuntimeFact。
- [ ] Round close 仅在完成条件满足时发生，首次 close 生成一个 immutable RoundFactSet；重复 close 不重复事实、不推进新 revision、不重新处理 mechanics。
- [ ] Minimal ProjectedRoundSummary 真正接入下一轮 `AiContextBuilder`，并通过 A/B/C private projection 验证 actor isolation。
- [ ] Archive restore/supersede 后，作废 Round/WorkingFact/RoundFactSet 不会进入 active 下一轮 Context。
- [ ] RuntimeFact、ActorKnowledge、NarrativeFactExtractor、WorldTick/close contributor seam 已定义，但没有引入其完整长期持久化、AI orchestration 或世界模拟实现。
- [ ] 临时 SQLite fixture 覆盖正常流程、重复提交、后续 Decision 失败、candidate 越权、Round close 幂等、projection privacy、archive supersede 和 migration rollback/failure。
- [ ] 通过项目规定的 `typecheck`、focused tests、full test、build、migration manifest 检查和 `git diff --check`。

## Post-implementation review follow-up（2026-08-17）

代码 review 已确认主体数据链已经落地，但 live product semantics 仍有以下缺口：

- **P0：live NarrativeRound 仍可被 legacy whole-turn `resolveTurn()` 处理。** 新 active Round 必须只允许 Decision-scoped resolution；旧 whole-turn path 仅保留历史/兼容读取，或在无 NarrativeRound 的旧数据上运行。
- **P0：submit 后仍要等所有 required participant 提交才开始处理。** Round 必须允许收集新提交的同时处理已经提交的最早 Decision；不能把 `all submitted` 当作 processing 的开始条件。
- **P0：outbox worker 不能依赖进程内 handled-event 集合。** 未修改 `published_at` 的 wake-up 事件必须通过 `platform_outbox_consumer_receipts` 持久化消费状态；查询必须能跨越超过一个 batch，并在重启后继续处理更新事件。
- **P1：Decision-scoped path 缺少 presentation-only Narration。** Mechanics/WorkingFacts/Decision 状态提交后，应独立生成可重试的 narration，不得让 narration 失败回滚已提交 StateRevision。
- **P1：Fact authority/source/status 需要组合矩阵。** 至少禁止 `narration_result -> runtime_state + authoritative`，不能只检查 `ai_candidate + authoritative`。
- **P1：production deterministic contributors 需要覆盖现有 server mechanical/state/event effects；不实现完整 FactCompiler。**
- **P2：Round close 需要接入 automatic archive recovery boundary；Fact payload 需要增加大小/深度/键数量限制。**

### Closed decision — Immediate decision scheduling

正式采用异步 outbox/coordinator worker：

```text
action submit short transaction
→ commit
→ narrative.round.work_available outbox
→ worker claims earliest eligible submitted Decision
→ decision-scoped resolution
→ WorkingFacts commit
→ presentation-only narration
→ schedule next eligible Decision
```

Outbox 只负责唤醒，不负责决定顺序；worker 每次都重新查询 `submitted_at ASC, id ASC` 的最早 eligible Decision。一个 Round 同时最多允许一个 Decision resolution in flight。Round 在 collecting 时可以继续接收新提交，同时处理已提交 Decision；最早 Decision 被 `needs_owner_attention` 阻塞时，后续 Decision 不得越过它。

Action submit 与异步 claim 通过同一 campaign mutation/CAS 串行化：claim 成功后使用不可变的当前 action/context snapshot，后续修改不能改变本次 execution；claim 前的修改则由 worker 读取最新版本。

## Blocking open questions

无。MVP 范围、端到端验收、权威状态源、事务边界和长期 seam 均已锁定；本 task 已进入实现阶段。