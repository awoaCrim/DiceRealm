# Implementation Plan: Task 8 CSRF Foundation

> **Status: Deferred.** Do not execute this plan in the current milestone.

## Ordered checklist

1. Load the server/client Trellis specs and re-read the Phase 2 security authority docs.
2. Add the bounded pre-auth CSRF store and security issuance route with purpose binding, opaque handle cookie, five-minute expiry, one-time consume, digest-only storage, and no-store response behavior.
3. Extract or extend the authenticated CSRF guard using the existing session binding and timing-safe comparison conventions.
4. Attach pre-auth or authenticated CSRF before body parsers across every current mutation route; preserve read-only/SSE exceptions and `/me` recovery.
5. Update the auth API and platform HTTP helper for pre-auth register/login and authenticated mutation headers.
6. Extend focused unit tests, HTTPS harness helpers, and the negative matrix for parser-order and oracle-prevention behavior.
7. Run focused tests, typechecks, and the Task 7 regression matrix. Do not add limiter tests or limiter code.

## Validation commands

```bash
npx vitest run server/src/platform/http/csrf/csrf.test.ts server/src/tests/http-security-negative-matrix.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1
```

Also run the affected server/client typechecks and the repository's full test/lint/build gates after the focused suite passes.

## Risk and rollback points

- Keep all CSRF checks before `jsonBodyBudget` and before `req.body` access.
- Preserve `__Host-dnd_session`, `__Host-dnd_csrf`, `/me` recovery, and session rotation semantics.
- If a mutation route is not yet compatible, fix its guard placement or test harness rather than weakening CSRF globally.
- If work begins to require rate thresholds, limiter storage, or future route families, stop and return to planning; those are explicitly deferred.
