# Client Frontend Guidelines

These guidelines describe the Vite/React client under `client/src`.

## Guideline index

| Guide | Purpose |
|---|---|
| [Directory Structure](./directory-structure.md) | `app`, `api`, `entities`, `features`, and shared boundaries |
| [Component Guidelines](./component-guidelines.md) | Typed React components, accessibility, and safe rendering |
| [Hook Guidelines](./hook-guidelines.md) | TanStack Query hooks and mutation invalidation |
| [State Management](./state-management.md) | Server, local, URL, and realtime state ownership |
| [Quality Guidelines](./quality-guidelines.md) | Testing, security, and forbidden client shortcuts |
| [Type Safety](./type-safety.md) | Contract parsing and opaque-payload handling |
| [Story History](./story-history.md) | Turn history projection and entry rendering |

## Before development

1. Read the relevant feature and entity files before adding a new hook or component.
2. Confirm the endpoint schema in `client/src/shared/lib/contractSchemas.ts` and the matching `@dnd/contracts` module.
3. Reuse the query-key helper and `AsyncState` where applicable.
4. For audience-sensitive data, verify the server projection and add a role-specific test.

## Quality check

- `npm run typecheck --workspace client`
- Focused `npm test -- client/src/...`
- `npm run build --workspace client`
- For browser fixture work, run the dedicated Phase 4 command with TLS verification enabled.

All documentation in this directory is written against the current codebase, not an aspirational frontend architecture.
