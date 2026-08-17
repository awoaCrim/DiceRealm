# Contracts Frontend Hook Guidelines

`@dnd/contracts` defines no hooks. React Query hooks live in `client/src/entities/<domain>/*Queries.ts` and call API functions that use contract schemas.

When changing a hook-facing contract:

1. Change the shared schema/type in the relevant domain module.
2. Update the client envelope schema if the route wrapper changed.
3. Update the API function and entity hook tests.
4. Keep query keys and invalidation behavior in the client entity layer, not in this package.

A contract module must remain usable by server code, tests, and non-React clients.
