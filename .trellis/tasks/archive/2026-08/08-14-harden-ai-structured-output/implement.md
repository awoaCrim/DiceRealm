# Implementation plan: harden AI structured output

## Preparation

- [x] Capture the two observed failed-run facts in a regression-oriented research note.
- [x] Identify the single owner of prompt construction and every caller of `turnResolutionSchema`.
- [x] Trace `AppError` through `AiResolutionService.fail()` and Owner run detail before choosing the diagnostics representation.

## Implementation

1. [x] Add RED shared-contract tests for omitted empty top-level collections and malformed nested values.
2. [x] Add a RED prompt/provider-boundary test that asserts JSON-only instructions and the complete canonical template are sent.
3. [x] Add a RED vertical resolution test where the Provider returns only `publicNarrative`; assert current `AI_OUTPUT_INVALID`, then normalize omitted collections.
4. [x] Add defaults for semantically empty collections without weakening nested schemas or `publicNarrative`.
5. [x] Centralize and inject the canonical structured-output instruction/template in `AiContextBuilder`.
6. [x] Add bounded safe Zod issue projection for Owner diagnostics without raw values or Provider content.
7. [x] Verify `AiResolutionService.fail()` persists the safe diagnostic while HTTP and SSE errors remain concise and secret-free.
8. [x] Eliminate Provider-controlled member/target ids from domain-validation messages; persist only controlled path/code metadata.
9. [x] Add negative tests for invalid member/visibility/state/combat values and no-formal-write behavior.
10. [x] Confirm the transport still performs one request and does not require `response_format`, tools, or Provider-specific APIs.
11. [x] Remove duplicated top-level `AiPrompt.system`; persist and send one `role=system` message as the single source of system instructions.

## Validation

- [x] `npx vitest run packages/contracts/src/contracts.test.ts server/src/modules/ai-runtime/turn-resolution-validator.test.ts server/src/modules/ai-runtime/open-ai-compatible-provider.test.ts server/src/modules/ai-runtime/open-ai-compatible-transport.test.ts server/src/modules/ai-runtime/ai-context-builder.test.ts server/src/modules/ai-runtime/ai-resolution.test.ts server/src/tests/open-ai-compatible-resolution.test.ts server/src/tests/vertical-ai-resolution-http.test.ts --maxWorkers=1`
- [x] `npm run typecheck --workspace server`
- [x] `env -u NODE_TLS_REJECT_UNAUTHORIZED npm test -- --maxWorkers=1`
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] `git diff --check`
- [x] Independent Trellis check confirms compatibility, privacy, and fail-closed behavior (final recheck: PASS, no blockers).

## Rollback points

- Contract defaults and prompt changes should land together so model guidance and server normalization do not drift.
- Diagnostics must be reviewed before persistence; do not temporarily store raw Provider output.
- No schema migration or automatic retry belongs in this task.
