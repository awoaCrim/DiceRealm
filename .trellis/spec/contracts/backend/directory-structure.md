# Contracts Backend Directory Structure

`@dnd/contracts` is the repository's shared runtime-contract package. It contains domain schemas and inferred TypeScript types, not database access, HTTP handlers, or UI code.

## Layout

```text
packages/contracts/
├── package.json
├── tsconfig.json
└── src/
    ├── <domain>.ts          # Zod schemas, exported inferred types, helpers
    ├── <domain>.test.ts     # schema and helper contract tests
    └── index.ts             # public barrel exports
```

Current domain modules include `auth.ts`, `campaign.ts`, `character.ts`, `combat.ts`, `turn.ts`, `ai.ts`, `events.ts`, `archive.ts`, `world.ts`, `runtime.ts`, `adjudication.ts`, and `errors.ts`.

## Module organization

- Keep one domain or cross-layer contract family per file.
- Define the runtime schema first, then export the corresponding type with `z.infer`.
- Put pure helpers next to the schema they interpret. For example, event visibility helpers live in `events.ts` beside `campaignEventSchema`.
- Add the module to `src/index.ts`; consumers import from `@dnd/contracts`, not from a deep source path.
- Put focused schema tests beside the module, such as `src/ai.test.ts` and `src/events.test.ts`.

## Naming

- Use `camelCase` for schema constants and `PascalCase` for inferred types.
- Use the suffix `Schema` for Zod schemas and `Input`, `View`, `Result`, `Envelope`, or `Projection` for their role in a boundary.
- Keep file names lowercase and domain-oriented (`turn.ts`, `runtime.ts`).

## Example

```ts
// packages/contracts/src/campaign.ts
export const campaignSummarySchema = campaignSchema
  .pick({ id: true, name: true, status: true, ruleset: true, updatedAt: true })
  .extend({ role: z.enum(['owner', 'player']) });

export type CampaignSummary = z.infer<typeof campaignSummarySchema>;
```

Do not put `better-sqlite3`, Express request types, React components, or environment access in this package.
