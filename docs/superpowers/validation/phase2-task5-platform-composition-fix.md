# Phase 2 Task 5 Platform Composition Test-Boundary Fix

## Scope

Fixed only the final Phase 2 Task 5 acceptance Major in `server/src/tests/platform-composition.test.ts`. The two pure composition-root tests still construct `createPlatformApp` directly. Only HTTP-facing tests were converted to the shared pinned-CA ephemeral HTTPS harness. No production behavior changed and Task 6 was not started.

## Strict TDD evidence

### RED

A focused boundary test was added first. It required the local HTTP test server URL to use `https://` and registration/login to return an opaque actor exposing a cookie jar rather than a raw cookie string.

Command:

`npx vitest run server/src/tests/platform-composition.test.ts --maxWorkers=1`

Pre-fix result: **1 file failed; 1 failed / 9 passed (10 total)**. Vitest reported two assertions within the focused test:

- received `http://127.0.0.1:57272` instead of matching `^https://`;
- received raw `__Host-dnd_session=...` instead of an object containing `cookieJar`.

### GREEN

The file now:

- imports and uses `startTestPlatformServer`, `registerAndLogin`, and `TestCookieJar` from `httpTestHarness.ts`;
- installs the harness fetch adapter in `beforeAll` and restores it in `afterAll`;
- keeps direct `createPlatformApp` construction in the first two pure composition tests;
- uses `actor.cookieJar.header()` only while forming request headers;
- has no local server bootstrap, raw `Set-Cookie` parsing, or raw session-cookie return value;
- preserves composition checks for route mounting, safe legacy 404s, unified errors, and injected AI provider reachability.

Focused GREEN command:

`npx vitest run server/src/tests/platform-composition.test.ts --maxWorkers=1`

Result: **1 file / 10 passed / 0 failed**.

## Validation

- Final focused Task 5 five-file command:
  `npx vitest run server/src/modules/identity/sessionTokens.test.ts server/src/modules/identity/identity.test.ts server/src/tests/authCampaignRoutes.test.ts server/src/tests/platform-composition.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1`
  → **5 files / 74 passed / 0 failed**.
- Full suite:
  `npx vitest run --maxWorkers=1`
  → **74 files passed / 2 skipped; 627 tests passed / 22 skipped; 0 failed**.
- Typechecks:
  `npx tsc -p server/tsconfig.json --noEmit && npx tsc -p packages/contracts/tsconfig.json --noEmit && npx tsc -p client/tsconfig.json --noEmit`
  → PASS.
- Boundary scan for `app.listen(0)`, `http://127.0.0.1`, raw session regex, and `cookieHeader` in `platform-composition.test.ts` → no matches.
- Touched test file no-index whitespace check → no whitespace errors. The file is untracked in the inherited dirty tree, so ordinary `git diff --check -- <file>` has no tracked diff to inspect.
- No production files were changed by this fix.

## Safety

- HEAD remains `641709e`.
- Staging is empty.
- Default hashes remain unchanged:
  - `server/dnd.sqlite`: `b0b74c555515fc328e8d2908335e35af2fb4af3ed28f2f2752c3bcf1f0b27f96`
  - `server/dnd.sqlite-wal`: `0849cfbe850859d8f68a170e37ec24e07cf9fe97aa52023dd6ce84ab3eb5577b`
  - `server/dnd.sqlite-shm`: `1b2c5181027e6df211419a70e0cbaa45e297b853e8ac1cfb91d21dd64810d381`
  - `server/.dnd-ai-credential-key`: `63412f0702525078b826dcecf9ae9dadd2e593fe21dc9faaea5beb1aabf5f776`
- Root `.dnd-ai-credential-key` absent.
- Root/server instance locks absent.
- No git add/commit/amend/stash/reset/clean/checkout was used.
- Tests used memory SQLite and ephemeral HTTPS only.

## Changed files for this narrow fix

- `server/src/tests/platform-composition.test.ts`
- `docs/superpowers/validation/phase2-task5-ledger.md`
- `docs/superpowers/validation/phase2-implementation-ledger.md`
- `docs/superpowers/validation/phase2-task5-platform-composition-fix.md`
- `.pi/subagents/artifacts/outputs/64bd80f9/docs/superpowers/validation/phase2-task5-platform-composition-fix.md`

## Residuals

- Node prints the inherited machine-level `NODE_TLS_REJECT_UNAUTHORIZED=0` warning during HTTPS tests. This fix does not set or broaden that environment behavior; the repository harness still uses its pinned fixture CA and restores the fetch adapter.
- Independent review still follows.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Converted only platform-composition HTTP tests to the existing pinned-CA HTTPS harness and cookie-jar actor boundary; pure composition tests and production behavior were unchanged, and Task 6 was not started."
    }
  ],
  "changedFiles": [
    "server/src/tests/platform-composition.test.ts",
    "docs/superpowers/validation/phase2-task5-ledger.md",
    "docs/superpowers/validation/phase2-implementation-ledger.md",
    "docs/superpowers/validation/phase2-task5-platform-composition-fix.md",
    ".pi/subagents/artifacts/outputs/64bd80f9/docs/superpowers/validation/phase2-task5-platform-composition-fix.md"
  ],
  "testsAddedOrUpdated": [
    "server/src/tests/platform-composition.test.ts"
  ],
  "commandsRun": [
    {
      "command": "npx vitest run server/src/tests/platform-composition.test.ts --maxWorkers=1 (RED)",
      "result": "failed",
      "summary": "1 file; 1 failed / 9 passed. The focused test observed plain HTTP and a raw __Host-dnd_session string."
    },
    {
      "command": "npx vitest run server/src/tests/platform-composition.test.ts --maxWorkers=1 (GREEN)",
      "result": "passed",
      "summary": "1 file / 10 tests passed."
    },
    {
      "command": "npx vitest run server/src/modules/identity/sessionTokens.test.ts server/src/modules/identity/identity.test.ts server/src/tests/authCampaignRoutes.test.ts server/src/tests/platform-composition.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1",
      "result": "passed",
      "summary": "Final focused Task 5 suite: 5 files / 74 tests passed."
    },
    {
      "command": "npx vitest run --maxWorkers=1",
      "result": "passed",
      "summary": "74 files passed / 2 skipped; 627 tests passed / 22 skipped."
    },
    {
      "command": "npx tsc -p server/tsconfig.json --noEmit && npx tsc -p packages/contracts/tsconfig.json --noEmit && npx tsc -p client/tsconfig.json --noEmit",
      "result": "passed",
      "summary": "Server, contracts, and client typechecks passed."
    },
    {
      "command": "boundary forbidden-token scan and touched-file no-index diff check",
      "result": "passed",
      "summary": "No app.listen(0), plain loopback HTTP URL, raw session regex, cookieHeader, or whitespace error in platform-composition.test.ts."
    }
  ],
  "validationOutput": [
    "RED: 1 file; 1 failed / 9 passed (10 total)",
    "GREEN platform composition: 1 file / 10 passed",
    "Focused Task 5: 5 files / 74 passed",
    "Full: 74 files passed / 2 skipped; 627 passed / 22 skipped",
    "Server/contracts/client typechecks passed",
    "Default hashes unchanged; staging empty; root key and locks absent"
  ],
  "residualRisks": [
    "Inherited machine-level NODE_TLS_REJECT_UNAUTHORIZED=0 warning remains outside this repository fix.",
    "Independent review is still required."
  ],
  "noStagedFiles": true,
  "diffSummary": "Removed the local plain-HTTP/manual-cookie helpers from platform-composition tests, reused the shared ephemeral HTTPS harness, scoped/restored its fetch adapter, and passed TestCookieJar headers only at request construction.",
  "reviewFindings": [
    "no blockers in the narrow Task 5 platform-composition boundary after focused and full validation"
  ],
  "manualNotes": "The inherited tree is heavily dirty and these validation files are untracked; unrelated changes were preserved."
}
```
