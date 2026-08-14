# Harden AI structured output contract

## Goal

Make real OpenAI-compatible turn resolution reliably produce and accept the structured contract expected by the server, while preserving fail-closed formal application and providing enough safe diagnostics to identify schema mismatches.

## Background

Two consecutive production-like runs using `openai-compatible` / `deepseek-v4-flash` failed with `AI_OUTPUT_INVALID`. Both runs emitted a non-empty `ai.preview.delta` before failing. This proves the Provider request succeeded, the response was decoded into a JSON object with `publicNarrative`, and failure occurred later in `turnResolutionSchema` or domain validation.

Repository inspection found:

- `AiContextBuilder` names the output fields but does not require JSON-only output or provide an exact schema/template.
- `OpenAiCompatibleTransport` does not request a structured response mode.
- `turnResolutionSchema` requires `privateUpdates`, `diceResults`, `stateChanges`, and `interactionRequests` even when empty, while newer optional collections already default to `[]`.
- `TurnResolutionValidator` collapses all Zod issues into one generic error, and failed runs do not retain safe issue paths.

Detailed evidence is recorded in `research/live-failure-diagnosis.md`.

## Requirements

### R1. Provide an exact model-facing contract

- The turn-resolution prompt must explicitly require one JSON object and no prose or Markdown outside it.
- It must include a canonical minimal template containing every top-level collection.
- It must explain the important visibility/member/id constraints without asking the model to invent server-owned ids.
- The prompt contract must remain Provider-neutral and work through generic OpenAI-compatible endpoints.

### R2. Tolerate omitted empty collections

- Collections that semantically mean “no updates/results/changes/requests” must default to `[]` when omitted.
- Non-empty values must continue to pass the existing strict nested schemas and domain/member validation.
- `publicNarrative` must remain required and non-empty.
- Unknown or unsafe state mutations must remain rejected.

### R3. Improve safe diagnostics

- Schema failures must record or expose safe issue metadata such as field paths and validation codes.
- Diagnostics must not persist the raw Provider response, API keys, authorization headers, configured endpoint credentials, or player-visible private output.
- The public HTTP error envelope may remain concise; Owner-only run diagnostics must be sufficient to identify which contract field failed.

### R4. Preserve runtime safety and request semantics

- Invalid output must still produce no formal entries, state changes, archive, or next turn.
- The turn must still enter `needs_owner_attention` and the run must still be marked failed.
- Do not add automatic Provider retries; one run attempt remains one Provider request.
- Do not require Provider-specific tool calling or a response-format feature that generic OpenAI-compatible endpoints may not implement.
- Preview privacy behavior must remain unchanged: only `publicNarrative` may be emitted.

## Acceptance Criteria

- [x] A realistic Provider response containing `publicNarrative` but omitting empty collections resolves successfully with those collections normalized to `[]`.
- [x] The actual outbound prompt contains a JSON-only instruction and canonical complete top-level template.
- [x] Malformed nested values still fail with `AI_OUTPUT_INVALID` and produce no formal writes.
- [x] Owner-safe diagnostics identify failing schema/domain paths and controlled codes without storing raw Provider content, rejected ids, or secrets.
- [x] Existing OpenAI-compatible single-request, redirect, timeout, and credential-redaction behavior remains unchanged.
- [x] Focused contract/provider/AI-resolution tests, full tests, typecheck, build, and `git diff --check` pass.

## Out of Scope

- Automatic retries or a second AI “repair” request.
- Provider-specific tool-calling APIs.
- Persisting complete invalid Provider responses.
- Relaxing member, visibility, target ownership, combat command, or state-change whitelist validation.
- Changing gameplay, routes, archive semantics, or realtime projection behavior.
