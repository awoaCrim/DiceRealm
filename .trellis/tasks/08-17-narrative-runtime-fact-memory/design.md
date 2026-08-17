# Technical Design — Narrative Runtime & Fact Memory

## 1. Design decisions

### 1.1 NarrativeRound owns live round lifecycle

`NarrativeRound` is a real runtime aggregate stored separately from `platform_turns`. It is not a rename of Turn:

- `platform_turns` remains the compatibility action/container table and continues to support existing routes, archive snapshots, and old read DTOs.
- `platform_narrative_rounds` becomes the only authoritative source for live round lifecycle, participant progress, decision cursor, close state, and round provenance.
- Every live transition updates the round first and mirrors the compatible Turn status in the same coordinator-owned transaction. No new service may independently update `platform_turns.status` for a live round.
- Existing `TurnService`/AI entry points become adapters to `NarrativeRoundService`; direct Turn status helpers remain only as internal compatibility helpers used by that service or legacy restore code.

Round status is a coarse lifecycle indicator, not the lock that serializes Decision execution:

```text
collecting -> ready -> closed
     ^          |
     |          +-> close eligible
     +---------- needs_owner_attention (after owner retry/skip)
```

While a Round is `collecting`, it may continue accepting new participant submissions while one Decision is `processing` or earlier Decisions are already `resolved`. Decision status, not Round status, expresses per-Decision execution. `ready` means no further ordinary submission is expected and close is eligible; the normal immediate-resolution path does not wait for all participants before starting work. `processing` remains a compatibility/legacy aggregate state and is not required for a new Decision claim.

Compatibility mapping:

```text
collecting              -> waiting_for_actions
ready                   -> locked
processing              -> resolving
needs_owner_attention   -> needs_owner_attention
closed                  -> completed
```

A round close is a real coordinator mutation. Projection reads and Narration retry do not advance the runtime revision. The work signal is an outbox wake-up only; it never becomes the ordering source of truth.

### 1.2 One decision, one short authoritative apply

The provider may run outside a database transaction, but a live round never holds a transaction from the first action through close. Action submission wakes an asynchronous coordinator through an outbox event:

```text
action submit (short tx; Decision submitted + work_available outbox)
  -> worker claims earliest eligible Decision (short tx; context/action snapshot)
  -> intent Provider outside tx
  -> apply Decision (short coordinator tx; mechanics + WorkingFacts + Decision resolved)
  -> presentation-only Narration outside tx
  -> worker re-checks and schedules the next eligible Decision
  -> close Round (short coordinator tx; FactSet + automatic archive + next Round)
```

The worker always re-queries `submitted_at ASC, action_id ASC`; duplicated, delayed, or replayed outbox events cannot change causal order. The claim mutation atomically requires no earlier submitted unresolved Decision and no other `processing` Decision in the same Round. Therefore one Round has at most one Decision resolution in flight even when several workers receive duplicate signals. A process-local `NarrativeClaimLeaseSweeper` periodically scans active processing claims without invoking a Provider, so a crashed claim is fenced even when no owner HTTP request arrives; the actual outbox-to-Provider consumer remains a deployment/transport seam rather than being hidden inside this lifecycle service.

The claim mutation records the execution identity and expected input revision. The apply mutation CASes that expected revision, calls a decision-scoped server adjudication seam, persists the mechanical outcome and WorkingFacts, and marks exactly that Decision resolved. A provider failure or owner-required result marks only that Decision/round as needing attention; it cannot make the Round appear closed. A `processing` claim uses `platform_narrative_decisions.updated_at` as a five-minute lease. If no mechanical outcome is committed when the lease expires, a recovery sweep fences the claim with `WORKER_CLAIM_EXPIRED`, fails its still-running AI run, updates the participant/Round/Turn mirror, and blocks later Decisions. If the mechanical outcome already exists, the sweep leaves the claim intact so idempotent replay can finish metadata without rerunning mechanics; a late Provider result must fail the processing/execution identity check.

The existing `MechanicalResolutionService.resolveIn()` is kept as the compatibility whole-turn wrapper. The implementation adds a decision-scoped `resolveDecisionIn()` (or equivalent internal input) that accepts exactly one action/intent and does not require all actions in the Turn. It reuses the same server `AdjudicationService`, `DiceService`, `RollPlan`, `RollRecord`, `MechanicalResolvedOutcome`, and `CampaignMutationCoordinator` boundaries.

A decision retry reuses the same execution/outcome identity when the mechanics are already committed. It must return the stored outcome and never re-roll or re-apply effects. A failed provider interpretation can use a new attempt while retaining the same Decision identity; a failed mechanical apply rolls back its transaction and leaves the Decision retryable/owner-attention. A `needs_owner_attention` Decision blocks all later Decisions in deterministic order; owner resolution or skip is an authoritative mutation that emits a fresh work signal.

### 1.3 Action snapshot and submit/claim CAS

Before claim, a participant may edit a submitted action. The claim mutation and action submit mutation both run through the same campaign coordinator boundary:

- claim reads the latest action `updated_at` and writes the immutable context/action snapshot into the AI run/Decision execution;
- once the Decision is `processing`, `resolved`, or `needs_owner_attention` for that execution, action edits are rejected rather than silently changing the input;
- if submit wins the race, claim observes the new action version; if claim wins, the submit mutation fails its Decision-status CAS;
- mechanics validates the proposal against the claimed action/actor identity, not a later mutable action row.

This uses the existing action timestamp plus Decision status/state-revision CAS instead of treating outbox delivery order as an action revision. A later `turn_action_submit` is input-only: it may advance the campaign revision while the Provider is running, so Decision apply rebases its CAS over only those allowed submit revisions. Any intervening world/runtime mutation still fails with `STALE_STATE_REVISION`.

## 2. Persistence model

Add migrations `017_narrative_runtime_fact_memory.sql`, `018_narrative_work_consumer_receipts.sql` and `019_action_branch_lifecycle.sql` with manifest entries. Do not edit an applied migration. Migration 019 must rebuild the SQLite action/FK dependency graph atomically so existing `platform_action_intents` references survive. All new repositories depend on `DatabasePort`/`QueryExecutor`, use parameterized SQL, and receive the caller's transaction executor.

The exact JSON payload fields should be represented by shared contracts and bounded schemas; SQL stores JSON only for the variable fact payload/source arrays, not for lifecycle columns needed by queries.

### 2.1 `platform_actions` branch lifecycle

`platform_actions` is both the active input slot and the immutable parent of adjudication audit. Archive restore therefore uses versioned branch semantics:

- active rows have `superseded_at IS NULL`; historical rows retain `superseded_at` and `superseded_by_archive_id` for audit;
- migration 019 replaces table-level `UNIQUE (turn_id, player_id)` with a partial unique index over active rows only;
- `listActionsByTurn`/`findActionByTurnPlayer` and all worker/context/view joins are active-only; all-history reads are explicit and limited to restore/audit paths;
- restore marks snapshot-external actions superseded without deleting them, reactivates snapshot actions, and creates a new action id when a participant submits after restore;
- active Decision ordering remains `submitted_at ASC, id ASC`, so a superseded later-branch action cannot block or reorder the restored branch.

### 2.2 `platform_narrative_rounds`

Core columns:

- `id`, `campaign_id`, `turn_id UNIQUE`, `number`/round number;
- `status` (`collecting`, `ready`, `processing`, `needs_owner_attention`, `closed`);
- `decision_cursor` or `active_decision_id`, `last_state_revision`;
- `closed_at`, `created_at`, `updated_at`;
- `superseded_at`, `superseded_by_archive_id`.

The one-to-one `turn_id` constraint prevents a second authoritative wrapper for the same Turn. Existing turns receive a deterministic compatibility round row during migration/bootstrap; no old narrative text is converted into facts.

### 2.2 `platform_narrative_round_participants`

Each row represents one required actor in a round:

- `round_id`, `campaign_id`, `player_id`, optional `character_id`;
- `participant_order`, `required`, `status`/derived progress;
- `created_at`, `updated_at` and archive supersede columns.

The primary/unique key is `(round_id, player_id)` for the current player-only MVP. The contract keeps actor/participant naming open for future NPC participants without implementing NPC simulation now.

### 2.3 `platform_narrative_decisions`

Each participant has at most one active primary decision:

- `id`, `round_id`, `turn_id`, `action_id`, `actor_id`;
- deterministic `decision_order` captured from `submitted_at ASC, action_id ASC`;
- status: `waiting`, `submitted`, `processing`, `resolved`, `skipped`, `needs_owner_attention`;
- `execution_id`, `claim_revision`, `applied_state_revision`, `outcome_id`;
- bounded failure/owner-attention code, timestamps, and archive supersede columns.

A successful claim fixes the current action/context input for that execution. The implementation may use the existing action `updated_at` plus the claimed run context snapshot rather than adding a second mutable action-history model; submit-after-claim must fail its Decision-status CAS.

Use unique constraints for `(round_id, actor_id)` and `(round_id, action_id)` for active rows. The raw action remains in `platform_actions`/the run snapshot for audit. Decision context reads the current action only; previous decision bodies are never assembled into later context.

### 2.4 `platform_narrative_working_facts`

Working facts are persistent append-only inputs to the current round:

- `id`, `campaign_id`, `round_id`, `decision_id`, optional `action_id`;
- `fact_kind`, bounded `payload_json`, `visibility`, `audience_actor_ids_json`;
- `authority`, `validation_status`, `source_kind`, `source_refs_json`;
- `based_on_state_revision`, `applied_state_revision`, `execution_id`, optional `event_id`;
- `created_at`, plus archive supersede metadata.

Fact rows are not Provider truth. Authoritative rows are inserted by deterministic server contributors inside the Decision apply transaction. Candidate rows are insertable only through the candidate port and remain `candidate`/`pending` until a later promotion task validates them.

The query contract separates:

```text
party       -> public/party-visible authoritative facts
actor_private(actor) -> party facts + facts addressed to actor
 gm_only/server_only -> owner/server facts and candidates as explicitly requested
```

No raw action, Provider prompt, or Narration prose is stored as a WorkingFact payload unless it is explicitly classified as an evidence/candidate source and kept out of actor mechanical context.

### 2.5 `platform_round_fact_sets` and `platform_round_facts`

`platform_round_fact_sets` has one active row per closed round:

- `id`, `round_id UNIQUE`, `campaign_id`, `source_state_revision`;
- `created_at`, `closed_at`, archive supersede metadata.

`platform_round_facts` is an immutable snapshot of the selected WorkingFacts and close-time contributors:

- `id`, `fact_set_id`, `round_id`, optional `decision_id`/`action_id`;
- fact payload/type, visibility/audience, authority, validation status;
- complete provenance/source refs, source execution/outcome/event and state revision;
- `created_at` and archive supersede metadata.

Closing copies/normalizes the already persisted WorkingFacts into this immutable set. The copy is deliberate: WorkingFacts remain the causal working log, while RoundFactSet is the replayable round memory boundary. Supersede metadata may be added during archive restore, but fact content is never edited in place.

No separate summary table is needed for MVP. `ProjectedRoundSummary` is a deterministic read/projection over the immutable active FactSet, so a process restart can regenerate it without relying on Provider memory or a second mutable source of truth.

## 3. Contracts and module boundaries

### 3.1 Shared contracts

Add a focused contract module (for example `packages/contracts/src/narrative.ts`) and export it from the contracts index. It should define strict schemas/types for:

- `NarrativeRound`, participant and Decision statuses;
- `WorkingFact`, `FactProvenance`, authority/source/validation enums;
- `RoundFactSet`, `RoundFact`;
- `ProjectedRoundSummary` and its audience variants;
- `RuntimeFactPromotionCommand/Result` and `ActorKnowledgeUpdateProposal` ports only.

Fact authority is a new domain enum. Do not reuse `runtime.ts`'s Context `Authority`, because that enum describes prompt-block authority and includes a different `ai_inferred` meaning.

`ProjectedRoundSummary` is structured and source-grounded, not an AI-generated prose summary. It includes `roundId`, `roundNumber`, `factSetId`, audience/actor, projected facts, source refs and source StateRevision.

### 3.2 Server modules

Create a focused server module (for example `server/src/modules/narrative-runtime/`) with:

- `NarrativeRoundRepository` for round/participant/decision lifecycle;
- `WorkingFactRepository` and `RoundFactSetRepository` for persistence and active/superseded reads;
- `NarrativeRoundService` for create/submit/claim/apply/skip/close transitions;
- `NarrativeWorkCoordinator`/worker for idempotent `narrative.round.work_available` wake-ups and one-in-flight-per-round scheduling;
- `FactProvenanceService`/deterministic contributors for mechanical outcome, runtime state, event, GM-authored and candidate rows;
- `RoundProjectionService.projectRoundFacts(roundId, audience, actorId?)`;
- `RuntimeFactRepository` and `ActorKnowledgeRepository` interfaces/ports with no production SQL implementation in this task;
- `NarrativeFactExtractor` and `RoundCloseContributor` interfaces with no new Provider orchestration/world simulation.

The service owns transactions. Repositories never open a top-level transaction. Outbox publication for `decision.claimed`, `decision.resolved`, `round.closed`, and next-round creation belongs to the same transaction as the corresponding authoritative mutation.

## 4. Decision context and next-round context

Extend `AiContextBuilder` with a decision-scoped option, without removing existing legacy DTOs:

```ts
{
  audience: 'party' | 'actor_private' | 'gm_only' | 'server_only',
  actorId: string,
  roundId: string,
  decisionId: string,
  stage: 'decision_interpretation' | 'decision_narration'
}
```

For `decision_interpretation`, source blocks are ordered as:

1. system/ruleset/campaign runtime policy;
2. stable current runtime state;
3. active previous-round projected summary for this actor/audience;
4. current-round WorkingFacts projected for this actor/audience;
5. current player's current input only;
6. resolution contract.

Do not include prior `platform_actions`, prior `recent-action` blocks, prior raw Provider messages, or prior Narration entries in this stage. The current input may be persisted in the claimed run snapshot for audit; that does not make it available to later actors.

The worker must build this context after claim, from the claimed input snapshot. It must not re-read a later action body while the Provider is running. A later Decision is not eligible while an earlier submitted Decision is unresolved or needs owner attention, even if a work signal for the later Decision arrives first.

For the next Turn/round, query the latest active closed RoundFactSet before the new round and add one `previous_round_summary` context block. `RoundProjectionService` performs visibility filtering before block rendering and emits `ContextTrace` source refs. A/B/C privacy is tested at the `AiContextBuilder` boundary, not reconstructed in the client.

Narration remains presentation-only. `NarrationService` can consume the decision's safe mechanical outcome and projected facts, but its prose is not fed back into mechanical context as truth. A future `NarrativeFactExtractor` may receive narration output and return `CandidateNarrativeFact[]`; this task does not call a second Provider to do so.

## 5. Fact provenance and authority rules

Use two independent dimensions:

```text
Fact authority:
  server_mechanical | runtime_state | event_evidence | ai_candidate

Evidence/source:
  state_transaction
  mechanical_resolved_outcome
  narrative_decision
  narration_result
  turn_or_narrative_event
  gm_authored
```

Examples:

- HP/effect/roll/state revision: `authority=server_mechanical` or `runtime_state`, `source=mechanical_resolved_outcome/state_transaction`, validation `authoritative`.
- GM-authored explicit runtime fact: `authority=runtime_state`, `source=gm_authored`, validation `authoritative` after the normal server mutation.
- Turn/outbox evidence: `authority=event_evidence`, source `turn_or_narrative_event`; it supports audit/projection but cannot bypass server validation.
- Narration statement or “NPC seems afraid”: `authority=ai_candidate`, source `narration_result`, validation `candidate`; it never becomes objective truth automatically.

The write path uses an allow-list matrix, not only pairwise forbidden checks:

```text
mechanical_resolved_outcome -> server_mechanical -> authoritative
state_transaction           -> runtime_state    -> authoritative
gm_authored                 -> runtime_state/event_evidence -> authoritative
turn_or_narrative_event     -> event_evidence   -> authoritative/verified
narration_result            -> ai_candidate/event_evidence -> candidate/pending
```

`narration_result -> runtime_state + authoritative` is invalid, as are any unlisted authority/source/status combinations. Candidate rows remain visible only to explicitly authorized audit/projection audiences.

Every fact has stable source refs such as `round:<id>`, `decision:<id>`, `execution:<id>`, `outcome:<id>`, `state-revision:<campaign>:<revision>`, or `event:<id>`. Source refs are bounded and contain no raw Provider text, credentials, URLs, or database JSON.

## 6. Round close and next round

`closeRound()` runs in one coordinator-owned transaction:

1. reload the active authoritative round and verify it is not superseded;
2. verify every required Decision is `resolved` or `skipped`;
3. return the existing FactSet on idempotent replay, otherwise allocate one close mutation/revision;
4. collect deterministic WorkingFacts and explicitly supplied candidate/evidence rows;
5. insert the immutable FactSet/facts with the close revision and full provenance;
6. mark the Round `closed` and mirror Turn `completed`;
7. create the automatic archive boundary from the closed Turn/Round/FactSet before creating the next Turn;
8. publish close/resolution events and create the next `Turn + NarrativeRound + participants` in the same transaction;
9. keep `ProjectedRoundSummary` as a deterministic projection over the just-created active FactSet.

No mechanics, DiceService call, or Provider call occurs in this transaction. If any close write fails, the coordinator rolls back the close revision, FactSet, round status mirror, outbox events and next round together.

The existing automatic archive path must capture the current round/FactSet boundary before the next round is created. Extend archive snapshot/watermarks with the current NarrativeRound and FactSet data, and update restore order so later narrative rounds, working facts and fact sets are superseded before the restored snapshot is reactivated. Older snapshots without the new fields remain readable through a compatibility fallback; they do not invent historical facts.

## 7. Archive and branch safety

Every new table that represents active runtime history has `superseded_at`/`superseded_by_archive_id` or is joined to a row that does. `ArchiveService.supersedeHistory()` must:

- supersede rounds/facts/fact sets and actions after the snapshot's active turn watermark;
- restore snapshot-contained active rows with their original content and new active markers;
- for the restored current Turn, mark snapshot-external actions superseded while retaining their audit/FK rows;
- leave later branch audit rows queryable only through all-history/admin paths;
- ensure projection, view, worker ordering and context queries join only active round/fact-set/fact/action rows.

A restored historical branch may advance the live StateRevision via `archive_restore`; it never rewinds the revision head. A stale later Decision/apply or Narration retry must fail/reject because its execution/round/fact rows are superseded.

## 8. Key trade-offs

- **Separate Round table plus Turn mirror:** preserves existing routes/archive compatibility while eliminating dual authority. Cost: every lifecycle write must be audited to ensure it passes through Round service.
- **Persistent WorkingFacts plus copied immutable FactSet:** duplicates structured fact rows, but gives crash recovery, causal audit, immutable close snapshots and replayable projection without mutable summaries.
- **Deterministic projection instead of stored prose summary:** avoids another mutable source and proves privacy. Cost: future summary compression can be added later without changing fact authority.
- **Decision-scoped Provider calls:** enables causal visibility and per-decision retries. Cost: more AI run records/provider calls than the legacy whole-turn path.
- **Async outbox/coordinator scheduling:** keeps action submit short and crash-safe, while the database—not event delivery—owns ordering. Cost: work is eventually started and requires idempotent worker wake-ups.
- **Ports for RuntimeFact/ActorKnowledge:** keeps this task bounded. Cost: long-term promotion and epistemic semantics remain a follow-up task.

## 9. Failure and rollback behavior

- Provider interpretation failure: no mechanical or WorkingFact write; Decision becomes `needs_owner_attention`, Round remains open.
- Stale apply: coordinator rejects before work; no effect, RollRecord, WorkingFact, outcome or close write; controlled retry/owner path records the failure mutation.
- Mechanical domain failure after partial in-transaction work: rollback all writes for that Decision, including facts and outbox; prior committed Decisions remain.
- Narration failure: mechanical Decision/WorkingFacts remain committed; only presentation retry state changes, with no new StateRevision or round lifecycle mutation. The worker records the terminal narration attempt and may schedule the next Decision; a narration retry never re-runs mechanics.
- Work signal duplication/crash: the worker re-queries the earliest eligible Decision and the one-in-flight guard makes duplicate delivery a no-op.
- Duplicate claim/apply/close: existing execution/outcome/fact set is returned; no second mechanics, revision or next round.
- Archive restore: later branch rounds, facts and actions are superseded atomically; active projection filters them even though audit rows and action-intent FKs remain.

## 10. Verification strategy

Use fresh temporary SQLite fixtures and test at the narrowest useful boundaries plus one vertical flow:

- contract tests for round/decision/fact/provenance/projection schemas;
- repository tests for lifecycle constraints, active/superseded filtering and immutable FactSet;
- scheduler tests proving outbox delivery is only a wake-up, one in-flight Decision per Round, earliest-order claim, blocked-prefix behavior and crash/replay idempotency;
- action/claim race tests proving pre-claim edits are observed and post-claim edits fail without changing the execution snapshot;
- service tests for sequential A→B apply, WorkingFacts persistence after reopening DB, failure rollback, duplicate replay and close idempotency;
- context tests proving no previous raw action/narration leakage and actor-private projection isolation;
- provenance tests proving deterministic facts vs evidence vs AI candidates;
- archive tests proving later round/fact-set supersede and restored branch projection;
- migration manifest/reset/rollback tests, including the 019 existing-schema FK/action-branch upgrade;
- existing AI/adjudication/turn/archive regressions.

Required repository checks remain:

```text
npm run typecheck
npm test -- --maxWorkers=1
npm run build
python ./.trellis/scripts/task.py validate .trellis/tasks/08-17-narrative-runtime-fact-memory
git diff --check
```
