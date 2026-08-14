# Phase 2 Task 5 Validation Ledger

## Scope

Implemented only Phase 2 Task 5: digest sessions, cookie-only HTTP auth, public auth contract/client changes, HTTPS test harness, and the authenticated missing-CSRF-cookie recovery base. Task 6 was not started.

## Implementation evidence

- Added independent 32-byte canonical base64url internal ID, session token, and CSRF generation with SHA-256 digest-only persistence/lookups.
- Secure sessions write the exact additive 013 fields, including legacy `expires_at = absolute_expires_at`; absolute TTL is 7 days and idle TTL is 12 hours.
- Session resolution rejects legacy rows, disabled accounts, auth revision mismatch, revoked sessions, and absolute/idle expiry.
- HTTP auth reads only `__Host-dnd_session`; Bearer fallback and `dnd_session` were removed.
- Login body is only `{session:{expiresAt}}`; raw material is route-private and emitted only through exact secure cookies.
- Added exact two-cookie set/clear helpers, current logout, logout-all, and authenticated CSRF enforcement for logout surfaces.
- `/api/auth/me` performs no-store conditional CSRF digest rotation when the readable CSRF cookie is absent. Conditional updates make concurrent recovery deterministic, and state-changing CSRF validation re-reads the current digest so the old token immediately fails.
- Public session schema no longer contains `sessionId`; client requests use `credentials:'include'`, read CSRF only from the cookie, and do not access local/session storage or create bearer headers.
- HTTP harness now uses an ephemeral HTTPS server and black-box cookie jar; Secure-cookie behavior was not downgraded.

## TDD evidence

1. Exact plan command was run first. Since `sessionTokens.test.ts` did not exist, Vitest collected the four existing files and reported 40 passing tests; this exposed the missing public seam rather than a behavioral RED.
2. Added only the first minimal token seam test; running it failed because `./sessionTokens.js` did not exist.
3. Implemented the token seam and confirmed the isolated test GREEN.
4. Added minimal service tests, confirmed 7 RED failures, then implemented secure persistence/resolution.
5. Added minimal HTTP cookie/Bearer tests, confirmed 5 RED failures, then implemented cookie-only routes/harness.
6. Added CSRF recovery test, confirmed old-token mutation incorrectly returned 200, then added authenticated synchronizer validation and confirmed GREEN.

## Commands and results

- Exact Task 5 focused command (initial): passed collection of existing 4 files / 40 tests; missing test file was not collected by Vitest 4.1.7.
- `npx vitest run server/src/modules/identity/sessionTokens.test.ts --maxWorkers=1`: RED, import missing; then GREEN, 1/1.
- `npx vitest run server/src/modules/identity/identity.test.ts --maxWorkers=1`: RED 7 failures; final GREEN 18/18.
- `npx vitest run server/src/tests/authCampaignRoutes.test.ts --maxWorkers=1`: RED 5 failures, later CSRF RED 1 failure; final GREEN 11/11.
- Exact Task 5 focused command (final): 5 files / 48 tests passed.
- Wider affected HTTP command: 7 files / 29 tests passed.
- Full `npx vitest run --maxWorkers=1`: final 74 passed files / 2 skipped; 601 passed tests / 22 skipped; 0 failed.
- Server, contracts, and client TypeScript no-emit checks: passed.
- `git diff --check`: passed with only pre-existing Windows LF-to-CRLF warnings.
- Staging: empty.
- Default artifact hashes: unchanged (`server/dnd.sqlite` `b0b74c55…`, WAL `0849cfbe…`, SHM `1b2c5181…`, credential key `63412f07…`); root key absent; instance lock absent.

## Changed files

- `server/src/modules/identity/sessionTokens.ts`
- `server/src/modules/identity/sessionTokens.test.ts`
- `server/src/modules/identity/IdentityRepository.ts`
- `server/src/modules/identity/IdentityService.ts`
- `server/src/modules/identity/identity.test.ts`
- `server/src/platform/http/authCookies.ts`
- `server/src/platform/http/authenticatedCsrf.ts`
- `server/src/platform/http/sessionMiddleware.ts`
- `server/src/platform/http/AppError.ts`
- `server/src/routes/authRoutes.ts`
- `packages/contracts/src/auth.ts`
- `packages/contracts/src/errors.ts`
- `client/src/shared/api/platformHttp.ts`
- `client/src/shared/api/platformHttp.test.ts`
- `client/src/api/auth/authApi.ts`
- `server/src/tests/httpTestHarness.ts`
- `server/src/tests/authCampaignRoutes.test.ts`
- `server/src/tests/platform-composition.test.ts`
- `server/src/tests/fixtures/tls/localhost-key.pem`
- `server/src/tests/fixtures/tls/localhost-cert.pem`
- `docs/superpowers/validation/phase2-implementation-ledger.md`

## Residual risks

- `resolveSession` refreshes idle timestamps on authenticated reads. The quiescent maintenance distinction is not wired into the current composition root yet; authenticated CSRF recovery itself is implemented as the separately allowlisted conditional write. This is a bounded Task 5 integration risk for the future maintenance-policy task, not Task 6 work.
- Security audit event schemas already exist, but Task 5 did not broaden the audit surface with non-transactional writes. Session create/logout audit integration remains for a transactionally safe composition pass.
- The HTTPS harness trusts only its test dispatcher/self-signed fixture. Node prints a TLS warning in this environment, but production cookie/TLS settings are unchanged.
- The first full run had one unrelated order-sensitive failure in `state-change-materializer.test.ts`; isolated rerun passed, and the final full run passed. Task 5 did not modify that test or implementation.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Task 5-only digest sessions, cookie-only auth, contracts/client, HTTPS harness, and authenticated CSRF recovery implemented; Task 6 was not started."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Focused, wider, full test, three typecheck, diff-check, staging, default hash, key, and lock evidence recorded."
    }
  ],
  "changedFiles": [
    "server/src/modules/identity/sessionTokens.ts",
    "server/src/modules/identity/sessionTokens.test.ts",
    "server/src/modules/identity/IdentityRepository.ts",
    "server/src/modules/identity/IdentityService.ts",
    "server/src/modules/identity/identity.test.ts",
    "server/src/platform/http/authCookies.ts",
    "server/src/platform/http/authenticatedCsrf.ts",
    "server/src/platform/http/sessionMiddleware.ts",
    "server/src/platform/http/AppError.ts",
    "server/src/routes/authRoutes.ts",
    "packages/contracts/src/auth.ts",
    "packages/contracts/src/errors.ts",
    "client/src/shared/api/platformHttp.ts",
    "client/src/shared/api/platformHttp.test.ts",
    "client/src/api/auth/authApi.ts",
    "server/src/tests/httpTestHarness.ts",
    "server/src/tests/authCampaignRoutes.test.ts",
    "server/src/tests/platform-composition.test.ts",
    "server/src/tests/fixtures/tls/localhost-key.pem",
    "server/src/tests/fixtures/tls/localhost-cert.pem",
    "docs/superpowers/validation/phase2-implementation-ledger.md"
  ],
  "testsAddedOrUpdated": [
    "server/src/modules/identity/sessionTokens.test.ts",
    "server/src/modules/identity/identity.test.ts",
    "server/src/tests/authCampaignRoutes.test.ts",
    "server/src/tests/platform-composition.test.ts",
    "client/src/shared/api/platformHttp.test.ts"
  ],
  "commandsRun": [
    {
      "command": "npx vitest run server/src/modules/identity/sessionTokens.test.ts server/src/modules/identity/identity.test.ts server/src/tests/authCampaignRoutes.test.ts server/src/tests/platform-composition.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1",
      "result": "passed",
      "summary": "Final focused Task 5 suite: 5 files, 48 tests passed."
    },
    {
      "command": "npx vitest run server/src/tests/authCampaignRoutes.test.ts server/src/tests/ai-routes-http.test.ts server/src/tests/vertical-ai-resolution-http.test.ts server/src/tests/vertical-characters-http.test.ts server/src/tests/vertical-world-outbox-turns-http.test.ts server/src/tests/realtime-events-http.test.ts server/src/tests/rules-routes-http.test.ts --maxWorkers=1",
      "result": "passed",
      "summary": "Wider affected HTTP suite: 7 files, 29 tests passed."
    },
    {
      "command": "npx vitest run --maxWorkers=1",
      "result": "passed",
      "summary": "Final full suite: 74 files passed, 2 skipped; 601 tests passed, 22 skipped."
    },
    {
      "command": "npx tsc -p server/tsconfig.json --noEmit && npx tsc -p packages/contracts/tsconfig.json --noEmit && npx tsc -p client/tsconfig.json --noEmit",
      "result": "passed",
      "summary": "Server, contracts, and client typechecks passed."
    },
    {
      "command": "git diff --check",
      "result": "passed",
      "summary": "No whitespace errors; only Windows line-ending warnings."
    }
  ],
  "validationOutput": [
    "Focused: 5 files / 48 tests passed",
    "Wider HTTP: 7 files / 29 tests passed",
    "Full: 74 passed files / 2 skipped; 601 passed tests / 22 skipped",
    "Server/contracts/client typechecks passed",
    "Default database/key hashes unchanged; root key and instance lock absent",
    "Staging empty"
  ],
  "residualRisks": [
    "Quiescent maintenance read/write distinction is not yet wired into current composition; CSRF recovery conditional write is implemented.",
    "Session audit integration was not broadened without a transactionally safe seam.",
    "One unrelated order-sensitive test failed on the first full run but passed isolated and in the final full run."
  ],
  "noStagedFiles": true,
  "diffSummary": "Replaced raw/Bearer sessions with digest-only 013-backed sessions, exact __Host cookies, authenticated CSRF recovery, public contract/client cleanup, and an ephemeral HTTPS cookie-jar harness.",
  "reviewFindings": [
    "no blockers in Task 5 focused/final validation",
    "review gate remains required by parent reviewer"
  ],
  "manualNotes": "Dirty-tree files were preserved and edited in place. No git add/commit/stash/reset/clean/checkout was used."
}
```

## Independent review checkpoint fix (REVISE → code Majors fixed)

The independent checkpoint verdict was **REVISE**. The original Task 5 implementation history above is immutable and was **not strict TDD**: its initial exact command collected only pre-existing tests, and later tests were written incrementally around implementation. This checkpoint fix does not relabel or retroactively repair that history. It followed strict TDD for the newly identified review defects: focused regression tests were added first, run against the pre-fix implementation, and produced real RED failures before production changes.

### RED evidence for this fix

Command:

`npx vitest run server/src/modules/identity/identity.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1`

Result against pre-fix production code: **2 files; 12 failed / 30 passed (42 total)**. Failures pinned missing transactional `session.created` audit/rollback, current logout epoch/audit/rollback, logout-all auth revision/epoch/audit/rollback, deterministic stale-revision login race (timeout because the verifier seam was absent), unified invalid cleanup/audit, and invalid-cleanup audit rollback. The strict client envelope test was already GREEN only because the test and `.strict()` schema change were a bounded independent edit in the same RED preparation batch; the server Major tests supplied the required real behavioral RED.

### GREEN implementation

- `login` now password-verifies before entering the write queue, then performs an authoritative user/password/status/auth-revision re-read and recheck inside the session-insert transaction. Session insert and typed `session.created` audit share that transaction. This establishes the insertion transaction as the linearization point and prevents stale captured revisions after concurrent logout-all/password changes.
- `logoutCurrent` transactionally conditionally revokes only the bound internal session, increments that row's `revoke_epoch`, and writes typed `session.logout`; audit failure rolls back both changes.
- `logoutAll` transactionally advances `users.auth_revision`, revokes all currently-live rows, increments affected `revoke_epoch` values, and writes one coarse typed `session.logout_all {userId,count}` event; audit failure rolls back the complete unit.
- Normal `resolveSession` invalidity for disabled user, revision mismatch, idle expiry, or absolute expiry uses one transaction: re-read authoritative row, read `platform_instance.maintenance_state`, conditionally revoke/increment epoch, and append typed `session.expired`. Missing singleton is treated as `active` for in-memory/test compatibility; production startup gates prevent serving an unenrolled database. Quiescent lookups return unauthenticated with zero session/audit writes. Already-revoked/unknown rows do not append duplicate cleanup audit. `resolveSessionForCsrf` remains side-effect-free.
- A narrow `SessionAuditWriter`/default `SecurityAuditWriter`, injected password verifier, and composition test injection seam were added. Production defaults always use the real typed writer. Tests prove audit metadata is coarse and omits raw session/CSRF/password material.
- Client `sessionEnvelopeSchema` is strict and rejects a leaked top-level `sessionId`.
- `TestActor.cookieHeader` was removed. Ordinary tests now materialize headers on demand through `TestCookieJar.header()`; explicit `peek()` remains limited to dedicated black-box auth/CSRF tests.
- The HTTPS harness now installs a suite-scoped fetch adapter, restores the prior global after each HTTP suite, and trusts only the fixture certificate (`ca: TLS_CERT`) rather than configuring its own `rejectUnauthorized:false`. The machine environment still globally exports `NODE_TLS_REJECT_UNAUTHORIZED=0`, which produces Node warnings outside repository control; no production bypass was introduced and Secure cookies remain unchanged.

### GREEN and validation evidence

- Focused exact Task 5 suite: `npx vitest run server/src/modules/identity/sessionTokens.test.ts server/src/modules/identity/identity.test.ts server/src/tests/authCampaignRoutes.test.ts server/src/tests/platform-composition.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1` → **5 files / 65 passed / 0 failed**.
- Wider affected HTTP/realtime: `npx vitest run server/src/tests/authCampaignRoutes.test.ts server/src/tests/ai-routes-http.test.ts server/src/tests/vertical-ai-resolution-http.test.ts server/src/tests/vertical-characters-http.test.ts server/src/tests/vertical-world-outbox-turns-http.test.ts server/src/tests/realtime-events-http.test.ts server/src/tests/rules-routes-http.test.ts server/src/tests/vertical-sse-combat-http.test.ts --maxWorkers=1` → **8 files / 32 passed / 0 failed**.
- Full suite: `npx vitest run --maxWorkers=1` → **73 files passed / 2 skipped; 617 tests passed / 22 skipped; 1 unrelated failed**. The failure is the pre-existing order-sensitive assertion in `state-change-materializer.test.ts` (`owner_only` vs `player_private` ordering); isolated rerun passed **10/10**, while a second full run reproduced exactly the same unrelated failure. No Task 5 file changes that implementation/test.
- Server/contracts/client no-emit typechecks: PASS.
- Touched-scope `git diff --check`: PASS (only Windows LF→CRLF warnings).
- Staging empty; lock absent; root key absent. Default hashes unchanged: SQLite `b0b74c55…`, WAL `0849cfbe…`, SHM `1b2c5181…`, credential key `63412f07…`.

### Residuals

- Task 6 SessionAuthority/SSE runtime closing was deliberately not implemented.
- Full suite cannot be honestly called all-green due to the reproducible pre-existing order-sensitive state-change-materializer assertion described above; all focused and wider Task 5 affected suites are green.
- Machine-level `NODE_TLS_REJECT_UNAUTHORIZED=0` remains a test-environment residual. The repository harness no longer requests blanket trust and instead pins its fixture CA.

## Final resolution checkpoint fix (remaining REVISE Major)

The post-fix review still found one Major: valid session resolution read authority outside the database queue, returned a stale binding across revocation, and refreshed idle fields in quiescent. This focused pass fixed only that Task 5 issue and the separately diagnosed order-sensitive test; Task 6 was not started.

### Strict RED

- Added focused service/HTTP/race tests first. Pre-production-fix command:
  `npx vitest run server/src/modules/identity/identity.test.ts server/src/tests/authCampaignRoutes.test.ts --maxWorkers=1`
  → **2 files; 5 failed / 47 passed (52 total)**. Three production failures showed valid quiescent service and HTTP `/me` changed `last_seen_at`/`idle_expires_at`, including missing-CSRF `/me` changing more than `csrf_digest`. Two initial race-test failures were a test-only pausing-wrapper method/property naming defect; that defect was corrected before production edits, and the behavioral quiescent RED remained.
- Order reproduction before its test fix: 30 isolated `state-change-materializer.test.ts` runs → **4/30 failed**, each exactly one positional `rows[1].visibility` assertion (`owner_only` or `public` observed instead of `player_private`).

### Minimal GREEN

- `resolveSession` now performs joined authority reread, validation, maintenance branching, conditional refresh, returned-binding derivation, and invalid cleanup/audit in one `DatabasePort.transaction`, with no nested transaction.
- Valid active/draining refresh uses an authority-conditional update; a lost update returns unauthenticated. Valid quiescent resolution returns the authoritative binding with zero session/audit writes.
- `resolveSessionForCsrf` remains side-effect-free and now uses `DatabasePort.readCommitted`.
- Test-only `PausingAuthorityDatabase` proves valid resolution and CSRF authority reads serialize before or after logout-current/logout-all and cannot yield a binding observed after revocation commit. No production timing hook was added.
- HTTP quiescent `/me` tests prove existing CSRF does zero session/audit writes, while missing CSRF changes only `csrf_digest`; no-store and conditional rotation remain.
- Order-test root cause: three tight-loop `new Date().toISOString()` calls can tie; `ORDER BY created_at` has no tie order and no insertion-order product contract was found. Production ordering was unchanged. The test now asserts by stable title key. Post-fix isolated loop: **30/30 passed**.

### Final evidence

- Focused Task 5: **5 files / 73 passed / 0 failed**.
- Wider HTTP/realtime: **8 files / 34 passed / 0 failed**.
- Full `npx vitest run --maxWorkers=1`: **74 files passed / 2 skipped; 626 passed / 22 skipped; 0 failed**.
- Server/contracts/client typechecks PASS; touched-scope `git diff --check` PASS (LF→CRLF warnings only).
- Staging empty. Default hashes unchanged: `b0b74c55…` / `0849cfbe…` / `1b2c5181…` / `63412f07…`. Root key and instance locks absent.
- Detailed handoff: `docs/superpowers/validation/phase2-task5-final-resolution-fix.md`.
- Independent review still follows; no acceptance claim is made.

## Final platform-composition HTTPS/cookie-jar boundary fix

Independent acceptance found the remaining Task 5 Major in `platform-composition.test.ts`: its local helper still used plain HTTP and replayed a regex-extracted raw session cookie. This narrow test-only pass removed that helper and converted only the HTTP tests to `startTestPlatformServer` + `registerAndLogin`/`TestCookieJar`, with suite-scoped `installHarnessFetch()` restoration. The first two pure `createPlatformApp` composition tests remain direct and unchanged in purpose. No production behavior changed; Task 6 was not started.

- Strict RED: focused boundary assertion first; `npx vitest run server/src/tests/platform-composition.test.ts --maxWorkers=1` → **1 file; 1 failed / 9 passed**. The focused test observed `http://127.0.0.1:57272` and raw `__Host-dnd_session=...` instead of HTTPS plus an opaque cookie-jar actor.
- GREEN: platform composition → **1 file / 10 passed**.
- Final focused Task 5 five-file command → **5 files / 74 passed**.
- Full suite → **74 files passed / 2 skipped; 627 passed / 22 skipped / 0 failed**.
- Server/contracts/client typechecks PASS; forbidden boundary scan and touched-file no-index diff check PASS.
- Safety: staging empty; default DB/WAL/SHM/key hashes unchanged; root key and instance locks absent; HEAD `641709e`.
- Detailed handoff: `docs/superpowers/validation/phase2-task5-platform-composition-fix.md`.

## Final independent acceptance

Fresh-context targeted reviewer `aeb89548` re-inspected the final tree and confirmed the former platform-composition test-boundary Major is closed: all HTTP-facing composition tests use pinned-CA ephemeral HTTPS, suite-scoped fetch restoration, and `TestCookieJar`; there is no raw `__Host-dnd_session` extraction or manual replay. It also confirmed the Task 5 authority/revision/epoch/audit/quiescent semantics remain intact.

**Final verdict: PASS / 0 Blocker / 0 Major / 0 Minor.** Final evidence remains focused Task 5 **74/74**, full suite **627 passed / 22 skipped / 0 failed**, server/contracts/client typechecks PASS, diff-check PASS, staging empty, default DB/WAL/SHM/key hashes unchanged, and root key/instance locks absent. Task 5 is accepted complete; Task 6 was not part of this acceptance run.
