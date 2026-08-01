import Database from 'better-sqlite3';
import type { AppDatabase } from '../../db/connection.js';
import type { DatabasePort, MigrationExecutor, QueryExecutor } from './DatabasePort.js';
import { MigrationRunner } from './migrations/MigrationRunner.js';

/**
 * SQLite adapter over an existing `better-sqlite3` connection.
 *
 * All synchronous driver calls are exposed through the Promise-based port.
 * Transactions use explicit BEGIN/COMMIT/ROLLBACK so an asynchronous callback
 * that rejects reliably rolls back (the built-in `better-sqlite3` transaction
 * helper does not await the callback's promise).
 */
export class SqliteDatabaseAdapter implements DatabasePort, MigrationExecutor {
  readonly raw: AppDatabase;
  private readonly runner: MigrationRunner;

  constructor(raw: AppDatabase) {
    this.raw = raw;
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    this.runner = new MigrationRunner(this);
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = this.raw.prepare(sql).run(...params);
    return { changes: result.changes };
  }

  async exec(sql: string): Promise<void> {
    // Wrap multi-statement scripts (migrations) in an explicit transaction so
    // a mid-batch failure rolls back everything that ran before it.
    this.raw.exec('BEGIN');
    try {
      this.raw.exec(sql);
      this.raw.exec('COMMIT');
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  async migrate(): Promise<void> {
    await this.runner.run();
  }

  async transaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    this.raw.exec('BEGIN');
    const tx: QueryExecutor = {
      query: async <R>(sql: string, params: unknown[] = []): Promise<R[]> =>
        this.raw.prepare(sql).all(...params) as R[],
      execute: async (sql: string, params: unknown[] = []) => {
        const result = this.raw.prepare(sql).run(...params);
        return { changes: result.changes };
      },
    };
    try {
      const result = await work(tx);
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.raw.open) {
      this.raw.close();
    }
  }
}

export interface SqliteDatabase extends DatabasePort {}

/**
 * Create an SQLite adapter. When `reuseRaw` is given the existing
 * `better-sqlite3` connection is wrapped instead of opening a new file.
 */
export function createSqliteDatabase(path?: string, options?: { reuseRaw?: AppDatabase }): SqliteDatabaseAdapter {
  const raw = options?.reuseRaw ?? new Database(path ?? ':memory:');
  return new SqliteDatabaseAdapter(raw);
}
