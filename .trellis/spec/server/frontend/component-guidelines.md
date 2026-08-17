# Server Frontend Component Guidelines

There are no frontend components in the `server` package. Server code must return contract-shaped JSON or projected SSE events; it must not render HTML components or embed client presentation logic.

A route may choose an HTTP status and envelope, but labels, loading states, retry controls, and layout belong to `client/src/features` or `client/src/shared/ui`.

The server should expose semantic domain values (`turnStatus`, `entryKind`, event `type`) rather than UI-specific strings. Use `@dnd/contracts` schemas to keep the component-facing boundary explicit.
