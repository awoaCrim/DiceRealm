# Client Frontend Quality Guidelines

## Required patterns

- Run `npm run typecheck --workspace client`, focused Vitest tests, and the production build for client changes.
- Use `platformRequest` with a response schema for every API call. It handles credentials, CSRF, timeout, error envelopes, and response validation.
- Test user-visible behavior with Testing Library rather than implementation details. Keep browser-only Phase 4 coverage in the dedicated runner.
- Preserve server-owned visibility and projection rules; the client renders the data it receives.
- Keep auth failure handling centralized through `authRequiredBus` and `AppProviders`.

## Forbidden patterns

- Do not use raw `fetch` in feature components or bypass `platformRequest`.
- Do not cast network data with `as` or render `JSON.stringify` as user content.
- Do not create a second global auth/realtime context when the app already uses the Query cache and realtime boundary.
- Do not share a single query key across different campaign/turn IDs.
- Do not disable TLS verification or weaken production Vite proxy settings for the Phase 4 fixture.

## Review checklist

- Is the route response parsed by a contract schema?
- Are loading, empty, error, and retry states usable and accessible?
- Are mutation invalidations correct?
- Does the test cover the behavior and the relevant role/audience?
- Does the component remain safe when an opaque payload is malformed?
