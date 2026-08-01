import pg from 'pg';
import type { DatabasePort, MigrationExecutor, QueryExecutor } from './DatabasePort.js';
import { MigrationRunner } from './migrations/MigrationRunner.js';

/**
 * PostgreSQL adapter over `pg.Pool`.
 *
 * Implements the same port as the SQLite adapter. `?` placeholders are
 * rewritten to `$1`, `$2`, ... (by occurrence order) so both adapters share
 * the same SQL syntax.
 */
export class PostgresDatabaseAdapter implements DatabasePort, MigrationExecutor {
  readonly pool: pg.Pool;
  private readonly runner: MigrationRunner;

  constructor(pool: pg.Pool) {
    this.pool = pool;
    this.runner = new MigrationRunner(this);
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(rewritePlaceholders(sql, params.length), params);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = await this.pool.query(rewritePlaceholders(sql, params.length), params);
    return { changes: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async migrate(): Promise<void> {
    await this.runner.run();
  }

  async transaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx: QueryExecutor = {
        query: async <R>(sql: string, params: unknown[] = []): Promise<R[]> => {
          const result = await client.query(rewritePlaceholders(sql, params.length), params);
          return result.rows as R[];
        },
        execute: async (sql: string, params: unknown[] = []) => {
          const result = await client.query(rewritePlaceholders(sql, params.length), params);
          return { changes: result.rowCount ?? 0 };
        },
      };
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Rewrite `?` placeholders to Postgres `$1`, `$2`, ... by occurrence order.
 * SQL string literals are skipped so question marks inside quotes stay intact.
 */
export function rewritePlaceholders(sql: string, paramCount: number): string {
  if (!sql.includes('?') || paramCount === 0) {
    return sql;
  }
  let out = '';
  let index = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    }
    if (char === '?' && !inSingle && !inDouble) {
      index += 1;
      out += `$${index}`;
    } else {
      out += char;
    }
  }
  return out;
}
