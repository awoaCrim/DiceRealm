# `@dnd/contracts` Frontend Guidelines

The frontend consumes the same shared schemas and inferred types as the server. This layer documents how the contract package should remain browser-safe; it does not contain React code.

## Guideline index

| Guide | Purpose |
|---|---|
| [Directory Structure](./directory-structure.md) | Shared schemas versus client-only envelope composition |
| [Component Guidelines](./component-guidelines.md) | Component boundary expectations |
| [Hook Guidelines](./hook-guidelines.md) | Hook/API separation |
| [Quality Guidelines](./quality-guidelines.md) | Browser-facing schema quality |
| [State Management](./state-management.md) | State ownership boundary |
| [Type Safety](./type-safety.md) | Inferred types and opaque payloads |

## Before development

1. Reuse an existing domain schema and enum where possible.
2. Keep route envelope composition in `client/src/shared/lib/contractSchemas.ts`.
3. Decide whether a value is a shared domain contract or client-only view state before adding it.
4. Preserve server-owned visibility and projection semantics.

## Quality check

- `npm run typecheck --workspace @dnd/contracts`
- `npm run typecheck --workspace client`
- Contract tests cover malformed and visibility-sensitive payloads.
- No React, browser-global, query-cache, or transport code enters this package.
