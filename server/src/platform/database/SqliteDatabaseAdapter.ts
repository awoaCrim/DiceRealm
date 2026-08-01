import Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  /** 平台事务互斥队列尾链：新的 transaction 等待前一事务 settle（成功或失败）后再执行。 */
  private lastTransaction: Promise<unknown> = Promise.resolve();
  /** 事务回调执行期间标记，用于检测嵌套 transaction 调用（防止队列自锁死锁）。 */
  private readonly transactionContext = new AsyncLocalStorage<boolean>();

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

  /**
   * 平台异步事务：per-adapter 互斥队列串行执行 BEGIN → work → COMMIT/ROLLBACK，
   * 避免同一 better-sqlite3 连接上并发 BEGIN 触发
   * "cannot start a transaction within a transaction" 的裸 SQLITE_ERROR（HTTP 500）。
   * 队列在成功与失败后都释放（lastTransaction 用 catch 吞错），不会因上一事务 reject 阻塞后续。
   * 嵌套调用（在事务回调内再次调用本适配器的 transaction）立即抛出清晰错误，
   * 防止回调 await 自己身后队列项造成死锁；service 应把 tx 传给内部方法而非再开事务。
   */
  async transaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) {
      throw new Error(
        'SqliteDatabaseAdapter.transaction 不支持嵌套调用：请在事务回调内使用传入的 tx，而不是再次调用同一适配器的 transaction。',
      );
    }
    const run = this.lastTransaction.then(() => this.runTransaction(work));
    this.lastTransaction = run.catch(() => undefined);
    return run;
  }

  /** 单个事务体：BEGIN IMMEDIATE 在受保护路径执行（失败不留下锁）；work 拒绝时回滚并保留原始错误。 */
  private async runTransaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    try {
      this.raw.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw new Error(
        `无法开启数据库事务：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const tx: QueryExecutor = {
      query: async <R>(sql: string, params: unknown[] = []): Promise<R[]> =>
        this.raw.prepare(sql).all(...params) as R[],
      execute: async (sql: string, params: unknown[] = []) => {
        const result = this.raw.prepare(sql).run(...params);
        return { changes: result.changes };
      },
    };
    try {
      const result = await this.transactionContext.run(true, () => work(tx));
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // 回滚失败（连接已不可用等极端情况）时保留原始错误，不叠加掩盖。
      }
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
