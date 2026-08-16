# Design: 服务端裁定与骰子权威 v0.1

## 1. Design goal

本阶段把当前“Provider 输出结构化结果，服务端校验并写入”进一步收敛为：Provider 只解释玩家行动，服务端决定机械裁定、锁定 RollPlan、生成 RollRecord、提交 ResolvedOutcome，Narrator 只能描述已经提交的结果。

保留现有多人回合模型：一个 turn 包含多个已提交玩家 action。每个 action 生成一个 `ActionIntent`，按 `submitted_at ASC, action.id ASC` 的稳定顺序处理；同一 turn 的机械处理共享一个 authoritative transaction，只推进一次 campaign StateRevision。

本阶段不实现完整规则引擎、Worldbook、复杂战斗 runtime 或完整 GM Console。

## 2. Existing boundaries to preserve

- `CampaignMutationCoordinator` 是唯一的 revision head/ledger/CAS seam。
- `AiResolutionService` 保留 claim → Provider outside transaction → validate/formal apply/retry 的生命周期，但 formal apply 内部改为先完成服务端 mechanical resolution，再单独执行 narration。
- `AiPrompt.messages` 仍是 Provider 的唯一输入表达；不使用自动 repair、多模型编排或第二次同任务重试。
- `TurnEntryRepository.projectEntries()` 继续负责 Player/Owner 持久化 visibility 投影。
- archive superseded 语义、旧 `dice_result` entry 读取和现有 Owner combat HTTP command 保持兼容。
- 普通启动不猜测式应用 pending migration。新增 migration 016 只纳入 fresh/temp fixture 和显式升级路径；维护启动边界单独更新，不静默替换用户数据库。

## 3. End-to-end data flow

```text
platform_actions (all submitted actions)
  -> turn-level Intent Interpretation Provider call
  -> ActionIntentProposal[]
  -> schema + actor/target/campaign validation
  -> ActionIntent records (basedOnStateRevision = claim revision)
  -> deterministic server adjudication, in submitted order
  -> AdjudicationDecision
  -> immutable RollPlan when roll_required
  -> DiceService / RollRecord
  -> server-owned mechanical effects
  -> ResolvedOutcome with all members validated
  -> one CampaignMutationCoordinator mechanical mutation
  -> runtime state + RollPlan/RollRecord/Outcome + entries/events/archive/next turn
  -> player-observable Narration Context
  -> Narration Provider call
  -> NarrationOutput validation
  -> idempotent narration attempt / turn entries
```

Intent interpretation is a logical stage call that returns one proposal per submitted action. Narration is a separate logical stage call. The same Provider/model may serve both stages, but their contracts and context builders are different.

## 4. Multi-action turn semantics

### 4.1 Ordering

The server creates the intent list from all required submitted actions. Ordering is deterministic:

1. `submitted_at ASC`;
2. `action.id ASC` as the tie-breaker.

The ordering is persisted with each intent and is not recomputed from Provider output.

### 4.2 Sequential adjudication inside one transaction

The adjudicator processes intents in that order against the transaction's current state. A prior successful effect is visible to later intents in the same transaction. A later intent never reads a stale pre-turn snapshot.

If an earlier effect makes a later intent invalid, the later intent receives a controlled `STATE_CONFLICT`, `ACTION_NOT_AVAILABLE`, or `GM_ADJUDICATION_REQUIRED` decision according to the rule slice. It cannot silently apply against the old state. The default policy is fail closed for the affected intent while preserving the already-valid earlier effects only if the product transaction explicitly supports partial resolution; the first MVP should use all-or-nothing mechanical commit for the turn to keep StateRevision and story semantics simple.

Therefore the initial implementation should reject/rollback the whole mechanical transaction when any intent cannot be safely adjudicated, while retaining per-intent diagnostics for Owner inspection. Partial-turn commit is a later task.

## 5. Contracts

### 5.1 Action intent

Provider-facing:

```ts
interface ActionIntentProposal {
  actionId: string;
  actorId: string;
  mode: 'player_action' | 'npc_action' | 'owner_command';
  actionType: 'ability_check' | 'attack' | 'saving_throw' | 'healing' | 'use_action' | 'improvised_action';
  actionRef?: string;
  targetIds: string[];
  declaredApproach?: string;
  desiredOutcome?: string;
  resourceChoices: string[];
  fallbackPolicy?: 'stop_on_failure' | 'continue' | 'ask_player';
}
```

Server-owned `ActionIntent` adds `campaignId`, stable intent id, `sourceInput`, `basedOnStateRevision`, and normalized actor/target references. It must not contain `attackBonus`, `saveBonus`, `dc`, damage formula/amount, dice, or final result.

The proposal schema rejects unknown mechanical fields and validates action/target identifiers against the turn/campaign before an `ActionIntent` record is created.

### 5.2 Adjudication decision

```ts
interface AdjudicationDecision {
  id: string;
  intentId: string;
  kind: 'automatic_success' | 'automatic_failure' | 'roll_required'
      | 'player_choice_required' | 'gm_adjudication_required' | 'unsupported';
  reasonCode: string;
  ruleRef?: string;
  rollPlanId?: string;
  basedOnStateRevision: number;
}
```

Reason codes are server-controlled. An unsupported or ambiguous action produces `gm_adjudication_required`; the server never asks the Narrator to invent a DC.

### 5.3 RollPlan

`RollPlan` is created and hash-locked before any random source is read:

```ts
interface RollPlan {
  id: string;
  campaignId: string;
  intentId: string;
  executionId: string;
  actorId: string;
  targetIds: string[];
  rollKind: 'd20_check' | 'attack' | 'saving_throw' | 'damage' | 'healing';
  diceExpression: string;
  modifierBreakdown: Array<{ source: string; value: number }>;
  advantageState: 'normal' | 'advantage' | 'disadvantage';
  targetType: 'dc' | 'ac' | 'none';
  targetValue: number | null;
  successEffects: string[];
  failureEffects: string[];
  ruleRefs: string[];
  basedOnStateRevision: number;
  planHash: string;
  lockedAt: string;
}
```

The expression, target and modifier breakdown are generated from server-owned rules/action definitions and runtime state. Provider text is never interpolated into an executable expression without schema validation against the fixed rules slice.

### 5.4 RollRecord

```ts
interface RollRecord {
  id: string;
  rollPlanId: string;
  actionIntentId: string;
  executionId: string;
  rawDice: number[];
  selectedDice: number[];
  modifierBreakdown: Array<{ source: string; value: number }>;
  total: number;
  targetValue: number | null;
  result: 'success' | 'failure' | 'critical_success' | 'critical_failure' | 'not_applicable';
  rulesetId: string;
  stateRevision: number;
  mutationId: string;
  rolledAt: string;
}
```

A unique key over campaign/action/execution/roll-plan identity makes retries reuse the existing record. `DiceService` is the only constructor of formal RollRecord values.

### 5.5 ResolvedOutcome and validated members

`ResolvedOutcome` is created only after validation of:

- all ActionIntent references;
- AdjudicationDecision and RollPlan references;
- RollRecord references and state revision;
- `ValidatedStateChange[]`;
- `ValidatedWorldFactCreation[]`;
- `ValidatedEncounterStart[]`;
- `ValidatedInteractionRequest[]`;
- visibility/knownBy/member ownership.

Shape schemas may parse proposals but cannot create validation brands. The server-only validator/factory creates the validated outcome consumed by materialization.

### 5.6 NarrationOutput

Narration input is a server-owned `NarrationRequest` containing only the submitted action summaries, observable scene projection, committed ResolvedOutcome and public/private audience scope. Narration output may contain readable public narrative and validated player-private text, but no StateChange, RollPlan, RollRecord, DC, modifier or numeric mechanical command.

## 6. Provider workflow and audience boundaries

### 6.1 Intent interpretation

The turn-level intent call receives:

- all submitted action bodies in deterministic order;
- actor/party-scoped approved character data needed to identify possible actions;
- public/current scene and encounter projection;
- player agency policy and action contract.

It does not receive GM-only future plot secrets, Owner raw context, credentials, or arbitrary private facts unrelated to the action. The proposal is internal and never returned to Player.

### 6.2 Mechanical adjudication

Adjudication is deterministic server code. It may use only:

- validated ActionIntent;
- approved character/runtime data;
- current encounter/scene state;
- stable ruleset/action definitions;
- current transaction StateRevision.

No Referee AI is required for the first slice. Unsupported/ambiguous cases become `GM_ADJUDICATION_REQUIRED`.

### 6.3 Narration

Narration runs only after the mechanical transaction commits. Its context is built with player-observable audience rules and cannot include GM-only blocks or other players' private knowledge. It consumes the committed outcome; it cannot create a new mechanical effect.

A narration failure leaves mechanical state, RollRecords, Outcome and revision committed. The failure is stored as a retryable narration attempt. A retry uses the same mechanical run/outcome and never calls DiceService again.

## 7. Minimal rules slice

Use a code-owned, versioned fixture identified by a stable ruleset such as `dnd5e-2024-core@v0.1`. No external rule source registry is introduced.

The fixture contains only:

- ability check with explicit ability/modifier source;
- saving throw with server-selected save modifier and fixed target;
- single attack action resolved from an allowlisted `actionRef`;
- AC comparison;
- normal/advantage/disadvantage d20 selection;
- natural 20/1 handling for the supported attack slice;
- server-owned damage expression and healing amount;
- HP clamp and state effect generation.

If a character sheet lacks the explicit data required by the fixture, the action is unsupported or requires GM adjudication. The server does not infer mechanics from free-form narrative or accept numeric mechanics from Provider output.

## 8. Persistence and migration

Add an explicit migration 016 for temporary/fresh databases. The exact column names can be finalized during implementation, but the maintained model must provide:

- `platform_action_intents` — source action, normalized intent, actor/targets, based-on revision and execution;
- `platform_adjudication_decisions` — decision kind, reason/rule reference and roll-plan link;
- `platform_roll_plans` — immutable locked plan, hash, ruleset, state revision and execution;
- `platform_roll_records` — raw/selected dice, modifiers, total, result, mutation and state revision;
- `platform_resolved_outcomes` — validated outcome snapshot and applied revision;
- `platform_narration_attempts` — narration run/attempt, source outcome, state revision, status, bounded diagnostics and retry identity.

If existing `platform_ai_runs` is reused for intent/narration execution identity, add an explicit run kind and parent mechanical run reference rather than overloading `turn-resolution` semantics silently. All new tables must preserve campaign/turn ownership and archive superseded behavior.

Migration 016 must be included in the manifest and fresh schema tests, but ordinary production startup must continue to reject unapproved pending migrations until the project has an explicit safe upgrade path.

## 9. GM/debug command isolation

Existing Owner combat HTTP commands remain a separate direct-command path. Provider proposals must not call `CombatCommandPort` with numeric payloads. The adapter for AI accepts only the new semantic action/effect path. Any future GM override must have its own permission, cause type, audit event and revision mutation; it cannot masquerade as an AI proposal.

## 10. Main trade-offs

- **Preserve multi-action turns**: avoids breaking current gameplay, but requires deterministic ordering and all-or-nothing first-slice commit.
- **Two logical Provider stages**: permits Narrator to see committed results without granting it mechanical authority; increases latency and requires narration retry persistence.
- **Code-owned rules fixture**: provides a testable authority boundary without rebuilding a rules registry; unsupported character data becomes GM adjudication rather than guessed mechanics.
- **Explicit RollPlan/RollRecord tables**: improves auditability and retry safety; requires migration 016 and more persistence code.
- **Narration after mechanical commit**: guarantees retryable prose, but UI must represent pending/failed narration without treating mechanics as failed.

## 11. Rollback and compatibility

- Keep the old AI turn-resolution path behind an explicit compatibility boundary while the new execution path is introduced; do not allow both paths to write the same turn without a run-kind/claim guard.
- Migration 016 is additive. If it fails, no live database is rebuilt or replaced.
- Existing combat command HTTP tests and Owner/debug flows remain valid; Provider-facing numeric commands are rejected only at the AI proposal boundary.
- A failed narration attempt rolls back only narration-attempt writes, not the committed mechanical mutation.
- A stale mechanical revision rolls back all RollPlan/RollRecord/Outcome/effect writes in the transaction and does not advance the turn.
