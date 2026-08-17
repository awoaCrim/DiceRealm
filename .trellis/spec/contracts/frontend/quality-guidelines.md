# Contracts Frontend Quality Guidelines

- Treat shared schemas as the runtime source of truth for browser responses and request DTOs.
- Export inferred types from the same schema; do not maintain a parallel client-only interface for the same payload.
- Keep audience and visibility rules in the contract/server projection. The UI should render the already-projected data.
- Use discriminated unions for variants such as campaign events and visibility-bearing values.
- Test malformed payloads at the contract boundary. Component tests should focus on rendering and user behavior after parsing.

```ts
const turnEntryListEnvelopeSchema = z.object({
  entries: z.array(turnEntrySchema),
});
```

Do not put browser-only globals, React imports, query-cache operations, or ad hoc `JSON.parse` logic in `@dnd/contracts`.
