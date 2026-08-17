import Database from 'better-sqlite3';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const LEGACY_MIGRATION_NAME = '011_rule_sources.sql';
const LEGACY_MIGRATION_VERSION = '011';
const BACKUP_DIRECTORY_PREFIX = '.dnd-rule-sources-migration-backup-';
const BACKUP_DATABASE_NAME = 'database.sqlite';
const BACKUP_KEY_NAME = '.dnd-ai-credential-key';

/** The exact legacy schema that is safe to remove after the rule-material feature was removed. */
const LEGACY_RULE_SOURCE_COLUMNS = [
  'id',
  'source_name',
  'version',
  'license',
  'attribution',
  'content_hash',
  'scope',
  'campaign_id',
  'user_id',
  'created_by_user_id',
  'created_at',
] as const;

export interface LegacyRuleSourcesMigrationResult {
  migrated: boolean;
  /** The durable pre-migration backup directory when migration was applied. */
  backupDirectory?: string;
}

/**
 * Remove only the retired 011 rule-source table from an exact, known legacy
 * database. This is intentionally not a general migration mechanism: every
 * other migration inventory is rejected before any database mutation.
 *
 * The backup is made with SQLite's backup API before the mutation transaction,
 * in the database's own directory. A credential key is copied beside it when
 * the live key is an ordinary file, keeping the pair recoverable.
 */
export async function migrateLegacyRuleSourcesDatabase(options: {
  databasePath: string;
  credentialKeyPath: string;
  /** The currently maintained approved set, which must no longer contain 011. */
  approvedMigrationFilenames: readonly string[];
}): Promise<LegacyRuleSourcesMigrationResult> {
  const databasePath = resolve(options.databasePath);
  const keyPath = resolve(options.credentialKeyPath);
  const maintained = [...options.approvedMigrationFilenames]
    .filter((name) => name !== LEGACY_MIGRATION_NAME)
    .sort(compareNames);
  // Keep the previous pre-adjudication baseline as a read-only admission shape
  // so the retired-rule cleanup can still fail closed safely on a database that
  // has not yet crossed the explicit 016 schema boundary. It never applies 016.
  const maintainedCandidates = [maintained];
  if (maintained.some((name) => name.startsWith('016_'))) {
    maintainedCandidates.push(maintained.filter((name) => !name.startsWith('016_') && !name.startsWith('017_')));
  }

  // If 011 is still approved, this is the pre-removal application and there
  // is no compatibility bridge to run. This also prevents an accidental
  // allowlist expansion from rewriting every ordinary database.
  if (options.approvedMigrationFilenames.includes(LEGACY_MIGRATION_NAME)) {
    return { migrated: false };
  }

  const source = new Database(databasePath, { fileMustExist: true });
  let backupDirectory: string | undefined;
  try {
    source.pragma('foreign_keys = ON');
    const rows = readMigrationRows(source);
    const maintainedRows = maintainedCandidates.map((candidate) => migrationRowsFor(candidate));
    const legacyRows = maintainedCandidates.map((candidate) =>
      migrationRowsFor([...candidate, LEGACY_MIGRATION_NAME].sort(compareNames)));

    const hasLegacyMarker = rows.some(
      (row) => row.version === LEGACY_MIGRATION_VERSION || row.name === LEGACY_MIGRATION_NAME,
    );
    const ruleSourcesObject = readRuleSourcesObject(source);
    if (maintainedRows.some((candidate) => sameMigrationRows(rows, candidate))) {
      if (ruleSourcesObject !== undefined) {
        throw new LegacyRuleSourcesMigrationError(
          '拒绝自动迁移：维护迁移集合中仍存在未标记来源的 platform_rule_sources 对象。',
        );
      }
      return { migrated: false };
    }
    // Other incomplete/foreign sets remain the startup gate's responsibility;
    // do not turn their established diagnostics into a compatibility error.
    if (!hasLegacyMarker) {
      if (ruleSourcesObject !== undefined) {
        throw new LegacyRuleSourcesMigrationError(
          '拒绝自动迁移：platform_rule_sources 存在但没有精确的 011 legacy tracking row。',
        );
      }
      return { migrated: false };
    }
    if (!legacyRows.some((candidate) => sameMigrationRows(rows, candidate))) {
      throw new LegacyRuleSourcesMigrationError(
        '拒绝自动迁移：数据库的 platform_migrations 集合不是维护集合或唯一批准的 011 legacy 集合。',
      );
    }

    assertLegacyRuleSourcesTable(source);
    backupDirectory = await createPreMigrationBackup({ source, databasePath, keyPath });
    applyRemovalTransaction(source);
    return { migrated: true, backupDirectory };
  } finally {
    source.close();
  }
}

export class LegacyRuleSourcesMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyRuleSourcesMigrationError';
  }
}

type MigrationRow = { version: string; name: string };

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function migrationRowsFor(names: string[]): MigrationRow[] {
  return names.map((name) => ({ version: name.slice(0, 3), name })).sort((a, b) => compareNames(a.version, b.version));
}

function readMigrationRows(db: Database.Database): MigrationRow[] {
  try {
    return (db.prepare('SELECT version, name FROM platform_migrations ORDER BY version').all() as MigrationRow[])
      .map((row) => ({ version: String(row.version), name: String(row.name) }));
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table: platform_migrations')) {
      return [];
    }
    throw new LegacyRuleSourcesMigrationError(
      `拒绝自动迁移：platform_migrations 缺失或格式无效（${error instanceof Error ? error.message : String(error)}）。`,
    );
  }
}

function sameMigrationRows(actual: MigrationRow[], expected: MigrationRow[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((row, index) => row.version === expected[index].version && row.name === expected[index].name);
}

function readRuleSourcesObject(db: Database.Database): { type: string } | undefined {
  return db.prepare(
    "SELECT type FROM sqlite_master WHERE name = 'platform_rule_sources'",
  ).get() as { type: string } | undefined;
}

function assertLegacyRuleSourcesTable(db: Database.Database): void {
  const object = readRuleSourcesObject(db);
  if (object?.type !== 'table') {
    throw new LegacyRuleSourcesMigrationError(
      '拒绝自动迁移：platform_rule_sources 不是实际 SQLite table。',
    );
  }

  let columns: Array<{ name: string }>;
  try {
    columns = db.prepare('PRAGMA table_info(platform_rule_sources)').all() as Array<{ name: string }>;
  } catch (error) {
    throw new LegacyRuleSourcesMigrationError(
      `拒绝自动迁移：无法读取 platform_rule_sources 表结构（${error instanceof Error ? error.message : String(error)}）。`,
    );
  }
  const actual = columns.map((column) => column.name);
  if (actual.length !== LEGACY_RULE_SOURCE_COLUMNS.length
    || actual.some((name, index) => name !== LEGACY_RULE_SOURCE_COLUMNS[index])) {
    throw new LegacyRuleSourcesMigrationError(
      `拒绝自动迁移：platform_rule_sources 表结构不是受支持的 legacy 形状（${actual.join(', ')}）。`,
    );
  }
}

async function createPreMigrationBackup(options: {
  source: Database.Database;
  databasePath: string;
  keyPath: string;
}): Promise<string> {
  const backupRoot = join(dirname(options.databasePath), 'backups');
  let backupDirectory: string | undefined;
  try {
    if (existsSync(backupRoot)) {
      const rootStats = lstatSync(backupRoot);
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        throw new LegacyRuleSourcesMigrationError('备份目录不是普通目录，拒绝自动迁移。');
      }
    } else {
      mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    }
    backupDirectory = mkdtempSync(join(backupRoot, BACKUP_DIRECTORY_PREFIX));
    chmodSync(backupDirectory, 0o700);

    const backupDatabasePath = join(backupDirectory, BACKUP_DATABASE_NAME);
    // Keep source open until the official better-sqlite3 backup Promise settles.
    await options.source.backup(backupDatabasePath);

    chmodSync(backupDatabasePath, 0o600);
    const backup = new Database(backupDatabasePath, { fileMustExist: true });
    try {
      const journalMode = backup.pragma('journal_mode', { simple: true }) as string;
      if (journalMode.toLowerCase() !== 'delete') {
        backup.pragma('journal_mode = DELETE');
      }
      const integrity = backup.pragma('integrity_check', { simple: true }) as string;
      if (integrity !== 'ok') throw new LegacyRuleSourcesMigrationError('备份数据库 integrity_check 失败。');
      if ((backup.pragma('foreign_key_check') as unknown[]).length !== 0) {
        throw new LegacyRuleSourcesMigrationError('备份数据库 foreign_key_check 失败。');
      }
    } finally {
      backup.close();
    }

    if (existsSync(options.keyPath)) {
      const stats = lstatSync(options.keyPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new LegacyRuleSourcesMigrationError('credential key 存在但不是普通文件，拒绝创建未配对备份。');
      }
      const backupKeyPath = join(backupDirectory, BACKUP_KEY_NAME);
      cpSync(options.keyPath, backupKeyPath);
      chmodSync(backupKeyPath, 0o600);
    }
    return backupDirectory;
  } catch (error) {
    if (backupDirectory !== undefined) {
      rmSync(backupDirectory, { recursive: true, force: true });
    }
    if (error instanceof LegacyRuleSourcesMigrationError) throw error;
    throw new LegacyRuleSourcesMigrationError(
      `拒绝自动迁移：无法创建完整的 pre-migration backup（${error instanceof Error ? error.message : String(error)}）。`,
    );
  }
}

function applyRemovalTransaction(db: Database.Database): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP TABLE platform_rule_sources');
    const result = db.prepare(
      'DELETE FROM platform_migrations WHERE version = ? AND name = ?',
    ).run(LEGACY_MIGRATION_VERSION, LEGACY_MIGRATION_NAME);
    if (result.changes !== 1) {
      throw new LegacyRuleSourcesMigrationError('拒绝自动迁移：011 legacy tracking row 在事务内不再唯一可删除。');
    }
    const integrity = db.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') {
      throw new LegacyRuleSourcesMigrationError('拒绝自动迁移：事务内 integrity_check 失败。');
    }
    const foreignKeys = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeys.length !== 0) {
      throw new LegacyRuleSourcesMigrationError('拒绝自动迁移：事务内 foreign_key_check 失败。');
    }
    if (readRuleSourcesObject(db) !== undefined) {
      throw new LegacyRuleSourcesMigrationError('拒绝自动迁移：规则资料表未在事务内删除。');
    }
    if (db.prepare('SELECT 1 FROM platform_migrations WHERE version = ? AND name = ?').get(LEGACY_MIGRATION_VERSION, LEGACY_MIGRATION_NAME) !== undefined) {
      throw new LegacyRuleSourcesMigrationError('拒绝自动迁移：011 legacy tracking row 未在事务内删除。');
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original failure if the connection is already unusable.
    }
    throw error;
  }
}
