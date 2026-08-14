# Implementation plan: local-first architecture simplification

## Execution strategy

Implement one child at a time in the order below. Each child must return to green before the next child starts. The parent is not a direct implementation target; it owns compatibility decisions and final integration verification.

## Phase A — composition and adapter cleanup

- [ ] Complete and approve `08-14-simplify-composition-adapters` artifacts.
- [ ] Start only that child task.
- [ ] Remove PostgreSQL code/dependencies/support claims.
- [ ] Add a separate test-only app constructor and narrow production composition to real dependencies.
- [ ] Run focused app/database/harness tests, typecheck, and build.
- [ ] Run a Trellis quality review before moving to the next child.

Rollback point: restore the adapter/dependency and prior app option shape; no schema or data change occurs in this phase.

## Phase B — realtime/session simplification

- [ ] Complete and approve `08-14-simplify-realtime-session` artifacts.
- [ ] Start only that child task after Phase A is green.
- [ ] Remove per-frame authority reads and final-header race machinery.
- [ ] Keep established-stream post-commit revocation and add/document low-frequency fallback authority checks.
- [ ] Remove dormant realtime maintenance hooks and unreachable maintenance behavior.
- [ ] Update race-heavy tests to assert the simpler bounded-revocation contract.
- [ ] Run focused identity/SSE/client realtime tests and the browser disconnect/reconnect flow.
- [ ] Run a Trellis quality review before moving to the next child.

Rollback point: restore the prior EventStreamRuntime/SessionAuthority contract; no schema reset occurs in this phase.

## Phase C — startup, migration, and credential simplification

- [ ] Complete and approve `08-14-simplify-platform-startup` artifacts.
- [ ] Start only that child task after Phase B is green.
- [ ] Establish the clean fresh-database migration baseline.
- [ ] Reduce the CLI to the documented initialization/reset-boundary operations.
- [ ] Make ordinary startup apply conventional pending migrations before listening.
- [ ] Remove enrollment/security-cutover/manifest/hash/decrypt-all steady-state machinery and obsolete security-audit/maintenance persistence if confirmed unused.
- [ ] Isolate campaign provider decryption failure at provider-use time.
- [ ] Update temporary-database tests and user-facing initialization/rebuild documentation.
- [ ] Run focused migration/startup/credential tests and a Trellis quality review.

Rollback point: because the user approved a reset boundary, rollback is code-only using temporary fixtures. Never use repository-root `dnd.sqlite` as a test rollback artifact.

## Parent integration verification

- [ ] Verify task artifacts and implementation agree across all three children.
- [ ] Confirm no production import/reference remains for PostgreSQL, enrollment, security-cutover, migration manifest/allowlist, per-frame authority checking, or maintenance-only realtime runtime.
- [ ] Confirm retained seams each provide concrete leverage.
- [ ] Confirm comments/docs describe the local-first product rather than historical Phase/Task plans.
- [ ] Run focused server tests for app composition, database migrations/startup, identity, AI provider config, Outbox/SSE, archive, and HTTP routes.
- [ ] Run focused client realtime/browser-flow tests.
- [ ] Run `env -u NODE_TLS_REJECT_UNAUTHORIZED npm test -- --maxWorkers=1`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `env -u NODE_TLS_REJECT_UNAUTHORIZED npm run test:phase4-browser`.
- [ ] Run `git diff --check`.
- [ ] Verify no test touched repository-root `dnd.sqlite` or its WAL/SHM files.
- [ ] Run final independent Trellis check.
- [ ] Update `.trellis/spec/` with the accepted SQLite-only startup, migration, realtime, and composition contracts.

## Review gates

- Do not start a child until its final planning summary has been approved.
- Do not combine child implementations in parallel because `server/src/app.ts`, test harnesses, and migration fixtures overlap.
- Stop before deleting any unexpected user-authored change that conflicts with these plans.
- Do not weaken HTTPS, Origin, cookie, privacy projection, transactional Outbox, AI whitelist, or archive transaction behavior to make tests pass.
- Do not commit unless the user explicitly requests a commit.
