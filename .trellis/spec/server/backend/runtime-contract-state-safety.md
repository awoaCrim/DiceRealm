# Runtime Contract & State Safety

## 1. Scope / Trigger

Use this contract for changes that cross the AI context, authoritative campaign state, database migration, turn resolution, combat, character, world-fact, membership, or archive layers.

The runtime protocol uses an independent per-campaign revision head and an append-only mutation ledger. It prevents a delayed Provider result from being applied to a newer campaign state and keeps context visibility separate from persisted turn/world visibility.

## 2. Signatures

```ts
new CampaignMutationCoordinator(database: DatabasePort)

coordinator.run<T>(
  request: {
    campaignId: string;
    expectedRevision?: number;
    mutationId: string;
    causeType: string;
    causeId?: string;
  },
  work: (context: {
    tx: QueryExecutor;
    campaignId: string;
    previousRevision: number;
    stateRevision: number;
    mutationId: string;
    causeType: string;
    causeId?: string;
  }) => Promise<T>,
): Promise<{
  replayed: boolean;
  result?: T;
  revision: StateRevision;
}>
```

Use `mutateIn(tx, request, work)` when the caller already owns the outer transaction, such as AI claim, formal apply, and archive restore. The coordinator is the only seam that allocates a new runtime revision.

The database contract is:

```sql
platform_campaign_state_heads(
  campaign_id PRIMARY KEY,
  revision >= 0,
  updated_at
)

platform_campaign_state_revisions(
  campaign_id,
  revision > 0,
  mutation_id UNIQUE PER CAMPAIGN,
  cause_type,
  cause_id,
  created_at
)

platform_ai_runs(
  expected_state_revision INTEGER NULL,
  applied_state_revision INTEGER NULL
)
```

Migration `015_campaign_state_revision.sql` initializes existing campaigns at revision `0`. Revision `0` is a legacy baseline and has no fabricated ledger row. New campaigns insert their head at revision `0` in the same transaction as campaign and owner membership creation.

## 3. Contracts

### State and idempotency

- A mutation without `expectedRevision` advances the current head by exactly one.
- A mutation with `expectedRevision` must match the current head; otherwise the coordinator throws `STALE_STATE_REVISION` before invoking business work.
- The database CAS is `UPDATE ... WHERE campaign_id = ? AND revision = ?`; application-level pre-checks are not sufficient.
- Duplicate `(campaign_id, mutation_id)` with the same cause is an idempotent replay and does not invoke business work or advance the head.
- Reusing a mutation ID with a different cause is `MUTATION_REPLAY`.
- Missing state head is `STATE_CONFLICT`; do not infer or silently recreate one during a normal business mutation.
- Any callback failure rolls back the head, ledger row, and all business writes in the same transaction.

### Context contracts

`Authority` and `ContextVisibility` are independent fields.

```text
Authority: system | ruleset | campaign | gm | world | scene | actor | ai_inferred
ContextVisibility: server_only | gm_only | actor_private | party | campaign | public
```

`ContextBlock` must contain `id`, `type`, `content`, `sourceRefs`, `authority`, `visibility`, and `priority`; `estimatedTokens` and bounded `audienceActorIds` are optional. `sourceRefs` use a stable namespaced form such as `world-fact:<id>` and never contain raw Provider content, credentials, URLs, or database JSON.

`AiContextBuilder` constructs blocks first, filters them before rendering, records `ContextTrace`, then renders the existing `AiPrompt.messages`. Provider calls remain single-call. Server-only policy may be included in server-rendered actor/party context; GM-only and actor-private facts must still be denied unless the audience is authorized and the actor is in the fact's scope.

Persisted visibility remains `public | player_private | owner_only`. Map it at the context boundary to `public | actor_private | gm_only`; do not rename the persisted enum.

### AI lifecycle

1. Claim changes `locked` to `resolving` through the coordinator and stores the post-claim revision in `expected_state_revision` and `context_json.stateRevision`.
2. Provider invocation occurs outside the database transaction and happens once per claimed execution.
3. Formal apply performs an expected-revision CAS. Only after it succeeds may the transaction apply typed state changes, entries, interactions, run success, turn completion, archive creation, formal events, and next-turn creation. For semantic Intent resolution, the mechanical checkpoint owns the same Turn completion/archive/next-turn lifecycle; the later Narration finalize is presentation-only.
4. Successful formal apply stores the new head in `applied_state_revision`; the resolved Turn lifecycle must be part of that same revision.
5. A stale result writes no formal entries, state changes, archive, or next turn. The controlled failure path marks the run failed, moves the turn to `needs_owner_attention`, emits preview failure, and records its own authoritative failure mutation.
6. Legacy runs with `expected_state_revision IS NULL` are audit/display-only and cannot formally apply.

### Mutation classification

Route these through the coordinator:

- campaign member join;
- player action create/update and owner turn creation;
- character create/update/review/approve/reject;
- world-fact create/update/delete;
- combat start and owner commands;
- AI claim, formal apply, and controlled failure state;
- archive restore.

Do not advance the runtime revision for preview deltas, debug metadata, Outbox sequence allocation by itself, login/session/security audit, campaign settings metadata-only changes, or manual archive snapshot creation. Internal `createIn`/`applyIn` seams called inside a coordinator-owned formal transaction must not open a nested transaction or allocate a second revision.

### Typed StateChange boundary

`stateChangeSchema` is a discriminated union for `character`, `world`, `quest`, and `combat`. Character and world patches are strict allowlists. Combat state changes are command-shaped and are revalidated by `CombatAiAdapter` against the existing strict combat command schema. Unknown kinds, cross-campaign targets, invalid fields, and unsupported commands fail before persistence.

The Provider-facing value is a `ProposedStateChange`. The formal materializer seam must receive only a `ValidatedStateChange` produced after schema, campaign ownership, visibility, and domain checks:

```ts
validator.validate(campaignId, providerOutput): Promise<ResolvedOutcome>
materializer.applyAll(
  tx,
  campaignId,
  outcome.stateChanges, // ValidatedStateChange[] only
  actorUserId,
)
```

`isValidatedStateChange()` is a runtime fail-closed guard in addition to the TypeScript brand. The `applyProposals()` compatibility seam may accept unknown proposal input only when it parses the same strict schema and then enters the same formal guarded path; the AI formal-apply path uses `ResolvedOutcome` directly. `markStateChangeValidated()` is a server-owned validator helper, not a general adapter or Provider API.

### Proposal / resolved outcome boundary

The single Provider call returns an `AiResolutionProposal` (the backward-compatible `TurnResolution` name may remain at transport boundaries). It is not an authoritative result:

- `diceResults` may remain in the proposal shape for transport compatibility, but any non-empty Provider collection is rejected with `AI_OUTPUT_INVALID`, path `['diceResults']`, code `provider_dice_results_not_allowed`;
- `resolvedOutcomeSchema` is shape-only and requires `diceResults: []`; parsing it does not create a validated state-change brand;
- `TurnResolutionValidator` performs campaign/domain checks and is the only application seam that creates the validated `ResolvedOutcome` used by formal apply;
- formal apply never writes Provider-supplied formula/total values as `dice_result` entries. Mechanical results must be generated by a future server-owned Dice/Rules boundary.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Missing/invalid mutation identifiers or negative expected revision | `VALIDATION_ERROR`; no callback and no revision |
| Missing campaign state head | `STATE_CONFLICT`; no inferred head |
| Expected revision differs from current head | `STALE_STATE_REVISION`; business callback is not called |
| Duplicate mutation ID with same cause | replay result; no callback, ledger duplicate, or second revision |
| Duplicate mutation ID with different cause | `MUTATION_REPLAY` |
| Callback/provider formal failure | transaction rollback; controlled run/turn failure path where applicable |
| Provider proposal contains non-empty `diceResults` | `AI_OUTPUT_INVALID`; diagnostic path `['diceResults']`, code `provider_dice_results_not_allowed`; no formal writes |
| Formal outcome schema contains non-empty `diceResults` | Schema rejection; formal outcome is never created |
| Unvalidated StateChange reaches `applyAll()` or a combat adapter | `AI_OUTPUT_INVALID`; runtime brand guard rejects it before mutation |
| Legacy AI run with NULL expected revision | `STATE_CONFLICT`; no formal apply |
| Unauthorized context block | omitted from Provider messages and trace entry has `included: false`, `reason: visibility_denied` |
| Unknown StateChange kind/field or cross-campaign target | `AI_OUTPUT_INVALID`; no formal state write |
| Archive restore from old snapshot | new monotonic revision; never restore the live head to the snapshot's old revision |

## 5. Good / Base / Bad Cases

- **Good:** claim at head `N`, store expected `N+1`, a formal result CASes `N+1 -> N+2`, and every formal table/event/archive/Turn-lifecycle write commits with that transaction; Narration may then add presentation entries without a third runtime revision.
- **Good:** actor context includes a player's scoped fact, excludes another player's private fact and GM-only secret, and leaves a stable denial trace.
- **Base:** existing campaigns start at revision `0`; existing AI runs keep NULL revision columns and remain readable but unappliable.
- **Base:** a manual archive snapshot does not advance revision; restoring it later advances the current live head by exactly one.
- **Bad:** use Outbox sequence, AI-run sequence, archive version, or `campaigns.updated_at` as the runtime revision.
- **Bad:** read expected revision, write business tables, and update the head in separate transactions.
- **Bad:** let Provider output supply arbitrary `{ entity, field, value }` patches or let a denied block reach `AiPrompt.messages`.

## 6. Tests Required

- Contract tests for authority/audience independence, bounded source refs, strict context blocks, typed proposal StateChange branches, shape-only formal outcome parsing, empty formal dice, unknown kinds, and invalid patch fields.
- Proposal/resolved boundary tests proving non-empty Provider dice is rejected, formal schema parsing does not mint `ValidatedStateChange`, and an unvalidated change cannot enter materializer/combat writes.
- Coordinator tests for revision allocation, concurrent expected-revision CAS, duplicate replay, cause mismatch, missing head, callback rollback, and metadata-only no-op classification.
- Context-builder fixture with a GM-only secret, actor A private knowledge, and actor B private knowledge; assert Provider messages and trace inclusion/denial.
- AI resolution tests for claim expected revision, successful applied revision, stale Provider result, NULL legacy run rejection, formal rollback, and same-key replay with no duplicate entries/archive/turn.
- Service tests proving authoritative character/world/combat/turn/member/archive mutations advance the head once per logical transaction.
- Fresh/temp SQLite migration tests for revision-0 head initialization and preservation of legacy AI NULL columns.
- `npm test -- --maxWorkers=1`, `npm run typecheck`, `npm run build`, and `git diff --check`; tests must not read or mutate repository-root databases.

## 7. Wrong vs Correct

### Wrong

```ts
const run = await loadAiRun(runId);
await materializer.applyAll(db, campaignId, run.stateChanges);
await db.execute('UPDATE campaigns SET updated_at = ? WHERE id = ?', [now, campaignId]);
```

This has no independent expected revision, no CAS, no single authoritative transaction, and allows a delayed Provider result to overwrite newer state.

### Correct

```ts
await database.transaction((tx) => coordinator.mutateIn(tx, {
  campaignId,
  expectedRevision: run.expected_state_revision,
  mutationId: `ai-formal:${run.id}`,
  causeType: 'ai_formal_apply',
  causeId: run.id,
}, async ({ stateRevision }) => {
  await materializer.applyAll(tx, campaignId, resolution.stateChanges, ownerId);
  await entries.writeIn(tx, ...);
  await runs.markSucceeded(tx, run.id, resultJson, rawDebugJson, now, stateRevision);
  await turns.markCompleted(run.turn_id, now);
  await archives.createAutomatic(tx, campaignId, run.turn_id, ownerId, archiveId);
  // Semantic path also creates the next waiting turn in this same callback.
}));
```

The callback, head CAS, ledger row, formal writes, and applied revision commit or roll back together.

For the AI output boundary, the equivalent safe flow is:

```ts
const proposal = aiResolutionProposalSchema.parse(providerOutput);
const outcome = await validator.validate(campaignId, proposal);
// outcome.stateChanges is branded only here; outcome.diceResults is always []
await materializer.applyAll(tx, campaignId, outcome.stateChanges, ownerId);
```

Do not pass `proposal.stateChanges` directly to the materializer, do not let `resolvedOutcomeSchema.parse()` manufacture the validation brand, and do not persist `proposal.diceResults` as formal game facts.
