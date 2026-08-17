# `@dnd/contracts` Backend Guidelines

`@dnd/contracts` is the shared runtime-contract package. It contains Zod schemas, inferred TypeScript types, pure visibility/event helpers, and shared error codes. It has no database, HTTP, logging, or UI runtime.

## Guideline index

| Guide | Purpose |
|---|---|
| [Directory Structure](./directory-structure.md) | Domain modules, barrel exports, and tests |
| [Database Guidelines](./database-guidelines.md) | How database-backed DTOs are represented without coupling to SQLite |
| [Error Handling](./error-handling.md) | Shared error codes and response envelope |
| [Quality Guidelines](./quality-guidelines.md) | Schema-first validation and tests |
| [Logging Guidelines](./logging-guidelines.md) | Pure-package logging boundary |

## Before development

1. Find the existing domain contract before creating a new module or enum.
2. Define the Zod runtime schema before its inferred type.
3. Check both server consumers and client envelope composition for compatibility.
4. Add accepted, rejected, and cross-field validation tests.
5. Export new public modules from `src/index.ts`.

## Quality check

- `npm run typecheck --workspace @dnd/contracts`
- `npm test -- packages/contracts/src`
- Confirm no storage, Express, React, environment, or logging dependency was added.
- Confirm public DTOs use camelCase and explicit nullable/enum fields.

The contract package is the source of truth for shared wire shapes; do not duplicate these definitions in server or client packages.
