# AI Structured Turn Output

## Scenario: Provider-neutral structured turn resolution

### 1. Scope / Trigger

Use this contract whenever an AI Provider produces a formal turn resolution that will be validated and transactionally materialized by `AiResolutionService`.

The boundary must tolerate a common model omission (empty collections) without weakening nested validation, and must retain safe Owner diagnostics when schema validation fails.

### 2. Signatures

```ts
turnResolutionSchema.parse(output: unknown): TurnResolution

new TurnResolutionValidator(executor).validate(
  campaignId: string,
  output: unknown,
): Promise<TurnResolution>

new AiResolutionService(...).resolveTurn(
  ctx: CampaignAuthContext,
  turnId: string,
  input: { idempotencyKey: string },
): Promise<{ created: boolean; run: AiRunView }>
```

One claimed run attempt calls `AiProviderPort.stream(...)` once. The generic OpenAI-compatible transport sends `model`, `messages`, `temperature`, and `stream: false`; structured mode, tools, and automatic repair/retry are not required.

### 3. Contracts

The model-facing prompt is owned by `AiContextBuilder`. `AiPrompt.messages` is the sole Provider conversation representation; system instructions appear exactly once as a `role: 'system'` message and must not be duplicated in a top-level `system` property persisted to `context_json`.

The prompt must require:

- exactly one JSON object;
- no explanatory prose or Markdown fences;
- a complete top-level template containing `publicNarrative`, `privateUpdates`, `diceResults`, `stateChanges`, `interactionRequests`, `worldFactCreations`, and `encounterStarts`;
- `[]` for collections with no entries;
- server-generated ids omitted for newly created facts, encounters, and combatants.

`turnResolutionSchema` behavior:

- `publicNarrative`: required non-empty string;
- all six collection fields: omitted input normalizes to `[]`;
- supplied entries: continue through their existing nested schemas;
- member, visibility, target ownership, state-change whitelist, and combat checks remain fail-closed.

Schema and domain-validation failure diagnostics stored in Owner-only `raw_debug_json` have this bounded shape:

```ts
{
  code: 'AI_OUTPUT_INVALID',
  diagnostic: {
    kind: 'turn_resolution_schema_validation' | 'turn_resolution_domain_validation',
    issues: Array<{ path: Array<string | number>; code: string }>,
    truncated: boolean,
  },
}
```

Limits are 20 issues, 12 path segments per issue, and 64 characters per string segment. Domain paths/codes must be server-controlled constants. Do not include Zod issue messages, received values, rejected member/target ids, raw Provider output, prompts, URLs, headers, or credentials. Client-facing `AppError.message` must remain generic and must never interpolate Provider-controlled values.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Non-empty `publicNarrative`, collections omitted | Normalize collections to `[]`, continue formal apply |
| Empty or missing `publicNarrative` | `AI_OUTPUT_INVALID` |
| Supplied nested entry has an invalid type/shape | `AI_OUTPUT_INVALID` plus bounded Owner-only path/code diagnostic |
| Player-private/member target is invalid | `AI_OUTPUT_INVALID` plus Owner-only controlled path/code; rejected id is not echoed or persisted |
| State/combat target is missing or belongs to another campaign | `AI_OUTPUT_INVALID` plus Owner-only controlled path/code; rejected id is not echoed or persisted |
| Formal state conflict after validation | `STATE_CONFLICT` |
| Provider/network/response decoding failure | `AI_PROVIDER_FAILED` |

Every validation or formal-apply failure must leave no formal entries, state changes, archive, or next turn. The run becomes `failed`, the turn becomes `needs_owner_attention`, and preview failure is emitted.

### 5. Good / Base / Bad Cases

- **Good:** Provider returns the complete template with explicit empty arrays.
- **Base:** Provider returns only `{ "publicNarrative": "..." }`; the server normalizes every collection to `[]` and succeeds.
- **Bad (schema):** Provider supplies `privateUpdates[0].content` as an object; validation fails, `raw_debug_json` records only path `['privateUpdates', 0, 'content']` and code `invalid_type`, and no formal writes occur.
- **Bad (domain):** Provider supplies an unknown `privateUpdates[0].playerId`; the rejected id is absent from the thrown message and persisted JSON, while Owner-only `raw_debug_json` records path `['privateUpdates', 0, 'playerId']` and code `not_campaign_member`.

### 6. Tests Required

- Shared contract: omitted collections normalize to `[]`; malformed supplied nested entries still reject.
- Prompt builder: outbound messages contain the JSON-only instruction and every top-level template key; the built and persisted prompt has no top-level `system` property and exactly one system message.
- OpenAI-compatible vertical flow: a `publicNarrative`-only response succeeds, sends one request, and does not require `response_format` or tools.
- Validator: schema and domain diagnostics contain only bounded path/code metadata and exclude model-provided values.
- Resolution service: safe diagnostics persist only in Owner-only `rawDebug`; generic error JSON and thrown/HTTP messages remain concise; rejected member/target ids are never persisted; failed validation creates no formal writes.
- Full regression suite, typecheck, build, and `git diff --check` must pass.

### 7. Wrong vs Correct

#### Wrong

```ts
// Rejects harmless omission and provides no actionable safe diagnostic.
privateUpdates: z.array(privateUpdateSchema)
throw new AppError('AI_OUTPUT_INVALID', 'invalid');
```

Do not fix this by storing the raw Provider response or by issuing an automatic second Provider request.

#### Correct

```ts
privateUpdates: z.array(privateUpdateSchema).default([])

throw new AiOutputValidationError({
  kind: 'turn_resolution_schema_validation',
  issues: [{ path: ['privateUpdates', 0, 'content'], code: 'invalid_type' }],
  truncated: false,
});
```

The prompt still requests the complete template, while the server safely normalizes omitted empty collections and keeps all supplied nested/domain values strictly validated.
