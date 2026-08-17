# Contracts Backend Quality Guidelines

## Required patterns

- Keep TypeScript `strict`-compatible and export runtime schemas together with inferred types.
- Use Zod objects for request, response, event, and persisted-view contracts. Use `.strict()` where unknown keys would be unsafe or ambiguous, as in `turnResolutionShapeSchema` and `aiNarrationAttemptViewSchema`.
- Normalize safe defaults in the schema (`.default([])`) when older provider payloads may omit an empty collection.
- Test both accepted and rejected values. Existing tests in `packages/contracts/src/*.test.ts` assert trimming, bounds, visibility rules, malformed archive versions, and discriminated unions.
- Keep helpers deterministic and side-effect free.

## Forbidden patterns

- Do not use `any` or make consumers cast unvalidated JSON into a contract type.
- Do not use a type assertion as a substitute for a schema parse.
- Do not duplicate the same enum or envelope in server/client packages.
- Do not put transport, storage, React, or environment concerns in a contract module.

## Test checklist

For a new or changed schema, add tests for:

- a valid representative payload;
- missing, empty, overlong, and wrong-type fields;
- cross-field rules (`superRefine`);
- unknown keys when strictness is intentional;
- a round trip through the public barrel export when relevant.

## Example

```ts
const parsed = turnResolutionSchema.parse(providerValue);
expect(parsed.privateUpdates).toEqual([]); // omitted empty collections normalize here
```

Keep comments focused on an invariant or compatibility reason. Avoid historical phase/task narration in contract code.
