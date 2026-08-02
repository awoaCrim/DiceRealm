import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresDatabaseAdapter } from './PostgresDatabaseAdapter.js';
import type { MigrationToApply } from './DatabasePort.js';
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
    try {
      // Tracking table bootstrap is a separate concern (CREATE IF NOT EXISTS).
      await db.exec(`
        CREATE TABLE IF NOT EXISTS platform_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      // 预置重复版本：tracking INSERT 违反 PRIMARY KEY，在 SQL 执行后、
      // COMMIT 之前抛错，从而验证 schema 与 tracking 同事务提交/回滚。
      await db.execute(
        'INSERT INTO platform_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        ['900-pg', 'seed', 'now'],
      );
      const probeTable = `atomic_pg_rollback_probe_${randomUUID().replaceAll('-', '')}`;
      const migration: MigrationToApply = {
        version: '900-pg',
        name: '900_pg_atomic_test.sql',
        sql: `CREATE TABLE ${probeTable} (id TEXT PRIMARY KEY);`,
      };

      await expect(db.applyMigration(migration, new Date().toISOString())).rejects.toThrow();
      const table = await db.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [probeTable]);
      expect(table[0].name).toBeNull();
      const tracking = await db.query<{ version: string }>(
        "SELECT version FROM platform_migrations WHERE version = '900-pg'",
      );
      expect(tracking.map((row) => row.version)).toEqual(['900-pg']);
    } finally {
      await db.close();
    }
  });
});
