# Contracts Frontend Directory Structure

The contracts package has no frontend runtime. Its frontend-facing surface is the same `packages/contracts/src/` tree consumed by the Vite client.

## Frontend-facing organization

- Domain schemas stay in domain files (`campaign.ts`, `turn.ts`, `ai.ts`, `events.ts`).
- Client-specific envelope composition belongs in `client/src/shared/lib/contractSchemas.ts`, because it combines route envelopes with shared domain schemas.
- `packages/contracts/src/index.ts` is the only public import surface for client code.
- Schema tests remain next to the source module; UI and hook tests belong under `client/src/`.

```text
packages/contracts/src/       # shared runtime schemas and inferred types
client/src/shared/lib/        # client-only response envelopes and query keys
client/src/api/<domain>/      # HTTP calls using those envelopes
client/src/entities/<domain>/ # React Query hooks
```

Do not create React components, hooks, CSS, or browser storage code in `@dnd/contracts`.
