# Implementation Plan: Phase 2 Tasks 8-9

> **Status: Deferred.** Do not execute this plan until the main product flow milestone is complete and the tasks are explicitly reopened.

## Order

1. Review the accepted Task 7 security behavior and load package-specific Trellis guidance before code changes.
2. Start and implement child Task 8 (CSRF foundation only). Do not implement or stub rate limiting.
3. Run the Task 8 focused tests, typechecks, and the Task 7 regression matrix. Fix only CSRF/admission regressions.
4. Archive/accept Task 8 only after its checks pass.
5. Start and implement child Task 9. Use the accepted Task 8 guard/parser ordering as the inventory baseline.
6. Harden contracts incrementally by module, adding representative negative and boundary tests alongside each change.
7. Add and validate the route/parser inventory, then run the full contract, HTTP, AI, typecheck, lint, and repository test gates.
8. Perform a final cross-child review for scope drift: no rate limiter, migration 015+, bootstrap service, invite/admin/maintenance routes, or domain refactor.

## Validation commands

Task 8 focused:

```bash
npx vitest run server/src/platform/http/csrf/csrf.test.ts server/src/tests/http-security-negative-matrix.test.ts client/src/shared/api/platformHttp.test.ts --maxWorkers=1
```

Task 9 focused (after adapting to the repository's actual test files):

```bash
npx vitest run --passWithNoTests packages/contracts/src server/src/tests/http-security-negative-matrix.test.ts server/src/tests/ai-routes-http.test.ts --maxWorkers=1
```

Then run the repository's documented typecheck, lint, full test, build, and safety-hash commands discovered from package scripts and prior Task 7 validation.

## Risk and rollback points

- **CSRF route coverage:** verify every mutation route before changing any contract schema. If a route fails due to ordering, fix the shared guard attachment rather than moving validation after parsing.
- **Client auth flow:** preserve cookie/session recovery behavior; isolate pre-auth token acquisition from authenticated token handling.
- **Contract bounds:** add limits from existing fixtures first; if a valid fixture fails, adjust the specific bound only.
- **Inventory completeness:** compare declarations to actual route registrations before claiming coverage.
- **Scope:** stop and return to planning if implementation starts requiring rate-limit policy, new migrations, or future route families.

## Review gates before task start

- [ ] Latest PRDs contain no unresolved product decision.
- [ ] Task 8 and Task 9 design documents agree on CSRF/parser order.
- [ ] Child manifests contain only real spec/research entries.
- [ ] Task 8 is the first implementation target; Task 9 dependency is recorded in its PRD.
- [ ] User explicitly approves the final planning summary in a later turn before `task.py start`.
