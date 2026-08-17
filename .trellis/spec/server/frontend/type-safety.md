# Server Frontend Boundary Type Safety

- Use `@dnd/contracts` schemas for browser request and response shapes.
- Map database rows to camelCase DTOs before returning them.
- Use discriminated unions for SSE event variants and explicit visibility projections.
- Treat provider debug data and opaque entry payloads as `unknown`; do not expose or cast them into a client shape without a deliberate safe contract.
- Keep HTTP error codes synchronized with `appErrorCodes` and `DEFAULT_HTTP_STATUS`.

The server may use Express types internally, but Express request/response types must not leak into shared contracts or client code.
