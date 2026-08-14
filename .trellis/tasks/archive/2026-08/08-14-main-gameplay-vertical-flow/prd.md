# Main Gameplay Vertical Flow Browser Closure

## Goal

Make the existing end-to-end gameplay path runnable and verifiable through a real browser, prioritizing the product loop over deferred HTTP hardening:

`register/login → create/join campaign → create/approve characters → submit/lock turn actions → AI resolve → realtime story projection → archive → AI-created world/combat projection → restore → logout`.

The repository already contains the intended server, client, and browser scenario. This task closes blockers in that existing flow; it does not redesign the product.

## Confirmed evidence

- Server-side vertical flow tests currently pass:
  - `server/src/tests/vertical-ai-resolution-http.test.ts`
  - `server/src/tests/vertical-characters-http.test.ts`
  - `server/src/tests/ai-routes-http.test.ts`
  - Current result: 3 files, 10 tests passed.
- Client workspace/campaign flow tests currently pass with mocked API boundaries:
  - `client/src/features/campaigns/campaign-flow.test.tsx`
  - `client/src/features/player/player-workspace.test.tsx`
  - `client/src/features/owner/owner-workspace.test.tsx`
  - Current result: 3 files, 44 tests passed, 8 intentionally skipped.
- The real-browser runner already exercises the complete flow in `client/src/tests/phase4-browser-flow.test.ts` using three isolated browser contexts, an in-memory SQLite fixture server, a scripted AI provider, real HTTP/SSE, and real UI interactions.
- The first browser run failed before the registration form because the test-only Vite proxy targeted the fixture's self-signed HTTPS server without trusting its CA:
  - `npm run test:phase4-browser`
  - observed `http proxy error: /api/auth/me` with `self-signed certificate`.
- The static client Vite configuration targets the normal local HTTP server. The browser runner intentionally overrides the proxy and is the correct boundary for test-fixture TLS configuration.

## Requirements

1. Fix the browser runner's test-only `/api` proxy so it trusts the fixture certificate explicitly, without relying on process-wide `NODE_TLS_REJECT_UNAUTHORIZED=0`, `secure: false` in production configuration, or a browser security bypass.
2. Keep the existing browser scenario as the acceptance contract. Do not replace real UI interactions with direct API calls, query-cache seeding, or mocked service responses.
3. Preserve isolated owner/player browser contexts, the in-memory SQLite fixture, deterministic scripted AI provider, real HTTPS fixture server, real SSE disconnect/reconnect checks, and no access to the default database/key.
4. If the first blocker fix exposes another genuine flow blocker, fix the smallest underlying issue and add or update the closest focused regression test. Do not pull in deferred Task 8/9 security hardening or unrelated product features.
5. Preserve the current product boundaries: players submit actions, the owner starts/resolves turns and reviews characters, AI owns world/combat writes, players receive privacy-filtered projections, archives restore gameplay state, and logout returns to authentication.

## Acceptance Criteria

- [ ] `npm run test:phase4-browser` exits successfully and reports all browser scenarios passed.
- [ ] The browser run reaches and verifies registration/login, campaign creation/join, character approval, turn locking, AI resolution, SSE reconnect, privacy isolation, archive restore, AI-created world/combat projections, feature-error recovery, session refresh, and logout.
- [ ] The Vite proxy connects to the HTTPS fixture using explicit CA trust; the solution does not depend on a process-wide TLS verification disable or change production/dev proxy security behavior.
- [ ] Existing focused server vertical tests and client flow/workspace tests remain green.
- [ ] Repository typechecks and the relevant build/validation commands pass.
- [ ] No default `dnd.sqlite*`, credential key, production database, or unrelated user changes are modified.
- [ ] Deferred Tasks 8 and 9 remain deferred; no CSRF/rate-limiter or strict-contract sweep is introduced as part of this task.

## Out of scope

- CSRF implementation, rate limiting, strict contract/schema hardening, and route-parser inventory (deferred Tasks 8/9).
- Bootstrap, platform invite/admin, maintenance, migration 012+, or production deployment work.
- Replacing the deterministic browser fixture with a real external AI provider.
- Broad UI redesign, new gameplay rules, or new domain mechanics beyond blockers discovered in the existing scenario.
