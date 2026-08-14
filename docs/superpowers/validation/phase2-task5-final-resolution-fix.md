# Phase 2 Task 5 Final Resolution Fix

## Scope and verdict boundary

This focused checkpoint fixes the remaining Phase 2 Task 5 session-resolution Major and the diagnosed unrelated order-sensitive test. Task 6 was not started. This handoff reports implementation and validation evidence only; it does not claim independent acceptance.

## Strict TDD evidence

### Session authority RED

Tests were added first to `server/src/modules/identity/identity.test.ts` and `server/src/tests/authCampaignRoutes.test.ts`, then run against the pre-fix production implementation:

```text
npx vitest run server/src/modules/identity/identity.test.ts server/src/tests/authCampaignRoutes.test.ts --maxWorkers=1
Test Files 2 failed (2)
Tests 5 failed | 47 passed (52)
```

Exact failures:

1. `valid quiescent resolve returns the binding without changing session or audit columns`: `last_seen_at` changed from `2026-08-12T00:00:00.000Z` to `2026-08-12T00:05:00.000Z`, and `idle_expires_at` changed from `2026-08-12T12:00:00.000Z` to `2026-08-12T12:05:00.000Z`.
2. `quiescent /me with an existing CSRF cookie performs zero session or audit writes`: HTTP `/me` changed `last_seen_at` and `idle_expires_at`.
3. `quiescent /me with missing CSRF changes only csrf_digest`: HTTP `/me` changed `last_seen_at` and `idle_expires_at` in addition to the allowed CSRF digest rotation.
4. The two new pausing-database race tests initially failed because the first test seam had a test-only method/property naming error (`TypeError: pausingDb.release is not a function`). That test defect was corrected before production code was changed. The behavioral RED above remained real and directly pinned the production quiescent-write defect. The race tests then served as GREEN regression gates for queue serialization.

### Order-sensitive test RED

Before editing the order assertion, the existing state-change-materializer test was looped 30 times:

```text
for i in $(seq 1 30); do npx vitest run server/src/modules/ai-runtime/state-change-materializer.test.ts --maxWorkers=1; done
ORDER_RED_FAILURES=4/30
```

Each failing iteration had exactly 1 positional assertion failure at `rows[1].visibility`; observed unexpected values included `owner_only` and `public` instead of `player_private`.

## Implementation

### Authoritative valid resolution

- `IdentityService.resolveSession` is now one `DatabasePort.transaction` operation.
- The joined session/account row is reread inside the serialized transaction, validated there, and the returned binding is derived from that authoritative row.
- Unknown rows return unauthenticated from the same operation.
- Invalid cleanup remains in that transaction through a non-nesting helper; active/draining invalid rows are conditionally revoked and audited atomically, while quiescent invalid rows remain zero-write.
- Valid active/draining resolution reads maintenance state and conditionally updates idle fields only if session/account authority still matches: token digest, CSRF digest, captured auth revision, revoke epoch, non-revoked state, active account, and matching current account revision. A losing update returns unauthenticated.
- Valid quiescent resolution returns the authoritative binding without session or audit writes.

### CSRF authority read

- `resolveSessionForCsrf` remains side-effect-free.
- It now uses `DatabasePort.readCommitted`, sharing SQLite's transaction/read FIFO and using PostgreSQL's short read-only transaction.
- A reusable repository static read accepts `QueryReader`, avoiding a write-capable repository construction on the read-only path.

### Deterministic race regression

- Added a narrow `PausingAuthorityDatabase` wrapper in the identity test only; no production timing hook was introduced.
- It pauses immediately after the real joined authority query resolves, allowing logout-current or logout-all to be queued.
- Tests assert queued revocation cannot finish before the paused authoritative resolve/read is released, the pre-revocation resolve may finish as valid, and every subsequent resolve is unauthenticated. They also assert a valid result is never observed after revocation has committed.
- The same seam verifies side-effect-free CSRF authority reads serialize against logout.

### Maintenance/HTTP regressions

Added coverage for:

- valid quiescent service resolution: binding returned, exact session/audit rows unchanged;
- valid active resolution refreshes `last_seen_at` and `idle_expires_at`;
- valid draining resolution refreshes those fields;
- HTTP quiescent `/me` with an existing CSRF cookie: no session/audit writes and no Set-Cookie;
- HTTP quiescent `/me` with a missing CSRF cookie: only `csrf_digest` changes; last-seen, idle expiry, revoke fields, and audit rows stay unchanged;
- existing invalid quiescent zero-write behavior remains covered;
- existing CSRF conditional recovery and `Cache-Control: no-store` behavior remains covered.

### Order-test diagnosis and fix

The production/query contract only orders these rows by `created_at`. The three creations call `new Date().toISOString()` in a tight loop, so timestamp ties are legitimate; SQL `ORDER BY created_at ASC` does not specify insertion order among tied rows, and SQLite may return a different tie order depending on its scan/index plan. No product contract found promises input/insertion order for tied world-fact timestamps. Therefore production ordering and timestamps were not changed. The test now indexes the returned rows by stable `title` and asserts each creation's own fields.

Order GREEN loop:

```text
30 isolated runs of state-change-materializer.test.ts
ORDER_GREEN_FAILURES=0/30
```

## Validation

- Focused Task 5 command: **5 files / 73 passed / 0 failed**.
- Wider affected HTTP/realtime command: **8 files / 34 passed / 0 failed**.
- Repeated order regression: **30/30 iterations passed** after the test-only fix.
- Final full `npx vitest run --maxWorkers=1`: **74 files passed / 2 skipped; 626 tests passed / 22 skipped; 0 failed**.
- Server, contracts, and client no-emit typechecks: PASS.
- Touched-scope `git diff --check`: PASS; only Windows LF-to-CRLF warnings were emitted.

## Safety gates

- Staging is empty.
- Default hashes are unchanged:
  - `server/dnd.sqlite`: `b0b74c555515fc328e8d2908335e35af2fb4af3ed28f2f2752c3bcf1f0b27f96`
  - `server/dnd.sqlite-wal`: `0849cfbe850859d8f68a170e37ec24e07cf9fe97aa52023dd6ce84ab3eb5577b`
  - `server/dnd.sqlite-shm`: `1b2c5181027e6df211419a70e0cbaa45e297b853e8ac1cfb91d21dd64810d381`
  - `server/.dnd-ai-credential-key`: `63412f0702525078b826dcecf9ae9dadd2e593fe21dc9faaea5beb1aabf5f776`
- Root `.dnd-ai-credential-key` absent.
- Root and server instance locks absent.
- No `git add`, commit, amend, stash, reset, clean, or checkout was used.
- Tests used memory SQLite and ephemeral HTTPS fixtures only.

## Changed files for this focused fix

- `server/src/modules/identity/IdentityService.ts`
- `server/src/modules/identity/IdentityRepository.ts`
- `server/src/modules/identity/identity.test.ts`
- `server/src/tests/authCampaignRoutes.test.ts`
- `server/src/modules/ai-runtime/state-change-materializer.test.ts`
- `docs/superpowers/validation/phase2-task5-ledger.md`
- `docs/superpowers/validation/phase2-implementation-ledger.md`
- `docs/superpowers/validation/phase2-task5-final-resolution-fix.md`

## Residuals

- Independent review remains required; no acceptance claim is made here.
- Task 6 SessionAuthority/realtime revocation work was deliberately not started.
- The environment still emits the pre-existing `NODE_TLS_REJECT_UNAUTHORIZED=0` warning; repository HTTPS tests continue to use the pinned fixture CA adapter, and no production TLS bypass was added.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Task 5 resolveSession and resolveSessionForCsrf authority serialization, maintenance-aware writes, race regressions, and the diagnosed order-test-only correction were implemented without starting Task 6."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Recorded real RED failures, focused/wider/order/full GREEN counts, typechecks, hashes, staging state, changed files, and residuals for independent review."
    }
  ],
  "changedFiles": [
    "server/src/modules/identity/IdentityService.ts",
    "server/src/modules/identity/IdentityRepository.ts",
    "server/src/modules/identity/identity.test.ts",
    "server/src/tests/authCampaignRoutes.test.ts",
    "server/src/modules/ai-runtime/state-change-materializer.test.ts",
    "docs/superpowers/validation/phase2-task5-ledger.md",
    "docs/superpowers/validation/phase2-implementation-ledger.md",
    "docs/superpowers/validation/phase2-task5-final-resolution-fix.md"
  ],
  "testsAddedOrUpdated": [
    "server/src/modules/identity/identity.test.ts",
    "server/src/tests/authCampaignRoutes.test.ts",
    "server/src/modules/ai-runtime/state-change-materializer.test.ts"
  ],
  "commandsRun": [
    {
      "command": "npx vitest run server/src/modules/identity/identity.test.ts server/src/tests/authCampaignRoutes.test.ts --maxWorkers=1",
      "result": "failed",
      "summary": "Pre-production-fix RED: 2 files, 5 failed and 47 passed; three production failures proved quiescent idle writes, plus two initial test-seam naming failures corrected before production edits."
    },
    {
      "command": "30x npx vitest run server/src/modules/ai-runtime/state-change-materializer.test.ts --maxWorkers=1 (pre-fix)",
      "result": "failed",
      "summary": "Order RED: 4 of 30 iterations failed at the positional rows[1] visibility assertion."
    },
    {
      "command": "npx vitest run server/src/modules/identity/sessionTokens.test.ts server/src/modules/identity/identity.test.ts server/src/tests/authCampaignRoutes.test.ts server/src/tests/platform-composition.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1",
      "result": "passed",
      "summary": "Final focused Task 5 suite: 5 files, 73 tests passed."
    },
    {
      "command": "npx vitest run server/src/tests/authCampaignRoutes.test.ts server/src/tests/ai-routes-http.test.ts server/src/tests/vertical-ai-resolution-http.test.ts server/src/tests/vertical-characters-http.test.ts server/src/tests/vertical-world-outbox-turns-http.test.ts server/src/tests/realtime-events-http.test.ts server/src/tests/rules-routes-http.test.ts server/src/tests/vertical-sse-combat-http.test.ts --maxWorkers=1",
      "result": "passed",
      "summary": "Wider affected HTTP/realtime suite: 8 files, 34 tests passed."
    },
    {
      "command": "30x npx vitest run server/src/modules/ai-runtime/state-change-materializer.test.ts --maxWorkers=1 (post-fix)",
      "result": "passed",
      "summary": "Order regression GREEN: 30 of 30 iterations passed."
    },
    {
      "command": "npx vitest run --maxWorkers=1",
      "result": "passed",
      "summary": "Final full suite: 74 files passed, 2 skipped; 626 tests passed, 22 skipped; 0 failed."
    },
    {
      "command": "npx tsc -p server/tsconfig.json --noEmit; npx tsc -p packages/contracts/tsconfig.json --noEmit; npx tsc -p client/tsconfig.json --noEmit",
      "result": "passed",
      "summary": "Server, contracts, and client typechecks passed."
    },
    {
      "command": "git diff --check -- <touched scope>",
      "result": "passed",
      "summary": "No whitespace errors; only LF-to-CRLF warnings."
    }
  ],
  "validationOutput": [
    "Focused: 5 files / 73 passed / 0 failed",
    "Wider HTTP/realtime: 8 files / 34 passed / 0 failed",
    "Order regression: 30/30 passed after 4/30 RED reproduction",
    "Full: 74 files passed / 2 skipped; 626 passed / 22 skipped / 0 failed",
    "Default DB/WAL/SHM/key hashes unchanged",
    "Staging empty; root key and instance locks absent"
  ],
  "residualRisks": [
    "Independent review is still required.",
    "Task 6 was not started.",
    "Machine environment emits the pre-existing NODE_TLS_REJECT_UNAUTHORIZED=0 warning."
  ],
  "noStagedFiles": true,
  "diffSummary": "Serialized authoritative session resolution and CSRF authority reads, made valid idle refresh conditional and quiescent resolution zero-write, added deterministic revocation races and HTTP maintenance regressions, and replaced an unsupported positional order assertion with stable title-keyed assertions.",
  "reviewFindings": [
    "no known blocker after focused, wider, repeated-order, typecheck, and full-suite validation",
    "review gate remains required"
  ],
  "manualNotes": "Dirty-tree changes were preserved in place. No raw session or CSRF secret was added to public responses, logs, or audit metadata."
}
```
