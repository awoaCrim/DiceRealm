# Design: Runtime Contract & State Safety

## 1. Design goal

第一阶段不建设完整 Worldbook，也不拆多模型流程。目标是把当前单次 AI turn resolution 流程改造成一个可追踪、可校验、可拒绝 stale result 的运行时协议：

```text
Player Actions
  -> ActionIntent projection
  -> ContextBlock[] + ContextTrace
  -> one AiProvider call
  -> ResolvedOutcome / NarrativeOutput / proposed StateChange
  -> schema + domain + revision validation
  -> one authoritative mutation transaction
  -> entries / runtime / events / archive / next turn
  -> commit or rollback
```

当前代码的 `AiContextBuilder`、`AiResolutionService` 和 `StateChangeMaterializer` 保留为主要 seam；本任务不重写 Provider、Outbox、turn-entry projection 或 archive superseded 语义。

## 2. Existing boundaries to preserve

### 2.1 Existing Provider contract

- `AiPrompt.messages` 继续是 Provider 唯一输入表示；system instruction 仍只出现一次。
- 每次 claim 只调用一次 Provider。
- `AiResolutionService` 继续使用 claim -> provider outside transaction -> validate/formal apply -> fail/replay 的生命周期。
- Provider 原始输出、凭据和敏感诊断不进入 ContextTrace 或普通 HTTP DTO。

### 2.2 Existing persisted visibility

当前 turn entries/world facts 使用：

```text
public / player_private / owner_only
```

这些值继续服务 HTTP projection 和数据库不变量。本阶段新增的上下文受众语义使用独立的 `ContextVisibility`/等价类型，避免把现有 `Visibility` schema 重命名或扩大后破坏 Player/Owner 投影。

Context boundary 负责把 persisted visibility、knownBy、当前 actor 和任务类型映射为：

```text
SERVER_ONLY / GM_ONLY / ACTOR_PRIVATE / PARTY / CAMPAIGN / PUBLIC
```

### 2.3 Existing state mutation boundary

`StateChangeMaterializer` 继续拥有 formal apply 的业务写入权。第一阶段把其输入从宽泛的 `z.record` 逐步收敛为按 kind 分支的受控 patch/command contract，迁移已有测试而不是引入第二套并行写入口。

## 3. Runtime contracts

Contracts package 增加或扩展以下概念：

### 3.1 `Authority`

建议枚举：

```text
system
ruleset
campaign
 gm
world
scene
actor
ai_inferred
```

`Authority` 只表达事实来源/冲突优先级，不表达谁能看见。

### 3.2 `ContextVisibility`

建议枚举：

```text
server_only
gm_only
actor_private
party
campaign
public
```

`ContextVisibility` 只表达 Context consumer 的允许受众，不代替现有 persisted visibility。

### 3.3 `ContextBlock`

```ts
interface ContextBlock {
  id: string;
  type: ContextBlockType;
  content: string;
  sourceRefs: ContextSourceRef[];
  authority: Authority;
  visibility: ContextVisibility;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  estimatedTokens?: number;
}
```

第一阶段 block type 至少覆盖：

```text
system_policy
ruleset_policy
campaign_runtime
scene_state
actor_state
actor_knowledge
recent_action
player_input
resolution_contract
```

`sourceRefs` 使用稳定、非敏感的内部引用，例如 `campaign:c1`、`turn:t1`、`character:c1`，不得包含 raw prompt、数据库 JSON 或 Provider URL。

### 3.4 `ContextTrace`

最小结构：

```ts
interface ContextTraceEntry {
  actionId: string;
  blockId: string;
  sourceRef: string;
  included: boolean;
  reason: ContextTraceReason;
  estimatedTokens?: number;
}
```

第一阶段 reason 使用服务端控制的固定枚举，例如：

```text
required
scope_match
actor_knowledge
visibility_denied
not_relevant
budget_dropped
legacy_source
```

Trace 存在于 owner-safe AI run context 中，不进入 Player response，也不保存 Provider 原文。

### 3.5 Action / result contracts

第一阶段不要求新增独立 Provider endpoint，但在内部 contract 上区分：

- `ActionIntent`：来自玩家 action 的结构化 interpretation；
- `ResolvedOutcome`：服务端/规则边界确认的结果；
- `NarrativeOutput`：模型生成的可读叙事；
- `StateChange`：经过约束的 mutation proposal。

当前 turn 聚合多个玩家 action，因此暂时以 `turnId` 作为本轮逻辑 `actionId` 的稳定聚合身份；`platform_ai_runs.id` 作为 execution identity，`idempotency_key` 继续作为客户端重试幂等键。未来引入独立玩家行动编排时再拆出更细的 ActionIntent id，不在本阶段增加多行动 orchestrator。

## 4. Context construction flow

### 4.1 Build

`AiContextBuilder.buildForTurn()` 先构造 block registry：

```text
System Policy
Ruleset Identity
Campaign Runtime
Current Turn / Actions
Approved Actor State
Known World Facts
Owner Combat Projection
Output Contract
```

每个 block 同时生成 trace candidate。根据当前 Owner-only turn resolution 的任务受众执行确定性过滤和排序。

### 4.2 Filter

过滤顺序：

```text
source scope
  -> persisted visibility / knownBy
  -> task audience
  -> actor/party knowledge
  -> authority-safe projection
  -> priority ordering
  -> optional basic token budget
```

本阶段不做 semantic retrieval。fixture 只验证：GM-only secret 不会进入不允许的 AI context，actor-private knowledge 不会自动进入其他 actor 的 context。

### 4.3 Render

新增纯函数/小模块将 `ContextBlock[]` 渲染为现有 `AiPrompt.messages`。Renderer 不重新定义权限，不读取数据库，不自行追加未 trace 的内容。

`AiContextPackage` 保留现有 `prompt` 和 owner-safe `context`，增加结构化 blocks/trace 的稳定表示，以兼容现有 `context_json` 和 Owner debug 页面。

## 5. StateRevision storage

### 5.1 Tables

新增 migration `015_campaign_state_revision.sql`：

```sql
CREATE TABLE platform_campaign_state_heads (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE platform_campaign_state_revisions (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  revision INTEGER NOT NULL,
  mutation_id TEXT NOT NULL,
  cause_type TEXT NOT NULL,
  cause_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, revision),
  UNIQUE (campaign_id, mutation_id)
);

ALTER TABLE platform_ai_runs ADD COLUMN expected_state_revision INTEGER;
ALTER TABLE platform_ai_runs ADD COLUMN applied_state_revision INTEGER;
```

Migration 在 head/ledger 建立后将所有既有 campaign 初始化为 revision `0`。`0` 是引入协议时的 legacy baseline，不是伪造的历史事件编号。旧 AI run 的 revision 字段保持 `NULL`。

Migration manifest、approved migration set、fresh fixtures 和 schema inventory 必须保持一致。普通启动不得因此恢复“任意 pending migration 自动应用”；旧数据库如何进入包含 015 的维护集合必须遵循项目既有显式 migration/reset boundary，并在实现计划中单独验证。

### 5.2 Mutation coordinator

新增内部 `CampaignMutationCoordinator` 或等价的组合根边界，负责：

1. 在同一 transaction 中读取/锁定 state head；
2. 对带 expected revision 的请求执行 CAS；
3. 对无 expected revision 的新 authoritative mutation 分配下一个 revision；
4. 插入唯一 `mutation_id` 的 revision ledger；
5. 执行 callback 内的业务写入；
6. 把 `previousRevision` / `stateRevision` 注入 MutationContext；
7. 任一失败时整体 rollback。

建议 API：

```ts
interface CampaignMutationRequest {
  campaignId: string;
  expectedRevision?: number;
  mutationId: string;
  causeType: string;
  causeId?: string;
}

interface CampaignMutationContext {
  tx: QueryExecutor;
  campaignId: string;
  previousRevision: number;
  stateRevision: number;
  mutationId: string;
}
```

CAS 语义必须由数据库条件更新保证，而不是先 SELECT 再依赖应用层假设：

```sql
UPDATE platform_campaign_state_heads
SET revision = revision + 1, updated_at = ?
WHERE campaign_id = ? AND revision = ?;
```

影响行数为零时抛出受控 `STALE_STATE_REVISION`/等价内部错误，正式事务不产生任何状态写入。

### 5.3 Mutation classification

以下权威 Runtime mutation 推进 revision：

- 玩家正式 action submit/update；
- turn lock/resolving/completed 等影响后续结算的状态变化；
- StateChangeMaterializer formal apply；
- world fact、character gameplay state、combat、quest、knowledge sync；
- archive restore；
- GM runtime override。

以下不单独推进 revision：

- AI preview delta；
- ContextTrace；
- AI debug metadata；
- Outbox publish 本身；
- 只修改 Campaign metadata（如 name）；
- login/session/security audit；
- 手动 archive snapshot 本身。

一个 formal apply 无论修改多少表只推进一次 revision。该 transaction 中的 entries、archive、outbox、audit 和 state changes共享其 applied revision。

### 5.4 AI lifecycle

Claim 事务：

```text
locked turn
  -> state head N -> N+1
  -> turn resolving
  -> build ContextRun at revision N+1
  -> ai_run.expected_state_revision = N+1
```

Formal apply 事务：

```text
read expected revision
  -> CAS N+1 -> N+2
  -> materializer / entries / turn / archive / events
  -> ai_run.applied_state_revision = N+2
  -> commit
```

Provider 返回期间如果其他 authoritative mutation 推进了 head，CAS 失败，AI run 进入受控失败/owner attention 状态，不能写 formal entries 或 next turn。

同一 `mutation_id` 重放必须命中唯一约束并返回幂等 replay 或受控冲突，不得再次应用 effects。

### 5.5 Archive restore

Restore 从旧快照恢复状态内容，但永远不把 live head 回退到旧 revision。若当前 live revision 为 90、快照捕获于 30，恢复后应产生新 mutation：

```text
90 -> 91
```

快照的历史来源可以记录 `capturedStateRevision=30`，但 live head 始终单调递增。旧 Archive schema 未包含该字段时保持兼容，使用 `NULL`/旧 schema version 表示未知。

## 6. StateChange boundary

把当前 `StateChange` schema 从宽泛 `patch: record` 收敛为按 kind 的 typed patch/command union，并把 materializer 中的 patch schema 提取为共享或同源定义，避免 contract 与 service 各自漂移。

第一阶段至少保持这些现有能力：

- character：只允许已审核字段白名单；
- world/quest：只允许已定义的事实字段；
- combat：只允许 CombatStateChangeApplier 支持的命令；
- 所有目标必须属于 campaign；
- visibility/knownBy 继续由服务端验证。

不在本阶段把所有领域重写成完整 `GameEffect` 系统；只建立可继续演进的 typed StateChange 和 MutationContext seam。

## 7. Compatibility and rollback

- 015 是 schema change，必须同步维护 migration manifest、approved set、fresh/temp fixtures、migration tests 和 build copy list。
- 旧 AI run 的 expected/applied revision 为 NULL，只能读取、审计和展示，不能 formal apply。
- 旧 archive snapshot 没有 captured revision 时继续恢复，但 restore 仍从当前 head 推进新 revision。
- state head/ledger/AI columns 的 migration 失败时数据库保持原状，不静默重建或删除。
- 普通 startup 继续遵守当前不自动应用任意 pending migration 的安全门；显式升级/重建路径必须在验证阶段确认。
- 任意 formal apply 失败时 head、ledger、entries、state changes、archive、outbox 和 run 状态按现有事务边界整体回滚。

## 8. Observability and security

- ContextTrace 只记录稳定 sourceRef、blockId、reason、included 和 bounded token metadata。
- error/diagnostic 不持久化 Provider 原文、请求 headers、URL、凭据、拒绝的敏感值或完整 prompt。
- Owner 可读取受保护的 trace/context，Player 不获得 GM-only block、AI raw context 或其他玩家 private knowledge。
- revision ledger 的 causeType/causeId 使用服务端控制的值，不能直接信任 Provider 输出。

## 9. Main trade-offs

- 独立 head/ledger 比 `campaigns.state_revision` 多两张表和一个 migration，但语义隔离、Branch 扩展和审计更清晰。
- claim 也推进 revision 会多消耗一个版本，但可以保证 Provider 看到的 ContextRun 对应一个已提交的 `resolving` 状态，避免 context/revision 缝隙。
- 暂时将当前 turn 作为聚合 actionId，避免引入多行动 orchestrator；未来可再拆成独立 ActionIntent。
- 先 typed StateChange、后完整 GameEffect，降低第一阶段变更面，同时不把任意 JSON patch 留在边界上。
