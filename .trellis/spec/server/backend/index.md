# Server Backend Guidelines

These guidelines describe the Express/SQLite server under `server/src`. They document current implementation contracts, including the intentionally SQLite-only production architecture and server-owned gameplay/adjudication boundaries.

## Guideline index

| Guide | Purpose | Status |
|---|---|---|
| [Directory Structure](./directory-structure.md) | Composition root, routes, modules, and platform layers | Active |
| [Database Guidelines](./database-guidelines.md) | SQLite port, transactions, migrations, and outbox | Active |
| [Error Handling](./error-handling.md) | AppError and safe HTTP envelopes | Active |
| [Quality Guidelines](./quality-guidelines.md) | Validation, tests, composition, and forbidden patterns | Active |
| [Logging Guidelines](./logging-guidelines.md) | Safe console/CLI diagnostics | Active |
| [AI Structured Turn Output](./ai-structured-output.md) | Provider-neutral AI output contract | Active |
| [Turn Entry Projection](./turn-entry-projection.md) | Audience projection and per-turn reads | Active |
| [Schema Reset Boundary](./schema-reset-boundary.md) | Safe removal of persisted features | Active |
| [Runtime Contract & State Safety](./runtime-contract-state-safety.md) | Revision CAS, state changes, and stale-result rejection | Active |
| [Server Adjudication & Dice Authority](./server-adjudication-dice-authority.md) | Server-owned mechanics and narration retry | Active |

## Before development

1. Read the relevant task artifacts and this index plus the linked guideline files.
2. Trace the full write/read path: route → service → repository/database → DTO/event → client.
3. Identify the transaction owner and pass its executor inward; do not open nested top-level transactions.
4. Check auth, campaign membership, audience projection, error codes, migrations, and outbox publication.
5. Keep production construction narrow; test-only timing/provider overrides belong in `createTestPlatformApp` or lower-level tests.

## Quality check

- `npm run typecheck --workspace server`
- Focused module/HTTP tests, then `npm test`
- `npm run build --workspace server`
- `git diff --check`
- For schema or contract changes, verify migration manifest, rollback behavior, server response schemas, and client consumers.

Comments should explain current invariants such as transaction ownership, visibility, provider fallback, or SSE shutdown—not historical phase/task chronology.
