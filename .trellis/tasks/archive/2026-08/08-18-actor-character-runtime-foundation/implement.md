# Implementation Plan — Actor & Character Runtime Foundation

## Phase 0 — Evidence and design gate

- [x] Read the current Character, campaign participant, Narrative Decision, Combatant, mechanical effect, composition, and migration implementations.
- [x] Confirm exact legacy HP shape/status vocabulary and choose the deterministic migration initialization policy.
- [x] Confirm that current contracts have no canonical CampaignActor owner and that `runtime.ts`/`narrative.ts` contain scattered actorId fields.
- [x] Lock the additive/dual-identity migration: `userId`/`playerId` remain auth/submitter identities; new live `actorId` means CampaignActor ID.
- [x] Record the compatibility adapter and archive policy before changing live identity reads.
- [x] Final planning summary approved; `task.py start` completed and implementation may begin.

## Phase 1 — Shared contracts

- [x] Add or extend the single public Actor contract owner with `CampaignActor`, `ActorControlBinding`, and `CharacterRuntimeState` schemas/types.
- [x] Define `characterType`, `controlMode`, `mechanicsMode`, runtime status, nullable authoring reference, and bounded conditions.
- [x] Export the contracts from the package barrel.
- [x] Add accepted, rejected, cross-field, nullability, bounds, and public-export tests.

## Phase 2 — Persistence and backfill

- [x] Add the next numbered SQLite migration for CampaignActor, control bindings, and CharacterRuntimeState.
- [x] Additive actor columns/mappings for live Narrative and Combat identity; do not rewrite old `player_id`/legacy `actor_id` history or archive meaning.
- [x] Preserve `platform_actions.player_id` as action submitter and `combatant.id` as encounter instance.
- [x] Implement deterministic existing-data backfill: approved Character → Actor, owner/player → binding, legacy HP → runtime state under the documented policy.
- [x] Add explicit conflict handling for multiple approved Characters owned by one User; never silently let a `Map<player_id, CharacterRow>` decide.
- [x] Update migration manifest/approved migration set and migration failure/rollback tests.
- [x] Add repositories with narrow `QueryReader`/`QueryExecutor` dependencies and explicit row-to-view mapping.

## Phase 3 — Actor and runtime services

- [x] Implement Actor creation/query and binding resolution with campaign ownership and membership authorization.
- [x] Implement userless NPC creation and multi-actor user control without treating user ID as actor ID.
- [x] Implement CharacterRuntimeState creation/read/update through `CampaignMutationCoordinator`/`mutateIn` seams.
- [x] Implement minimal damage/healing/condition mutation with bounds, idempotency, stale revision checks, and applied StateRevision recording.
- [x] Add service tests for cross-campaign rejection, inactive binding, replay, rollback, and malformed legacy state.

## Phase 4 — Character integration

- [x] Keep `CharacterService` focused on authoring/review/build data.
- [x] Create/link a CampaignActor for new/existing player Characters without changing authoring sheet semantics.
- [x] Remove normal runtime HP writes from CharacterRepository/CharacterService paths.
- [x] Keep only explicit migration/bootstrap compatibility reads from `sheet_json.hpCurrent`.
- [x] Add regression assertions that runtime damage leaves `platform_characters.sheet_json` byte-for-byte/value-for-value unchanged.

## Phase 5 — Narrative integration

- [x] Resolve Narrative participant/Decision actor identity through CampaignActor and active control binding.
- [x] Make new live participant/Decision identity actor-scoped; preserve action submitter `playerId` and historical rows through compatibility mapping.
- [x] Backfill and expose `NarrativeDecision.actorId` as CampaignActor ID.
- [x] Update context/projection/fact audience paths without changing the frozen Presentation checkpoint/scheduling/Fact authority behavior.
- [x] Add User→Kayla Actor, User→second Actor, and userless NPC Decision tests, including campaign isolation and legacy compatibility.

## Phase 6 — Combat integration

- [x] Backfill/create Actor references for PC and NPC Combatants while preserving `Combatant.id`/`actorCombatantId` as encounter-instance identity.
- [x] Expose `Combatant.actorId` through the shared contract and server mapping.
- [x] Route validated damage/healing/conditions through CharacterRuntimeStateService and update the current encounter projection atomically.
- [x] Keep Provider numeric mechanics and raw combat commands behind existing adjudication validation; do not expand the rules slice.
- [x] Add Combat tests proving actor identity, multiple instance semantics, runtime HP mutation, NPC participation, replay, and unchanged authoring sheet.

## Phase 7 — Composition and vertical verification

- [x] Wire the new services into production and test composition roots.
- [x] Verify no module imports the SQLite adapter directly and no nested top-level transaction is opened.
- [x] Run focused contracts, actor, character, narrative, combat, migration, and composition tests.
- [x] Run `npm run typecheck`, `npm run build`, `npm run test`/server suite, and `git diff --check`.
- [x] Run a final cross-layer review for `userId`/`playerId` uses in new live Actor paths.

## Risk and rollback points

- **Contract risk:** avoid introducing a second Actor/status vocabulary; stop and reuse/extend an existing module if one is found.
- **Migration risk:** never edit migrations 001–019; validate fresh and existing DBs before wiring new live writes.
- **Identity risk:** keep compatibility columns until all active reads use Actor ID; add explicit assertions to prevent fallback to user ID.
- **Runtime risk:** keep the coordinator as the only revision authority; rollback any direct sheet mutation or nested transaction path.
- **Scope risk:** do not add ActorKnowledge, Worldbook, full Combat rules, archive recovery, or UI rewrite in this task.

## Completion gate

- [x] All PRD acceptance criteria are observable in tests or migration assertions.
- [x] `prd.md` has passed the final convergence pass; blocking open questions are empty.
- [x] Relevant specs are updated if implementation discovers a reusable Actor/runtime invariant.
- [x] `trellis-check` passes.
- [x] Commit only after verification; never commit unrelated `.mcp.json` or `bin/` local files.
