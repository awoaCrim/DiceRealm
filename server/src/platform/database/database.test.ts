import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from './SqliteDatabaseAdapter.js';
import { rewritePlaceholders } from './PostgresDatabaseAdapter.js';
import { MigrationRunner, PLATFORM_MIGRATION_INSERT_SQL } from './migrations/MigrationRunner.js';
import type { MigrationToApply } from './DatabasePort.js';
import { createMemoryDb } from '../../db/connection.js';
import { createLegacySyncAdapter, migrate, migratePlatform } from '../../db/schema.js';
import { defineDatabaseContractSuite } from './databaseContractSuite.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

defineDatabaseContractSuite({
  label: 'sqlite',
  create: async () => createSqliteDatabase(':memory:'),
});

describe('database adapter', () => {
  it('creates the initial platform tables after migrate', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    for (const table of ['users', 'sessions', 'campaigns', 'campaign_members']) {
      const rows = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [table],
      );
      expect(rows.map((row) => row.name)).toContain(table);
    }
    await db.close();
  });

  it('rolls back the first failed migration in a batch', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await expect(
      db.exec(`
        CREATE TABLE IF NOT EXISTS _migration_test_partial (a TEXT);
        CREATE TABLE _migration_test_should_not_exist (a TEXT, b TEXT, c TEXT, d TEXT);
        INSERT INTO _migration_test_should_not_exist (a, b, c, d) VALUES (1, 1, 1, 1, 1);
      `),
    ).rejects.toThrow();
    const rows = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ['_migration_test_partial'],
    );
    expect(rows).toEqual([]);
    await db.close();
  });
});

describe('transaction serialization', () => {
  it('serializes two overlapping async transactions without a nested BEGIN error', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const order: string[] = [];
    // 两个 transaction 同时发起：互斥队列必须串行执行，第二个不得因 BEGIN 冲突报裸 SQLITE_ERROR。
    const first = db.transaction(async (tx) => {
      order.push('first-start');
      await tx.execute(
        'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
        ['t-1', 'serialized-1', 'hash'],
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      order.push('first-end');
    });
    const second = db.transaction(async (tx) => {
      order.push('second-start');
      await tx.execute(
        'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
        ['t-2', 'serialized-2', 'hash'],
      );
      order.push('second-end');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    const rows = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM users WHERE login IN (?, ?)',
      ['serialized-1', 'serialized-2'],
    );
    expect(Number(rows[0].count)).toBe(2);
    await db.close();
  });

  it('continues serving the queue after a transaction rejects', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const failing = db.transaction(async () => {
      throw new Error('abort');
    });
    const succeeding = db.transaction(async (tx) => {
      await tx.execute(
        'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
        ['after-fail', 'after-fail-login', 'hash'],
      );
    });
    await expect(failing).rejects.toThrow('abort');
    // 前一事务失败后队列必须继续工作，不得因上一 reject 阻塞。
    await expect(succeeding).resolves.toBeUndefined();
    const rows = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM users WHERE login = ?',
      ['after-fail-login'],
    );
    expect(Number(rows[0].count)).toBe(1);
    await db.close();
  });

  it('rejects a nested transaction with a clear error instead of deadlocking', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await expect(
      db.transaction(async (tx) => {
        await db.transaction(async (innerTx) => {
          await innerTx.query<{ v: number }>('SELECT 1 AS v');
        });
      }),
    ).rejects.toThrow(/不支持嵌套/);
    // 嵌套错误不会破坏队列：后续普通事务仍可执行。
    const result = await db.transaction(async (tx) => {
      const rows = await tx.query<{ v: number }>('SELECT 1 AS v');
      return rows[0].v;
    });
    expect(result).toBe(1);
    await db.close();
  });
});

describe('postgres placeholder rewrite', () => {
  it('rewrites ? placeholders to $1, $2 in order', () => {
    expect(rewritePlaceholders('SELECT * FROM t WHERE a = ? AND b = ?', 2)).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
  });

  it('does not rewrite ? inside single-quoted string literals', () => {
    expect(rewritePlaceholders("SELECT '?' AS literal, a = ? FROM t", 1)).toBe(
      "SELECT '?' AS literal, a = $1 FROM t",
    );
  });

  it('does not rewrite ? inside double-quoted identifiers', () => {
    expect(rewritePlaceholders('SELECT "?" AS id FROM t', 0)).toBe('SELECT "?" AS id FROM t');
  });
});

describe('migration SQL portability', () => {
  it('never uses the SQLite-only datetime() function', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '001_initial_platform.sql'), 'utf8');
    expect(sql).not.toMatch(/datetime\s*\(/i);
    expect(sql).toContain('DEFAULT CURRENT_TIMESTAMP');
  });
});

describe('migration runner failure modes', () => {
  it('fails explicitly when the migrations directory is missing', async () => {
    const db = createSqliteDatabase(':memory:');
    const runner = new MigrationRunner(db, join(MIGRATIONS_DIR, 'does-not-exist'));
    await expect(runner.run()).rejects.toThrow(/Migrations directory not found/);
    await db.close();
  });

  it('fails explicitly when the migrations directory contains no SQL files', async () => {
    // The parent directory exists but holds no *.sql migration files; this is
    // the production failure shape where a build forgot to copy the .sql files
    // next to the compiled runner (the directory itself still exists because
    // the compiled MigrationRunner.js is emitted there).
    const parentDir = fileURLToPath(new URL('../', import.meta.url));
    const db = createSqliteDatabase(':memory:');
    const runner = new MigrationRunner(db, parentDir);
    await expect(runner.run()).rejects.toThrow(/No SQL migration files found/);
    await db.close();
  });
});

describe('atomic migration application', () => {
  it('rolls back the migration schema when the tracking INSERT fails', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      // 先建立真实平台表（users 等），确保 migration 的 CREATE TABLE 与
      // ALTER TABLE users 都能执行；唯一失败源只能是 tracking INSERT 违反
      // PRIMARY KEY/UNIQUE，而不是 "no such table: users"。
      await db.migrate();
      // 以随机值 seed，避免与未来版本号（如 008）冲突；同时记录 baseline，
      // 不把迁移版本硬编码进断言。
      const seedVersion = `seed-${randomUUID()}`;
      const baseline = (await db.query<{ version: string }>('SELECT version FROM platform_migrations')).map((r) => r.version).sort();
      await db.execute(PLATFORM_MIGRATION_INSERT_SQL, [seedVersion, 'dummy', 'now']);

      const migration: MigrationToApply = {
        version: seedVersion,
        name: `${seedVersion}_atomic_test.sql`,
        sql: `
          CREATE TABLE atomic_rollback_probe (id TEXT PRIMARY KEY);
          ALTER TABLE users ADD COLUMN atomic_rollback_probe_col TEXT;
        `,
      };
      // 断言失败来自 tracking 的唯一约束，而不是迁移 SQL 本身。
      await expect(db.applyMigration(migration, new Date().toISOString())).rejects.toThrow(
        /UNIQUE constraint failed: platform_migrations\.version/,
      );
      const tableRows = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ['atomic_rollback_probe'],
      );
      expect(tableRows).toEqual([]);
      const colRows = await db.query<{ name: string }>(
        "SELECT name FROM pragma_table_info('users') WHERE name = ?",
        ['atomic_rollback_probe_col'],
      );
      expect(colRows).toEqual([]);
      // tracking = baseline + seed；seed 行仍是唯一的（name='dummy'），
      // 失败的 migration 没有留下自己的 tracking 行。
      const tracking = (await db.query<{ version: string }>('SELECT version FROM platform_migrations')).map((r) => r.version).sort();
      expect(tracking).toEqual([...baseline, seedVersion].sort());
      const seedRow = await db.query<{ name: string }>(
        'SELECT name FROM platform_migrations WHERE version = ?',
        [seedVersion],
      );
      expect(seedRow).toEqual([{ name: 'dummy' }]);
    } finally {
      await db.close();
    }
  });

  it('commits the migration schema and its tracking row together', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      // Tracking table bootstrap is a separate concern (CREATE IF NOT EXISTS),
      // exactly as MigrationRunner does before discovering applied versions.
      await db.exec(`
        CREATE TABLE IF NOT EXISTS platform_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      // 随机版本号，避免与真实迁移版本（001..008+）冲突。
      const version = `atomic-commit-${randomUUID()}`;
      const name = `${version}.sql`;
      const migration: MigrationToApply = {
        version,
        name,
        sql: 'CREATE TABLE atomic_commit_probe (id TEXT PRIMARY KEY);',
      };
      const appliedAt = new Date().toISOString();
      await db.applyMigration(migration, appliedAt);
      const tableRows = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ['atomic_commit_probe'],
      );
      expect(tableRows.map((row) => row.name)).toEqual(['atomic_commit_probe']);
      const tracking = await db.query<{ version: string; name: string; applied_at: string }>(
        'SELECT version, name, applied_at FROM platform_migrations WHERE version = ?',
        [version],
      );
      expect(tracking).toEqual([{ version, name, applied_at: appliedAt }]);
    } finally {
      await db.close();
    }
  });
});

describe('legacy schema initialisation', () => {
  it('creates schema_migrations matching the legacy table contract', () => {
    const db = createMemoryDb();
    migrate(db);
    const columns = db
      .prepare('PRAGMA table_info(schema_migrations)')
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const byName = new Map(columns.map((column) => [column.name, column]));
    // Note: SQLite reports notnull=0 for a TEXT PRIMARY KEY column even when
    // it is the primary key; the reviewer-required constraints are the
    // primary key on `id` and NOT NULL on `version` (and the remaining fields
    // matching the legacy production table contract).
    expect(byName.get('id')).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(byName.get('version')).toMatchObject({ type: 'INTEGER', notnull: 1, pk: 0 });
    expect(byName.get('summary_json')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
    expect(byName.get('completed_at')).toMatchObject({ type: 'TEXT', notnull: 1, pk: 0 });
    expect(columns).toHaveLength(4);
    db.close();
  });

  it('inserts the legacy checkpoint only once across restarts', () => {
    const db = createMemoryDb();
    migrate(db);
    migrate(db);
    const rows = db
      .prepare("SELECT id, version FROM schema_migrations WHERE id = 'legacy-schema-init-v1'")
      .all() as Array<{ id: string; version: number }>;
    expect(rows).toEqual([{ id: 'legacy-schema-init-v1', version: 0 }]);
    db.close();
  });

  it('keeps the legacy schema_migrations rows untouched when platform migrations run', async () => {
    const raw = createMemoryDb();
    migrate(raw);
    const adapter = createSqliteDatabase(undefined, { reuseRaw: raw });
    await adapter.migrate();
    const rows = await adapter.query<{ id: string; version: number }>(
      "SELECT id, version FROM schema_migrations WHERE id = 'legacy-schema-init-v1'",
    );
    expect(rows).toEqual([{ id: 'legacy-schema-init-v1', version: 0 }]);
    const platform = await adapter.query<{ version: string }>(
      'SELECT version FROM platform_migrations ORDER BY version',
    );
    expect(platform.map((row) => row.version)).toEqual(
      expect.arrayContaining(['001', '002']),
    );
    expect(new Set(platform.map((row) => row.version)).size).toBe(platform.length);
    await adapter.close();
  });

  it('rolls back the migration schema when tracking fails on the legacy sync path', () => {
    const db = createMemoryDb();
    try {
      migrate(db);
      // Tracking bootstrap mirrors MigrationRunner; preseed a duplicate version
      // so the tracking INSERT violates its PRIMARY KEY after the SQL ran.
      db.exec(`
        CREATE TABLE IF NOT EXISTS platform_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.prepare('INSERT INTO platform_migrations (version, name, applied_at) VALUES (?, ?, ?)').run('900', 'seed', 'now');
      const migration: MigrationToApply = {
        version: '900',
        name: '900_sync_atomic_test.sql',
        sql: 'ALTER TABLE rooms ADD COLUMN atomic_sync_probe TEXT;',
      };

      expect(() => createLegacySyncAdapter(db).applyMigration(migration, new Date().toISOString())).toThrow();
      const roomColumns = db.prepare('PRAGMA table_info(rooms)').all() as Array<{ name: string }>;
      expect(roomColumns.some((c) => c.name === 'atomic_sync_probe')).toBe(false);
      const tracking = db.prepare('SELECT version FROM platform_migrations').all() as Array<{ version: string }>;
      expect(tracking.map((row) => row.version)).toEqual(['900']);
    } finally {
      db.close();
    }
  });

  it('applies a migration and its tracking row together on the legacy sync path, then skips', () => {
    const db = createMemoryDb();
    const tmpDir = mkdtempSync(join(tmpdir(), 'dnd-migration-sync-test-'));
    try {
      migrate(db);
      writeFileSync(join(tmpDir, '901_sync_commit_test.sql'), 'CREATE TABLE atomic_sync_commit_probe (id TEXT PRIMARY KEY);');

      const first = MigrationRunner.runSync(createLegacySyncAdapter(db), tmpDir);
      expect(first.applied).toEqual(['901']);
      expect(first.skipped).toEqual([]);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all('atomic_sync_commit_probe') as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual(['atomic_sync_commit_probe']);
      const tracking = db.prepare('SELECT version, name FROM platform_migrations WHERE version = ?').all('901') as Array<{ version: string; name: string }>;
      expect(tracking).toEqual([{ version: '901', name: '901_sync_commit_test.sql' }]);

      const second = MigrationRunner.runSync(createLegacySyncAdapter(db), tmpDir);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(['901']);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      db.close();
    }
  });

  it('migratePlatform applies every platform migration once and is idempotent on the sync path', () => {
    const db = createMemoryDb();
    try {
      migrate(db);
      migratePlatform(db);
      migratePlatform(db);
      const rows = db.prepare('SELECT version FROM platform_migrations').all() as Array<{ version: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.version)).size).toBe(rows.length);
    } finally {
      db.close();
    }
  });
});
