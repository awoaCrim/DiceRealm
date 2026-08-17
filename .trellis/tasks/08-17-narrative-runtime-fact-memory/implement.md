# Implementation Plan — Narrative Runtime & Fact Memory

## Phase 0 — Preconditions and guardrails

1. Read the final `prd.md`, this design, the injected backend specs, and existing Turn/AI/adjudication/archive tests.
2. Keep all work on the active Trellis task; do not start a second task or commit during implementation.
3. Treat `platform_narrative_rounds` as the sole live round authority. Before editing any existing Turn status path, identify whether it is a compatibility mirror, legacy replay, or a live mutation.
4. Preserve unrelated working-tree changes, especially local `.mcp.json`.

## Phase 1 — Contracts and schema boundary

1. Add strict shared contracts for:
   - NarrativeRound/participant/Decision lifecycle;
   - FactAuthority, FactSourceKind, FactValidationStatus and FactProvenance;
   - WorkingFact, RoundFact, RoundFactSet;
   - ProjectedRoundSummary and actor/audience projection inputs;
   - RuntimeFact promotion and ActorKnowledge ports/proposals;
   - NarrativeFactExtractor and RoundCloseContributor interfaces.
2. Export the contracts from `packages/contracts/src/index.ts` and add contract tests for invalid status/audience/source combinations, bounded source refs and candidate-vs-authoritative rules.
3. Do not reuse `runtime.ts` Context `Authority` for fact authority; document/map the two domains separately.

## Phase 2 — Migration and repositories

1. Add `017_narrative_runtime_fact_memory.sql` with tables/indexes for:
   - rounds;
   - participants;
   - decisions;
   - persistent working facts;
   - one immutable FactSet per closed round;
   - immutable FactSet facts.
2. Use SQLite-compatible parameter/DDL conventions and add all migration manifest/hash updates through the repository's migration tooling.
3. Add active/superseded columns or joins for archive branch safety; add uniqueness for one round per Turn, one active participant per player, one active decision per player/action, and one FactSet per round.
4. Add repositories with row mapping and no transaction ownership. Include methods for deterministic ordering, conditional lifecycle transitions, idempotent lookup, active projections and archive restore/supersede operations.
5. Add temp SQLite migration/repository tests before service wiring.

## Phase 3 — Authoritative NarrativeRound lifecycle

1. Implement `NarrativeRoundService` create/bootstrap/associate logic for active Turns and next-round creation.
2. Backfill/compatibility behavior must associate existing Turns without fabricating old narrative facts; preserve legacy Turn/AI rows as readable audit data.
3. Route action submission/lock/progress through the Round service. Mirror compatible `platform_turns.status` in the same coordinator transaction; remove live direct status writes from new paths.
4. Implement participant and Decision creation/update with deterministic order `submitted_at ASC, action.id ASC`, one primary Decision per participant, and statuses `waiting/submitted/processing/resolved/skipped/needs_owner_attention`.
5. Implement conditional claim, retry/owner attention, skip, and close guards. Add outbox events in the same transaction as lifecycle writes.
6. Keep legacy whole-turn replay/display paths readable, but do not let them claim or mutate the live NarrativeRound authority.

## Phase 4 — Decision-scoped resolution and WorkingFacts

1. Extend `AiContextBuilder` with a decision-scoped build path:
   - stable runtime;
   - previous active Round projection;
   - current-round WorkingFacts projection;
   - current player's input only;
   - resolution contract.
2. Add ContextBlock/ContextTrace source refs for WorkingFacts and `previous_round_summary`; assert denied actor-private facts are excluded before render.
3. Add a decision-scoped AI claim/apply facade. Provider calls happen outside transactions and each claim stores a bounded context snapshot with expected StateRevision.
4. Refactor/extend `MechanicalResolutionService` with a singleton decision apply seam while preserving the existing all-actions compatibility wrapper.
5. In one coordinator-owned Decision apply transaction:
   - CAS expected revision;
   - persist normalized intent/adjudication/roll plan/roll record/outcome;
   - apply server-owned effects;
   - derive deterministic WorkingFacts with complete provenance;
   - mark Decision resolved and update Round cursor/revision;
   - publish resolution events.
6. Ensure a failed later Decision rolls back only its own uncommitted transaction and leaves prior committed WorkingFacts/StateRevision intact. Ensure duplicate execution returns existing outcome without reroll/reapply.
7. Keep Narration separate and presentation-only; its failure must not remove mechanical WorkingFacts or allocate another state revision.

## Phase 5 — Fact provenance, candidate seam, and RoundFactSet

1. Implement deterministic fact contributors for:
   - StateTransaction/runtime mutation;
   - MechanicalResolvedOutcome/effects/roll evidence;
   - NarrativeDecision and turn/round events;
   - explicitly server-validated GM-authored facts.
2. Implement `FactProvenanceService` so every fact records round, decision/action, execution/outcome/event and StateRevision refs.
3. Implement the `NarrativeFactExtractor` port and candidate storage shape only. Do not add a new Provider call or promote candidates automatically.
4. Implement explicit `closeRound()`:
   - verify all required Decisions are resolved/skipped;
   - idempotently return an existing FactSet;
   - allocate one close StateRevision on first close;
   - copy/normalize active WorkingFacts into immutable RoundFactSet facts;
   - mark Round closed / Turn completed;
   - create next Turn + Round + participants;
   - publish close/resolution events and create the automatic archive boundary.
5. Assert close does not call DiceService, reapply mechanics, or change historical StateRevisions.

## Phase 6 — ProjectedRoundSummary and next Context integration

1. Implement deterministic `RoundProjectionService.projectRoundFacts()` over the active immutable FactSet.
2. Support `party`, `actor_private`, `gm_only`, and `server_only` with fail-closed actor filtering. Candidate/evidence visibility must not silently become world truth.
3. Connect the projection to the next-round `AiContextBuilder` as `previous_round_summary`.
4. Add the A/B/C acceptance flow: C private fact is absent from A/B next context and present for C; party fact is visible to the permitted party audience.
5. Define, but do not implement persistence, for `RuntimeFactRepository` and `ActorKnowledgeRepository` promotion/query seams.

## Phase 7 — Archive and compatibility integration

1. Extend archive snapshot/watermark capture for current NarrativeRound, participant/Decision state, active WorkingFacts and closed FactSet boundary.
2. Update archive restore supersede order to mark later rounds/working facts/fact sets inactive before restoring snapshot rows.
3. Keep old archive snapshots readable with an explicit compatibility fallback; never invent missing facts or actor knowledge.
4. Add active-list and projection tests proving superseded branches cannot enter next-round Context while all-history Owner audit remains available.

## Phase 8 — Tests and quality gates

Run focused tests after each phase, then the full suite. Required scenarios:

- migration manifest and fresh SQLite bootstrap/rollback/failure;
- one active Turn ↔ one NarrativeRound and no dual status authority;
- participant/decision ordering and one decision per player;
- A commits before B, B reads A WorkingFacts, B cannot read A raw action/narration/private data;
- DB reopen preserves WorkingFacts and applied StateRevision provenance;
- later Decision failure leaves earlier Decision committed and blocks close;
- duplicate Decision claim/apply and duplicate Round close are idempotent;
- server fact vs event evidence vs AI candidate authority boundary;
- candidate cannot promote directly to authoritative RuntimeFact;
- immutable FactSet and deterministic projection;
- A/B/C actor-private next-round Context;
- archive supersede/restore and stale retry rejection;
- existing adjudication, narration retry, turn-entry projection and archive regressions.

Use the repository's commands:

```bash
npm run typecheck
npm test -- --maxWorkers=1
npm run build
python ./.trellis/scripts/task.py validate .trellis/tasks/08-17-narrative-runtime-fact-memory
git diff --check
```

## Risk checkpoints / rollback points

- **After migration:** if schema or manifest tests fail, stop before changing services; migration must be corrected without editing prior migrations.
- **After Round authority wiring:** verify all live Turn status mutations route through Round service before enabling decision-scoped resolution.
- **After decision apply:** verify StateRevision/CAS, effect rollback, idempotent outcome replay and WorkingFacts insertion in one transaction.
- **After close:** verify no second FactSet, revision or next Round on replay.
- **After archive integration:** verify restore supersedes later round/fact rows and active projection filters them.
- **Before final report:** inspect `git diff`, run all quality commands, and confirm no `.mcp.json` or unrelated user change was touched.

## Deferred follow-ups

- Historical Narration Request Snapshot hardening.
- RuntimeFact long-term storage/deduplication/supersede graph/retrieval.
- ActorKnowledge belief/certainty/propagation/rumor model and KnowledgeSync.
- NarrativeFactExtractor Provider orchestration.
- WorldTick/NPC autonomous simulation.
- Worldbook/RAG and full UI/GM tooling.
