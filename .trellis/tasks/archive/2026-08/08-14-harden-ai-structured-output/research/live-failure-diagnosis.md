# Live structured-output failure diagnosis

Date: 2026-08-14

## Read-only evidence

The active development database `server/.dev/dnd.sqlite` was opened read-only. Two consecutive runs for the same turn were observed:

- Provider: `openai-compatible`
- Model: `deepseek-v4-flash`
- Attempts: 1 and 2
- Final status: `failed`
- Error code: `AI_OUTPUT_INVALID`

Each run emitted:

1. `ai.preview.started`
2. a non-empty `ai.preview.delta` containing coherent public narrative
3. `ai.preview.failed` with `AI_OUTPUT_INVALID`

## What this proves

`OpenAiCompatibleAiProvider` emits a preview only after `extractJsonObjectCandidate()` has parsed a JSON object and found a non-empty string `publicNarrative`. Therefore both failures occurred after successful HTTP transport and JSON-object decoding, at `turnResolutionSchema`, domain validation, or formal apply validation.

The persisted error is the generic AppError only. Failed `raw_debug_json` does not contain the model object or safe Zod issue paths, so the exact rejected field cannot be reconstructed from the current run record.

## Repository mismatch

- `AiContextBuilder` asks for named structured fields but supplies no exact JSON-only template.
- `OpenAiCompatibleTransport` sends `model`, `messages`, `temperature`, and `stream:false`, with no structured-output mode.
- `turnResolutionSchema` requires four commonly empty collections while only newer creation collections default to `[]`.
- `TurnResolutionValidator` discards Zod issue details.

## Tight feedback signals

- Live symptom query: latest runs must not end in `AI_OUTPUT_INVALID` after a valid public preview for a minimal turn.
- Deterministic regression: a local HTTP stub returns `{ "publicNarrative": "..." }`; the vertical runtime should normalize omitted empty collections and complete the turn.
- Prompt assertion: captured outbound messages must contain the canonical complete JSON template and JSON-only instruction.

## Security constraint

Do not persist raw invalid Provider responses. Diagnostics should retain only bounded schema issue paths/codes and must exclude values, prompt content, URLs, API keys, and headers.
