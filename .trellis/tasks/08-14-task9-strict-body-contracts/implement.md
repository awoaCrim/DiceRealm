# Implementation Plan: Task 9 Strict Body and Contract Inventory

> **Status: Deferred.** Do not execute this plan in the current milestone.

## Dependency

Begin only after Task 8's CSRF foundation is accepted. Rate limiting is deferred and is not a prerequisite.

## Ordered checklist

1. Load contracts/server/client Trellis specs and re-read the final Task 8 admission seam.
2. Inventory current external request schemas and identify existing largest normal fixtures and route parser budgets before editing.
3. Harden `auth`, `campaign`, `character`, `world`, `turn`, `combat`, `ai`, `archive`, and `rules` schemas in small module-sized increments: strict objects first, then fixture-supported bounds for strings, arrays, records, and nested payloads.
4. Harden current sensitive response DTOs and client response envelopes without changing intentional domain-map semantics.
5. Add representative unknown-key and boundary tests for each contract module, including nested payload negatives.
6. Add the declarative route/parser/admission inventory and cover every current POST/PUT/PATCH/DELETE route, including bodyless mutations.
7. Add the failure test for an undeclared mutation route and verify parser/admission order against the accepted Task 8 guard.
8. Run focused contract/HTTP/AI tests, affected typechecks, lint, full tests, build, and safety checks.
9. Review the diff for scope drift and confirm no future route family, migration 015+, rate limiter, or domain refactor was introduced.

## Validation commands

```bash
npx vitest run --passWithNoTests packages/contracts/src server/src/tests/http-security-negative-matrix.test.ts server/src/tests/ai-routes-http.test.ts --maxWorkers=1
```

Use the repository package scripts for typecheck, lint, full test, build, and the existing Task 7 safety-hash checks.

## Risk and rollback points

- Record fixture and route-budget evidence before changing a bound.
- Do not solve an individual fixture mismatch by removing strictness globally.
- Keep arbitrary character/derived/AI maps semantically compatible and bounded.
- Keep the inventory declarative and fail-closed; do not silently treat an unknown mutation as bodyless.
- If a design choice requires rate-limit policy or future bootstrap/admin routes, return to planning rather than broadening this task.
