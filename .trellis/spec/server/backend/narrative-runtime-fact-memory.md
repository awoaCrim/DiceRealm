# Narrative Runtime & Fact Memory

## 1. Scope / Trigger

Use this contract when changing `NarrativeRound`, decision-scoped resolution, persistent `WorkingFact`, `RoundFactSet`, actor/audience projection, or archive restore of narrative runtime history.

This boundary is separate from the legacy whole-turn AI path. `platform_turns` remains a compatibility action container, while `platform_narrative_rounds` is the authoritative live round lifecycle.

## 2. Signatures

```ts
new NarrativeRoundService(database, outbox, mutations?)

service.ensureForTurnIn(tx, campaignId, turnId)
service.claimDecision(campaignId, roundId, decisionId, executionId?)
service.claimDecisionIn(tx, {
  campaignId, roundId, decisionId, executionId, stateRevision,
})
service.recordWorkingFactIn(tx, input)
service.markDecisionResolvedIn(tx, {
  campaignId, roundId, decisionId, outcomeId?, stateRevision,
})
service.closeRound(campaignId, roundId)
mutations.latestCompatibleRevisionIn(tx, campaignId, baseRevision, allowedCauseTypes)

new RoundProjectionService(executor)
projection.projectWorkingFacts(roundId, audience, actorId?)
projection.projectRoundFacts(roundId, audience, actorId?)
projection.projectLatestClosedBefore(campaignId, roundNumber, audience, actorId?)

new NarrativeDecisionResolutionService(database, provider, outbox, ...)
service.resolveDecision(ctx, roundId, decisionId, { idempotencyKey })
service.resolveDecisionInternal(campaignId, roundId, decisionId, { idempotencyKey })

new NarrativeWorkRuntime(database, coordinator, worker, intervalMs?)
runtime.start()
runtime.stop()
runtime.runOnce()
OutboxRepository.listUnpublishedByType(eventType, limit?)
```

Persistence is split across:

```text
platform_narrative_rounds
platform_narrative_round_participants
platform_narrative_decisions
platform_narrative_working_facts
platform_narrative_round_fact_sets
platform_narrative_round_facts
```

Migration `017_narrative_runtime_fact_memory.sql` is part of the frozen approved migration set and must be listed in both the source manifest and approved migration filenames.

## 3. Contracts

### Round and Decision

- Round lifecycle: `collecting | ready | processing | needs_owner_attention | closed`.
- Decision lifecycle: `waiting | submitted | processing | resolved | skipped | needs_owner_attention`.
- One active Round per Turn (`turn_id` unique); one primary Decision per actor per Round.
- Decision order is `platform_actions.submitted_at ASC, platform_actions.id ASC`.
- Each decision claim/apply is a short transaction. Provider calls happen outside transactions.
- `platform_turns.status` is a compatibility mirror for live paths; new lifecycle code must not create an independent status authority.
- `narrative.round.work_available` is only a wake-up signal. A worker must re-query the earliest eligible Decision by `submitted_at ASC, action_id ASC`; outbox delivery order, duplication, and delay never define causal order.
- Production `NarrativeWorkRuntime` polls active unpublished `narrative.round.work_available` rows, never marks `published_at` (that column remains part of the SSE/outbox surface), and uses process-local handled-event state plus resolver idempotency for restart/replay safety. Each Provider attempt uses `narrative-work:<eventId>:<candidateDecisionId>`; the resolver-owned claim/CAS remains the duplicate-work authority.
- `NarrativeWorkCoordinator.peekNext()` is the production worker query seam. `claimNext()` is compatibility/test-only and must not run before `NarrativeDecisionResolutionService.resolveDecisionInternal()`.
- `collecting` remains submit-capable while Decisions independently move through `submitted/processing/resolved`. Claim does not require `round.status=processing`; one Round may have at most one `processing` Decision at a time.
- The claim revision anchors the world-state snapshot, not the input queue. A `turn_action_submit` mutation may advance the campaign revision while a Provider is running; apply may rebase to the latest revision only when every intervening ledger row has `cause_type='turn_action_submit'`. Any other intervening mutation is `STALE_STATE_REVISION`.
- Every live transition must read and conditionally update `NarrativeRound.status` first; only then may the same transaction update the compatible Turn mirror. A stale or missing round transition rolls back the mirror update.
- `ensureForTurnIn` must reject a second non-closed round in the same campaign, while allowing an explicit compatibility repair for legacy completed Turns whose stale round row is still active. This repair must not fabricate historical facts.
- Claim/failure/apply paths must persist the resulting StateRevision and decision cursor on the Round. Failure must move the Round and applicable participant/decision to `needs_owner_attention` so a retry with a new execution key is possible.
- A `processing` Decision claim uses its `updated_at` as a five-minute worker lease. The process-local lease sweeper runs independently of HTTP/Provider traffic and must CAS-expire an abandoned claim to `needs_owner_attention`, move the participant/Round/Turn mirror to the same attention state, and fail any still-running AI run with `WORKER_CLAIM_EXPIRED`. A committed mechanical outcome is a recoverable checkpoint and must not be expired; a late Provider result must fail the Decision/apply identity guard. The sweeper only recovers claims; the outbox-to-Provider work consumer remains a separate transport concern.
- WorkingFacts are append-only within an open round; a closed or superseded round is fail-closed for new facts and active projection. Idempotent FactSet replay must verify campaign ownership before returning an existing set.

### Fact authority and provenance

`FactAuthority` is independent from ContextBlock `Authority`:

```text
server_mechanical | runtime_state | event_evidence | ai_candidate
```

`FactSourceKind` supports:

```text
state_transaction
mechanical_resolved_outcome
narrative_decision
narration_result
turn_or_narrative_event
gm_authored
```

Every fact stores bounded source refs plus round/decision/action/execution/outcome/event and based/applied StateRevision fields. Raw action bodies, Provider prompts and Narration prose are not WorkingFact truth.

`ai_candidate` may only be `candidate`, `pending` or `rejected`; it must never be inserted as `authoritative`. Fact writes use an allow-list matrix: `mechanical_resolved_outcome -> server_mechanical -> authoritative`, `state_transaction -> runtime_state -> authoritative`, `gm_authored -> runtime_state/event_evidence -> authoritative`, `turn_or_narrative_event -> event_evidence -> authoritative/verified`, and `narration_result -> ai_candidate/event_evidence -> candidate/pending`. Unlisted combinations, including `narration_result -> runtime_state + authoritative`, fail closed.

### Visibility and projection

Persisted visibility remains `public | player_private | owner_only`. Context projection maps it to:

```text
party              -> public authoritative facts
actor_private(A)   -> public facts + player_private facts addressed to A
gm_only/server_only -> audit view; candidates may be inspected explicitly
```

Actor/party projections exclude candidate facts and superseded rows. `ProjectedRoundSummary` is deterministic structured data derived from the active immutable FactSet; it is not an AI prose summary.

### Next-round context

Decision-scoped context must contain only:

```text
stable runtime
+ previous_round_summary
+ current-round WorkingFacts
+ current player input
+ resolution contract
```

Previous raw actions, previous Provider messages and previous Narration entries are not reused as context. `AiContextBuilder` filters blocks before rendering and records stable `ContextTrace.sourceRefs`.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Second active Round for one Turn | DB uniqueness/state conflict; do not create another authority |
| Decision has no submitted action | `STATE_CONFLICT`; no claim/revision |
| Decision claim/apply has stale expected revision | `STALE_STATE_REVISION`; no mechanics/facts/outcome |
| Only `turn_action_submit` revisions occur after a claim | Rebase apply CAS to the latest revision; preserve the claimed world/action snapshot |
| Any non-input mutation occurs after a claim | `STALE_STATE_REVISION`; no mechanics/facts/outcome |
| Duplicate decision execution/idempotency | Return stored execution/outcome; no reroll/reapply/duplicate facts |
| Outbox signal arrives for a later Decision while an earlier submitted Decision is unresolved/needs attention | Do not claim the later Decision; preserve the blocked prefix |
| Duplicate/replayed `work_available` row | Re-query the earliest candidate; resolver idempotency/CAS permits at most one Provider execution per Decision |
| Runtime sees a stale signal for a closed/resolved/owner-attention prefix | Consume the wake-up without Provider work; a later valid transition must emit a fresh signal |
| A second worker claims while another Decision in the same Round is processing | No-op/`STATE_CONFLICT`; keep one in-flight Decision per Round |
| A processing claim is older than the worker lease without a committed outcome | CAS-expire it to `needs_owner_attention`, fail its running AI run, and keep later Decisions blocked |
| A processing claim is older than the worker lease but already has a committed mechanical outcome | Do not expire it; replay must recover Decision/run metadata without a second mechanics revision |
| Action edit races with claim | Edit wins before claim and is snapshotted; after claim, edit fails its Decision-status/CAS check |
| Required Decision unresolved at close | `STATE_CONFLICT`; Round remains open |
| Duplicate Round close | Return existing FactSet; no second close revision/next Round |
| `ai_candidate` with authoritative status | `AI_OUTPUT_INVALID`; transaction rolls back |
| `player_private` fact without actor audience | `VALIDATION_ERROR` |
| WorkingFact append after Round is `closed` or superseded | `STATE_CONFLICT`; do not mutate the fact log |
| Candidate/event evidence projected to actor context without authoritative validation | Exclude from actor/party context |
| Superseded Round/fact queried through active projection | Return no row/fact; retain all-history audit visibility |
| Existing FactSet replay with a round from another campaign | `NOT_FOUND`/`STATE_CONFLICT`; never return the FactSet |
| Archive restore of old v2 snapshot without `narrative` field | Restore legacy Turn state without inventing facts |

## 5. Good / Base / Bad Cases

- **Good:** A claims at revision N; B submits while A's Provider is running; A applies at N+2 because the only intervening revision is `turn_action_submit`, while A still uses its immutable claim snapshot.
- **Good:** A applies one decision at revision N+2; B's decision context contains A's public structured WorkingFact but not A's raw input.
- **Good:** C's private fact has `visibility=player_private`, `audienceActorIds=[C]`; C's next-round summary includes it while A/B summaries do not.
- **Good:** Round close copies active WorkingFacts into one immutable FactSet and creates the next Turn/Round in the same close transaction.
- **Base:** Legacy `resolveTurn()` remains readable and finalizes a compatibility Round/FactSet; new clients can call decision-scoped resolution without a whole-round transaction.
- **Bad:** Keep all prior action bodies in the next Provider prompt and rely on the model to hide private information.
- **Bad:** Let an AI statement such as “the NPC is afraid” enter `runtime_state` as an authoritative fact without candidate validation.
- **Bad:** Re-run `MechanicalResolutionService` or `DiceService` during Round close.
- **Bad:** Restore a historical branch while leaving later RoundFactSet rows active in projection queries.

## 6. Tests Required

- Fresh SQLite migration test for migration 017 and manifest admission.
- Round/participant/decision uniqueness, deterministic ordering, lifecycle transitions and Turn compatibility mirror.
- Sequential A→B decision test: B sees A WorkingFact but not A raw action/private prompt/Narration.
- WorkingFact persistence after database reopen, provenance source refs and StateRevision assertions.
- Candidate authority rejection and actor/party projection filtering.
- Close precondition, immutable FactSet, duplicate close and no duplicate next Round/revision; automatic archive is captured from the closed round before the next Round is created.
- A/B/C private next-round `AiContextBuilder` test with `previous_round_summary` and trace refs.
- Archive restore test proving later Round/WorkingFact/FactSet rows are superseded and excluded from active projection.
- Decision-scoped Provider test proving one action intent, server mechanics, idempotent replay and no second roll.
- Async coordinator tests proving work signals only wake the worker, one in-flight Decision per Round, earliest-order/blocked-prefix scheduling, claim-lease expiry/late-result fencing, crash/replay idempotency, and submit/claim action snapshot CAS.
- Production composition/startup test proving the composed outbox runtime starts and stops with the server; vertical A-only submit test must show no Owner resolve call, exactly one Provider call, one resolved Decision, mechanical outcome/WorkingFact persistence, and later participants still waiting.
- Existing turn, AI, narration retry, archive, migration, typecheck, build and projection regressions.

## 7. Wrong vs Correct

### Wrong

```ts
// A coordinator claims first, then the resolver attempts a second claim with a new execution id.
const item = await coordinator.claimNext(campaignId, roundId);
await resolver.resolveDecisionInternal(campaignId, roundId, item.decision.id, {
  idempotencyKey: `work:${item.decision.id}`,
});
```

This creates two competing execution identities and can reject the real Provider run as already owned.

```ts
// Long transaction around the entire round and raw history in the next prompt.
await db.transaction(async (tx) => {
  for (const action of allActions) {
    await provider.stream({ messages: [...allPreviousActions] }, hooks);
    await resolveMechanics(tx, action);
  }
  await closeRound(tx);
});
```

This holds a transaction across Provider work, exposes raw history, prevents crash-safe per-decision progress, and makes retry semantics ambiguous.

```ts
// Also wrong: use the legacy Turn mirror as the live lifecycle authority.
if (turn.status === 'waiting_for_actions') {
  await turns.lockTurn(turn.id, now);
  await rounds.markReady(round.id, now);
}
```

A failed or stale Round transition can then leave Turn and Round disagreeing, and a legacy completed Turn can accidentally keep an active round visible.

### Correct

```ts
// The outbox row only wakes the runtime; resolver owns claim + execution identity.
const candidate = await coordinator.peekNext(campaignId, roundId);
if (candidate?.status === 'submitted') {
  await resolver.resolveDecisionInternal(campaignId, roundId, candidate.id, {
    idempotencyKey: `narrative-work:${eventId}:${candidate.id}`,
  });
}

const claim = await rounds.claimDecision(campaignId, roundId, decisionId, executionId);
const proposal = await provider.stream(decisionContext(claim), hooks);

await db.transaction(async (tx) => {
  const applyExpectedRevision = await mutations.latestCompatibleRevisionIn(
    tx, campaignId, claim.stateRevision, ['turn_action_submit'],
  );
  await mutations.mutateIn(tx, {
    campaignId,
    expectedRevision: applyExpectedRevision,
    mutationId: `narrative-ai-apply:${executionId}`,
    causeType: 'narrative_decision_apply',
    causeId: executionId,
  }, async ({ stateRevision }) => {
  const outcome = await mechanics.resolveDecisionIn(tx, {
    ...decisionInput,
    proposal,
    appliedStateRevision: stateRevision,
  });
  await recordAuthoritativeWorkingFacts(tx, outcome);
  await rounds.markDecisionResolvedIn(tx, {
    campaignId, roundId, decisionId,
    outcomeId: outcome.outcomeId,
    stateRevision,
  });
  });
});
```

The provider sees only the current actor's projected context; each apply is a normal short CAS transaction; close only copies already committed facts into the immutable FactSet.
