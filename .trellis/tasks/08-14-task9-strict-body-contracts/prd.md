# Task 9: Strict Body and Contract Inventory

> **Status: Deferred.** Do not start this task in the current milestone; prioritize the main product flow first.

## Goal

Make the current HTTP boundary explicit and fail-closed: server-side request schemas reject unknown keys and unbounded transport data, sensitive response DTOs reject accidental extra fields, and every current mutation route has a visible body-budget/parser/admission entry. Valid domain behavior and the existing AI/character/context fixtures must remain unchanged.

## Confirmed requirements

1. Update the external contract modules named by the Phase 2 plan: `auth.ts`, `campaign.ts`, `character.ts`, `world.ts`, `turn.ts`, `combat.ts`, `ai.ts`, `archive.ts`, and `rules.ts`, plus their contract/server HTTP tests.
2. Apply `.strict()` to externally accepted object shapes and add explicit maximum lengths/counts for strings, arrays, records, and nested payloads. Bounds must be lower than the route parser budget only when the existing largest normal fixtures and the documented endpoint budget support that choice.
3. Preserve intentional domain maps and AI/context data. Bound their transport size/cardinality and nested structure without replacing valid domain semantics with an unrelated whitelist or performing a Phase 3 domain refactor.
4. Make existing sensitive response DTOs/envelopes strict, including auth/session/bootstrap-shaped responses that exist in the current contracts and the response wrappers used by the client. Future Task 10/11 route families must consume the convention but are not implemented here.
5. Keep explicit parser placement after origin/session/role/CSRF admission and before strict Zod. Bodyless mutations remain parser-free but still require their other admission checks.
6. Add a route/parser budget inventory test that covers current POST/PUT/PATCH/DELETE surfaces and provides a registration seam or failure rule for future mutation routes. A new mutation route must not be able to omit its parser configuration silently.
7. Unknown request keys must produce the existing safe 400 validation envelope on the server; client-side Zod stripping is not a substitute. Error/response strictness must not leak secrets or internal state.
8. Keep the accepted Task 8 CSRF seam and Task 7 behavior intact. Rate limiting is explicitly deferred and is not a dependency of this task. Do not add migrations or pull bootstrap/invite/admin/maintenance implementations into this task.

## Acceptance Criteria

- [ ] All current external input schemas in the named modules are strict and have documented transport bounds appropriate to their route budgets.
- [ ] Unknown keys are rejected by representative tests for auth, campaign, character, world, turn, combat, AI, archive, and rules inputs, including nested payloads where applicable.
- [ ] Sensitive response schemas/wrappers used by current auth and platform flows reject unknown fields while intentionally broad domain maps remain valid and bounded.
- [ ] The parser/admission inventory has an entry for every current state-changing route, identifies bodyless routes, and fails tests when a new mutation is registered without a parser/budget declaration.
- [ ] Existing largest normal fixtures, AI/context/character behavior, error envelopes, and Task 7 HTTP security tests remain green.
- [ ] Focused contract/security/AI route tests, relevant typechecks, and the full repository validation path pass.
- [ ] No bootstrap service, platform admin/invite/maintenance route, migration 015+, rate limiter, or unrelated domain refactor is introduced.

## Out of scope

- Implementing CSRF or rate-limiter internals (Task 8 owns the CSRF seam; rate limiting is deferred).
- Implementing future bootstrap, invite, account, session, audit, or maintenance route families.
- Changing domain validation rules, persistence models, AI context semantics, or client UX beyond consuming strict response contracts.
- Replacing arbitrary but intentional domain maps with a new business-specific schema solely to reduce the diff.

## Dependency and sequencing

Task 9 may be designed while Task 8 is in planning, but implementation of the final inventory and parser-order tests waits for Task 8's accepted CSRF/admission seam. This avoids freezing a route contract against an obsolete middleware shape. It does not wait for rate limiting because that feature is deferred.
