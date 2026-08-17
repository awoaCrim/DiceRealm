# Contracts Backend Logging Guidelines

`@dnd/contracts` is a pure library and must not log. It has no logger, console calls, network access, or environment reads.

## What belongs in this package

- Zod schemas and pure contract helpers, such as `eventDefaultAudience` and `canReadEvent`.
- Error-code and payload definitions that other layers can validate.
- Tests that report failures through the test runner.

## What does not belong here

- Logging provider calls, user prompts, credentials, raw AI output, SQL, or stack traces.
- Adding diagnostic fields solely for logging. If a field is required for a public or owner-safe DTO, define its contract explicitly and document its visibility.
- Formatting operational messages. Server startup and route layers own operational diagnostics.

A schema failure should be surfaced as a parse/safe-parse result to the caller. The caller decides whether it becomes an HTTP error, a test failure, or a safe UI fallback.
