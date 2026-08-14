# Implementation plan: remove speculative adapters and narrow composition

## Preparation

- [x] Locate every import/reference to `PostgresDatabaseAdapter`, `pg`, PostgreSQL test environment variables, and deployment claims.
- [x] Classify every `CreatePlatformAppOptions` field as production dependency or test-only override.
- [x] Identify retained generic transaction tests before deleting PostgreSQL parity tests.

## Implementation

1. [x] Remove `PostgresDatabaseAdapter` and PostgreSQL-specific tests.
2. [x] Remove `pg`/type dependencies and unused PostgreSQL configuration/docs.
3. [x] Keep and clarify the concrete leverage of `DatabasePort` and SQLite adapter.
4. [x] Reduce production app options to real startup dependencies.
5. [x] Add a separate test-only app constructor that delegates to the same internal builder without appearing on the production interface; retain the current production `credentialCipher` seam in this child.
6. [x] Keep `startPlatformServer` importing only the production constructor; update the HTTP harness and Phase 4 fixture to use the test constructor where deterministic overrides are required.
7. [x] Keep configured AI provider transport/factory injection available only through the test constructor or lower-level module tests.
8. [x] Keep short realtime timing/authority overrides available only through the test constructor for the next child.
9. [x] Remove historical Phase/Task narration in touched production files while preserving invariant comments.
10. [x] Search for and remove stale PostgreSQL support claims.

## Validation

- [x] No import/reference to `PostgresDatabaseAdapter` remains.
- [x] No `pg` runtime/type dependency remains.
- [x] SQLite adapter/transaction tests pass.
- [x] App composition and HTTP harness tests pass.
- [x] AI provider configuration/transport tests pass.
- [x] Server typecheck passes.
- [x] Full repository tests, typecheck, and build pass.
- [x] `git diff --check` passes.
- [ ] Independent Trellis check confirms behavior-only refactoring and narrow interfaces (review agents were isolated at stale HEAD without `.trellis` or the dirty worktree, so they correctly reported blocked; direct parent-worktree review found no task-attributable issue).

## Verification record

- Focused composition/database/security/AI/combat/vertical tests: 114 passed.
- Full suite: 77 files passed; 694 passed, 8 skipped.
- Root typecheck and production server/client builds passed.
- `git diff --check` passed.
- Immutable migration SQL comments that mention historical cross-database portability were left unchanged to avoid rewriting versioned migration artifacts; current code, package metadata, and authoritative v1 decisions are SQLite-only.

## Rollback points

- Delete PostgreSQL only after the reference/dependency inventory is complete.
- Move test overrides before removing their old top-level fields so fixture failures identify missed callers.
- This child makes no schema changes, so rollback is code/package metadata only.
