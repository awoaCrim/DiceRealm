# Simplify local-first architecture

## Goal

Reduce operational, runtime, and maintenance complexity so the product is easy to install, understand, recover, and evolve for its intended deployment model: one local or remotely reachable server used by a small group of trusted acquaintances.

The simplification must preserve the core gameplay vertical flow and the security controls required when that single server is reachable from the public Internet.

## Background

- Production currently composes one Node/Express process with SQLite.
- PostgreSQL has an adapter but no production startup composition.
- Platform initialization and startup include enrollment, exact migration-set/hash verification, credential-key fingerprint binding, session-security cutover, and fail-closed decrypt-all behavior.
- SSE combines transactional outbox replay with per-poll/per-event authoritative session checks and in-process revocation.
- The composition root exposes multiple test-only injection options.
- A repository-root `dnd.sqlite` currently exists; the user explicitly allows rebuilding it and does not require preservation of existing local data. Planning and automated tests must still not inspect or mutate it accidentally.

## Requirements

### R1. Preserve the product-defining core

The refactor must preserve:

- cookie-only authenticated accounts and campaign authorization;
- Owner/Player server-side visibility projection;
- shared Zod contracts and safe HTTP errors;
- transactional domain writes and transactional outbox events;
- SSE reconnect/replay and client deduplication;
- structured AI validation, whitelist materialization, and short database transactions;
- transactional archive restore;
- SQLite instance locking and graceful shutdown.

### R2. Align architecture with a single-instance SQLite product

- Remove speculative multi-database and multi-instance machinery that has no current product use.
- Do not add queues, Redis, distributed sessions, microservices, or new infrastructure.
- Prefer a small number of deep modules with narrow production interfaces.

### R3. Simplify installation, startup, and recovery

- Existing local databases may be intentionally discarded and rebuilt; backward compatibility with 001–011, 001–012, `pending`, `cleaning`, or the current repository-root database is not required.
- The maintained schema may be rebased/squashed into a clean fresh-install baseline when that materially reduces code and migration complexity.
- A fresh installation must have one understandable initialization path based on a single data directory containing the SQLite database, instance lock, migration backups, and local credential key.
- An existing supported database must receive pending conventional SQLite migrations automatically during Server startup; startup must create a SQLite backup before migration, and migration failure must roll back and prevent listening.
- A missing database must still require explicit initialization rather than being created by ordinary startup.
- Ordinary startup must otherwise perform only checks needed to prevent likely data loss or unusable credentials.
- A missing/malformed credential key or one corrupt campaign AI-provider configuration must not prevent non-AI features from starting; only affected AI configuration is unavailable until an Owner re-saves it.
- Database and credential recovery behavior must be documented in user-operable terms.

### R4. Simplify realtime session lifecycle

- Preserve authenticated SSE, replay, privacy projection, logout revocation, and safe shutdown.
- Remove database checks and race-handling complexity whose only value is millisecond-level revocation precision.
- Avoid dormant maintenance lifecycle abstractions unless a currently reachable product operation needs them.

### R5. Reduce speculative and test-induced interfaces

- Remove the unused PostgreSQL production capability.
- Keep a database seam only where it provides concrete transaction/test leverage.
- Narrow the production app-construction interface; test-only controls must be exposed only through a separate test constructor or lower-level module seams.

### R6. Preserve public-Internet security baseline

The simplification must not remove:

- HTTPS/canonical-origin enforcement for deployed environments;
- Secure/HttpOnly session cookies and token digests;
- CSRF and Origin defenses;
- request schemas and body-size limits;
- password hashing and authorization checks;
- encrypted-at-rest campaign AI credentials;
- privacy-safe error responses.

## Child Tasks

1. `08-14-simplify-composition-adapters` — speculative PostgreSQL removal and production/test composition cleanup.
2. `08-14-simplify-realtime-session` — realtime authority lifecycle and dormant maintenance removal.
3. `08-14-simplify-platform-startup` — persistence startup, migrations, credentials, and provider fault isolation.

The parent owns cross-child compatibility decisions and final integration review. Each child is independently implemented and verified.

## Acceptance Criteria

- [ ] A fresh user can initialize and start the application through one documented data-directory flow.
- [ ] The repository documents that this simplification is a reset boundary and provides a clear rebuild command; no legacy database state is silently treated as supported.
- [ ] Missing key material or a damaged AI-provider credential affects only AI configuration, not whole-server startup; explicit Owner re-save is the recovery path.
- [ ] SSE still authenticates viewers, projects events by role, replays after disconnect, deduplicates on the client, and closes on normal logout/disable paths.
- [ ] Realtime authorization no longer queries session authority before every individual event delivery.
- [ ] PostgreSQL-specific production code and misleading support claims are removed.
- [ ] Production composition presents a narrow interface without scattered test-only parameters.
- [ ] Core Phase 4 browser behavior remains green.
- [ ] Focused tests, full tests, typecheck, build, and diff checks pass.
- [ ] No test reads or writes the repository-root `dnd.sqlite`.

## Out of Scope

- Multi-instance deployment.
- PostgreSQL deployment support.
- Background AI workers or distributed queues.
- Replacing SSE with WebSocket or an external broker.
- Gameplay, UX, domain-rule, or archive-format redesign.
- Removing security controls solely because the expected human user count is small.
- Implementing the currently deferred full-CSRF and strict-body-contract Tasks 8/9; those plans will be rebased after this refactor.

## Compatibility and Upgrade Decisions

- Existing databases do not need to be preserved. The implementation may establish a clean schema/reset boundary and remove legacy enrollment/cutover compatibility code.
- After that reset boundary, future pending migrations run automatically at Server startup inside the migration runner's transaction boundary. A migration failure prevents listening; a missing database still requires explicit initialization.
