# Server Frontend Layer

The `server` package contains no React or browser UI source. Its frontend-facing boundary is the HTTP and SSE contract consumed by `client`.

Do not add components, hooks, CSS, or browser state to `server/src`. For a new browser-facing field, update `@dnd/contracts`, the server route/service projection, and the client package separately.

Relevant server-side files are:

- `server/src/routes/` for HTTP endpoint wiring;
- `server/src/platform/realtime/` for SSE transport and event projection;
- `server/src/tests/*-http.test.ts` for browser-facing integration coverage.

Client component and hook rules belong in `.trellis/spec/client/frontend/`.
