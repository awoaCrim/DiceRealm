# Design: simplify persistence startup and credential lifecycle

## 1. One data directory

Replace independently configured relative database/key paths with one local data directory:

```text
DND_DATA_DIR/
├── dnd.sqlite
├── .dnd-instance.lock
├── .dnd-ai-credential-key
└── backups/
```

Production derives all operational paths from this directory. `DND_DATA_DIR`, when supplied, must resolve to an explicit absolute directory; otherwise both CLI and Server use one stable per-user default such as `~/.dnd-ai-dm`. Tests inject a temporary absolute directory. This avoids opening a different database merely because the process was started from another working directory.

## 2. Reset and schema-version boundary

The user approved discarding existing databases. Replace the historical 001–014 development migration chain with one clean SQLite baseline representing the maintained local-first schema.

Use SQLite `PRAGMA user_version` as the single schema-version source:

- `0`: empty, manually created, or unsupported legacy database — ordinary startup rejects it and instructs `platform init`/rebuild.
- `1`: clean local-first baseline.
- `2+`: future conventional migrations.

Remove `platform_migrations`, migration filename/hash manifests, frozen allowlists, and exact applied-set startup checks. Migration execution is an internal SQLite startup concern, not part of the domain-facing `DatabasePort` interface.

## 3. Baseline schema contents

The clean baseline contains the current gameplay state needed by production:

- users and secure digest sessions;
- campaigns, members, and invites;
- characters and review state;
- world facts;
- transactional Outbox;
- turns, actions, requests, and entries;
- archives;
- AI runs/logs and encrypted campaign provider config;
- combat state;
- rule-source metadata.

Exclude lifecycle-only persistence that has no current product consumer:

- enrollment state/key origin/fingerprint binding;
- maintenance `active/draining/quiescent` state and epochs;
- session-security `pending/cleaning/ready` cutover state;
- persisted security-audit machinery when repository inspection confirms there is no current read surface or product requirement;
- legacy room/token tables and dual migration tracking.

Keep secure session fields required by current cookie-only authentication, expiry, logout-all/user invalidation, and CSRF. Do not broaden this child into a password/session redesign unless a field exists only for the removed per-frame realtime authority protocol.

## 4. Fresh initialization

The maintained CLI has one primary operation:

```text
platform init [--data-dir <absolute-path>]
```

Flow:

1. Canonicalize/create the data directory with private practical permissions.
2. Refuse database/key symlinks and refuse existing target files.
3. Acquire the CLI/instance lock.
4. Create a temporary SQLite database in the data directory.
5. Apply the full baseline and set `user_version = 1` in the migration transaction.
6. Run foreign-key and integrity checks.
7. Generate and atomically publish the local credential key.
8. Atomically publish the initialized database.
9. Reopen/reload both artifacts for a final lightweight verification.
10. Close and release.

`enroll`, `enroll-resume`, `enroll-rollback`, `security-cutover`, sensitive token byte scans, hash-bound migration allowlists, and obsolete bootstrap environment parsing are removed. `.env.example` is updated to the data-directory/init model.

No command silently replaces an existing database. Rebuild is explicit: stop the server, make any desired manual backup, move/delete the data directory artifacts, and run init.

## 5. Ordinary startup and automatic upgrades

```text
resolve data directory
  -> validate existing regular DB/no symlink
  -> acquire instance lock
  -> open one SQLite adapter
  -> read user_version
  -> reject version 0 or newer-than-supported version
  -> if pending migrations exist:
       atomically replace one rotating SQLite backup at backups/pre-migrate.sqlite
       apply each migration transactionally with user_version update
       run quick/integrity check
  -> construct credential store (key may be unavailable)
  -> compose app
  -> listen
```

Properties:

- Missing database: fail with `platform init` instruction.
- Unsupported/legacy database: fail with rebuild instruction before migration.
- Pending supported migrations: back up once, then apply the entire pending batch automatically before listening.
- Migration failure: the whole pending batch and final `user_version` update roll back, the Server never listens, and the pre-migration backup remains available.
- Newer database version: fail rather than downgrading.
- Missing/malformed credential key: do not replace it during startup and do not block non-AI functionality.
- One corrupt provider ciphertext: does not affect startup.

Keep InstanceLock, SQLite foreign keys/WAL/busy timeout, graceful shutdown, and safe coarse errors.

## 6. Production and test startup seams

The production startup function accepts only real runtime inputs, such as validated application config and environment/provider configuration. Current coordinator controls—database factory, migration directory, credential path, listener factory, app factory, and ordering-event emitter—move to a distinct startup test constructor or one internal test options seam that production startup never imports.

This preserves deterministic startup/shutdown/failure tests without advertising test factories as production configuration.

## 7. Migration module shape

Move migration operations out of `DatabasePort`. The production app receives only the query/transaction/read-committed database seam. Startup owns a small SQLite-only migration module such as:

```text
readSchemaVersion(sqlite)
applyPendingMigrations(sqlite, migrationsDir)
```

All pending migration scripts and the final `PRAGMA user_version` update execute inside one SQLite transaction, so the supported version advances only when the whole batch commits. Delete PostgreSQL/synchronous/legacy migration execution paths.

CI validates that a fresh baseline initializes every repository and that a synthetic later migration upgrades atomically.

## 8. Provider credential lifecycle and fault isolation

Saved campaign API keys remain AES-encrypted with one local credential key, but the key is no longer fingerprint-bound to a database singleton and startup no longer decrypts all rows.

### Read/use path

```text
load selected campaign config
  -> key present and ciphertext valid: construct provider
  -> key missing/malformed or ciphertext invalid: only that campaign provider is unavailable
```

Return a safe actionable AI credential/configuration error. Never expose ciphertext, key path, AES details, raw Provider error, or secrets.

### Save/recovery path

- Normal save uses the existing local key.
- If the key is missing, an explicit Owner save may atomically create a new key and replace that campaign's configuration; other old ciphertext remains unavailable until each affected campaign is re-saved.
- Startup itself never creates/replaces the key.
- Re-saving the affected campaign is the supported recovery action.

Backups should normally preserve the data directory as a unit. A database without its matching key retains gameplay data but requires provider keys to be re-entered.

## 9. Security-audit simplification

If `security_audit_events` has no current read route/UI and its production writers exist only for enrollment/cutover/session ceremony, remove the persisted audit module and its injection seams. Authentication still uses coarse safe errors and must not log secrets.

This removes a failure mode where audit persistence can roll back user-visible session operations without providing a product-visible audit capability.

## 10. Tests

Replace lifecycle-state matrices with observable product tests:

- init refuses existing DB/key and symlinks;
- init creates a startable baseline, `user_version=1`, and reloadable key;
- startup rejects missing/empty/version-0/newer databases;
- startup automatically backs up and applies a synthetic pending migration before listening;
- migration failure rolls back the entire pending batch, prevents listening, and leaves the pre-migration backup;
- lock contention prevents two instances/CLI operations;
- missing/malformed key permits non-AI startup but AI configuration is unavailable;
- an explicit provider re-save can create/recover the key;
- corrupt one-campaign ciphertext does not block startup or another campaign;
- all fixtures use in-memory or temporary directories, never repository-root `dnd.sqlite`.

## 11. Development lifecycle on Windows

The current repository-root process tree is unsafe for a lock-owning child on Windows:

```text
concurrently SIGINT
  -> tree-kill
  -> taskkill /T /F
  -> Server dies before async close
  -> .dnd-instance.lock remains
```

`ChildProcess.kill('SIGINT')` is not a graceful fallback on Windows, and `tsx watch` can create the same problem when it kills/restarts the backend child. Replace this tree with one repository-owned coordinator executed directly in a single Node process:

```text
node --import tsx scripts/dev.ts
  -> load server/.env explicitly
  -> register SIGINT/SIGTERM before startup
  -> startPlatformServer(...)
  -> create/start ViteDevServer programmatically
  -> on shutdown: stop Vite intake -> close Platform Server -> exit
```

The coordinator owns both runtime handles and awaits both close paths. Backend startup must complete before Vite is exposed, preserving the current readiness intent without a polling child command. If a signal arrives during startup, the coordinator waits for the current startup step to settle and closes every resource that was created. Repeated signals do not start a second cleanup chain.

The root development command must not depend on `concurrently`, `tree-kill`, workspace npm wrappers, or `tsx watch` for the lock owner's lifetime. The direct Server development command likewise runs without a force-killing watch supervisor. Vite continues to provide frontend HMR; backend edits use an orderly stop/start unless a future watcher introduces an explicit application-level shutdown handshake.

This change does not weaken InstanceLock. Existing well-formed, corrupt, or foreign lock files remain fail closed under the lock policy; normal Ctrl+C correctness comes from allowing the owning process to execute `release()` rather than deleting its file externally.

Tests use injected backend/Vite starters and captured signal handlers to prove startup, partial-start cleanup, close ordering, idempotency, and immediate restart against a temporary data directory. Windows validation must also exercise actual console Ctrl+C; `ChildProcess.kill('SIGINT')` is explicitly not an equivalent smoke test.

## 12. Risks and rollback

- Squashing requires a complete schema inventory; compare fresh baseline objects/columns/indexes/FKs/triggers against the intended final domain schema and run every repository test.
- Version 0 must be rejected before automatic migration to avoid mutating unsupported files.
- The single rotating automatic backup must use SQLite's backup facility while holding InstanceLock, not copy an active main file.
- Removing persisted audit/lifecycle code must remove real dependencies rather than leave no-op compatibility adapters.
- Replacing the dev process manager must preserve Vite proxy/HMR behavior and explicitly load the Server environment before configuration is evaluated.
- The reset boundary is approved, so implementation rollback uses temporary fixtures and source control, not a production conversion path.
