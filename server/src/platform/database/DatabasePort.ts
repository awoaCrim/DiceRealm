/**
 * Database port: the interface the business layer depends on.
 *
 * The local SQLite driver stays behind this port so modules never depend on
 * better-sqlite3 APIs or a raw connection. SQL parameters use `?` placeholders.
 */

/** Minimal SQL executor shared by every database adapter. */
export interface QueryExecutor {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

/** 只读执行器：只有 query，没有 execute；用于 readCommitted 短快照读。 */
export interface QueryReader {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * SQLite 应用数据端口。readCommitted 与 write transaction 共用单一 FIFO 队列：
 * read 排在已有事务之后，绝不看到未提交或已回滚的数据。
 */
export interface DatabasePort extends QueryExecutor {
  migrate(): Promise<void>;
  transaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T>;
  readCommitted<T>(work: (reader: QueryReader) => Promise<T>): Promise<T>;
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