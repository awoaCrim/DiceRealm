import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { sha256OfMigrationText } from '../platform/ops/migrationManifest.js';

/** committed 迁移目录与 manifest（真实 runtime 目录）。 */
export function commitMigrationsDir(): string {
  return fileURLToPath(new URL('../platform/database/migrations/', import.meta.url));
}

export function commitManifestPath(): string {
  return join(commitMigrationsDir(), 'migrations.manifest.json');
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 复制 committed 迁移子集到临时目录并写匹配 manifest；返回 { dir, manifestPath }。 */
export function copyMigrations(versions: string[], targetDir: string): { dir: string; manifestPath: string } {
  const names = versions
    .map((version) => readdirSync(commitMigrationsDir()).find((name) => name.startsWith(`${version}_`))!)
    .sort();
  for (const name of names) {
    cpSync(join(commitMigrationsDir(), name), join(targetDir, name));
  }
  const manifest = {
    format: 1,
    files: names.map((name) => ({
      name,
      sha256: sha256OfMigrationText(readFileSync(join(targetDir, name), 'utf8')),
    })),
  };
  const manifestPath = join(targetDir, 'migrations.manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { dir: targetDir, manifestPath };
}

/** 用 raw better-sqlite3 把指定版本应用到数据库文件（schema + tracking 同事务）。 */
export function applyMigrationsToFileDb(databasePath: string, versions: string[]): void {
  const dir = tempDir('dnd-helpers-mig-');
  copyMigrations(versions, dir);
  const raw = new Database(databasePath);
  raw.exec('CREATE TABLE IF NOT EXISTS platform_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const insert = raw.prepare('INSERT INTO platform_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  try {
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(dir, name), 'utf8');
      raw.exec('BEGIN');
      try {
        raw.exec(sql);
        insert.run(name.slice(0, 3), name, new Date().toISOString());
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    }
  } finally {
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 创建精确当前 Phase 1 基线（无 012、无 enrollment）的 existing DB。 */
export function createExistingDb001_010(databasePath: string): void {
  applyMigrationsToFileDb(databasePath, ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']);
}
