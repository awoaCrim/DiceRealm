# Contracts Database Guidelines

The contracts package has **no database layer**. Its backend-facing responsibility is to describe stable DTOs and the invariants that database-backed services must honor.

## Contract rules for persisted data

- Represent persisted timestamps as ISO strings in public DTOs (`createdAt`, `updatedAt`, `completedAt`). Mapping from snake_case database rows belongs in server repositories/services.
- Represent database absence explicitly with `null`; do not make a field optional merely because a SQL column can be null. For example, `turnSummarySchema.completedAt` is nullable.
- Use stable string IDs and explicit enums for statuses, roles, visibility, and event types.
- Keep raw database rows out of the package. `campaignSchema` and `turnSummarySchema` are public views, not SQL row types.

## Runtime validation

Every persisted or transport-facing shape should have a Zod schema. Cross-field database invariants belong in `superRefine` when they are part of the contract. `diceResultSchema` is the model example: it requires a target player for `player_private` and forbids one for `public`/`owner_only`.

```ts
export const diceResultSchema = z.object({
  id: z.string().min(1),
  formula: z.string().min(1),
  total: z.number().int(),
  visibility: visibilitySchema,
  targetPlayerId: z.string().min(1).nullable(),
}).superRefine((dice, ctx) => {
  if (dice.visibility === 'player_private' && !dice.targetPlayerId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'targetPlayerId is required' });
  }
});
```

## Common mistakes

- Do not expose SQL column names or database-specific types in a shared DTO.
- Do not weaken a persisted contract to `z.unknown()` unless the value is intentionally opaque; document and safely decode opaque payloads at the consuming boundary.
- Do not add a database adapter or migration dependency to `@dnd/contracts`.
