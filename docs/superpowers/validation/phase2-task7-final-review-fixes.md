# Phase 2 Task 7 final review fixes

## Scope

Final narrow remediation for Task 7 HTTP front-door security only. No Task 8 CSRF/rate limiting, Task 9 static parser/strict DTO inventory, Task 10 bootstrap service/routes, admin or maintenance API, migration, or unrelated dependency work was added.

## Entry findings

The fresh post-review-fix reviews still found three active production/header issues:

1. Front-door rejection could occur before the auth router and omit `Cache-Control: no-store` on `/api/auth/*`.
2. Direct authoritative TLS followed by malformed trusted forwarding rejection could omit HSTS.
3. `securityHeaders` and `RequestSecurityPolicy.middleware()` each resolved request-derived security, creating duplicate authority evaluation and possible CORS emission before the authoritative rejection pass.

The reviews also required explicit sensitive evidence for normalized lowercase `forwarded`, direct client-IP validation, trusted forwarded HTTP, wrong-role authorization before malformed/oversized parsing, and allowed-role AI/Provider budgets.

## Process chronology

The delegated writer edited the new assertions before changing production code, but it did **not** execute the focused command between those two edits. Its first recorded focused execution after the production edits was green. Therefore this document does **not** claim a valid behavioral RED for this final narrow pass. The earlier Task 7 review-fix RED of 13 failures remains valid and separately recorded, but it does not retroactively prove these final three defects.

This is an explicit process-evidence gap for the final narrow pass, not a hidden or fabricated TDD claim. The behavioral sensitivity of the final matrix is established by direct assertions and repeated green execution; fresh reviewers must classify whether the missing pre-production RED chronology is dispositionable or acceptance-blocking under the approved strict-TDD process.

## Production GREEN

- `server/src/app.ts` installs path-local `/api/auth` `Cache-Control: no-store` before fixed headers and request-policy enforcement. Router-level auth `no-store` remains defense in depth.
- `server/src/platform/http/securityHeaders.ts` now installs invariant CSP, Referrer-Policy, Permissions-Policy, nosniff, and `Vary: Origin` only.
- `server/src/platform/http/RequestSecurityPolicy.ts` owns the single authoritative request-security resolution and enforcement pass.
- Direct TLS sets HSTS before later host/origin/client-IP rejection. A successfully resolved authoritative HTTP result removes HSTS and returns safe `FORBIDDEN`.
- Exact CORS headers are emitted only after a successful full resolution and only for an exact allowed non-null origin.
- Malformed policy-derived inputs remain safe `FORBIDDEN` JSON without raw details.

## Sensitive evidence

`server/src/tests/http-security-negative-matrix.test.ts` now covers:

- auth wrong-Host and malformed trusted-XFF rejection with safe JSON, auth `no-store`, fixed headers, and direct-TLS HSTS;
- isolated trusted `X-Forwarded-Proto: http` with a valid forwarded IPv4 and host, returning application 403 without HSTS;
- normalized lowercase `forwarded` rejection on a trusted peer;
- invalid direct remote addresses and valid direct IPv4/IPv6;
- one authoritative `resolve()` call across fixed headers and enforcement;
- exact CORS and no wildcard credentials;
- auth success, 404, parser, and payload-limit `no-store` responses;
- wrong-role malformed and oversized bodies rejected before parsers for campaign settings, character create/update, turn actions, AI resolve, and Provider save/test;
- allowed-role AI resolve over 8 KiB and Provider save/test over 16 KiB returning 413, with no Provider network call;
- SSE rejection before event-stream headers. The existing live-stream suite separately retains `no-cache`, `no-transform`, and `X-Accel-Buffering: no` assertions.

A complete static route/parser inventory and strict DTO inventory remain intentionally deferred to Task 9.

## Independent parent validation

Commands were rerun by the parent against the final current tree after the last characterization assertions:

- Matrix: `npx vitest run server/src/tests/http-security-negative-matrix.test.ts --maxWorkers=1` → **1 file / 49 passed**.
- Focused Task 7: `npx vitest run server/src/tests/config.test.ts server/src/tests/http-security-negative-matrix.test.ts server/src/tests/platform-composition.test.ts --maxWorkers=1` → **3 files / 65 passed**.
- Affected auth/AI/rules/realtime/vertical/startup: **7 files / 100 passed**.
- Full suite: `npx vitest run --maxWorkers=1` → **77 files passed / 2 skipped; 697 passed / 22 skipped**.
- Server, contracts, and client no-emit typechecks: **PASS**.
- `git diff --check`: **PASS**, with inherited LF→CRLF warnings only.
- Staging: **empty**.
- `server/.dnd-instance.lock`, `.dnd-instance.lock`, and root `.dnd-ai-credential-key`: **absent**.
- Default hashes unchanged:
  - DB `b0b74c555515fc328e8d2908335e35af2fb4af3ed28f2f2752c3bcf1f0b27f96`
  - WAL `0849cfbe850859d8f68a170e37ec24e07cf9fe97aa52023dd6ce84ab3eb5577b`
  - SHM `1b2c5181027e6df211419a70e0cbaa45e297b853e8ac1cfb91d21dd64810d381`
  - credential key `63412f0702525078b826dcecf9ae9dadd2e593fe21dc9faaea5beb1aabf5f776`

The delegated workflow's final status was `failed` only because its custom fenced acceptance report used unsupported field names. The child edits and test runs completed; the parent did not treat that parser failure as implementation evidence and reran every gate independently.

## Post-review active findings and valid RED → GREEN

Fresh workflow `c5fef784-2b4f-47d3-bece-058dcd3cd0da` returned REVISE. Its active implementation/evidence findings were:

- CORS credentials headers were emitted before final HTTPS/Host/mutation-origin front-door acceptance.
- A trusted peer could send standardized `Forwarded` together with `X-Forwarded-*`; the former was silently ignored instead of treating the authority set as ambiguous.
- Allowed-role runtime evidence was missing for the configured character 256 KiB budget and the 64 KiB world/turn/archive/combat/rules budgets.

A new narrow test-first pass then produced a valid RED before production edits:

- Command: `npx vitest run server/src/tests/http-security-negative-matrix.test.ts --maxWorkers=1`
- Result: **1 failed file; 2 failed / 47 passed**.
- Failures:
  1. mixed trusted `Forwarded` + `X-Forwarded-*` did not throw;
  2. wrong authoritative Host with an otherwise allowed Origin returned `Access-Control-Allow-Origin` instead of no CORS header.

The same test edit also added characterization coverage for rejected-response CORS absence and allowed-role 256/64 KiB controls. These budget assertions were not called RED because the production budget map was already correct.

Minimum GREEN:

- trusted standardized `Forwarded` is now rejected whenever present, including mixed/conflicting forwarding mechanisms;
- HTTPS/Host/mutation-origin/preflight acceptance completes before exact CORS headers are emitted;
- wrong Host, malformed forwarding, authoritative HTTP, and conflicting forwarding assert no `Access-Control-Allow-Origin` or credential header;
- player character create/update over 256 KiB and owner/player allowed-role world/turn/archive/combat/rules requests over 64 KiB return `413 PAYLOAD_TOO_LARGE`;
- Provider network calls remain zero during all rejected oversize requests.

Post-fix parent validation:

- matrix **49 passed**;
- focused **3 files / 65 passed**;
- affected **7 files / 100 passed**;
- full **77 files passed / 2 skipped; 697 passed / 22 skipped**;
- three typechecks, diff/staging/safety and exact hash gates passed.

## Final independent disposition

Fresh read-only closeout mission `72f04257-1fd1-4106-9815-ad1de1481a95` completed two independent lanes:

- security closeout run `0a5e6a89`: **PASS**;
- authorization/budget/process closeout run `74da2939`: **PASS**.

Both reviewers found **0 Blocker / 0 Major / 0 active Minor / 1 dispositioned process Minor** and explicitly authorized Task 7 acceptance and the start of Task 8. They independently confirmed the final CORS sequencing, trusted forwarding fail-closed semantics, no-store/HSTS/single-resolution behavior, exact CORS/preflight, body-budget and authorization ordering evidence, service-level defense in depth, SSE headers, pinned-CA TLS, strict configuration, and the parent validation gates.

The dispositioned Minor is the earlier missing executed RED for the preceding auth-no-store/HSTS/single-resolve narrow pass. It remains honestly recorded and is not retroactively cured or fabricated. Reviewers classified it as non-blocking because the earlier review-fix cycle has valid 13-failure RED evidence, the later CORS/forwarding cycle has independent valid **2 failed / 47 passed → 49 passed** evidence, current tests directly cover the affected behaviors, and no active implementation or evidence defect remains.

**Task 7 is independently accepted complete. Task 8 may begin; Tasks 8/9 have not yet started in this closeout.**
