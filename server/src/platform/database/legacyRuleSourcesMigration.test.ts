import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LegacyRuleSourcesMigrationError,
  migrateLegacyRuleSourcesDatabase,
} from './legacyRuleSourcesMigration.js';

const MAINTAINED = ['001_initial_platform.sql', '002_campaign_invites.sql', '012_platform_foundation.sql'];
const LEGACY_ROWS = [...MAINTAINED, '011_rule_sources.sql'];
const LEGACY_COLUMNS = 'id TEXT PRIMARY KEY, source_name TEXT NOT NULL, version TEXT NOT NULL, license TEXT NOT NULL, attribution TEXT NOT NULL, content_hash TEXT NOT NULL, scope TEXT NOT NULL, campaign_id TEXT, user_id TEXT, created_by_user_id TEXT, created_at TEXT NOT NULL';

function tempDir(prefix = 'dnd-legacy-rule-sources-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createLegacyDb(dir: string, options: { malformedTable?: boolean; rows?: string[]; databaseName?: string } = {}): string {
  const databasePath = join(dir, options.databaseName ?? 'db.sqlite');
  const db = new Database(databasePath);
  db.exec('CREATE TABLE platform_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO platform_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const name of options.rows ?? LEGACY_ROWS) insert.run(name.slice(0, 3), name, '2026-08-16T00:00:00.000Z');
  db.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO unrelated (id, value) VALUES (?, ?)').run('keep', 'untouched');
  db.exec(options.malformedTable
    ? 'CREATE TABLE platform_rule_sources (id TEXT PRIMARY KEY)'
    : `CREATE TABLE platform_rule_sources (${LEGACY_COLUMNS})`);
  if (!options.malformedTable) {
    db.prepare('INSERT INTO platform_rule_sources (id, source_name, version, license, attribution, content_hash, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('source-1', 'PHB', '2024', 'CC', 'Author', 'a'.repeat(64), 'platform', '2026-08-16T00:00:00.000Z');
  }
  db.close();
  return databasePath;
}

function backupDirectories(dir: string): string[] {
  const backupRoot = join(dir, 'backups');
  if (!existsSync(backupRoot)) return [];
  return readdirSync(backupRoot)
    .filter((name) => name.startsWith('.dnd-rule-sources-migration-backup-'))
    .map((name) => join(backupRoot, name));
}

describe('legacy rule-source compatibility migration', () => {
  it('backs up with SQLite backup(), copies the key, and removes only 011 data atomically', async () => {
    const dir = tempDir();
    try {
      const databasePath = createLegacyDb(dir);
      const keyPath = join(dir, '.dnd-ai-credential-key');
      writeFileSync(keyPath, 'credential-key-pair', { encoding: 'utf8', mode: 0o600 });

      const result = await migrateLegacyRuleSourcesDatabase({ databasePath, credentialKeyPath: keyPath, approvedMigrationFilenames: MAINTAINED });
      expect(result.migrated).toBe(true);
      expect(result.backupDirectory).toBeDefined();
      expect(backupDirectories(dir)).toEqual([result.backupDirectory]);

      const live = new Database(databasePath, { readonly: true });
      try {
        expect(live.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_rule_sources'").get()).toBeUndefined();
        expect(live.prepare('SELECT version, name FROM platform_migrations ORDER BY version').all()).toEqual(
          MAINTAINED.map((name) => ({ version: name.slice(0, 3), name })),
        );
        expect(live.prepare('SELECT * FROM unrelated').all()).toEqual([{ id: 'keep', value: 'untouched' }]);
      } finally {
        live.close();
      }

      const backupPath = join(result.backupDirectory!, 'database.sqlite');
      expect(existsSync(backupPath)).toBe(true);
      expect(readFileSync(join(result.backupDirectory!, '.dnd-ai-credential-key'), 'utf8')).toBe('credential-key-pair');
      const backup = new Database(backupPath, { readonly: true });
      try {
        expect(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_rule_sources'").get()).toEqual({ name: 'platform_rule_sources' });
        expect(backup.prepare('SELECT version, name FROM platform_migrations ORDER BY version').all()).toHaveLength(LEGACY_ROWS.length);
        expect(backup.prepare('SELECT * FROM unrelated').all()).toEqual([{ id: 'keep', value: 'untouched' }]);
      } finally {
        backup.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing for the maintained exact set and rejects ambiguous or malformed legacy candidates before backup', async () => {
    const dir = tempDir();
    try {
      const maintainedPath = join(dir, 'maintained.sqlite');
      const maintained = new Database(maintainedPath);
      maintained.exec('CREATE TABLE platform_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      maintained.prepare('INSERT INTO platform_migrations VALUES (?, ?, ?)').run('001', MAINTAINED[0], 'now');
      maintained.close();
      await expect(migrateLegacyRuleSourcesDatabase({ databasePath: maintainedPath, credentialKeyPath: join(dir, 'missing-key'), approvedMigrationFilenames: [MAINTAINED[0]] })).resolves.toEqual({ migrated: false });
      expect(backupDirectories(dir)).toEqual([]);

      const staleTablePath = createLegacyDb(dir, { rows: MAINTAINED, databaseName: 'stale-table.sqlite' });
      await expect(migrateLegacyRuleSourcesDatabase({ databasePath: staleTablePath, credentialKeyPath: join(dir, 'missing-key'), approvedMigrationFilenames: MAINTAINED })).rejects.toThrow(/未标记来源/);
      expect(backupDirectories(dir)).toEqual([]);

      const ambiguousPath = createLegacyDb(dir, { rows: [...LEGACY_ROWS, '999_foreign.sql'] });
      await expect(migrateLegacyRuleSourcesDatabase({ databasePath: ambiguousPath, credentialKeyPath: join(dir, 'missing-key'), approvedMigrationFilenames: MAINTAINED })).rejects.toBeInstanceOf(LegacyRuleSourcesMigrationError);
      expect(backupDirectories(dir)).toEqual([]);

      const malformedPath = createLegacyDb(dir, { malformedTable: true, databaseName: 'malformed.sqlite' });
      await expect(migrateLegacyRuleSourcesDatabase({ databasePath: malformedPath, credentialKeyPath: join(dir, 'missing-key'), approvedMigrationFilenames: MAINTAINED })).rejects.toThrow(/legacy 形状/);
      expect(backupDirectories(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back table and tracking-row changes when the mutation transaction fails', async () => {
    const dir = tempDir();
    try {
      const databasePath = createLegacyDb(dir);
      const db = new Database(databasePath);
      db.exec("CREATE TRIGGER fail_legacy_delete BEFORE DELETE ON platform_migrations BEGIN SELECT RAISE(ABORT, 'forced tracking failure'); END;");
      db.close();

      await expect(migrateLegacyRuleSourcesDatabase({ databasePath, credentialKeyPath: join(dir, 'missing-key'), approvedMigrationFilenames: MAINTAINED })).rejects.toThrow(/forced tracking failure/);
      const after = new Database(databasePath, { readonly: true });
      try {
        expect(after.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_rule_sources'").get()).toEqual({ name: 'platform_rule_sources' });
        expect(after.prepare('SELECT version FROM platform_migrations WHERE version = ?').get('011')).toEqual({ version: '011' });
      } finally {
        after.close();
      }
      expect(backupDirectories(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on a backup/key failure without changing the live database', async () => {
    const dir = tempDir();
    try {
      const databasePath = createLegacyDb(dir);
      const badKeyPath = join(dir, 'credential-key-directory');
      new Database(join(dir, 'key-seed.sqlite')).close();
      // An existing directory is not a valid paired credential key.
      mkdirSync(badKeyPath);
      await expect(migrateLegacyRuleSourcesDatabase({ databasePath, credentialKeyPath: badKeyPath, approvedMigrationFilenames: MAINTAINED })).rejects.toThrow(/credential key/);
      const after = new Database(databasePath, { readonly: true });
      try {
        expect(after.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_rule_sources'").get()).toEqual({ name: 'platform_rule_sources' });
        expect(after.prepare('SELECT version FROM platform_migrations WHERE version = ?').get('011')).toEqual({ version: '011' });
      } finally {
        after.close();
      }
      expect(backupDirectories(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
