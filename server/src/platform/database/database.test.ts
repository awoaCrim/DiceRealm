import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from './SqliteDatabaseAdapter.js';
import { rewritePlaceholders } from './PostgresDatabaseAdapter.js';
import { MigrationRunner } from './migrations/MigrationRunner.js';
import { createMemoryDb } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

describe('database adapter', () => {
  it('runs a transaction and rolls back on error', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await expect(db.transaction(async (tx) => {
      await tx.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u1', 'a', 'hash']);
      throw new Error('abort');
    })).rejects.toThrow('abort');

    const rows = await db.query<{ count: number }>('SELECT COUNT(*) AS count FROM users');
    expect(rows[0].count).toBe(0);
    await db.close();
  });

  it('commits a transaction when the callback succeeds', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u2', 'b', 'hash']);
    });

    const rows = await db.query<{ count: number }>('SELECT COUNT(*) AS count FROM users');
    expect(rows[0].count).toBe(1);
    await db.close();
  });

  it('supports parameterised query and execute with correct changes', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const insert = await db.execute(
      'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
      ['u3', 'c', 'hash'],
    );
    expect(insert.changes).toBe(1);

    const rows = await db.query<{ id: string; login: string }>(
      'SELECT id, login FROM users WHERE login = ?',
      ['c'],
    );
    expect(rows).toEqual([{ id: 'u3', login: 'c' }]);
    await db.close();
  });

  it('runs migrations only once', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await db.migrate();

    const rows = await db.query<{ count: number }>('SELECT COUNT(*) AS count FROM platform_migrations');
    expect(rows[0].count).toBeGreaterThanOrEqual(1);
    const versionRows = await db.query<{ version: string }>('SELECT version FROM platform_migrations');
    const versions = versionRows.map((row) => row.version);
    expect(versions).toEqual([...new Set(versions)]);

    const users = await db.query<{ count: number }>('SELECT COUNT(*) AS count FROM users');
    expect(users[0].count).toBe(0);
    await db.close();
  });

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
    const platform = await adapter.query<{ count: number }>('SELECT COUNT(*) AS count FROM platform_migrations');
    expect(platform[0].count).toBe(2);
    await adapter.close();
  });
});
