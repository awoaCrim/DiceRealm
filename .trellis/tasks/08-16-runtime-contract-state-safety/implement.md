# Implementation plan: Runtime Contract & State Safety

## Phase 0 — Baseline and mutation inventory

- [x] Confirm current task artifacts and leave `08-16-room-links-rules-materials` untouched.
- [x] Run `trellis-before-dev` and load contracts/server/database/AI specs before code changes.
- [x] Inventory all authoritative campaign runtime mutation entry points:
  - Campaign creation and membership/runtime setup;
  - Turn action submit/update, lock, resolving, completed and next-turn creation;
  - Character gameplay changes;
  - World fact and quest changes;
  - Combat state changes;
  - Knowledge/private synchronization paths if present;
  - AI formal apply;
  - Archive restore;
  - GM/admin runtime overrides if present.
- [x] Identify metadata-only writes that must not advance runtime revision.
- [x] Record current migration baseline and the existing explicit migration/startup boundary; do not introduce ordinary-startup auto-apply of arbitrary pending migrations.
- [x] Verify tests use temporary SQLite fixtures and do not touch repository-root or configured development databases.

## Phase 1 — Contracts first

- [x] Add shared schemas/types for `Authority`, context-specific `ContextVisibility`, `ContextBlock`, `ContextSourceRef`, `ContextTraceEntry`, `StateRevision`, `ActionIntent`, `ResolvedOutcome`, `NarrativeOutput`, and the typed StateChange boundary.
- [x] Preserve existing persisted `public` / `player_private` / `owner_only` visibility contracts; add explicit mapping at the context boundary instead of renaming the existing enum.
- [x] Define server-controlled trace reason codes and bounded source reference rules.
- [x] Make StateChange validation discriminated by kind and typed patch/command shape; preserve current character/world/quest/combat semantics and fail-closed behavior.
- [x] Add contract tests for valid values, invalid authority/visibility combinations, malformed source refs, typed state changes, and legacy turn-resolution compatibility.

## Phase 2 — Structured context construction

- [x] Refactor `AiContextBuilder` into a block construction phase plus a pure prompt renderer.
- [x] Produce blocks for policy/rules identity, campaign/runtime, current turn/actions, approved actor state, known facts, combat projection and output contract.
- [x] Attach stable `sourceRefs`, authority, context visibility, priority and bounded token estimates.
- [x] Apply deterministic filtering before rendering; verify GM-only and actor-private fixtures never enter unauthorized provider messages.
- [x] Build minimal `ContextTrace` with `actionId`, `blockId`, `sourceRef`, `included`, `reason` and optional bounded token data.
- [x] Persist blocks/trace in the existing owner-safe AI run context without storing Provider raw output or credentials.
- [x] Keep one system message and one Provider invocation; preserve current `AiPrompt.messages` contract.
- [x] Update `ai-context-builder` and vertical resolution tests for block order, trace, filtering and rendered prompt equivalence.

## Phase 3 — State head, ledger and migration

- [x] Add `015_campaign_state_revision.sql` with:
  - `platform_campaign_state_heads`;
  - `platform_campaign_state_revisions`;
  - nullable `expected_state_revision` and `applied_state_revision` on `platform_ai_runs`;
  - initialization of every existing campaign head to revision `0`.
- [x] Update migration manifest, approved migration set, migration copy/build inventory, fresh fixtures and migration tests.
- [x] Keep old AI runs NULL for revision fields; add tests proving legacy runs cannot enter formal apply.
- [x] Initialize a new campaign head in the same transaction as campaign creation; fail closed if an existing campaign unexpectedly lacks a head outside the explicit migration path.
- [x] Decide and document the operational path for existing databases under the current no-ordinary-pending-migration startup gate; do not silently rebuild or replace user databases.

## Phase 4 — Mutation coordinator and revision lifecycle

- [x] Implement `CampaignMutationCoordinator` or an equivalent internal transaction seam.
- [x] Implement head read, expected-revision CAS, revision allocation, unique mutation-id ledger insertion, and `MutationContext` creation in one transaction.
- [x] Add controlled error mapping for stale revision, duplicate mutation replay and missing state head.
- [x] Route campaign creation and all Phase 0 inventoried authoritative runtime mutations through the coordinator, beginning with turn/AI formal apply and then the remaining services.
- [x] Ensure one logical authoritative transaction advances exactly one revision regardless of the number of changed tables.
- [x] Ensure revision ledger `causeType`/`causeId` are server-controlled and stable.
- [x] Add tests for concurrent CAS failure, duplicate mutation replay, rollback of head/ledger with business writes, and metadata-only writes that do not advance revision.

## Phase 5 — AI claim/formal apply integration

- [x] During claim, treat the `locked -> resolving` transition as an authoritative mutation and advance the head once.
- [x] Build and persist ContextRun at the post-claim revision; set `platform_ai_runs.expected_state_revision`.
- [x] Keep Provider invocation outside the database transaction.
- [x] During formal apply, CAS the expected revision, apply typed StateChanges, write entries/interactions/archive/next turn/events, set `applied_state_revision`, and commit once.
- [x] On stale result, write only controlled failure/owner-attention state according to existing failure semantics; do not write formal entries, state changes, archive or next turn.
- [x] Preserve idempotency replay: same campaign + idempotency key does not call Provider or advance state twice.
- [x] Add end-to-end temporary SQLite tests for claim revision, stale Provider result, successful applied revision, retry/replay, and full rollback.

## Phase 6 — Archive restore and provenance

- [x] Route archive restore through the mutation coordinator.
- [x] Prove restore never decreases the live head; restoring a snapshot captured at revision N from live revision M creates M+1 (or the next current revision), never N.
- [x] Preserve existing archive watermark/superseded behavior.
- [x] Keep archive snapshot schemas backward-compatible; do not add captured state revision in Phase 1 because restore provenance is already represented by the archive snapshot/watermark contract and old snapshots remain readable.
- [x] Add tests for restore rollback, restore monotonicity, stale old AI run rejection after restore, and superseded history behavior.

## Phase 7 — Quality and review gates

- [x] Run contracts tests and all AI runtime tests.
- [x] Run revision/migration tests using temporary SQLite files.
- [x] Run `npm test -- --maxWorkers=1`.
- [x] Run `npm run typecheck` and `npm run build`.
- [x] Run applicable browser/HTTP regression tests for Owner/Player boundaries; no new UI is required for this phase.
- [x] Run `git diff --check`.
- [x] Search production code for direct runtime writes that bypass the coordinator; document any intentionally excluded metadata writes.
- [x] Verify no Worldbook persistence, vector/reranker dependency, multi-model orchestration, rules registry, or LOTM content was introduced.
- [x] Review migration behavior on fresh fixture, maintained existing fixture, and malformed/ambiguous database states before requesting final task review.

## Validation scenario

Use a temporary campaign fixture:

- Server knows `NPC A` is secretly a traitor with `authority=world`, `visibility=GM_ONLY`;
- Player-visible knowledge says the player trusts NPC A with `authority=actor`, `visibility=ACTOR_PRIVATE`;
- Player submits an action involving NPC A;
- Context excludes the GM-only secret and records a denial trace;
- AI run claims at revision N+1 and stores that expected revision;
- A competing authoritative mutation advances the head;
- The old AI result is rejected without formal writes;
- A replay of a successful execution does not duplicate damage, facts, entries, archives or turn advancement.

## Risk / rollback points

1. **Contract shape risk** — keep new context contracts separate from persisted turn-entry visibility; revert only the context adapter if shared contract compatibility fails.
2. **Migration risk** — do not run migration 015 against a real user database until fresh/temp fixtures and the explicit startup boundary are verified; migration must be atomic and non-destructive.
3. **Mutation coverage risk** — if an authoritative writer cannot be routed through the coordinator, do not claim the stale-result guarantee is complete; record it as an explicit blocker.
4. **Claim revision semantics risk** — if making `locked -> resolving` a revision creates an unacceptable compatibility issue, stop before formal apply integration and revisit the boundary; do not silently omit the transition.
5. **Archive compatibility risk** — preserve old snapshot parsing and never reuse old captured revision as the live revision.
6. **Scope drift risk** — stop if implementation starts adding Worldbook storage, embedding, reranking, UI inspector, full rules engine or multi-model orchestration; create a separate task instead.
