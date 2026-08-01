import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MigrationExecutor } from '../DatabasePort.js';

/** One migration file discovered in the migrations directory. */
export interface Migration {
  version: string;
  name: string;
  sql: string;
}

/** Result of a migration run. */
export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('./', import.meta.url));

/**
 * Tracking table for the platform migration runner.
 *
 * Deliberately named `platform_migrations` instead of the conventional
 * `schema_migrations`: the existing legacy database already has a
 * `schema_migrations` table with a different shape (`id`, `version`,
 * `summary_json`, `completed_at`) owned by the legacy extraction pipeline.
 * Using a separate table avoids conflicting with it and leaves it untouched.
 */
const TRACKING_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS platform_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

/**
 * Runs versioned SQL migrations from the migrations directory and records
 * applied versions in `schema_migrations` so migrations never run twice.
 *
 * The `run()` path targets the asynchronous `DatabasePort` adapters (SQLite
 * and PostgreSQL). `runSync()` exists for the legacy SQLite startup path
 * (`server/src/db/schema.ts`) which initialises the schema synchronously.
 * Applied versions are recorded in the dedicated `platform_migrations` table.
 */
export class MigrationRunner {
  private readonly executor: MigrationExecutor;
  private readonly migrationsDir: string;

  constructor(executor: MigrationExecutor, migrationsDir: string = DEFAULT_MIGRATIONS_DIR) {
    this.executor = executor;
    this.migrationsDir = migrationsDir;
  }

  async run(): Promise<MigrationReport> {
    await this.executor.exec(TRACKING_TABLE_DDL);
    const applied = new Set((await this.appliedVersions()).map((row) => row.version));
    const report: MigrationReport = { applied: [], skipped: [] };

    for (const migration of loadMigrations(this.migrationsDir)) {
      if (applied.has(migration.version)) {
        report.skipped.push(migration.version);
        continue;
      }
      await this.executor.exec(migration.sql);
      await this.executor.execute(
        'INSERT INTO platform_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, new Date().toISOString()],
      );
      report.applied.push(migration.version);
    }
    return report;
  }

  static runSync(executor: SyncLegacyExecutor, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): MigrationReport {
    executor.exec(TRACKING_TABLE_DDL);
    const applied = new Set(executor.query<{ version: string }>('SELECT version FROM platform_migrations').map((row) => row.version));
    const report: MigrationReport = { applied: [], skipped: [] };

    for (const migration of loadMigrations(migrationsDir)) {
      if (applied.has(migration.version)) {
        report.skipped.push(migration.version);
        continue;
      }
      executor.exec(migration.sql);
      executor.execute('INSERT INTO platform_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
      report.applied.push(migration.version);
    }
    return report;
  }

  private async appliedVersions(): Promise<Array<{ version: string }>> {
    return this.executor.query<{ version: string }>('SELECT version FROM platform_migrations');
  }
}

/**
 * Synchronous SQLite executor used by the legacy startup path
 * (`server/src/db/schema.ts`), which cannot await migrations.
 */
export interface SyncLegacyExecutor {
  query<T>(sql: string, params?: unknown[]): T[];
  execute(sql: string, params?: unknown[]): { changes: number };
  exec(sql: string): void;
}

/** Load `.sql` files from the migrations directory, sorted by filename. */
function loadMigrations(migrationsDir: string): Migration[] {
  let entries;
  try {
    entries = readdirSync(migrationsDir, { withFileTypes: true });
  } catch {
    // Failing loudly is intentional: a silently empty migration set would let
    // production start without the platform tables ever being created (e.g. a
    // build that did not copy the .sql files next to the compiled runner).
    throw new Error(
      `Migrations directory not found: ${migrationsDir}. ` +
        'Ensure the SQL migration files exist next to the compiled MigrationRunner ' +
        '(the server build runs scripts/copy-migrations.mjs to copy them into dist).',
    );
  }
  const migrations = entries
    .filter((entry) => entry.isFile() && /^[0-9].*\.sql$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      version: entry.name.match(/^[0-9]+/)?.[0] ?? entry.name,
      name: entry.name,
      sql: readFileSync(join(migrationsDir, entry.name), 'utf8'),
    }));
  if (migrations.length === 0) {
    throw new Error(`No SQL migration files found in: ${migrationsDir}`);
  }
  return migrations;
}
