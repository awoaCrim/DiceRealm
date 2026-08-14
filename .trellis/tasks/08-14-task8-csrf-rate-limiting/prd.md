# Task 8: CSRF Foundation (rate limiting deferred)

> **Status: Deferred.** Do not start this task in the current milestone; prioritize the main product flow first.

## Goal

Close the HTTP admission-control gap for the current platform routes: state-changing requests must prove exact same-origin intent and the correct CSRF credential before body parsing. The client and test harness must exercise the same contract.

Rate limiting is explicitly deferred by product decision and is not implemented or partially stubbed by this task.

## Confirmed requirements

1. Enforce exact `Origin === PUBLIC_ORIGIN` for state-changing requests; missing, null, wrong scheme, host, or port must fail without exposing application state. Preserve the Task 7 request-security behavior and headers.
2. Add `GET /api/security/preauth-csrf?purpose=bootstrap|register|login` with a raw `{ csrfToken }` response, an opaque HttpOnly Secure `__Host-dnd_preauth` handle cookie, `Cache-Control: no-store`, five-minute TTL, purpose binding, one-time atomic consumption, bounded storage/cleanup, and constant-time digest comparisons.
3. Integrate pre-auth validation before body parsing for the currently implemented register/login paths. Keep the bootstrap purpose/issuance seam generic, but do not implement the future bootstrap service or completion route.
4. Apply the authenticated synchronizer-token guard before the parser to every currently implemented state-changing route: auth logout paths, campaign, character, world, turn, archive, combat, rules, and AI mutations. Bodyless mutations require CSRF too. Existing `/me` recovery and session/CSRF rotation behavior must remain intact.
5. Leave read-only GET/HEAD and SSE without inbound CSRF, while retaining their documented non-CSRF admission behavior.
6. Use the existing `CSRF_INVALID` safe error envelope for missing, wrong, expired, replayed, cross-session, and purpose-mismatched credentials. Pre-auth failures must not reveal bootstrap, invite, account, or session state.
7. Update `platformHttp` and auth API flow so pre-auth credentials are obtained for register/login and authenticated state-changing requests carry `X-CSRF-Token`. Do not add rate-limit retry behavior or a limiter client contract.
8. Extend the HTTPS test harness and negative matrix to prove missing/wrong/replayed/cross-session/purpose-mismatched CSRF, origin failures, parser-order protection, trusted-forwarding behavior, and no state oracle on pre-auth failure.
9. Do not add `express-rate-limit`, Redis, `helmet`, `cookie-parser`, a default/global JSON parser, or a substitute limiter disguised as middleware.

## Acceptance Criteria

- [ ] `csrf.test.ts` proves purpose binding, five-minute expiry, one-time consume, bounded cleanup, constant-time comparison, and indistinguishable invalid/replayed failure behavior.
- [ ] Every existing state-changing route rejects missing, wrong, replayed, cross-session, and purpose-invalid CSRF before reading/parsing the request body; valid requests retain current behavior.
- [ ] Register/login use the pre-auth flow, while `/me` recovery and logout/session rotation remain compatible with Task 5.
- [ ] The client sends the right pre-auth or authenticated header and preserves the existing safe error behavior.
- [ ] The HTTP security negative matrix and focused CSRF command pass, followed by relevant typechecks and the full repository validation path.
- [ ] No rate limiter, rate policy threshold, bootstrap implementation, invite/admin/maintenance route family, database migration, or external security dependency is added.

## Out of scope

- Rate limiter implementation, threshold selection, bucket storage, and new `429 RATE_LIMITED` behavior.
- Bootstrap completion/business logic, platform invite/account/session/audit APIs, and maintenance transitions.
- Contract-wide strictness work owned by Task 9, except for the minimal error/transport types needed to expose this task's behavior.
- Domain-service changes, persistence changes, or a distributed limiter.
