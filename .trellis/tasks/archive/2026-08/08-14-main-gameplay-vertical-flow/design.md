# Design: Main Gameplay Vertical Flow Browser Closure

## Boundary

This is an integration-closure task around the existing Phase 4 browser acceptance harness. The primary change boundary is the test-only orchestration layer in `scripts/phase4-browser-validation.ts`; the static client Vite configuration and production server composition must not be weakened to accommodate the self-signed fixture.

## Existing flow contract

The browser scenario already defines the vertical data flow:

```text
real browser contexts
  -> Vite same-origin frontend
  -> test-only /api proxy
  -> HTTPS fixture server
  -> in-memory SQLite + scripted provider
  -> real route/service/repository/outbox/SSE path
  -> role/privacy-filtered UI projections
```

The owner, player A, and player B contexts must remain isolated. The scripted provider supplies deterministic output so the scenario can assert public/private/owner-only projections, preview replay, world facts, encounters, and archive restoration without external network calls.

## TLS proxy fix

The fixture server intentionally uses HTTPS with a repository test certificate. The runner currently passes a plain `target` to the Vite proxy, so Node's proxy client does not trust the self-signed certificate. Configure the runner's overridden `/api` proxy with the fixture certificate as an explicit CA and leave certificate verification enabled. The certificate path is resolved from the existing fixture files using the same repository-local boundary used by the fixture server.

Do not:

- change `client/vite.config.ts`'s normal HTTP development target;
- set `NODE_TLS_REJECT_UNAUTHORIZED=0` as the solution;
- use a global browser ignore-certificate-errors flag;
- set an insecure proxy option in production-shared configuration.

## Failure handling

After the proxy fix, rerun the complete scenario. If another blocker appears, classify it as one of:

1. test-runner/fixture integration configuration;
2. a real server/client vertical-flow defect;
3. a stale or incorrect browser assertion.

Fix only categories 1 or 2 in this task, and update the closest regression coverage. Do not weaken a privacy, role, persistence, or realtime assertion merely to make the scenario pass.

## Compatibility and rollback

- The fixture remains `:memory:` and uses an ephemeral TLS port.
- The default client proxy and production security behavior remain unchanged.
- A rollback consists of reverting only the test-runner proxy trust configuration and any narrowly discovered flow fix; no database or migration rollback is needed.
- Deferred security hardening remains a separate future milestone.
