import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { AppConfig } from '../../config.js';
import { parseSecurityConfig } from '../../config.js';
import { acquireInstanceLock } from '../../platform/ops/InstanceLock.js';
import { MigrationManifestError, sha256OfMigrationText } from '../../platform/ops/migrationManifest.js';
import { PlatformPathError } from '../../platform/ops/platformPaths.js';
import { StartupSecurityError } from './StartupSecurityGate.js';
import { startPlatformServer } from './startPlatformServer.js';
import type { StartPlatformServerOptions } from './startPlatformServer.js';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { runEnrollmentCommand } from '../../platform/ops/EnrollmentCoordinator.js';

const COMMITTED_MIGRATIONS_DIR = fileURLToPath(new URL('../../platform/database/migrations/', import.meta.url));
const COMMITTED_MANIFEST_PATH = join(COMMITTED_MIGRATIONS_DIR, 'migrations.manifest.json');

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 复制 committed 迁移子集到临时目录并写匹配 manifest。 */
function copyMigrations(versions: string[], targetDir: string): void {
  const names = versions
    .map((version) => readdirSync(COMMITTED_MIGRATIONS_DIR).find((name) => name.startsWith(`${version}_`))!)
    .sort();
  for (const name of names) {
    cpSync(join(COMMITTED_MIGRATIONS_DIR, name), join(targetDir, name));
  }
  const manifest = {
    format: 1,
    files: names.map((name) => ({
      name,
      sha256: sha256OfMigrationText(readFileSync(join(targetDir, name), 'utf8')),
    })),
  };
  writeFileSync(join(targetDir, 'migrations.manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

/** 用 raw better-sqlite3 应用一个迁移目录（schema + tracking 同事务）。 */
function applyMigrations(databasePath: string, versions: string[]): void {
  const dir = tempDir('dnd-startup-mig-');
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

/** 创建一个当前 Phase 1 基线 existing DB（无 012，无 enrollment）。 */
function createExistingDb001_010(dir: string): string {
  const databasePath = join(dir, 'db.sqlite');
  applyMigrations(databasePath, ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']);
  return databasePath;
}

/** 通过 enroll（existing current Phase 1 baseline → 只应用 012）创建 enrolled-pending（session security pending）DB。 */
async function createEnrolledPendingDb(dir: string): Promise<{ databasePath: string; keyPath: string }> {
  const databasePath = createExistingDb001_010(dir);
  const keyPath = join(dir, '.dnd-ai-credential-key');
  await runEnrollmentCommand({
    command: 'enroll',
    databasePath,
    keyPath,
    migrationsDir: COMMITTED_MIGRATIONS_DIR,
    manifestPath: COMMITTED_MANIFEST_PATH,
  });
  return { databasePath, keyPath };
}

/** 通过 coordinator init 创建 secure-ready（current approved migration set + session ready）DB。 */
async function createReadyDb(dir: string): Promise<{ databasePath: string; keyPath: string }> {
  const databasePath = join(dir, 'db.sqlite');
  const keyPath = join(dir, '.dnd-ai-credential-key');
  await runEnrollmentCommand({
    command: 'init',
    databasePath,
    keyPath,
    migrationsDir: COMMITTED_MIGRATIONS_DIR,
    manifestPath: COMMITTED_MANIFEST_PATH,
  });
  return { databasePath, keyPath };
}

function baseOptions(config: AppConfig, patches: Partial<StartPlatformServerOptions> = {}): StartPlatformServerOptions {
  const events: string[] = [];
  return {
    config: { ...config, security: config.security ?? parseSecurityConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://127.0.0.1' }) },
    env: {},
    migrationsDir: COMMITTED_MIGRATIONS_DIR,
    emit: (event: string) => events.push(event),
    listen: async () => ({
      stopAccepting: vi.fn(async () => undefined),
      destroyConnections: vi.fn(async () => undefined),
    }),
    events,
    ...patches,
  } as unknown as StartPlatformServerOptions;
}

describe('startPlatformServer Phase 2 fail-closed gate', () => {
  it('fails before acquiring the lock when the DB is missing and never creates a file', async () => {
    const dir = tempDir('dnd-startup-missing-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath });
      await expect(startPlatformServer(opts)).rejects.toThrow(PlatformPathError);
      expect(existsSync(databasePath)).toBe(false);
      const events = (opts as unknown as { events: string[] }).events;
      expect(events).toEqual([]);
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails before app with an enrollment hint for an existing current Phase 1 baseline DB, closing DB and releasing the lock', async () => {
    const dir = tempDir('dnd-startup-unenrolled-');
    try {
      const databasePath = createExistingDb001_010(dir);
      let closeCalls = 0;
      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, {
        createDatabase: (path) => {
          const real = createSqliteDatabase(path);
          const adapter = real;
          const originalClose = adapter.close.bind(adapter);
          return new Proxy(adapter, {
            get(target, prop) {
              if (prop === 'close') {
                return async () => {
                  closeCalls += 1;
                  return originalClose();
                };
              }
              return Reflect.get(target, prop);
            },
          });
        },
        credentialKeyPath: join(dir, '.dnd-ai-credential-key'),
      });
      await expect(startPlatformServer(opts)).rejects.toThrow(StartupSecurityError);
      const events = (opts as unknown as { events: string[] }).events;
      expect(events.slice(0, 4)).toEqual(['path.verify', 'lock.acquire', 'manifest.verify', 'database.open']);
      expect(events).toContain('close.database');
      expect(events[events.length - 1]).toBe('close.lock');
      expect(events).not.toContain('app.create');
      expect(events).not.toContain('listen');
      expect(closeCalls).toBe(1);
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with a security-cutover hint for an enrolled baseline + 012 DB (session security pending)', async () => {
    const dir = tempDir('dnd-startup-pending-');
    try {
      const { databasePath, keyPath } = await createEnrolledPendingDb(dir);
      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, {
        credentialKeyPath: keyPath,
      });
      await expect(startPlatformServer(opts)).rejects.toThrow(/security-cutover/);
      const events = (opts as unknown as { events: string[] }).events;
      expect(events).not.toContain('app.create');
      expect(events[events.length - 1]).toBe('close.lock');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the local key fingerprint does not match the enrolled fingerprint', async () => {
    const dir = tempDir('dnd-startup-wrongkey-');
    try {
      const { databasePath, keyPath } = await createReadyDb(dir);
      // 换成错误的 key（rotate 模拟）。
      rmSync(keyPath, { force: true });
      const { createCredentialCipher } = await import('../../modules/ai-runtime/CredentialKeyStore.js');
      createCredentialCipher({ keyPath });
      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, {
        credentialKeyPath: keyPath,
      });
      await expect(startPlatformServer(opts)).rejects.toThrow(/指纹.*不匹配/);
      const events = (opts as unknown as { events: string[] }).events;
      expect(events).not.toContain('app.create');
      expect(events[events.length - 1]).toBe('close.lock');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the fixed startup order for a secure-ready DB and closes in the fixed order', async () => {
    const dir = tempDir('dnd-startup-order-');
    try {
      const { databasePath, keyPath } = await createReadyDb(dir);
      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, {
        credentialKeyPath: keyPath,
      });
      const running = await startPlatformServer(opts);
      await running.close();
      const events = (opts as unknown as { events: string[] }).events;
      expect(events.slice(0, 7)).toEqual([
        'path.verify',
        'lock.acquire',
        'manifest.verify',
        'database.open',
        'security.verify',
        'app.create',
        'listen',
      ]);
      expect(events.slice(7)).toEqual([
        'close.server',
        'close.realtime',
        'close.connections',
        'close.database',
        'close.lock',
      ]);
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes close() idempotent: second call does nothing and the lock file is gone', async () => {
    const dir = tempDir('dnd-startup-idem-');
    try {
      const { databasePath, keyPath } = await createReadyDb(dir);
      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, {
        credentialKeyPath: keyPath,
      });
      const running = await startPlatformServer(opts);
      await running.close();
      await running.close();
      const events = (opts as unknown as { events: string[] }).events;
      expect(events.filter((event) => event === 'close.database')).toHaveLength(1);
      expect(events.filter((event) => event === 'close.lock')).toHaveLength(1);
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still closes database and releases the lock when listener.stopAccepting throws', async () => {
    const dir = tempDir('dnd-startup-stop-throw-');
    try {
      const { databasePath, keyPath } = await createReadyDb(dir);
      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, {
        credentialKeyPath: keyPath,
        listen: async () => ({
          stopAccepting: vi.fn(async () => {
            throw new Error('stop boom');
          }),
          destroyConnections: vi.fn(async () => undefined),
        }),
      });
      const running = await startPlatformServer(opts);
      await expect(running.close()).resolves.toBeUndefined();
      const events = (opts as unknown as { events: string[] }).events;
      expect(events).toEqual([
        'path.verify', 'lock.acquire', 'manifest.verify', 'database.open', 'security.verify', 'app.create', 'listen',
        'close.realtime', 'close.connections', 'close.database', 'close.lock',
      ]);
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still closes database and releases the lock when listener.destroyConnections throws', async () => {
    const dir = tempDir('dnd-startup-destroy-throw-');
    try {
      const { databasePath, keyPath } = await createReadyDb(dir);
      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, {
        credentialKeyPath: keyPath,
        listen: async () => ({
          stopAccepting: vi.fn(async () => undefined),
          destroyConnections: vi.fn(async () => {
            throw new Error('destroy boom');
          }),
        }),
      });
      const running = await startPlatformServer(opts);
      await expect(running.close()).resolves.toBeUndefined();
      const events = (opts as unknown as { events: string[] }).events;
      expect(events).toEqual([
        'path.verify', 'lock.acquire', 'manifest.verify', 'database.open', 'security.verify', 'app.create', 'listen',
        'close.server', 'close.realtime', 'close.database', 'close.lock',
      ]);
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails before open when the manifest is invalid, and releases the lock', async () => {
    const dir = tempDir('dnd-startup-manifest-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      writeFileSync(databasePath, '', 'utf8');
      const emptyMigrations = join(dir, 'migrations');
      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, {
        migrationsDir: emptyMigrations,
      });
      await expect(startPlatformServer(opts)).rejects.toThrow(MigrationManifestError);
      const events = (opts as unknown as { events: string[] }).events;
      expect(events).toEqual(['path.verify', 'lock.acquire', 'close.lock']);
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an ordinary startup DB with a future 016 applied even when the manifest includes it (frozen current approved migration set acceptance)', async () => {
    const dir = tempDir('dnd-startup-frozen-');
    try {
      // 运行时迁移目录：current approved migration set committed 副本 + 未来 016 + 匹配 manifest（16 项）。
      const migrationsDir = join(dir, 'migrations');
      mkdirSync(migrationsDir, { recursive: true });
      copyMigrations(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '012', '013', '014', '015'], migrationsDir);
      writeFileSync(join(migrationsDir, '016_future_phase.sql'), 'CREATE TABLE IF NOT EXISTS future_phase_table (id INTEGER PRIMARY KEY);', 'utf8');
      const names = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
      const manifest = {
        format: 1,
        files: names.map((name) => ({
          name,
          sha256: sha256OfMigrationText(readFileSync(join(migrationsDir, name), 'utf8')),
        })),
      };
      writeFileSync(join(migrationsDir, 'migrations.manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

      // DB：current approved migration set committed 应用 + 016 手工应用（已应用集合 = 16）。
      const databasePath = join(dir, 'db.sqlite');
      applyMigrations(databasePath, ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '012', '013', '014', '015']);
      const raw = new Database(databasePath);
      raw.exec('BEGIN');
      raw.exec(readFileSync(join(migrationsDir, '016_future_phase.sql'), 'utf8'));
      raw.prepare('INSERT INTO platform_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run('016', '016_future_phase.sql', new Date().toISOString());
      raw.exec('COMMIT');
      raw.close();

      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, { migrationsDir });
      await expect(startPlatformServer(opts)).rejects.toThrow(/批准集合不一致/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives an exact-set diagnostic (never a security-cutover hint) for an incomplete or foreign applied migration set', async () => {
    const dir = tempDir('dnd-startup-badset-');
    try {
      // 11 个已应用迁移但缺 012、含 013（集合异常，不是 enrollment 后 pending）。
      const databasePath = join(dir, 'db.sqlite');
      applyMigrations(databasePath, ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '013']);
      const keyPath = join(dir, '.dnd-ai-credential-key');
      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, { credentialKeyPath: keyPath });
      let message = '';
      try {
        await startPlatformServer(opts);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/已应用迁移集合异常/);
      expect(message).not.toMatch(/security-cutover/);
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('automatically removes the exact legacy rule-source state before the security gate and listening', async () => {
    const dir = tempDir('dnd-startup-legacy-rule-sources-');
    try {
      const { databasePath, keyPath } = await createReadyDb(dir);
      const raw = new Database(databasePath);
      raw.exec(`
        CREATE TABLE platform_rule_sources (
          id TEXT PRIMARY KEY,
          source_name TEXT NOT NULL,
          version TEXT NOT NULL,
          license TEXT NOT NULL,
          attribution TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          scope TEXT NOT NULL,
          campaign_id TEXT,
          user_id TEXT,
          created_by_user_id TEXT,
          created_at TEXT NOT NULL
        )
      `);
      raw.prepare('INSERT INTO platform_rule_sources (id, source_name, version, license, attribution, content_hash, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('legacy-source', 'PHB', '2024', 'CC', 'Author', 'a'.repeat(64), 'platform', '2026-08-16T00:00:00.000Z');
      raw.prepare('INSERT INTO platform_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run('011', '011_rule_sources.sql', '2026-08-16T00:00:00.000Z');
      raw.close();

      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, { credentialKeyPath: keyPath });
      const running = await startPlatformServer(opts);
      await running.close();
      const events = (opts as unknown as { events: string[] }).events;
      expect(events.indexOf('legacy-rule-sources.migrate')).toBeGreaterThan(events.indexOf('database.open'));
      expect(events.indexOf('legacy-rule-sources.migrate')).toBeLessThan(events.indexOf('security.verify'));
      expect(events).toContain('listen');

      const live = new Database(databasePath, { readonly: true });
      try {
        expect(live.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_rule_sources'").get()).toBeUndefined();
        expect(live.prepare("SELECT version FROM platform_migrations WHERE version = '011'").get()).toBeUndefined();
      } finally {
        live.close();
      }

      const backupRoot = join(dir, 'backups');
      const backupNames = readdirSync(backupRoot).filter((name) => name.startsWith('.dnd-rule-sources-migration-backup-'));
      expect(backupNames).toHaveLength(1);
      const backup = new Database(join(backupRoot, backupNames[0], 'database.sqlite'), { readonly: true });
      try {
        expect(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_rule_sources'").get()).toEqual({ name: 'platform_rule_sources' });
        expect(backup.prepare("SELECT version FROM platform_migrations WHERE version = '011'").get()).toEqual({ version: '011' });
      } finally {
        backup.close();
      }
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed before listening when the legacy marker has no matching rule-source table', async () => {
    const dir = tempDir('dnd-startup-legacy-rule-sources-invalid-');
    try {
      const { databasePath, keyPath } = await createReadyDb(dir);
      const raw = new Database(databasePath);
      raw.prepare('INSERT INTO platform_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run('011', '011_rule_sources.sql', '2026-08-16T00:00:00.000Z');
      raw.close();

      let listenCalls = 0;
      const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, {
        credentialKeyPath: keyPath,
        listen: async () => {
          listenCalls += 1;
          return { stopAccepting: async () => undefined, destroyConnections: async () => undefined };
        },
      });
      await expect(startPlatformServer(opts)).rejects.toThrow(/platform_rule_sources/);
      expect(listenCalls).toBe(0);
      expect((opts as unknown as { events: string[] }).events).not.toContain('listen');
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
      expect(existsSync(join(dir, 'backups'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a second instance before ever calling the database factory', async () => {
    const dir = tempDir('dnd-startup-second-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      writeFileSync(databasePath, '', 'utf8');
      const holder = acquireInstanceLock({ databasePath, purpose: 'server' });
      try {
        let dbCalls = 0;
        const opts = baseOptions({ host: '127.0.0.1', port: 0, databasePath }, {
          createDatabase: () => { dbCalls += 1; throw new Error('must not open'); },
        });
        await expect(startPlatformServer(opts)).rejects.toThrow(/实例锁已存在/);
        expect(dbCalls).toBe(0);
        const events = (opts as unknown as { events: string[] }).events;
      } finally {
        holder.release();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
