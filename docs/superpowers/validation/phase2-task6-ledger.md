# Phase 2 Task 6 Validation Ledger

## Scope

Implemented only Phase 2 Task 6: authoritative SSE session bindings, per-batch/per-frame authority revalidation, post-commit runtime invalidation, two-device HTTPS flows, and client EventSource generation isolation. Task 7+ was not started.

## Baseline and strict TDD evidence

- Required baseline was run before production edits:
  `npx vitest run server/src/platform/realtime/event-stream.test.ts server/src/tests/realtime-events-http.test.ts server/src/tests/vertical-sse-combat-http.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1`
  → **4 files / 28 passed / 0 failed**. This was an all-green baseline and is not labeled RED.
- First structural/import RED added at the new public authority seam:
  `npx vitest run server/src/modules/identity/SessionAuthority.test.ts --maxWorkers=1`
  → suite failed because `SessionAuthority.js` did not exist.
- First GREEN:
  same command → **1 file / 1 passed**.
- Event-stream vertical RED added before stream production changes:
  `npx vitest run server/src/platform/realtime/event-stream.test.ts --maxWorkers=1`
  → **1 failed / 12 passed**, deterministic timeout because the pre-fix stream never invoked the authority checker before batch/per-frame dispatch.
- Event-stream GREEN after the minimum binding/revalidation implementation:
  same command → **1 file / 13 passed**; final stream suite is **15 passed** after adding rejection and synchronous close/race regressions.
- Client generation regression was added at the existing public `RealtimeSession` seam and verified in the focused cycle; final client suite is **22 passed**.

## Architecture and behavior

- `SessionAuthority` reads the session/account join through `DatabasePort.readCommitted`, performs no writes or idle refresh, and returns false for missing, revoked, expired, disabled, revision/epoch/user mismatch, and checker exceptions.
- Each SSE request copies `{internalSessionId,userId,authRevision,revokeEpoch,campaignId,viewer}` from the authenticated request/campaign context. The runtime provisionally registers that binding before the final authority await; a concurrent commit notifier tombstones it. Headers are flushed only when the authoritative result is true and the provisional binding was not invalidated, with no await between that decision and `flushHeaders`.
- `EventStreamService` checks authority before each batch read and synchronously awaited immediately before every visible frame dispatch. Existing single-flight polling, cursor advancement, invisible/poison-row handling, projection path, and backpressure behavior remain.
- Runtime invalidation removes every matching client first, then invokes every delivery-state close callback with per-client exception isolation, and only then attempts every response destroy callback. `IdentityService` notifications are post-commit best-effort: notifier failures cannot change durable logout/expiry results or suppress cookie deletion.
- `IdentityService` invokes runtime notification only after the revocation/audit transaction resolves successfully. Audit rollback emits no notification. Current logout notifies one internal session; logout-all notifies the user; active/draining invalid cleanup notifies the cleaned session. Quiescent cleanup remains write/notification-free.
- The HTTPS harness explicitly sets `rejectUnauthorized: true` while pinning the fixture CA. An isolated child process sets `NODE_TLS_REJECT_UNAUTHORIZED=0`, proves the positive fixture request succeeds, and sends a well-formed valid-but-untrusted certificate through the actual shared harness dispatcher; the request is rejected.
- `RealtimeSession` assigns a connection generation and captures campaign/source. Late frames/open/error callbacks, including a synchronous campaign switch during source construction, cannot mutate the new campaign watermark/preview state or schedule reconnect.

## Validation

- Focused Task 6 after independent-review fixes:
  `npx vitest run server/src/modules/identity/SessionAuthority.test.ts server/src/modules/identity/identity.test.ts server/src/platform/realtime/event-stream.test.ts server/src/tests/realtime-events-http.test.ts server/src/tests/vertical-sse-combat-http.test.ts server/src/tests/httpTestHarness.test.ts client/src/app/realtime/RealtimeSession.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1`
  → **8 files / 106 passed**.
- Wider affected auth/composition/startup/HTTP: **8 files / 50 passed**.
- Typechecks: server, contracts, client all PASS.
- Full `npx vitest run --maxWorkers=1` → **76 files passed / 2 skipped; 647 tests passed / 22 skipped; 0 failed**.
- `git diff --check` PASS (only existing Windows LF→CRLF warnings).
- Staging empty.
- Default hashes unchanged: SQLite `b0b74c55…`, WAL `0849cfbe…`, SHM `1b2c5181…`, credential key `63412f07…`; root credential key absent; instance lock absent.

## Changed files

- `server/src/modules/identity/SessionAuthority.ts` (new)
- `server/src/modules/identity/SessionAuthority.test.ts` (new)
- `server/src/modules/identity/IdentityService.ts`
- `server/src/modules/identity/identity.test.ts`
- `server/src/platform/realtime/EventStreamService.ts`
- `server/src/platform/realtime/event-stream.test.ts`
- `server/src/routes/eventRoutes.ts`
- `server/src/app.ts`
- `server/src/tests/httpTestHarness.ts`
- `server/src/tests/httpTestHarness.test.ts` (new)
- `server/src/tests/realtime-events-http.test.ts`
- `client/src/app/realtime/RealtimeSession.ts`
- `client/src/app/realtime/RealtimeSession.test.ts`
- `docs/superpowers/validation/phase2-task6-ledger.md`
- `docs/superpowers/validation/phase2-implementation-ledger.md`

## Independent-review fix RED→GREEN evidence

- Pre-header commit race RED: focused HTTPS regression used real SQLite authority plus the real logout route; pre-fix returned **200 instead of 401**. After provisional runtime binding/tombstoning: **1 passed**.
- Post-commit notifier RED: identity regression rejected with `forced notifier failure`; HTTP logout returned **500 instead of 200**. After notifier isolation: identity focused **7 passed**, HTTP focused **2 passed**.
- Real per-frame commit race: replay row ready, authoritative frame check paused, real HTTPS logout committed, then release; GREEN proves zero campaign frames and reconnect 401.
- TLS pin regression: the isolated child sets `NODE_TLS_REJECT_UNAUTHORIZED=0`, sends both the trusted fixture and a well-formed unrelated self-signed certificate through the actual shared `testFetch` dispatcher, and rejects the latter. Removing shared-agent `rejectUnauthorized:true` produced a real RED; restoring it returned GREEN.
- Additional review coverage: expiry/disabled/revision cleanup remains exactly-once across repeated resolution of the same invalid token; rollback/quiescent zero notification; runtime close/destroy exception isolation; fully settled tracked-stream outcomes that reject unarmed/unexpected failures; bounded live-stream shutdown; ready-before-abort SSE cleanup with abort-only cancellation suppression; c1→c2→c1 watermarks; exponential retry progression/cap with restored mocks.
- Canonical final hardening evidence: `docs/superpowers/validation/phase2-task6-final-test-hardening.md`. It records the later operability correction and current command results; the earlier artifact copy is historical only.
- Original Task 6 was not wholly strict TDD. The original ledger remains limited to the authority/event-stream REDs actually observed; the bullets above are the new review-fix cycles and do not retroactively claim otherwise.

## Residual risks / future seams

- Admin revoke/disable HTTP APIs remain intentionally deferred. The runtime `revokeSession`/`revokeUser` ports are ready for that future integration; future account-status transactions must call them only after commit.
- `closeAllForMaintenance` is only the Task 6 runtime seam; Task 14 maintenance admission/transition policy is not implemented.
- Machine environment emits `NODE_TLS_REJECT_UNAUTHORIZED=0` warnings. The repository HTTPS harness continues to use its pinned fixture CA and no production TLS weakening was introduced.

## Final independent acceptance

- Correctness/concurrency review: **PASS / 0 Blocker / 0 Major / 0 Minor** (`ceda13c4`), including explicit race-order proof for provisional registration, final header flush, batch/frame checks, commit notification, rollback, and request close.
- TLS/runtime-contract review: **PASS / 0 Blocker / 0 Major / 0 Minor** (`82a4d1a7`).
- Production security/correctness review after all hardening: **PASS / 0 Blocker / 0 Major** (`90d679e5`).
- Operability review found one final Minor in the initial tracked-SSE response timeout; it was fixed by aborting the controller and boundedly observing the retained fetch outcome. Targeted closeout review: **PASS / 0 Blocker / 0 Major / 0 Minor** (`44f790e6`).
- One Minor is dispositioned: the prepared replay test identifies its per-frame phase by the documented third authority-check call. The phase is named, asserted, bounded, and released in `finally`; this is accepted test coupling, not a production correctness gap.
- Final aggregate verdict: **PASS / 0 Blocker / 0 Major / 1 dispositioned Minor**. Task 6 is accepted complete; Task 7+ remains unimplemented.
