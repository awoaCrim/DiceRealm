# Contracts Frontend Component Guidelines

There are no components in `@dnd/contracts`. React components consume contract-derived types but must not be defined here.

## Boundary rule

A component should receive a parsed contract value, not an unvalidated `unknown` response. Route envelopes are composed in `client/src/shared/lib/contractSchemas.ts` and parsed by `platformRequest` before a feature component renders them.

```ts
// client/src/shared/lib/contractSchemas.ts
export const campaignListEnvelopeSchema = z.object({
  campaigns: z.array(campaignSummarySchema),
});
```

Keep presentation decisions in `client/src/features` or `client/src/shared/ui`; keep shape and visibility decisions in the shared schema/server projection. Do not add UI-specific optional fields to a domain contract merely to simplify one component.
