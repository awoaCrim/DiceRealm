# Design: Phase 2 Tasks 8-9 Security and Contract Hardening

> **Status: Deferred.** This design is retained for a later hardening milestone and is not an implementation target now.

## Boundaries

The parent task coordinates two independently verifiable children:

1. **Task 8 — CSRF foundation:** add pre-auth nonce issuance/consumption, authenticated synchronizer-token coverage, client propagation, and negative HTTP tests.
2. **Task 9 — strict contracts and parser inventory:** harden external Zod boundaries and make the route body-budget/admission contract auditable.

Task 8 is implemented first. Task 9's final inventory and parser-order tests consume the accepted Task 8 CSRF seam. Rate limiting is explicitly deferred and must not appear as a partial implementation, placeholder middleware, or newly invented client contract.

## Request admission flow

Preserve the existing application-level order:

```text
basic request checks / exact Origin
  -> session resolution
  -> campaign or platform role
  -> CSRF guard for state-changing requests
  -> explicit endpoint JSON body budget (if a body exists)
  -> strict Zod parse
  -> service
```

The app must continue to avoid a global JSON parser. Existing route-local parser budgets remain the transport ceiling; Task 9 adds strict schema and route inventory coverage inside that boundary.

## Task 8 design

### Pre-auth CSRF

- `GET /api/security/preauth-csrf` validates the purpose enum (`bootstrap`, `register`, `login`) without accepting a body.
- The response returns only the raw CSRF token, marks the response `no-store`, and sets an opaque `__Host-dnd_preauth` handle cookie with secure HttpOnly attributes.
- The server stores only digests plus purpose, expiry, and used state. Consumption checks handle, token, purpose, expiry, and used state in one operation and returns the same `CSRF_INVALID` behavior for all failures.
- Storage is in-memory, bounded, and injectable for tests. No database or external cache is introduced.

### Authenticated CSRF

- Reuse the existing session binding and digest comparison conventions from `authenticatedCsrf.ts`, extracting or extending them into a reusable guard.
- Attach the guard to every currently implemented state-changing route before its body parser, including bodyless mutations.
- Keep GET/HEAD and SSE exempt from inbound CSRF, and preserve `/me` recovery/session rotation semantics.
- Keep exact-origin enforcement in the existing request-security layer; CSRF tests verify that the two checks cannot be bypassed by parser ordering or forwarding headers.

### Client flow

- Add a small auth API operation to obtain the pre-auth token and retain the handle cookie through the existing credentialed HTTPS request path.
- Register/login pass the returned token as `X-CSRF-Token`; authenticated mutation requests continue to read the synchronizer cookie and send the header.
- Do not change retry behavior for a limiter that does not exist in this scope.

### Test seam

Extend the HTTPS harness with helpers for pre-auth issuance, cookie isolation, and CSRF-bearing requests. Add focused unit tests for the store and integration negatives for missing, wrong, replayed, cross-session, purpose-mismatched, and parser-order failures.

## Task 9 design

### Contract hardening

- Treat every externally parsed object as strict unless it is an intentionally bounded domain map wrapper.
- Add explicit maximum lengths/counts to strings, arrays, records, and nested structures using limits supported by existing fixtures and endpoint body budgets.
- Keep arbitrary character sheets, derived data, AI context, and rule content semantically compatible; bound their transport size/cardinality rather than introducing a new domain whitelist.
- Make current sensitive response DTOs and client response envelopes strict, while retaining intentional `unknown` domain payloads where the contract explicitly allows them.

### Parser inventory

Create one declarative inventory or registration seam adjacent to the existing body-budget helper. Each current POST/PUT/PATCH/DELETE route records:

- HTTP method and route family;
- whether it has a body;
- parser/budget label or explicit bodyless marker;
- required CSRF/session/role admission;
- the strict contract used after parsing.

Tests compare the inventory against the current route registrations and fail when a mutation route is added without a declaration. Future Task 10/11 routes are not implemented here; they must use the same registration seam when introduced.

## Compatibility and rollback

- No migration or persistence shape changes are needed.
- Existing Task 7 security behavior, auth cookie/session recovery, AI/context fixtures, and domain services remain compatibility gates.
- If a schema bound is too narrow, roll back only that bound to the largest fixture-supported value; do not weaken strictness globally.
- If route integration exposes an ordering regression, remove the affected route attachment and restore it through the shared guard after the test demonstrates the correct placement. Do not move CSRF after parsing to make a test pass.
- Deferred rate limiting can be added later as a separate task with its own product policy and acceptance criteria.
