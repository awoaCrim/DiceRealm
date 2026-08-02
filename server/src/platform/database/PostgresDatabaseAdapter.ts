import pg from 'pg';
import type { DatabasePort, MigrationExecutor, MigrationToApply, QueryExecutor } from './DatabasePort.js';
import { MigrationRunner, PLATFORM_MIGRATION_INSERT_SQL } from './migrations/MigrationRunner.js';

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

  /**
   * Apply a migration's SQL and its `platform_migrations` tracking row on a
   * single pooled client inside ONE transaction. The migration script itself
   * can contain multiple statements (Postgres drivers only allow that on a
   * dedicated client, not through the generic pool `query`), and the tracking
   * INSERT is parameterised via the shared `PLATFORM_MIGRATION_INSERT_SQL`
   * (`?` placeholders rewritten to `$1..$n`), so the migration name never
   * appears in SQL text. The client is always released via `finally`, whether
   * or not the transaction committed.
   */
  async applyMigration(migration: MigrationToApply, appliedAt: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          rewritePlaceholders(PLATFORM_MIGRATION_INSERT_SQL, 3),
          [migration.version, migration.name, appliedAt],
        );
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // 回滚失败（连接已不可用等极端情况）时保留原始错误，不叠加掩盖。
        }
        throw error;
      }
    } finally {
      client.release();
    }
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
