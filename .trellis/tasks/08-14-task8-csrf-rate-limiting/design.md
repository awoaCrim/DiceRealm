# Design: Task 8 CSRF Foundation

> **Status: Deferred.** Retained for a later security-hardening milestone; do not implement now.

## Scope boundary

This task implements CSRF protection only. Rate limiting, threshold selection, bucket storage, and new `429 RATE_LIMITED` behavior are explicitly deferred. The task name remains the historical Task 8 identifier, but no limiter seam should be created as a placeholder.

## Server data flow

1. The existing request-security middleware performs basic request checks and exact `Origin === PUBLIC_ORIGIN` validation for state-changing methods.
2. Session and route-role middleware resolve the identity where required.
3. A reusable CSRF guard runs before `jsonBodyBudget(...)` and before any `req.body` access.
4. The existing endpoint parser applies its explicit body budget.
5. Strict contract parsing and service execution follow.

### Pre-auth store

Add a bounded in-memory store under `server/src/platform/http/csrf/` with injected clock/randomness. The store issues an opaque handle and raw token but persists only digests, purpose, expiry, and used state. Consumption is one-time and atomic from the caller's perspective. Invalid handle, token, purpose, expired, and replayed cases collapse to `CSRF_INVALID` without revealing whether register/login/bootstrap state exists.

Add `server/src/routes/securityRoutes.ts` for the no-body issuance endpoint. It must set the `__Host-dnd_preauth` cookie with secure HttpOnly attributes and return `Cache-Control: no-store`.

### Authenticated guard

Use the existing `authenticatedCsrf.ts` session-binding and timing-safe comparison conventions. Consolidate the check so every current mutation route can attach the same guard. The route list includes auth logout/logout-all, campaign mutations, character mutations/review, world mutations, turn actions/start, archive/restore, combat start/commands, rules mutations, and AI Provider/resolve mutations. Bodyless mutations still attach the guard.

Register/login use the purpose-specific pre-auth guard. `/me` remains a read-only recovery path and must preserve the existing missing-CSRF-cookie rotation behavior.

## Client data flow

`authApi` obtains a purpose-specific pre-auth token before register/login and passes it through the credentialed platform request. `platformHttp` continues to add the authenticated synchronizer token for state-changing requests. The client does not add limiter handling because rate limiting is outside this task.

## Tests and compatibility

- Unit-test the store lifecycle and bounded cleanup with an injected clock.
- Extend the HTTPS harness with isolated pre-auth cookie/token helpers.
- Add integration negatives for origin, CSRF absence/wrong value/replay/cross-session/purpose mismatch, and body-parser ordering.
- Preserve Task 7's exact-origin/security-header matrix, Task 5 session recovery, and existing valid auth/mutation behavior.
- Do not add bootstrap business logic, platform admin/invite/maintenance routes, migrations, or external dependencies.
