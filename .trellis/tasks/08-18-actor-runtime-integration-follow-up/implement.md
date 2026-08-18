# Implementation Plan

## Phase 0 — Baseline and red regressions

- [ ] Confirm current branch/status and preserve `.mcp.json`/`bin/`.
- [ ] Add failing Actor-aware Provider context regression.
- [ ] Add failing Archive V3 runtime round-trip regression.
- [ ] Add failing Combat runtime seed/identity regression.
- [ ] Add focused P1 regressions for healing cap, status preservation, multi-action read, Actor route, and `npc + pc_build`.

## Phase 1 — Actor identity context

- [ ] Add read-only Actor context identity resolver.
- [ ] Update `AiContextBuilder` action/character/fact/combat/narrative projections to use canonical Actor identity with legacy fallback.
- [ ] Wire the resolver through the production composition root and Decision resolution path.
- [ ] Verify sibling Actor privacy and exact current action through scripted Provider.

## Phase 2 — ArchiveSnapshotV3

- [ ] Add V3 contracts and public exports.
- [ ] Add ActorRepository restore/list-runtime seams.
- [ ] Capture Actor, binding, and runtime state in V3.
- [ ] Restore Actor/binding/runtime state with inactive legacy policy and monotonic restore revision.
- [ ] Keep V1/V2 parse/restore compatibility and update schema-version branches.

## Phase 3 — Combat authoritative seed

- [ ] Resolve existing Actor and Character identity consistently.
- [ ] Seed current HP/temporary HP/conditions from runtime for existing Actors.
- [ ] Reject Actor↔Character mismatch and impossible runtime/mechanics cap combinations.
- [ ] Preserve new NPC bootstrap behavior.
- [ ] Route mechanics cap into runtime mutation without persisting a second maxHp authority.

## Phase 4 — Runtime and contract hardening

- [ ] Clamp healing to caller-provided server mechanics cap.
- [ ] Preserve runtimeStatus for condition-only mutation.
- [ ] Remove NPC→pc_build restriction and add accepted contract tests.
- [ ] Add `myActions[]` with legacy `myAction` projection.
- [ ] Add minimal Actor read route and HTTP projection tests.

## Phase 5 — Verification and spec sync

- [ ] Run focused contracts, actor, AI context/narrative, archive, combat, turn, and HTTP tests.
- [ ] Run `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Run the server/contracts suite and record any unrelated root client test limitation.
- [ ] Update Actor/runtime and archive specs with the learned invariants.
- [ ] Run Trellis validation/check and archive the follow-up task only after all P0 regressions pass.
