# Server Frontend Boundary Quality Guidelines

- Treat HTTP JSON and SSE as public browser contracts; validate them with `@dnd/contracts`.
- Keep response envelopes stable and use typed error codes.
- Project audience-sensitive data on the server. Never send owner-only or another player's private entries and expect the browser to filter them.
- Test route status, envelope shape, authorization, and reconnect/replay behavior in server HTTP tests.
- Keep browser-only proxy/TLS fixture behavior isolated to `scripts/phase4-browser-validation.ts` and test fixtures; do not weaken production security for a browser test.

This layer is intentionally not a React layer. Client UI quality rules live in the client package specs.
