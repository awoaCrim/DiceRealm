# Design: local-first architecture simplification

## 1. Architecture target

The maintained deployment model is deliberately narrow:

```text
React browser client
        |
        | HTTPS + cookie auth + JSON/SSE
        v
One Express process
        |
        | one DatabasePort implementation
        v
One local data directory containing SQLite, lock, backups, and credential key
```

The target keeps deep modules that protect gameplay correctness and removes speculative platform lifecycle machinery.

### Deep modules retained

- `platformHttp`: credentialed HTTP, safe envelopes, contract validation.
- Domain services: authorization and transaction ownership.
- `DatabasePort` + SQLite adapter: query/transaction/read-committed seam used by production and deterministic tests.
- Transactional Outbox: same-transaction domain event publication and reconnect replay.
- Event projection: Owner/Player privacy.
- AI resolution: claim, provider call outside transaction, validation, whitelist apply, archive, next turn.
- Archive restore: transactional snapshot restoration.

### Machinery removed or reduced

- PostgreSQL adapter and support claims.
- Enrollment and security-cutover steady-state lifecycle.
- Runtime exact migration filename/hash allowlists.
- Whole-database provider decrypt-all startup gate.
- Per-frame SSE authority reads and final-header linearization machinery.
- Dormant maintenance state/runtime hooks.
- Scattered test-only fields in the production app-construction interface.
- Production comments whose only purpose is historical Phase/Task narration.

## 2. Persistence and startup shape

### Fresh initialization

A single explicit initialization flow operates on one data directory:

```text
validate DB/key targets are absent
  -> acquire SQLite instance/CLI lock
  -> create temporary database
  -> apply clean baseline and set PRAGMA user_version
  -> integrity-check and atomically publish database
  -> generate and atomically publish local credential key
  -> close and release lock
```

Fresh initialization is the only path that creates the production database without an explicit Owner credential-save recovery action.

### Ordinary startup

```text
validate existing regular database file
  -> acquire instance lock
  -> open SQLite adapter
  -> reject user_version 0 or newer-than-supported
  -> if pending: SQLite backup + transactional automatic migrations
  -> construct credential store (key may be unavailable)
  -> compose application
  -> listen
```

A migration failure prevents listening and leaves the pre-migration backup. Startup does not run destructive session cutover, byte scanning, enrollment, or exact manifest/hash checks. A missing credential key disables saved AI configurations but does not block non-AI startup.

### Reset boundary

The user approved discarding existing databases. Maintained runtime code therefore has no legacy enrollment/cutover state machine. Migration files may be rebased into a clean baseline. Any old database that happens to remain compatible is not a maintained compatibility promise.

No command silently replaces an existing database. Rebuild is explicit: stop the server, move/delete the database and matching key after any desired manual backup, then run initialization.

### Future migrations

Future schema changes use conventional numbered SQLite migrations with `PRAGMA user_version` as the single version source. Runtime backs up and applies pending migrations before listening. CI tests build a fresh database from the complete migration directory without a runtime tamper state machine.

## 3. Credential fault isolation

The local key remains required and saved provider API keys remain encrypted at rest.

Startup does not decrypt every campaign row and does not fail the whole application when the key is unavailable. Provider configuration is decrypted when loaded for a specific campaign/run:

```text
valid ciphertext -> construct configured provider
invalid ciphertext -> campaign provider unavailable + safe actionable error
```

The error must not expose ciphertext, key material, raw provider errors, or other campaigns. Non-AI features and unrelated campaigns remain available. An explicit Owner re-save replaces that campaign's bad ciphertext and may atomically create a missing key; startup itself never replaces the key.

## 4. Realtime lifecycle

### Connection establishment

The normal HTTP middleware chain remains authoritative:

```text
request security -> session resolution -> campaign membership -> SSE setup
```

The route registers an established client with a small in-process registry keyed by internal session/user and starts the Outbox subscription. It does not provisionally register before a second final-header authority race check.

### Revocation

- Logout-current closes established streams for that internal session after the durable transaction commits.
- Logout-all/user disable closes established streams for that user after commit.
- An at-most-once-per-60-seconds authority check handles expiry, notifier failure, and external database changes.
- Reconnect always passes through current session and campaign authorization again.

The 60-second interval bounds the rare in-flight/notifier-failure/external revocation window. Event delivery keeps an in-memory closed-state fence but performs no database authority query per frame.

### Delivery semantics retained

- committed Outbox rows only;
- monotonic campaign sequence;
- `after`/`Last-Event-ID` replay;
- Owner/Player event projection;
- poison-row cursor progress;
- at-least-once delivery with client deduplication;
- heartbeat and backpressure closure;
- close all subscriptions before database shutdown.

## 5. Composition interfaces

The production composition interface contains production dependencies only: database, validated security config, credential store, and AI fallback/provider configuration.

A separate test-only constructor owned by the HTTP/test harness delegates to the same internal builder and supplies deterministic clocks/randomness, provider transport/factory, short realtime intervals, or an authority checker. The production function has no test override bag and production startup never imports the test constructor.

`DatabasePort`, the Outbox publication port, and AI provider ports remain because they provide concrete leverage. A new seam is not introduced without a real second behavior or test/locality benefit.

## 6. Security posture

Simplification changes operational complexity, not the public-Internet baseline. Keep:

- HTTPS/canonical-origin and trusted-proxy validation;
- secure digest sessions and CSRF material;
- Campaign role checks and privacy projections;
- request budgets/contracts and safe error envelopes;
- encrypted provider credentials;
- transactional consistency.

Deferred Task 8/9 work is not pulled into this refactor. Its plans must be rebased after composition changes.

## 7. Compatibility and rollout

This is a deliberate reset release:

1. Land and verify child tasks sequentially.
2. Document that existing development databases are not supported by the new baseline.
3. Never run automated tests against repository-root `dnd.sqlite`.
4. Rebuild a temporary database through the public initialization command.
5. Run the full real-browser flow against an in-memory/temporary fixture.

Rollback during implementation is file-level/git-level; no production data rollback contract is required because existing data preservation was explicitly declined.

## 8. Child boundaries and order

Recommended implementation order:

1. `simplify-composition-adapters`: remove PostgreSQL and narrow composition without changing behavior.
2. `simplify-realtime-session`: reduce authority/maintenance runtime while current schema still exists.
3. `simplify-platform-startup`: establish the final clean schema and startup lifecycle after runtime dependencies are known.
4. Parent integration review: verify cross-child contracts, docs, full suite, and Phase 4 browser flow.
