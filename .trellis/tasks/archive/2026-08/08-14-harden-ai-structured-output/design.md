# Design: reliable and diagnosable AI structured output

## 1. Failure boundary

The observed path is:

```text
OpenAI-compatible HTTP success
→ JSON object extraction succeeds
→ publicNarrative preview is emitted
→ turnResolutionSchema/domain validation fails
→ AI_OUTPUT_INVALID
```

The fix therefore belongs at the model contract and schema-normalization boundary, not in HTTP transport retry logic or formal state application.

## 2. Canonical prompt contract

`AiContextBuilder` remains the owner of the turn-resolution prompt. Define one reusable structured-output instruction/template near that builder and include it in the system/user messages. `AiPrompt.messages` is the single source of Provider conversation input: do not duplicate the same system text in a top-level `AiPrompt.system` field, because the complete prompt is persisted in `context_json`.

The instruction requires:

- one JSON object only;
- no Markdown fences or explanatory prose;
- all top-level fields shown in a canonical template;
- empty arrays when there is nothing to report;
- server-owned ids omitted for creations;
- existing member/character ids copied exactly when required.

Keep the prompt Provider-neutral. Do not make `response_format` mandatory in this task because the product accepts arbitrary OpenAI-compatible endpoints and the transport is also used by the plain-text connection test.

## 3. Schema normalization

Update `turnResolutionSchema` so these semantically optional collections default to `[]`:

- `privateUpdates`
- `diceResults`
- `stateChanges`
- `interactionRequests`
- existing defaults for `worldFactCreations` and `encounterStarts` remain.

This normalizes a common model omission without weakening nested validation. `publicNarrative` stays `z.string().min(1)`. Supplied list entries still use the existing strict schemas and downstream member/target checks.

## 4. Safe validation diagnostics

Introduce a bounded safe projection of schema and domain validation issues. It contains only controlled path/code metadata, for example:

```json
{
  "issues": [
    { "path": ["diceResults", 0, "targetPlayerId"], "code": "custom" }
  ]
}
```

Do not include `received` values, rejected member/target ids, raw Provider output, prompt content, API credentials, URLs, or arbitrary model text. Schema-valid domain failures must never interpolate model-provided ids into an `AppError.message`; use a controlled path/code such as `privateUpdates.0.playerId / not_campaign_member` instead.

`TurnResolutionValidator` should throw an `AppError('AI_OUTPUT_INVALID', ...)` carrying or encoding this safe metadata through the existing failure persistence path. If the existing `AppError`/`fail()` shape cannot retain structured metadata cleanly, store a bounded sanitized diagnostic object specifically for Owner-only `rawDebug`; keep the client-facing message generic.

Diagnostics must be capped by issue count/path length to avoid unbounded model-controlled storage.

## 5. Compatibility and safety

- One attempt still performs exactly one Provider request.
- `extractJsonObjectCandidate` remains tolerant of JSON fences/prose for compatibility, even though the improved prompt asks for JSON-only output.
- Preview continues to emit only the parsed non-empty `publicNarrative`.
- Formal apply remains fully transactional and fail-closed.
- No database schema change is required; existing `raw_debug_json` can hold a safe diagnostic projection.

## 6. Regression seams

Add tests at three layers:

1. Shared contract: omitted empty collections normalize to `[]`; malformed nested entries still reject.
2. Prompt builder/provider boundary: outbound messages contain the canonical JSON-only template.
3. Vertical AI resolution: a Provider object with only `publicNarrative` succeeds; malformed nested output fails with safe diagnostics and no formal writes.

## 7. Rollback

The changes are limited to contract defaults, prompt text, validation diagnostics, and tests. Rollback requires no data migration. Existing failed runs remain readable under the current Owner-only run detail API.
