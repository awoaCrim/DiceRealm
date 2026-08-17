# Client Frontend Type Safety

## Network boundary

All API modules call `platformRequest` with a schema from `client/src/shared/lib/contractSchemas.ts`:

```ts
return platformRequest(`/api/campaigns/${campaignId}`, {
  responseSchema: campaignDetailEnvelopeSchema,
});
```

`platformRequest` parses success responses and normalizes failures to `PlatformHttpError`. A feature should receive a typed value or a typed error, never an unvalidated response body.

## Shared types and opaque data

- Import domain types/schemas from `@dnd/contracts`.
- Compose route envelopes in `contractSchemas.ts` rather than redefining domain fields in a feature.
- Treat `TurnEntry.payload` and owner AI debug data as `unknown`. Narrow them with `safeSheet` readers; malformed entries get a safe fallback, not an exception or raw JSON.
- Use discriminated unions and explicit nullable values from the shared contract.

## Forbidden shortcuts

- No `any` for API data.
- No `as` cast to make a response compile.
- No duplicated error-code strings or status assumptions outside `PlatformHttpError`/shared contracts.
- No client-side reimplementation of server visibility rules.
