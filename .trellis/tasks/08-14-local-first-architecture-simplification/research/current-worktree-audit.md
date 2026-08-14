# Current-worktree architecture audit

## Scope and caveat

This audit reflects the dirty main working tree, including untracked Phase 2/3/4 files. Isolated Explore worktrees were based on clean commit `641709e` and could not see many of those files, so their findings were rechecked against the main worktree before planning.

## Composition and database adapters

- `server/src/platform/database/PostgresDatabaseAdapter.ts` has no production composition caller.
- Current callers are PostgreSQL-specific tests and `rewritePlaceholders` tests:
  - `server/src/platform/database/postgres-contract.test.ts`
  - `server/src/platform/database/postgres-archives-ai.test.ts`
  - `server/src/platform/database/database.test.ts`
- `server/package.json` carries `pg` and `@types/pg` for this unused slice.
- `createSqliteDatabase()` no longer has the old `reuseRaw` option; current production already opens one SQLite adapter.
- `DatabasePort` still exposes `migrate()` and is documented as a SQLite/PostgreSQL portability interface. Migration operations can move to a startup-only SQLite seam while query/transaction/read-committed behavior stays behind `DatabasePort`.
- `MigrationRunner` still imports migration-manifest filename rules and tracks versions in `platform_migrations`; its comments and insert contract still describe PostgreSQL/legacy paths.

## Production versus test composition

Current `CreatePlatformAppOptions` includes these production-relevant values:

- `database`
- `securityConfig`
- `aiProvider`
- `credentialCipher`

It also exposes independent test-only controls:

- `identityOptions`
- `providerFetch`
- `configuredAiProviderFactory`
- `realtimeAuthorityChecker`
- `realtimePollIntervalMs`
- `realtimeHeartbeatIntervalMs`

Current test callers are primarily `server/src/tests/httpTestHarness.ts`, `server/src/tests/fixtures/phase4BrowserServer.ts`, and composition tests. The design should provide a separate test constructor/internal builder rather than leave these on the production interface.

## Startup and migration machinery

`server/src/platform/startup/startPlatformServer.ts` currently performs:

```text
existing-file check
-> InstanceLock
-> migration manifest verification
-> open SQLite
-> StartupSecurityGate exact-set/enrollment/key/decrypt-all/session-ready checks
-> compose app
-> listen
```

The following modules are lifecycle-only and removable under the approved reset boundary:

- `server/src/platform/ops/EnrollmentCoordinator.ts`
- `server/src/platform/ops/SecurityCutoverCoordinator.ts`
- `server/src/platform/ops/OfflineBackupPrimitives.ts`
- `server/src/platform/ops/PlatformInstanceStore.ts`
- `server/src/platform/ops/approvedMigrations.ts`
- `server/src/platform/ops/migrationManifest.ts`
- `server/src/platform/startup/StartupSecurityGate.ts`
- their focused tests/helpers and `migrations.manifest.json`

Current `platformCli.ts` exposes `init`, `enroll`, `resume`, `rollback`, `status`, and `security-cutover`; the maintained CLI can collapse to explicit data-directory initialization.

## Maintenance state

Production maintenance persistence is limited to:

- `platform_instance.maintenance_state/maintenance_epoch` in migration 012;
- `PlatformInstanceStore` transition methods;
- `IdentityRepository.readMaintenanceState()` and the identity expiry/login logic using it;
- realtime runtime `closeAllForMaintenance()`.

No current operator route/command was found that drives a complete maintenance workflow. Normal server shutdown already has an explicit stop-accepting -> realtime close -> connection destroy -> DB close -> lock release sequence.

## Persisted security audit

Current production writers are:

- `IdentityService` session/auth operations;
- `SecurityCutoverCoordinator`.

No current audit read route, repository query surface, or client UI was found. The module adds strict event schemas, secret sentinels, transaction failure coupling, migration 014, and substantial tests without product-visible behavior. It is a valid removal candidate for the clean baseline.

## Realtime authority

Current runtime behavior confirmed in the main worktree:

- `SessionAuthority.isCurrent()` performs a `readCommitted` sessions/users join checking user/session identity, status, revocation, auth revision, revoke epoch, and expiries.
- `eventRoutes.ts` provisionally registers a client, performs a final authority await before SSE headers, and passes the authority binding into the subscription.
- `EventStreamService` checks authority before each Outbox batch and again before every visible frame.
- `IdentityService` emits best-effort post-commit `revokeSession`/`revokeUser` notifications.
- `app.ts` keeps a process-local client Set and supports viewer, session, user, maintenance, and close-all operations.
- `realtime-events-http.test.ts` contains exact-race and per-frame-check tests in addition to replay/privacy/logout tests.

The target can retain connection-time middleware, post-commit same-process closure, periodic fallback validation, replay, and projection while deleting per-frame checks and final-header linearization tests.

## Data-path issue

`server/src/config.ts` defaults to relative `DATABASE_PATH ?? 'dnd.sqlite'`; the credential key path is derived separately. Starting from a different working directory can open a different file. A single `DND_DATA_DIR` from which DB/key/lock/backups are derived is easier to operate and test.

## Migration reset shape

The approved reset boundary makes a clean SQLite baseline viable. `PRAGMA user_version` can be the single schema version:

- 0: reject as empty/legacy;
- 1: clean baseline;
- 2+: future migrations.

Startup can check version before mutation, create a SQLite backup when pending migrations exist, apply each migration and version update atomically, and refuse listening on failure.

## Retained deep modules

- `QueryExecutor` and transaction-scoped executors.
- `DatabasePort` query/transaction/read-committed/close behavior.
- `SqliteDatabaseAdapter` FIFO transaction queue, rollback, nested-call detection, WAL/FK setup.
- `EventPublisherPort` and transactional Outbox.
- `AiProviderPort` and real provider/fallback/test adapters.
- Visibility/event projections.
- AI resolution/materializer/archive transaction modules.
