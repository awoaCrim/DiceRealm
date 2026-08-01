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

/** Executor capable of running multi-statement migration scripts. */
export interface MigrationExecutor extends QueryExecutor {
  exec(sql: string): Promise<void>;
}

/**
 * Synchronous executor used only by the legacy SQLite startup path
 * (`server/src/db/schema.ts`) which cannot await migrations.
 */
export interface SyncMigrationExecutor {
  query<T>(sql: string, params?: unknown[]): T[];
  execute(sql: string, params?: unknown[]): { changes: number };
  exec(sql: string): void;
}
