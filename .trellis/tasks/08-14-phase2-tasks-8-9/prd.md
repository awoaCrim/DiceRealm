# Phase 2 Tasks 8-9: Security and Contract Hardening

> **Status: Deferred.** By user decision, Tasks 8-9 are not implementation targets for the current milestone. Preserve this plan as deferred hardening work while the main product flow is completed.

## Goal

Complete the Phase 2 HTTP security and external-contract hardening slice for the existing platform app. The outcome is that every currently implemented state-changing surface has an explicit admission contract (origin, CSRF, body budget, and role/session checks), while externally accepted request shapes and sensitive response DTOs reject unknown or unbounded data without changing the domain behavior already validated by Task 7.

Rate limiting is explicitly deferred by product decision and is not part of this implementation slice.

## Background and confirmed facts

- The authoritative requirements are in:
  - `docs/superpowers/plans/2026-08-12-dnd-ai-dm-v1-phase2-security-foundation.md`
  - `docs/superpowers/specs/2026-08-12-dnd-ai-dm-v1-decisions.md`
  - `docs/superpowers/plans/2026-08-12-dnd-ai-dm-v1-hardening-cutover.md`
- Task 7's HTTP security matrix is accepted. Its behavior and regression coverage must remain green.
- The app intentionally has no global JSON parser. Existing route-local body budgets and the Task 7 request-security/session middleware are the foundation for this work.
- Existing authenticated CSRF validation is only attached to a subset of routes; pre-auth nonce validation is not yet complete.
- Many current contract schemas accept unknown keys or have no explicit string, array, record, or nested-payload bounds. The current implementation therefore cannot rely on client-side Zod stripping as a server security boundary.
- The Phase 2 plan forbids new migrations beyond 014 and defers bootstrap service/routes and platform invite/admin APIs to later tasks.
- The user has chosen to skip rate-limiter implementation. Rate-limit policy design, limiter storage, and new 429 behavior are deferred rather than silently replaced by invented thresholds.

## Requirements

### R1. Task 8: CSRF foundation

Implement the generic pre-auth CSRF store/guard, authenticated synchronizer-token coverage, client token propagation, and security-route seam described by the Phase 2 security foundation. Admission order must remain:

`basic request checks -> session -> role -> CSRF -> endpoint body parser -> strict Zod -> service`.

The implementation must cover all currently implemented mutation routers without introducing the future bootstrap, invite, admin, or maintenance route families. Rate limiting is out of scope for this task.

### R2. Task 9: strict contracts and parser inventory

Make external request schemas strict and explicitly bounded across the listed contract modules, make existing sensitive response DTOs strict, and create an auditable endpoint/parser inventory. Unknown request keys must be rejected by the server with the existing safe error envelope. Intentional domain maps and AI/context data must retain their domain semantics while receiving bounded transport protection.

### R3. Sequencing and compatibility

Plan and execute the CSRF portion of Task 8 before Task 9's final parser/admission inventory is frozen. Task 9 may be designed in parallel, but its implementation must consume the final Task 8 middleware seams. Neither task may change domain rules, add a database migration, or pull future Phase 2 tasks forward.

### R4. Regression and security behavior

Preserve Task 7 behavior, exact-origin enforcement, security headers, no-store behavior for sensitive responses, session/CSRF recovery semantics, and existing AI/character/context fixtures. Tests must prove negative behavior rather than only happy paths.

## Acceptance Criteria

- [ ] Task 8 has an explicit, tested pre-auth nonce lifecycle: purpose binding, opaque `__Host-dnd_preauth` handle, five-minute TTL, one-time atomic consumption, bounded cleanup, constant-time digest comparison, and indistinguishable failure behavior.
- [ ] Every currently implemented state-changing route validates exact `Origin` and the appropriate CSRF credential before its endpoint body parser; bodyless mutations are covered too. Read-only GET/HEAD and SSE follow the documented CSRF exception.
- [ ] The client obtains and sends pre-auth credentials for register/login and sends the authenticated synchronizer token on state-changing requests.
- [ ] Task 9's request schemas reject unknown keys and enforce documented transport bounds while preserving existing valid fixtures and domain-map semantics.
- [ ] Existing sensitive response DTOs/envelopes are strict, and a route/parser inventory test prevents a new current or future mutation route from bypassing its declared parser/admission contract.
- [ ] The focused Task 8 and Task 9 test commands, relevant typechecks, and the full repository validation path pass without adding migration 015+ or future bootstrap/invite/admin/maintenance implementations.
- [ ] Rate limiting is documented as deferred and no partial or invented limiter implementation is introduced in these tasks.

## Out of scope

- Rate limiter implementation, limiter policy thresholds, limiter storage, or new rate-limit response behavior.
- Implementing the bootstrap service or bootstrap completion route.
- Implementing platform invite, account, session, audit, or maintenance route families that are assigned to later tasks.
- Database schema changes, migrations after 014, Redis/external rate limiting, `helmet`, `express-rate-limit`, or `cookie-parser`.
- Rewriting domain services, AI context construction, character semantics, or the Task 7 security architecture.
- Treating client-side schema stripping as validation or broadening the task into a Phase 3 domain refactor.

## Resolved planning decisions

- Task 8 is reduced to its CSRF/pre-auth scope; rate limiting is deferred explicitly.
- Task 9 remains dependent on the accepted Task 8 CSRF/admission seam, not on a rate limiter.
