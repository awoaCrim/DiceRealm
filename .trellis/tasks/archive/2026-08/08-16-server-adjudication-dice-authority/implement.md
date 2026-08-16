# Implementation plan: 服务端裁定与骰子权威 v0.1

## Phase 0 — Baseline and scope lock

- [x] Read the current Runtime Contract, AI structured-output, turn-entry projection, database/migration and cross-layer specs.
- [x] Record the preserved multi-action turn semantics: one Intent per submitted action, ordered by `submitted_at ASC, action.id ASC`.
- [x] Inventory all current Provider-facing combat numeric fields and all Owner/debug direct command entry points.
- [x] Confirm current character/runtime data available to the minimal rules fixture; list unsupported fields that must produce `GM_ADJUDICATION_REQUIRED`.
- [x] Confirm migration 016 must use the explicit migration/startup boundary and temporary SQLite fixtures.
- [x] Keep existing `.mcp.json` and unrelated worktree changes untouched.

## Phase 1 — Authority and contract boundaries

- [x] Move `markStateChangeValidated` construction behind a server-owned factory while retaining the shared opaque type/guard needed by materializers.
- [x] Add proposed/validated validation boundaries for world-fact creation, encounter start, interaction request and ResolvedOutcome members.
- [x] Expand `ActionIntent` with semantic fields, target references and `basedOnStateRevision`; reject mechanic-bearing fields.
- [x] Add `ActionIntentProposal`, `AdjudicationDecision`, `RollPlan`, `RollRecord`, `NarrationRequest` and `NarrationOutput` schemas/types.
- [x] Replace Provider-facing numeric combat commands with semantic action references/choices; keep Owner/debug numeric commands on their separate route.
- [x] Add contract tests for unknown mechanic fields, cross-campaign targets, unsupported action types and proposal/formal brand separation.

## Phase 2 — Persistence and migration 016

- [x] Design and add migration 016 for action intents, adjudication decisions, immutable roll plans, roll records, resolved outcomes and narration attempts.
- [x] Add explicit execution/run kind and parent linkage where existing `platform_ai_runs` is reused; do not overload legacy resolution rows silently.
- [x] Add repository contracts with campaign/turn ownership, unique execution/idempotency keys and state revision columns.
- [x] Update migration manifest, fresh schema inventory, temporary fixtures and explicit migration tests.
- [x] Verify ordinary startup does not auto-apply migration 016 to arbitrary pending databases.

## Phase 3 — Dice core

- [x] Implement server-owned `DiceService` with injectable deterministic RNG for tests.
- [x] Implement safe expression parsing from server-owned rules definitions only; Provider text cannot become an executable formula.
- [x] Implement d20, advantage/disadvantage, damage and healing rolls for the minimal rules slice.
- [x] Lock RollPlan and compute a canonical plan hash before reading RNG.
- [x] Persist RollRecord with raw dice, selected dice, modifier breakdown, target, result, ruleset, state revision and mutation identity.
- [x] Add unique execution lookup/replay so retries return the original RollRecord without rerolling.
- [x] Add focused DiceService, RollPlan hash and RollRecord idempotency tests.

## Phase 4 — Deterministic adjudication

- [x] Implement `AdjudicationService`/rules slice for automatic success/failure, roll-required, unsupported and GM-adjudication outcomes.
- [x] Add server-owned action definitions for ability check, saving throw, single attack, healing and the supported advantage/disadvantage cases.
- [x] Resolve modifiers, DC/AC, damage and HP effects only from validated server data.
- [x] Produce `ValidatedStateChange`/validated creation values and `ResolvedOutcome` without accepting Provider mechanical numbers.
- [x] Process all Intent objects in stable action order inside one transaction; use current transaction state for later actions.
- [x] Default to all-or-nothing mechanical commit for the first slice; surface controlled per-intent diagnostics through the Owner-safe outcome/debug path.
- [x] Add ability-check, saving-throw, attack/damage, healing, unsupported-action and conflicting-intent fixtures.

## Phase 5 — Turn workflow integration

- [x] Add an intent interpretation stage that returns one proposal per submitted action and persists normalized ActionIntent records.
- [x] Bind the intent stage to the claim revision and reject stale intent output before mechanical resolution.
- [x] Replace the current direct AI `stateChanges`/combat numeric path with server adjudication and RollPlan/RollRecord generation.
- [x] Run one coordinator-owned mechanical mutation for all valid intents, effects, RollRecords, Outcome, entries/events/archive/next-turn writes and applied revision.
- [x] Preserve idempotent execution replay and ensure stale mechanical results produce no RollRecord, damage, state change or duplicate turn advancement.
- [x] Keep old direct Owner combat commands functional but ensure Provider cannot route through them.

## Phase 6 — Narration boundary and retry

- [x] Add a separate Narration Provider contract that accepts only player-observable context plus committed ResolvedOutcome.
- [x] Ensure the narration context excludes GM-only blocks, other players' private knowledge, raw context and credentials.
- [x] Add a separate narration attempt/run identity linked to the committed mechanical execution and applied StateRevision.
- [x] Validate `NarrationOutput` and persist readable public/private entries without accepting StateChange, RollPlan, RollRecord, DC or mechanical effects.
- [x] Make narration failure retryable without rolling again or replaying mechanical mutations.
- [x] Add fallback/pending API behavior that distinguishes narration failure from mechanical failure; Owner detail now exposes bounded narration attempt status.
- [x] Add tests for narration visibility, mechanical commit surviving provider failure and narration retry idempotency.

## Phase 7 — GM/debug isolation and observability

- [x] Give direct Owner/debug commands independent permission/cause/audit handling from Provider action proposals.
- [x] Expose Owner-safe intent, adjudication, RollPlan, RollRecord, Outcome and narration attempt diagnostics without exposing them to Player.
- [x] Bound all diagnostics: no Provider raw output, credentials, hidden facts or unsafe rejected values.
- [x] Verify old turn-entry projection and archive superseded behavior remain unchanged.

## Phase 8 — Quality gates

- [x] Run contracts and schema tests.
- [x] Run DiceService, adjudication, migration, AI workflow, combat, stale and idempotency tests with temporary SQLite.
- [x] Run HTTP/Owner/Player regression tests for direct commands, projected entries and narration visibility.
- [x] Run `npm test -- --maxWorkers=1`.
- [x] Run `npm run typecheck` and `npm run build`.
- [x] Run `git diff --check`.
- [x] Search production code for Provider-controlled mechanic fields and direct Provider-to-materializer/combat paths.
- [x] Verify no Worldbook, vector retrieval, full rules registry, full combat runtime or multi-model orchestration was introduced.
- [x] Verify tests do not create or modify repository-root/configured development databases.

## Required review gates before implementation

- [x] `prd.md` has no blocking open questions and has been read top-to-bottom after convergence pass.
- [x] `design.md` and this `implement.md` agree on multi-action ordering, transaction atomicity, migration boundary and narration retry semantics.
- [x] `implement.jsonl` and `check.jsonl` contain real spec/research entries.
- [x] User explicitly approves the final planning summary.
- [x] Only then run `python ./.trellis/scripts/task.py start .trellis/tasks/08-16-server-adjudication-dice-authority`.

## Rollback points

1. **Contract boundary** — revert only Provider proposal/schema adapters if existing Owner/debug commands break; do not reopen numeric Provider authority.
2. **Migration 016** — stop before live upgrade if fresh/temp/malformed admission tests fail; do not rebuild or replace databases.
3. **Dice core** — keep DiceService behind a server-only seam and injectable RNG; do not let CombatService receive Provider formula/total values.
4. **Turn integration** — retain the old resolution path behind an explicit run-kind guard until the new mechanical path is proven; never allow two paths to commit the same turn.
5. **Narration** — rollback narration attempt/entry changes independently; never rollback committed RollRecord or mechanical state because prose generation failed.
