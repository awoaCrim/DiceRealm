# Implementation Plan: Actor Foundation Integration Seam Follow-up

## Phase A — Context and wiring

- [x] Read current composition, worker, round, archive, adjudication implementations and relevant specs.
- [x] Add shared `NarrativeRoundService` seam to `NarrativeWorkCoordinator`.
- [x] Inject the composition-root `NarrativeRoundService` into `AiResolutionService` / decision resolver.
- [x] Return and reuse the composed coordinator for `NarrativeClaimLeaseSweeper`.
- [x] Add production two-round regression and confirm no legacy required participant is created.

## Phase B — True V1/V2 restore compatibility

- [x] Add idempotent deterministic legacy combatant Actor creation helper.
- [x] Actorize approved snapshot Characters even when their Actor rows are missing.
- [x] Resolve V2 combatants without `actorId` through Character Actor or deterministic NPC Actor.
- [x] Pass resolved Actor ids into combatant restore and runtime projection.
- [x] Add genuine old JSON tests for V1 and V2, including post-restore damage/runtime synchronization.

## Phase C — Narrative healing cap

- [x] Pass combatant hpMax and direct Actor/Character hpMax into runtime mutation.
- [x] Add regression tests for combatant and direct Character healing over max HP.

## Verification

Run focused checks after each phase:

```bash
npx vitest run server/src/tests/platform-composition.test.ts server/src/modules/narrative-runtime/narrative-runtime.test.ts server/src/modules/archives/archive.test.ts server/src/modules/combat/combat.test.ts --maxWorkers=1
npx vitest run server/src packages/contracts/src --maxWorkers=1
npm run typecheck
npm run build
git diff --check
```

Also run root `npm test -- --maxWorkers=1` and report any unrelated pre-existing client test failure separately.

## Review gates

- Verify every production `new NarrativeRoundService` / `new NarrativeWorkCoordinator` call.
- Verify V2 test JSON truly omits `actorId`, not only changes `schemaVersion`.
- Verify no restored Combatant has `actor_id = NULL` when an Actor can be resolved.
- Verify runtime state remains authoritative after Narrative healing.
- Do not commit until focused and full server/contracts checks pass.
