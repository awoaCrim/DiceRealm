# Implementation Plan: Main Gameplay Vertical Flow Browser Closure

## Ordered checklist

1. Load the relevant client/server Trellis guidance and confirm the current dirty-tree boundaries before editing.
2. Reproduce the browser failure with `npm run test:phase4-browser` and record the proxy TLS error as the initial RED.
3. Update only the test-only browser runner's Vite proxy to trust the existing fixture CA while keeping verification enabled.
4. Rerun the complete browser scenario. If a real flow blocker remains, add the smallest focused RED test, implement the underlying fix, and rerun the scenario.
5. Run the focused server vertical and client workspace/campaign suites.
6. Run repository typechecks, build, and the browser validation command again as the final gate.
7. Review the diff for scope drift and verify no default database/key, deferred Task 8/9 code, or unrelated user changes were touched.

## Validation commands

Initial and final browser gate:

```bash
npm run test:phase4-browser
```

Focused server gate:

```bash
npx vitest run server/src/tests/vertical-ai-resolution-http.test.ts server/src/tests/vertical-characters-http.test.ts server/src/tests/ai-routes-http.test.ts --maxWorkers=1
```

Focused client gate:

```bash
npx vitest run client/src/features/campaigns/campaign-flow.test.tsx client/src/features/player/player-workspace.test.tsx client/src/features/owner/owner-workspace.test.tsx --maxWorkers=1
```

Repository gates:

```bash
npm run typecheck
npm run build
```

Run the repository full test/safety commands when the focused gates are green and use the existing Task 7 ledger conventions for default DB/key/hash protection.

## Risk and rollback points

- **Proxy trust:** prefer explicit CA trust; never solve the test fixture with a process-wide TLS bypass.
- **Browser timing:** preserve existing wait/reconnect assertions and diagnose event ordering instead of adding arbitrary sleeps.
- **Privacy:** keep positive and negative visibility assertions for both players and owner-only data.
- **Persistence:** verify archive restore and AI-created world/combat state through real UI and server state, not fixture-only mocks.
- **Scope:** stop and return to planning if the flow requires bootstrap/admin/security-hardening work rather than the existing gameplay loop.
