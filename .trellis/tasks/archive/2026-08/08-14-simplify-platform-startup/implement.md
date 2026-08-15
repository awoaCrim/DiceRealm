# Implementation plan: simplify persistence startup and credential lifecycle

## Preparation

- [ ] Inventory the final schema produced by current migrations and every repository table/index/constraint dependency.
- [ ] Inventory production readers/writers of legacy schema, `platform_instance`, maintenance fields, session-cutover fields, security-audit events, manifest/allowlists, and credential fingerprint state.
- [ ] Confirm the SQLite migration transaction and backup facilities and identify a deterministic failing-migration fixture.
- [ ] Record current CLI/config/data-path behavior and temporary fixture safeguards.

## Data directory and baseline

1. [ ] Introduce one `DND_DATA_DIR`/data-directory configuration with a stable per-user default; derive DB, key, lock, and backup paths from it and require explicit overrides to be absolute.
2. [ ] Build one clean SQLite baseline migration containing all retained production tables, indexes, foreign keys, constraints, and `user_version=1`.
3. [ ] Remove legacy room/token schema, dual tracking tables, historical platform migration files/manifests, and PostgreSQL portability constraints.
4. [ ] Move migration operations out of `DatabasePort` into a SQLite startup module.
5. [ ] Add fresh-schema inventory/repository tests before deleting historical schema paths.

## CLI and startup

6. [ ] Replace enrollment/cutover command families with `platform init [--data-dir]`, sharing the Server's data-directory resolver.
7. [ ] Preserve canonical paths, no-symlink/existing-target refusal, private key permissions, atomic publication, integrity checks, and InstanceLock.
8. [ ] Remove enrollment resume/rollback, security-cutover, sensitive backup/byte-scan, exact manifest/hash allowlist, maintenance coordinators, and obsolete bootstrap environment parsing/tests; update `.env.example`.
9. [ ] Retire `scripts/copy-migrations.mjs` manifest coupling and `scripts/migration-manifest-shared.mjs`; keep build copying only the current SQL files if compiled runtime still requires it.
10. [ ] Split production startup from deterministic coordinator test construction so `createDatabase`, migration/key path overrides, `listen`, `appFactory`, and `emit` are not production options.
11. [ ] Change ordinary startup to reject missing/version-0/newer DBs, automatically back up/apply pending supported migrations, then compose/listen.
12. [ ] Ensure the entire pending migration batch and final `user_version` update are one transaction; failure rolls back the batch, prevents listening, and leaves the pre-migration backup.
13. [ ] Keep graceful HTTP/SSE/DB/lock shutdown order.
14. [x] Add RED dev-lifecycle tests for signal-during-startup, ordinary shutdown, partial-start failure, idempotent repeated signals, lock removal, and immediate restart using temporary data directories.
15. [x] Replace root `concurrently` orchestration with a repository-owned `node --import tsx` coordinator that explicitly loads `server/.env`, starts the Platform Server, then starts Vite programmatically.
16. [x] Await Vite and Platform Server cleanup before dev-process exit; do not use `taskkill /F` or `ChildProcess.kill('SIGINT')` as the graceful path on Windows.
17. [x] Remove `tsx watch` from the lock-owning Server development command unless an explicit application-level close handshake is implemented; preserve frontend Vite HMR and document orderly backend restart.
18. [ ] Add a Windows console-Ctrl+C smoke procedure/check proving the real root command releases the lock and starts again immediately; do not substitute a programmatic child kill.

## Credential/provider isolation

19. [ ] Remove startup fingerprint binding and decrypt-all checks.
20. [ ] Allow non-AI startup when the credential key is missing/malformed without auto-replacing it.
21. [ ] Make selected-campaign decryption failure return a safe provider-unavailable/configuration result.
22. [ ] Allow explicit Owner provider save to atomically create a missing key and replace that campaign's invalid configuration.
23. [ ] Verify unrelated campaigns and non-AI routes remain usable.

## Remove unused lifecycle/audit persistence

24. [ ] Remove `platform_instance`/maintenance/session-cutover persistence and callers obsolete after the realtime child.
25. [ ] Remove persisted security-audit modules/tables/injection/tests because current-worktree review found no product read surface.
26. [ ] Remove obsolete lifecycle/sentinel/manifest tests and helpers, including `superseded-foundations.test.ts`, `legacy-sentinel-startup.test.ts`, `migrationManifest.test.ts`, and `phase2StartupHelpers.ts` where no retained caller remains.
27. [ ] Add root/server SQLite sidecars, local credential key, and instance lock patterns to `.gitignore` without deleting or rewriting the user's current local files.
28. [ ] Remove historical Phase/Task comments and create concise root/local-deployment documentation for init, start, automatic upgrade, rebuild, backup pairing, and the no-forced-kill development lifecycle.
29. [ ] Keep deferred CSRF/strict-body seams intact; do not implement Tasks 8/9 here.

## Validation

- [ ] Init tests pass using temporary absolute data directories.
- [ ] Fresh baseline/schema inventory tests pass.
- [ ] Automatic upgrade, SQLite backup, and failed-migration rollback tests pass.
- [ ] Startup missing/version-0/newer/key/lock/shutdown tests pass.
- [x] Dev coordinator unit/integration tests pass, including cleanup during startup and immediate restart against the same temporary data directory.
- [ ] Windows repository-root `npm run dev` survives an actual console Ctrl+C with no stale lock; a second start reaches readiness immediately.
- [ ] Credential/provider config isolation and recovery tests pass.
- [ ] Identity, Campaign, Character, World, Turn, Combat, Archive, Rules, AI, Outbox, and SSE focused suites pass against the new baseline.
- [ ] `env -u NODE_TLS_REJECT_UNAUTHORIZED npm test -- --maxWorkers=1` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] `env -u NODE_TLS_REJECT_UNAUTHORIZED npm run test:phase4-browser` passes.
- [ ] `git diff --check` passes.
- [ ] Repository-root `dnd.sqlite`, WAL/SHM, and credential-key timestamps/checksums are unchanged by tests.
- [ ] Independent Trellis check confirms conventional automatic migrations, no silent reset, provider fault isolation, and no security/privacy regression.

## Rollback points

- Generate and test the baseline before deleting historical migrations/schema paths.
- Make `user_version` admission and automatic migration green before removing old startup gates.
- Localize provider decryption failure before deleting decrypt-all startup tests.
- Delete audit/lifecycle code only after all production references are removed.
- Never use the repository-root database as a migration or rollback fixture.
