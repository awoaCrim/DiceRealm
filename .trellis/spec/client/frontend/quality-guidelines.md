# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

<!-- What level of testing is expected -->

(To be filled by the team)

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)

---

## Phase 4 Browser Fixture Proxy Contract

### 1. Scope / Trigger

This contract applies when the real-browser Phase 4 runner proxies same-origin `/api` requests from Vite to the repository's ephemeral HTTPS fixture. It is test-only: production client proxy behavior and server security policy must remain unchanged.

### 2. Signatures

- Runner: `scripts/phase4-browser-validation.ts` creates a Vite server with an overridden `/api` proxy.
- Fixture: `startPhase4FixtureServer()` returns `baseUrl`, where the fixture presents the repository TLS certificate.
- Proxy target: `target: fixture.baseUrl` with the fixture certificate supplied as `ca`.

### 3. Contracts

- The proxy must set `secure: true`; certificate verification is required.
- The CA must be read from `server/src/tests/fixtures/tls/localhost-cert.pem`, not replaced by a global TLS bypass.
- The proxy must use `changeOrigin: true` and send the fixture HTTPS origin outbound so the fixture sees its expected Host/Origin while the browser remains same-origin with Vite.
- `client/vite.config.ts` is the normal development configuration and is not changed to accommodate the test fixture.

### 4. Validation & Error Matrix

| Condition | Expected result |
| --- | --- |
| Fixture certificate is supplied and verification is enabled | Browser `/api` and SSE traffic reaches the fixture |
| CA is omitted or wrong | The runner fails closed with a TLS proxy error |
| `secure: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, or browser certificate bypass is introduced | Reject the change; it weakens the security boundary |
| Normal client Vite proxy is modified for the fixture | Reject the change; keep the test override isolated |

### 5. Good / Base / Bad Cases

- **Good:** the runner reads the fixture certificate, configures `ca` plus `secure: true`, and the full three-context browser scenario passes with `NODE_TLS_REJECT_UNAUTHORIZED` unset.
- **Base:** the fixture remains in-memory, uses an ephemeral port, and the browser uses real HTTP/SSE through Vite.
- **Bad:** disabling verification or changing production-shared proxy settings merely to make the self-signed fixture connect.

### 6. Tests Required

- Run `env -u NODE_TLS_REJECT_UNAUTHORIZED npm run test:phase4-browser` and assert the full scenario passes.
- Run the focused server/client regressions, repository typecheck, build, and full Vitest suite.
- Check `git diff --check` and verify `client/vite.config.ts` is unchanged.

### 7. Wrong vs Correct

#### Wrong

```ts
proxy: { '/api': { target: fixture.baseUrl, secure: false } };
```

#### Correct

```ts
proxy: {
  '/api': {
    target: fixture.baseUrl,
    changeOrigin: true,
    ca: phase4FixtureCa,
    secure: true,
    headers: { origin: fixture.baseUrl },
  },
}
```
