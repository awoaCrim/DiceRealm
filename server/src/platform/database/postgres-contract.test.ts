import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresDatabaseAdapter } from './PostgresDatabaseAdapter.js';
import { PLATFORM_MIGRATION_INSERT_SQL } from './migrations/MigrationRunner.js';
import { defineDatabaseContractSuite } from './databaseContractSuite.js';

// POSTGRES_TEST_URL 必须指向一个可丢弃的测试库：契约套件会真实建表/插入/清理。
const url = process.env.POSTGRES_TEST_URL;

describe.skipIf(!url)('postgres database port contract', () => {
  defineDatabaseContractSuite({
    label: 'postgres',
    create: async () =>
      new PostgresDatabaseAdapter(new pg.Pool({ connectionString: url, max: 1 })),
  });
});

describe.skipIf(!url)('postgres migration atomicity', () => {
  it('rolls back the migration schema when the tracking INSERT fails', async () => {
    const db = new PostgresDatabaseAdapter(new pg.Pool({ connectionString: url, max: 1 }));
    // 随机唯一资源名，避免与共享 PG 测试库上任何既有/未来数据冲突。
    const seedVersion = `seed-${randomUUID()}`;
    const probeTable = `atomic_pg_rollback_probe_${randomUUID().replaceAll('-', '')}`;
    try {
      // Tracking table bootstrap is a separate concern (CREATE IF NOT EXISTS).
      await db.exec(`
        CREATE TABLE IF NOT EXISTS platform_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      // 预置同版本 seed：tracking INSERT 违反 PRIMARY KEY，在 SQL 执行后、
      // COMMIT 之前抛错，从而验证 schema 与 tracking 同事务提交/回滚。
      await db.execute(PLATFORM_MIGRATION_INSERT_SQL, [seedVersion, 'seed', 'now']);
      const migration = {
        version: seedVersion,
        name: `${seedVersion}_atomic_test.sql`,
        sql: `CREATE TABLE ${probeTable} (id TEXT PRIMARY KEY);`,
      };

      // 断言失败明确来自 duplicate key（唯一约束），而不是迁移 SQL 本身。
      await expect(db.applyMigration(migration, new Date().toISOString())).rejects.toThrow(
        /duplicate key value violates unique constraint/,
      );
      const table = await db.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [probeTable]);
      expect(table[0].name).toBeNull();
      // tracking 只有 seed 行，失败的 migration 没有留下自己的行。
      const tracking = await db.query<{ version: string }>(
        'SELECT version FROM platform_migrations WHERE version = ?',
        [seedVersion],
      );
      expect(tracking).toEqual([{ version: seedVersion }]);
    } finally {
      // 无论如何清理本次测试的 seed 行与 probe 表，避免污染共享 PG 库。
      try {
        await db.execute('DELETE FROM platform_migrations WHERE version = ?', [seedVersion]);
      } catch {
        // 清理失败不影响主断言结果；连接随后关闭。
      }
      try {
        await db.exec(`DROP TABLE IF EXISTS ${probeTable}`);
      } catch {
        // 同上。
      }
      await db.close();
    }
  });
});

