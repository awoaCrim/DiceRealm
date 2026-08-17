# Client Frontend Directory Structure

The client is a Vite React application organized by application wiring, domain data hooks, user-facing features, and shared primitives.

## Layout

```text
client/src/
├── main.tsx, App.tsx             # browser entry and app composition
├── app/                           # providers, router, auth/realtime boundaries
├── api/<domain>/                  # request functions; no React state
├── entities/<domain>/             # React Query hooks and query-key use
├── features/<feature>/            # pages and feature-specific UI
├── features/story/                # shared turn-entry/story rendering
├── shared/api/                    # platformRequest and HTTP errors
├── shared/lib/                    # query keys, schema envelopes, safe readers
├── shared/ui/                     # reusable presentational primitives
├── styles.css                     # global styles
└── tests/                         # browser/fixture tests
```

## Organization rules

- Keep API functions small and transport-focused (`api/campaigns/campaignApi.ts`).
- Keep query/mutation hooks in the matching entity module (`entities/turn/turnQueries.ts`).
- Put route-level pages and workflows in `features`; do not make pages reach directly into `fetch`.
- Put reusable async/error/presentation primitives in `shared/ui` only when they are not domain-specific.
- Keep router/provider/realtime lifecycle code under `app`.

## Naming

Use PascalCase for React components, camelCase for API/query modules, `useX` for hooks, and `.test.tsx` for Testing Library tests. Import shared package contracts from `@dnd/contracts`; use explicit relative imports for local modules.
