# Phase 2 Task 7 validation ledger

## Scope

Task 7 implements the approved HTTP front-door seam only: canonical origin/TLS/trusted-proxy policy, exact CORS, fixed security headers, explicit security configuration, route-local JSON budgets, authorization-before-parser ordering, auth `no-store`, safe error envelopes, and pinned-CA HTTPS test infrastructure. Task 8 CSRF/rate limiting, Task 9 strict DTO/static parser inventory, Task 10+ services/routes, and migrations after 014 remain out of scope.

## Initial RED / GREEN

- Before the matrix existed, the required focused command was run. Existing config/composition tests passed **16 tests** and the matrix file was absent; no behavioral RED was fabricated.
- After the initial matrix was added, the first run had **26 tests / 2 failures**: partial bootstrap configuration was accepted, and the initial cleartext assertion incorrectly expected an HTTP response from an HTTPS listener. The bootstrap parser was fixed; the test was corrected to assert that no HTTP fallback exists.
- Initial focused GREEN: **3 files / 42 passed**.
- Initial wider HTTP/SSE GREEN: **6 files / 65 passed**.

## First independent review and remediation

The initial implementation was rejected at **REVISE / 0 Blocker / 6 Major / 7 Minor**. The review-fix writer produced a valid focused RED of **13 failures** and corrected canonical bootstrap configuration, client-IP validation, default ports, fixed headers, safe policy rejection, authorization-before-parser ordering, auth router `no-store`, and AI/Provider budgets.

Parent validation after that pass:

- focused **3 files / 59 passed**;
- affected **7 files / 94 passed**;
- full **691 passed / 22 skipped**;
- three typechecks and all safety/hash gates passed.

Details: [`phase2-task7-review-fixes.md`](./phase2-task7-review-fixes.md).

## Final narrow review fix

A subsequent fresh review remained REVISE because auth front-door rejection could miss `no-store`, direct-TLS malformed-forwarding rejection could miss HSTS, request security was resolved twice, and sensitive evidence was incomplete.

The final narrow production shape is:

- path-local auth `no-store` before front-door enforcement;
- invariant fixed headers before enforcement;
- exactly one authoritative policy resolution/enforcement pass;
- direct-TLS HSTS retained on later rejection, authoritative HTTP without HSTS;
- exact CORS only after successful resolution;
- route-local parser budgets after role checks;
- safe JSON policy/parser/payload errors.

The final writer did not run its new assertions between test edits and production edits, so no final-pass behavioral RED is claimed. This explicit process gap is awaiting independent classification; it does not erase the earlier valid 13-failure review-fix RED.

## Final current-tree validation

- Security matrix: **1 file / 49 passed**.
- Focused config/security/composition: **3 files / 65 passed**.
- Affected auth/AI/rules/realtime/vertical/startup: **7 files / 100 passed**.
- Full suite: **77 files passed / 2 skipped; 697 passed / 22 skipped**.
- Server/contracts/client typechecks: **PASS**.
- Diff/staging/lock/root-key safety: **PASS**.
- Default DB/WAL/SHM/key hashes: **exactly unchanged**.
- Pinned CA and `rejectUnauthorized: true` remain in the shared HTTPS harness.

Details: [`phase2-task7-final-review-fixes.md`](./phase2-task7-final-review-fixes.md).

## Final post-review RED → GREEN

The first final acceptance workflow still returned REVISE. Active findings were premature CORS on rejected front-door requests, trusted mixed `Forwarded`/`X-Forwarded-*` ambiguity, and missing allowed-role 64/256 KiB black-box evidence.

A new valid RED was executed before production changes:

- matrix result: **2 failed / 47 passed**;
- mixed trusted forwarding did not reject;
- wrong-Host rejection still returned credentialed CORS headers.

Minimum GREEN rejects any trusted standardized `Forwarded`, emits exact CORS only after HTTPS/Host/origin/preflight acceptance, asserts no CORS on rejected responses, and adds runtime 413 evidence for character 256 KiB plus world/turn/archive/combat/rules 64 KiB budgets.

Final parent gate after that fix:

- matrix **49 passed**;
- focused **65 passed**;
- affected **100 passed**;
- full **697 passed / 22 skipped**;
- all three typechecks and all safety/hash gates passed.

The previous final-pass chronology gap remains documented rather than rewritten.

## Final independent acceptance

Fresh read-only closeout mission `72f04257-1fd1-4106-9815-ad1de1481a95` returned unanimous PASS:

- security closeout `0a5e6a89`: CORS ordering, trusted forwarding, HSTS/no-store/safe errors, fixed headers, exact preflight, TLS pinning, configuration, and no permissive fallback all correct;
- authorization/budget/process closeout `74da2939`: authorization-before-parser, resource hiding, service defense in depth, 8/16/32/64/256 KiB controls, Provider zero-call evidence, and SSE behavior all correct.

Final counts: **0 Blocker / 0 Major / 0 active Minor / 1 dispositioned process Minor**. The dispositioned Minor is the transparently documented missing executed RED in the preceding no-store/HSTS/single-resolve narrow pass. It is non-blocking after the separate valid 13-failure review-fix RED, the new valid **2 failed / 47 passed → 49 passed** CORS/forwarding RED→GREEN, direct current coverage, and green parent gates.

## Status

Task 7 is **complete and independently accepted**. Task 8 may begin, but Task 8 and Task 9 have not started in this closeout.
