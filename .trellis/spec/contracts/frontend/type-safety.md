# Contracts Frontend Type Safety Guidelines

## Schema-first types

Define a Zod schema and infer the public type from it:

```ts
export const turnListEntrySchema = z.object({
  turn: turnSummarySchema,
  progress: turnProgressSchema,
});
export type TurnListEntry = z.infer<typeof turnListEntrySchema>;
```

Client response envelopes may compose these schemas, but should not redefine their fields.

## Opaque payloads

Some payloads are intentionally `unknown`, such as `TurnEntry.payload` and owner-only AI debug data. The client must narrow those values with a safe reader at the rendering boundary (`client/src/shared/lib/safeSheet.ts`), never with `as SomeShape` alone.

## Forbidden shortcuts

- Do not export `any`-based DTOs.
- Do not use type assertions to skip validation of network data.
- Do not make a field optional to hide a server/client contract mismatch; use `null` or update both sides deliberately.
- Do not duplicate shared enums in client code.
