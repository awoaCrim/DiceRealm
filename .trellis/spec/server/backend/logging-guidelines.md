# Server Logging Guidelines

The server currently uses the platform console rather than a structured logging library. Keep diagnostics deliberate and never turn logs into a second data/API channel.

## Allowed logging

- Startup may emit a short warning when an optional AI provider configuration is incomplete (`server/src/index.ts`).
- The CLI may write user-requested output to its injected `stdout`/`stderr` sinks (`server/src/cli/platformCli.ts`).
- Tests may log progress for a dedicated browser/fixture runner when the output is explicitly test-only.

## Prohibited logging

Never log API keys, decrypted credentials, password values, session tokens, CSRF tokens, full user prompts, raw provider responses, SQL parameters containing secrets, or private player content. Error middleware intentionally sends a fixed generic response and does not log or expose stack/SQL details to clients.

## Operational rule

If a new diagnostic is needed, prefer a stable event/code and a short, redacted message. Do not add `console.log` to domain services or route handlers as a substitute for tests. Keep logs safe under both development and production configuration.
