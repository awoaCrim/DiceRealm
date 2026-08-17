# Server Database Guidelines

The supported production database is local SQLite through `SqliteDatabaseAdapter`. Feature code depends on `DatabasePort`/`QueryExecutor`, never on `better-sqlite3` directly.

## Query and transaction rules

- Use `?` parameters for every value; never interpolate user input into SQL.
- Repositories accept the narrowest executor they need. Read-only paths may use `QueryReader`.
- Use `database.transaction(async (tx) => ...)` for an atomic domain write and pass `tx` to repositories/helpers inside the callback.
- Do not call the top-level adapter again from inside a transaction or `readCommitted` callback; this can deadlock or nest `BEGIN`.
- Publish outbox events through `OutboxRepository.publishIn(tx, event)` in the same transaction as the business mutation.
- Use `readCommitted` for realtime/outbox reads that must not observe uncommitted rows.

```ts
await this.executor.transaction(async (tx) => {
  const repository = new CampaignRepository(tx);
  await repository.insertMember(campaignId, userId, 'player', now);
  await outbox.publishIn(tx, { type: 'player.joined', campaignId, playerId: userId });
});
```

## Migrations

- Migration SQL lives under `server/src/platform/database/migrations/` and is listed in the manifest.
- Startup applies a migration's SQL and its tracking row atomically through `MigrationExecutor.applyMigration`.
- Do not edit an already-applied migration to change schema history. Add a new numbered migration and update the manifest/tests.
- Migration code must preserve rollback behavior; test both success and injected failure where the migration changes a persisted boundary.

## Naming and mapping

Use snake_case for SQL tables/columns and camelCase for contract DTOs. Keep row-to-view mapping in repositories/services. Never expose `raw` outside database adapter tests or startup-only migration code.

## Common mistakes

- Opening a second transaction inside a transaction callback.
- Using `MAX(sequence) + 1` for per-campaign event sequence; use the counter upsert in `nextSequence`.
- Reading an outbox through a long-lived executor instead of the transaction-safe reader.
- Adding PostgreSQL-specific adapters or dependencies; this application is intentionally SQLite-only.
