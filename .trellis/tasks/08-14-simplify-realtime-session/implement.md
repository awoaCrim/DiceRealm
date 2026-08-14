# Implementation plan: simplify realtime session lifecycle

## Preparation

- [ ] Read the final PRD/design and relevant current-worktree files; many are untracked relative to HEAD.
- [ ] Confirm production callers of `closeViewer`, `closeAllForMaintenance`, maintenance-state reads, and authority-check overrides.
- [ ] Capture the focused identity/SSE/client realtime test commands from package scripts.

## Implementation

1. [ ] Reduce `EventStreamRuntime` to established-client registration, session/user revocation, and close-all behavior.
2. [ ] Simplify the app-level client registry to one close callback and minimum session/user identity.
3. [ ] Remove provisional registration/final-header linearization from `eventRoutes.ts`.
4. [ ] Move session-authority validation to connection admission plus an at-most-once-per-60-seconds subscription deadline.
5. [ ] Remove database `ensureCurrent` calls from per-frame delivery while retaining the in-memory `state.closed` fence before each frame.
6. [ ] Preserve Outbox cursor/projection/backpressure behavior unchanged.
7. [ ] Keep IdentityService's post-commit best-effort session/user notifier with the reduced runtime interface.
8. [ ] Remove maintenance-only realtime hooks and production `closeViewer`; in coordination with the startup child, remove maintenance-state identity behavior.
9. [ ] Update `server/src/tests/fixtures/phase4BrowserServer.ts` so its disconnect/reconnect scenario uses a test-only connection control returned by the test constructor, not the production runtime and not `revokeSession`.
10. [ ] Keep short authority/poll/heartbeat intervals under the separate test constructor/lower-level EventStream seam introduced by the composition child.
11. [ ] Replace exact-race tests with bounded-revocation and bounded-check-frequency tests.
12. [ ] Record the accepted 60-second fallback trade-off in the implementation/review ledger.
13. [ ] Remove stale Phase/Task comments in touched code; retain only invariant explanations.

## Validation

- [ ] Focused `EventStreamService` tests pass.
- [ ] Focused realtime HTTP tests pass.
- [ ] Focused IdentityService revocation/expiry tests pass.
- [ ] Client `RealtimeSession` replay/dedup/reconnect tests pass.
- [ ] Phase 4 browser SSE disconnect/reconnect, logout, privacy projection, AI, and archive flow passes.
- [ ] Server/client typecheck passes.
- [ ] Build passes.
- [ ] `git diff --check` passes.
- [ ] Independent Trellis check confirms there is no per-frame authority database read and no privacy regression.

## Rollback points

- Before changing route registration: EventStreamService authority frequency can be changed independently.
- Before deleting race tests: keep old tests until the replacement contract tests are green.
- If immediate same-process logout closure regresses, restore the notifier registry without restoring per-frame checks.
