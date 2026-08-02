/**
 * Database port: the interface the business layer depends on.
 *
 * SQLite and PostgreSQL are isolated behind this port so modules never touch
 * driver-specific APIs. Placeholders use `?` for both adapters; PostgreSQL
 * converts them to `$1`, `$2`, ... internally.
 */

/** Minimal SQL executor shared by every database adapter. */
export interface QueryExecutor {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

/** Asynchronous port implemented by the SQLite and PostgreSQL adapters. */
export interface DatabasePort extends QueryExecutor {
  migrate(): Promise<void>;
  transaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A single versioned migration script awaiting atomic application. */
export interface MigrationToApply {
  version: string;
  name: string;
  sql: string;
}

/** Executor capable of running multi-statement migration scripts. */
export interface MigrationExecutor extends QueryExecutor {
  exec(sql: string): Promise<void>;
  /**
   * Apply a migration's SQL and its `platform_migrations` tracking row in the
   * SAME database transaction. Without this, a crash between the schema
   * statement and the tracking INSERT would leave the schema applied but
   * untracked, so the next restart re-runs non-idempotent DDL (e.g. 007's
   * `ALTER TABLE ADD COLUMN`) and fails with a duplicate column.
   *
   * Startup-only: the migration runner invokes this before the server accepts
   * requests, so implementations may assume single-threaded use on a dedicated
   * connection and must never be called from inside a business `transaction()`
   * callback (the nested BEGIN would fail).
   */
  applyMigration(migration: MigrationToApply, appliedAt: string): Promise<void>;
}

/**
 * Synchronous executor used only by the legacy SQLite startup path
 * (`server/src/db/schema.ts`) which cannot await migrations.
 */
export interface SyncMigrationExecutor {
  query<T>(sql: string, params?: unknown[]): T[];
  execute(sql: string, params?: unknown[]): { changes: number };
  exec(sql: string): void;
  applyMigration(migration: MigrationToApply, appliedAt: string): void;
}
