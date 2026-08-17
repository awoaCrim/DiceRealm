# Server Backend Quality Guidelines

## Required patterns

- Run strict TypeScript, Vitest, and the repository build before finishing a cross-layer change.
- Keep route handlers thin; services own domain authorization and transactions.
- Validate external input with `@dnd/contracts` schemas and validate provider output before applying it.
- Add a regression test for a bug or behavior change. Use module tests for domain logic and vertical HTTP tests for route/auth/projection flows.
- Preserve audience projection: owner, public, and player-private data are filtered on the server, not reconstructed in the client.
- Keep production composition narrow. Use `createPlatformApp` for real dependencies and `createTestPlatformApp` for deterministic test overrides.

## Forbidden patterns

- Do not import `better-sqlite3` outside `platform/database/SqliteDatabaseAdapter.ts` and narrowly scoped adapter tests.
- Do not reintroduce PostgreSQL support, a generic DI container, or a test override bag on the production constructor.
- Do not trust provider-authored dice or state changes as authoritative; pass them through server validation/materialization.
- Do not use unbounded request bodies, raw error responses, or secret-bearing logs.
- Do not call top-level database methods inside transaction callbacks.

## Review checklist

- Does the change preserve route/auth/visibility contracts?
- Are all writes atomic with outbox publication where applicable?
- Are error codes mapped and tested?
- Are migrations listed and rollback-safe?
- Are tests placed at the narrowest useful layer plus a vertical test when a boundary changed?
- Are comments describing current invariants rather than historical phase/task chronology?
