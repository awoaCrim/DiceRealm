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

new RoundProjectionService(executor)
projection.projectWorkingFacts(roundId, audience, actorId?)
projection.projectRoundFacts(roundId, audience, actorId?)
projection.projectLatestClosedBefore(campaignId, roundNumber, audience, actorId?)

new NarrativeDecisionResolutionService(database, provider, outbox, ...)
service.resolveDecision(ctx, roundId, decisionId, { idempotencyKey })
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
- Every live transition must read and conditionally update `NarrativeRound.status` first; only then may the same transaction update the compatible Turn mirror. A stale or missing round transition rolls back the mirror update.
- `ensureForTurnIn` must reject a second non-closed round in the same campaign, while allowing an explicit compatibility repair for legacy completed Turns whose stale round row is still active. This repair must not fabricate historical facts.
- Claim/failure/apply paths must persist the resulting StateRevision and decision cursor on the Round. Failure must move the Round and applicable participant/decision to `needs_owner_attention` so a retry with a new execution key is possible.
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

`ai_candidate` may only be `candidate`, `pending` or `rejected`; it must never be inserted as `authoritative`.

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
| Duplicate decision execution/idempotency | Return stored execution/outcome; no reroll/reapply/duplicate facts |
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
- Close precondition, immutable FactSet, duplicate close and no duplicate next Round/revision.
- A/B/C private next-round `AiContextBuilder` test with `previous_round_summary` and trace refs.
- Archive restore test proving later Round/WorkingFact/FactSet rows are superseded and excluded from active projection.
- Decision-scoped Provider test proving one action intent, server mechanics, idempotent replay and no second roll.
- Existing turn, AI, narration retry, archive, migration, typecheck, build and projection regressions.

## 7. Wrong vs Correct

### Wrong

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
const claim = await rounds.claimDecision(campaignId, roundId, decisionId, executionId);
const proposal = await provider.stream(decisionContext(claim), hooks);

await db.transaction((tx) => mutations.mutateIn(tx, {
  campaignId,
  expectedRevision: claim.stateRevision,
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
}));
```

The provider sees only the current actor's projected context; each apply is a normal short CAS transaction; close only copies already committed facts into the immutable FactSet.
