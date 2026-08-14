# Local-first architecture simplification decisions

## Product deployment model

- One local or remotely reachable Node/Express server.
- A small group of trusted acquaintances uses the product.
- The server may still be Internet-reachable, so low user count does not remove the need for authentication, HTTPS/origin defenses, CSRF, input validation, or server-side privacy projection.
- Multi-instance scale, distributed queues, distributed sessions, and PostgreSQL deployment are not current product requirements.

## User-approved reset boundary

- Existing databases do not need to be preserved.
- The repository-root `dnd.sqlite` may be intentionally discarded/rebuilt, but planning and automated tests must not inspect or mutate it accidentally.
- Maintained code does not need to support 001–011, 001–012, enrollment `initializing`, or session-security `pending`/`cleaning` states.
- The schema may be squashed into a new clean baseline if that materially improves maintenance.
- Startup must reject an old/incompatible database with an explicit rebuild instruction; it must not silently delete or replace an existing file.

## User-approved future migration policy

- A missing database requires explicit initialization.
- For an existing supported database, ordinary Server startup automatically applies pending conventional migrations before listening.
- Migration failure rolls back through the migration runner transaction boundary and prevents listening.
- Runtime exact migration filename/hash choreography is not required; accidental drift checks belong in CI/build where useful.

## Simplification guardrails

Keep:

- SQLite instance lock and graceful shutdown;
- shared Zod contracts and safe errors;
- cookie-only digest sessions;
- campaign authorization and Owner/Player projections;
- transactional domain writes and transactional Outbox;
- SSE replay/client deduplication;
- structured AI validation and whitelist materialization;
- transactional archive restore;
- encrypted-at-rest campaign provider credentials.

Simplify or remove:

- unused PostgreSQL production adapter/support claims;
- enrollment/security-cutover steady-state architecture;
- exact migration-set/hash startup gate;
- whole-server decrypt-all credential gate;
- per-frame SSE session authority reads and final-header race machinery;
- dormant maintenance lifecycle hooks;
- scattered test-only parameters on the production composition interface.

## Related deferred work

The existing deferred Task 8/9 plans for full CSRF coverage and strict external body contracts are not implementation scope for this architecture simplification. This work must preserve their security seams where present; those plans must be rebased against the simplified composition/startup shape before they are eventually implemented.
