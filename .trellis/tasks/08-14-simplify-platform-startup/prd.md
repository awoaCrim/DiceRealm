# Simplify persistence startup and credential lifecycle

## Goal

Replace the enterprise-style enrollment/cutover/startup choreography with a maintainable single-instance SQLite lifecycle. This task is an explicit reset boundary: existing local databases do not need to remain compatible.

## Requirements

### R1. Fresh initialization

- Provide one primary `platform init [--data-dir <absolute-path>]` flow that creates the SQLite database, applies the current schema, creates the local credential key, and leaves the instance ready to start; without an override it uses the same stable per-user default directory as Server startup.
- Derive the database, lock, backup, and credential-key paths from one data directory rather than independent relative paths.
- Do not require a fresh user to understand enrollment, cleaning, cutover, or migration allowlists.

### R2. Ordinary startup

- Require an existing supported SQLite database; key absence/malformation may disable AI credentials but must not block non-AI startup.
- Retain SQLite instance locking and schema compatibility checks.
- Use SQLite `PRAGMA user_version` as the single schema version and automatically apply conventional pending migrations before app composition/listening.
- Create a SQLite backup before applying pending migrations; the entire pending migration batch and final version update must commit or roll back together, and any failure must prevent listening.
- Do not perform destructive session cleanup or surprise database creation during ordinary startup.
- Move accidental migration-integrity checks to build/CI where practical rather than requiring an exact runtime file/hash set for every start.

### R3. Reset boundary and schema baseline

- Existing 001–014 and intermediate databases are unsupported after this refactor and may be intentionally rebuilt.
- Prefer a clean squashed baseline when it removes migration, enrollment, cutover, maintenance, or audit scaffolding that has no steady-state product use.
- Startup must reject an old/incompatible database with a short rebuild instruction rather than attempting an implicit conversion.
- No automated command may silently delete an existing database; rebuild remains an explicit operator action.

### R4. Credential handling

- Continue encrypting saved campaign AI-provider API keys at rest.
- Startup must not perform whole-database decrypt-all or block non-AI functionality because the key/config is unavailable.
- Keep key-file permissions and a clear key-loss recovery story.
- A missing or corrupt provider configuration must be reported at campaign/provider use time and must not block unrelated server functionality.
- Startup must not automatically overwrite an existing unmatched/missing key; an explicit Owner provider save may create a missing key and replace only that campaign configuration.

### R5. Maintainability

- Remove or archive one-time state machines, bootstrap environment validation, and security-cutover code that no longer belongs in normal operation.
- Keep migration behavior conventional and easy to extend with future `user_version` migrations.
- Expose a narrow production startup function; database/listener/app factories, emitted ordering events, temporary migration directories, and similar coordinator controls belong to a separate startup test constructor/internal seam.
- Document backup pairing between the SQLite database and local credential key.
- Ignore root/server SQLite sidecars, local key, and instance-lock artifacts so local data cannot be committed accidentally.

## Acceptance Criteria

- [ ] Fresh initialization reaches a startable state through one documented data-directory flow.
- [ ] Ordinary startup does not create a missing production database.
- [ ] Ordinary startup accepts the new `user_version` baseline without literal exact-set/hash choreography, backs up the database, and automatically applies later pending migrations before listening.
- [ ] Unsupported or unsafe schema states fail with a short actionable message.
- [ ] A missing/malformed key or one corrupt provider ciphertext does not prevent server startup or non-AI campaign access.
- [ ] Re-saving the affected campaign provider configuration restores AI availability.
- [ ] Instance locking and graceful close remain intact.
- [ ] Migration/startup/credential tests use temporary databases only.
- [ ] Obsolete bootstrap environment variables and their negative tests/documentation are removed.
- [ ] Production startup has no test-factory/emit/migration-directory override bag; deterministic coordinator tests use a separate test seam.

## Out of Scope

- Online zero-downtime migration.
- Signed release artifacts or supply-chain attestation.
- OS-specific keychain integration.
- PostgreSQL migration behavior.

## Compatibility and Upgrade Decisions

- Existing databases may be discarded and rebuilt. No legacy upgrade path is required in the maintained runtime architecture.
- Future supported schemas upgrade automatically at Server startup. A missing database is never implicitly initialized, and a failed migration never proceeds to listening.
