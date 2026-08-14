# Phase 2 Task 7 review fixes

## Scope

This ledger records the first independent-review remediation pass for Phase 2 Task 7 only. Task 8 CSRF/rate limiting, Task 9 strict DTO inventory, Task 10 bootstrap service/routes, admin/maintenance APIs, migrations beyond 014, and unrelated dependencies remained out of scope.

## Review entry

The first fresh correctness/security/operability review rejected the initial Task 7 implementation at **REVISE / 0 Blocker / 6 Major / 7 Minor**. Confirmed issues included non-canonical bootstrap-secret validation, unvalidated authoritative client IP values, authorization after body parsing on sensitive campaign/character/turn/AI operations, inconsistent default-port handling, incomplete auth `no-store`, unsafe forwarding rejection, fixed headers installed too late, an oversized shared AI parser budget, and missing negative evidence.

## RED → GREEN evidence

The review-fix writer added security assertions before its production corrections. The focused RED produced **13 failures**, covering default-port canonicalization, illegal bootstrap configuration, and invalid trusted `X-Forwarded-For` values.

The narrow GREEN then added:

- exact 43-character canonical unpadded base64url bootstrap-secret validation with a strict 32-byte round trip;
- bounded opaque bootstrap database-ID validation;
- default-port normalization for HTTPS `:443` and HTTP `:80`;
- exact direct/trusted IPv4 or IPv6 validation and safe `FORBIDDEN` policy rejection;
- fixed security headers before rejection and exact HSTS/CORS behavior;
- owner/player authorization guards before route-local parsers for campaign settings, character mutation, turn actions, AI resolve, and Provider configuration;
- route-wide auth `Cache-Control: no-store` inside the auth router;
- AI resolve/retry `8kb` and Provider save/test `16kb` budgets;
- valid SSE `no-transform` and `X-Accel-Buffering: no` assertions.

Service-level authorization checks and campaign resource-hiding semantics were retained as defense in depth.

## Parent validation after the first review-fix pass

- Focused Task 7: **3 files / 59 passed**.
- Affected HTTP/SSE/startup: **7 files / 94 passed**.
- Full suite: **691 passed / 22 skipped**.
- Server, contracts, and client typechecks passed.
- `git diff --check` passed apart from inherited LF→CRLF warnings; staging stayed empty.
- Server/root instance locks and the root credential key were absent.
- Default SQLite/WAL/SHM/key hashes remained unchanged.

## Remaining review disposition

The next fresh review still returned **REVISE with no Blocker**. It identified three production/header issues plus sensitive evidence gaps:

1. `/api/auth/*` rejection before the auth router could omit `Cache-Control: no-store`.
2. Direct TLS requests rejected on malformed trusted forwarding could omit HSTS.
3. Fixed-header and enforcement middleware resolved request security twice, allowing split authority and premature CORS emission.
4. The matrix still needed explicit direct-IP/lowercase-`forwarded`/trusted-forwarded-HTTP evidence, wrong-role malformed/oversize parser-order evidence, and allowed-role AI/Provider budget controls.

Those items are handled and revalidated in [`phase2-task7-final-review-fixes.md`](./phase2-task7-final-review-fixes.md). Task 7 remained `in_progress` at this checkpoint.
