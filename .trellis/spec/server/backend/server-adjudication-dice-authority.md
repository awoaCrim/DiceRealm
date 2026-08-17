# Server Adjudication and Dice Authority

## Scope

This contract owns the boundary between Provider output, server mechanical resolution, and post-commit narration. It applies to the semantic turn-resolution path introduced with migration `016_server_adjudication_dice.sql`.

The goal is not a complete rules engine. The server owns the minimum adjudication slice needed to make combat and checks auditable, deterministic in ordering, safe to retry, and independent from Provider-authored numeric mechanics.

## Authority boundary

Provider output is parsed as an `ActionIntentProposal` from `packages/contracts/src/adjudication.ts`. The proposal may select semantic fields such as:

- `actionType`, `actionRef`, `targetIds`;
- declared approach and desired outcome;
- resource choices and fallback policy.

`resourceChoices` is retained as semantic metadata for future server-authorized resources. In the current v0.1 slice, raw Provider values such as `advantage` or `disadvantage` are ignored; they never select a RollPlan state. Only a server-owned action definition or validated server context may derive mechanical advantage.

The proposal must not contain attack/save modifiers, DC/AC, damage formulas or amounts, raw dice, totals, critical results, or direct combat commands. The schema is strict, and `TurnResolutionValidator` rejects a semantic proposal that also carries legacy mechanical state changes, creation payloads, or Provider dice results.

The server creates the normalized `ActionIntent` and supplies campaign, actor, target, source-input, and `basedOnStateRevision` values. Provider data is never branded as a validated state change or mechanical outcome merely because it passed shape parsing.

Owner/debug combat commands remain a separate permissioned HTTP path. They must not reuse the Provider proposal contract or provide a back door from Provider output to the combat materializer.

## Mechanical resolution flow

The semantic path is split into these stages:

```text
party-safe intent context
  -> Provider ActionIntentProposal[]
  -> schema + campaign/actor/target validation
  -> normalized ActionIntent records
  -> server AdjudicationService
  -> locked RollPlan (when a roll is required)
  -> DiceService / RollRecord
  -> ResolvedOutcome and server-owned effects
  -> one CampaignMutationCoordinator transaction / StateRevision
  -> separate NarrationService call
```

`TurnRepository.listActionsByTurn()` defines deterministic ordering as `submitted_at ASC, id ASC`. All intents for one turn are adjudicated in that order. The first slice is all-or-nothing: an unsupported, stale, or otherwise unsafe intent aborts the coordinator-owned mechanical transaction with a controlled error, so no partial RollRecord, HP change, outcome, or revision remains.

The transaction is owned by the caller (`AiResolutionService`) and includes intent, decision, plan, record, outcome, runtime effect, Turn completion, automatic archive, `turn.resolved`, next-turn creation, and revision writes. A retry with the same execution identity reuses the committed mechanical outcome and never rerolls, reapplies effects, or advances another revision. This is the only authoritative checkpoint for the resolved Turn lifecycle.

## Rules and dice

`AdjudicationService` owns the supported rules definitions and derives target values, modifiers, damage expressions, healing, and HP effects from validated server data. Unsupported or open-ended actions return a controlled `GM_ADJUDICATION_REQUIRED` path; Narration must not invent a DC or mechanical result.

`DiceService` is server-only and receives an injectable RNG in tests. It accepts only the allowlisted dice expressions used by the rules slice. Advantage/disadvantage selection and critical handling are server decisions: Provider `resourceChoices` cannot select them, while a server-owned `ActionDefinition.advantageState` may do so when a future rules/resource policy authorizes it.

A `RollPlan` is fully constructed and hash-locked before the RNG is read. The plan records the roll kind, server modifier breakdown, target, ruleset, state revision, execution identity, and lock time. The resulting immutable `RollRecord` records raw and selected dice, total, target/result, mutation identity, and state revision. RollPlan/RollRecord rows are audit data, not Provider input.

## Narration boundary and visibility

Narration is a separate Provider stage (`AiPrompt.stage = 'narration'`). `NarrationService` receives a server-built `NarrationRequest` containing only:

- the submitted action summaries needed to describe the turn;
- a player-observable scene projection;
- the committed `ResolvedOutcome`;
- visibility-projected mechanical effects (`kind`, `targetId`, `delta`, `reason`) whose targets are visible to the narration audience;
- safe observable roll data (kind, selected dice, total, result);
- the allowed public/private audience scope.

It must not receive GM-only context blocks, unrelated player-private knowledge, raw AI context/debug, credentials, target/DC/modifier breakdowns, or full Owner-only RollRecord data. `NarrationOutput` may contain readable public narrative and validated private updates only; it cannot create state changes, rolls, targets, DCs, or other mechanical effects.

Narration failure is persisted as a retryable narration attempt while the mechanical outcome, completed Turn lifecycle, automatic archive, next waiting Turn, and StateRevision remain committed. Retrying narration uses the same mechanical run/outcome and does not call `DiceService` or the mutation coordinator again. Narration finalize may only write presentation entries and run/attempt metadata; it must not complete the Turn, create an archive/next Turn, publish `turn.resolved`, or allocate another runtime revision. Player routes continue to rely on the existing server-side entry projection; Owner-only debug data remains behind Owner authorization.

## Persistence and startup boundary

Migration 016 adds explicit storage for action intents, adjudication decisions, immutable roll plans, roll records, resolved outcomes, narration attempts, and the run-kind/parent linkage needed to distinguish mechanical execution from legacy turn resolution.

Fresh/temp fixtures use the frozen `PHASE3_APPROVED_MIGRATION_FILENAMES` set. Ordinary startup also accepts only that exact set and does not infer approval from the migration directory or apply arbitrary pending migrations. A database missing migration 016 fails closed; it is not silently upgraded by normal startup. The separate retired-rule compatibility bridge may remove the exact old `011_rule_sources.sql` table state with a pre-migration SQLite backup, but it never applies 016.

## Required checks

- Keep Provider proposals free of numeric mechanical authority and direct combat commands.
- Keep `resourceChoices` from directly selecting advantage/disadvantage; test the server-owned derivation path separately.
- Keep all formal state changes behind server validation and preserve the existing campaign CAS/ledger seam.
- Assert that mechanical commit leaves the Turn lifecycle and `StateRevision` consistent even when Narration Provider execution fails.
- Preserve Player/Owner entry projection and archive superseded semantics.
- Test stale revisions, unsupported actions, plan hashing, replay/idempotency, narration visibility, narration retry, migration admission, and rollback with temporary SQLite databases.
- Never use repository-root or configured development databases as test fixtures.
