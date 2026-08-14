# Phase 2 Task 6 Final Test Hardening

## Scope

Task 6-only test/runtime-contract hardening. No Task 7+ HTTP policy, migration, dependency, maintenance policy, or future admin revoke/disable API was added.

## Prior hardening

- Made `EventStreamRuntime.registerClient` required so provisional pre-header registration is a type-level invariant.
- Added a regression-sensitive pinned-CA child-process test under `NODE_TLS_REJECT_UNAUTHORIZED=0`, using the actual shared `testFetch` dispatcher and a checked-in valid unrelated certificate.
- Added bounded authority/frame/heartbeat/shutdown diagnostics, ready-before-abort SSE coverage, mock restoration, and repeated invalid-token exactly-once coverage.
- Corrected the first `SessionAuthority` RED label to structural/import; original Task 6 is not claimed as wholly strict TDD.

## Final operability correction

Independent review found three remaining evidence gaps and this pass closes only those gaps:

1. `openTrackedSse` now records a settled outcome immediately, preserves unexpected read/socket/TLS errors, and exposes explicit `armExpectedServerClose`, `waitClosed`, `expectOpenFor`, and `abortAndWait` operations. Logout/revoke/maintenance/`closeViewer` tests arm expected server closure before the operation. Streams expected to remain open are checked and then explicitly aborted and awaited. An added sensitivity regression proves an unarmed server closure is rejected rather than counted as revocation evidence.
2. Stream reads abort their owning controller on timeout. Reader cancellation is bounded best-effort and never awaited unboundedly. Background tasks attach rejection handling immediately through settled outcomes. The per-frame response, response-body closure, heartbeat reads, live shutdown, and shutdown cleanup are bounded with diagnostics. No Task 6-added background rejection is left floating.
3. This canonical repository evidence file now exists. Task 6 ledgers point here and continue to require independent re-review; they do not claim final PASS.

## TDD evidence

- Targeted RED before the tracked-stream refactor:
  `npx vitest run server/src/tests/realtime-events-http.test.ts -t "tracked SSE rejects an unarmed server-side closure" --maxWorkers=1`
  → **1 failed / 14 skipped** because `waitClosed` did not exist and the old helper swallowed all stream failures.
- Targeted GREEN after the refactor:
  `npx vitest run server/src/tests/realtime-events-http.test.ts --maxWorkers=1`
  → **1 file / 15 passed**.

The earlier TLS sensitivity RED remains valid: temporarily removing the shared Agent's `rejectUnauthorized:true` caused the child regression to fail because the valid unrelated certificate was accepted; restoring it returned GREEN. No temporary weakening remains.

## Final validation

- Focused Task 6 + harness:
  `npx vitest run server/src/modules/identity/SessionAuthority.test.ts server/src/modules/identity/identity.test.ts server/src/platform/realtime/event-stream.test.ts server/src/tests/realtime-events-http.test.ts server/src/tests/vertical-sse-combat-http.test.ts server/src/tests/httpTestHarness.test.ts client/src/app/realtime/RealtimeSession.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1`
  → **8 files / 107 passed / 0 failed**.
- Wider auth/composition/startup/HTTP:
  `npx vitest run server/src/tests/authCampaignRoutes.test.ts server/src/tests/platform-composition.test.ts server/src/tests/ai-routes-http.test.ts server/src/tests/vertical-ai-resolution-http.test.ts server/src/tests/vertical-characters-http.test.ts server/src/tests/vertical-world-outbox-turns-http.test.ts server/src/tests/rules-routes-http.test.ts server/src/platform/startup/startPlatformServer.test.ts --maxWorkers=1`
  → **8 files / 50 passed / 0 failed**.
- Typechecks:
  - `npx tsc -p server/tsconfig.json --noEmit` — PASS.
  - `npx tsc -p packages/contracts/tsconfig.json --noEmit` — PASS.
  - `npx tsc -p client/tsconfig.json --noEmit` — PASS.
- Full suite: `npx vitest run --maxWorkers=1` → **76 files passed / 2 skipped; 648 passed / 22 skipped / 0 failed**.
- `git diff --check` PASS; only existing Windows LF→CRLF warnings.
- Staging empty.
- Safety gates PASS. Exact hashes:
  - `server/dnd.sqlite`: `b0b74c555515fc328e8d2908335e35af2fb4af3ed28f2f2752c3bcf1f0b27f96`
  - `server/dnd.sqlite-wal`: `0849cfbe850859d8f68a170e37ec24e07cf9fe97aa52023dd6ce84ab3eb5577b`
  - `server/dnd.sqlite-shm`: `1b2c5181027e6df211419a70e0cbaa45e297b853e8ac1cfb91d21dd64810d381`
  - `server/.dnd-ai-credential-key`: `63412f0702525078b826dcecf9ae9dadd2e593fe21dc9faaea5beb1aabf5f776`
  - server/root instance locks and root credential key absent.

The first aggregate validation attempt reached focused **107/107** and wider **50/50**, then server typecheck found a test-helper generic typing error. That test-only typing error was corrected; the complete validation sequence above then passed. No production behavior was changed.

## Safety

Tests use only `:memory:` databases and ephemeral HTTPS listeners. No default database, credential key, or production lock is opened by these tests. No Git mutation/staging command is used.

## Review status

Final independent review status:

- TLS/shared-dispatcher and required runtime registration: **PASS / 0 Blocker / 0 Major / 0 Minor** (`82a4d1a7`).
- Production security/correctness after all fixes: **PASS / 0 Blocker / 0 Major** (`90d679e5`).
- Final active operability Minor was closed by aborting and boundedly settling the initial tracked-SSE fetch on timeout/error; targeted review: **PASS / 0 Blocker / 0 Major / 0 Minor** (`44f790e6`).
- One test-only Minor remains dispositioned: the prepared replay per-frame phase is identified by the documented third authority-check call, but is explicitly named, asserted, bounded, and safely released.

Final aggregate verdict: **PASS / 0 Blocker / 0 Major / 1 dispositioned Minor**. Task 6 is accepted complete. Task 7+ is not implemented by this work.
