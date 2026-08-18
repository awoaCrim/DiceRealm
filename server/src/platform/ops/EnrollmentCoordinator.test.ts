import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runEnrollmentCommand, EnrollmentError } from './EnrollmentCoordinator.js';
import { createSqliteDatabase } from '../database/SqliteDatabaseAdapter.js';
import { sha256OfMigrationText } from './migrationManifest.js';
import { applyMigrationsToFileDb } from '../../tests/phase2StartupHelpers.js';
import { createCredentialCipher, loadCredentialCipher } from '../../modules/ai-runtime/CredentialKeyStore.js';
import { CredentialCipher } from '../../modules/ai-runtime/CredentialCipher.js';
import { PlatformInstanceStore } from './PlatformInstanceStore.js';
import { runStartupSecurityGate } from '../startup/StartupSecurityGate.js';
import { APPROVED_MIGRATION_FILENAMES } from '../../tests/phase2TempFixture.js';

const COMMITTED_MIGRATIONS_DIR = fileURLToPath(new URL('../database/migrations/', import.meta.url));
const COMMITTED_MANIFEST_PATH = join(COMMITTED_MIGRATIONS_DIR, 'migrations.manifest.json');

const NOW = '2026-08-12T00:00:00.000Z';
const DATABASE_ID = 'db-test-0001';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 把 committed 迁移子集复制到临时目录并写匹配 manifest。 */
function migrationsSubset(versions: string[]): { dir: string; manifestPath: string } {
  const dir = tempDir('dnd-enroll-mig-');
  const names = versions
    .map((version) => readdirSync(COMMITTED_MIGRATIONS_DIR).find((name) => name.startsWith(`${version}_`))!)
    .sort();
  for (const name of names) {
    cpSync(join(COMMITTED_MIGRATIONS_DIR, name), join(dir, name));
  }
  const manifest = {
    format: 1,
    files: names.map((name) => ({
      name,
      sha256: sha256OfMigrationText(readFileSync(join(dir, name), 'utf8')),
    })),
  };
  const manifestPath = join(dir, 'migrations.manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { dir, manifestPath };
}

/** 用 raw better-sqlite3 手工应用 current Phase 1 baseline（与 MigrationRunner 相同 schema+tracking 原子语义）。 */
async function createExistingDb001_010(databasePath: string): Promise<void> {
  const raw = new Database(databasePath);
  raw.exec('CREATE TABLE IF NOT EXISTS platform_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const insert = raw.prepare('INSERT INTO platform_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  const { dir } = migrationsSubset(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']);
  try {
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(dir, name), 'utf8');
      raw.exec('BEGIN');
      try {
        raw.exec(sql);
        insert.run(name.slice(0, 3), name, NOW);
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    raw.close();
  }
}

function opts(dir: string, databasePath: string, keyPath: string, command: 'enroll' | 'resume' | 'rollback' | 'status' | 'init') {
  return {
    command,
    databasePath,
    keyPath,
    migrationsDir: COMMITTED_MIGRATIONS_DIR,
    manifestPath: COMMITTED_MANIFEST_PATH,
    now: () => NOW,
    databaseId: DATABASE_ID,
  };
}

describe('EnrollmentCoordinator enroll', () => {
  it('enrolls an existing current Phase 1 baseline DB: applies only 012, creates a generated key, marks ready', async () => {
    const dir = tempDir('dnd-enroll-ok-');
    try {
      const databasePath = join(dir, 'existing.sqlite');
      const keyPath = join(dir, '.dnd-ai-credential-key');
      await createExistingDb001_010(databasePath);

      const result = await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'enroll'));
      expect(result.enrollmentState).toBe('ready');
      expect(result.keyOrigin).toBe('generated');
      expect(result.createdKey).toBe(true);
      expect(result.databaseId).toBe(DATABASE_ID);
      expect(result.sessionSecurityState).toBe('pending');
      expect(existsSync(keyPath)).toBe(true);

      // 012 已应用且是唯一新迁移。
      const raw = new Database(databasePath, { readonly: true });
      try {
        const versions = raw.prepare('SELECT version FROM platform_migrations ORDER BY version').all().map((r) => (r as { version: string }).version);
        expect(versions).toEqual(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '012']);
        const instance = new PlatformInstanceStore();
        const row = (await instance.read({ query: async <R>(sql: string, p?: unknown[]) => raw.prepare(sql).all(...(p ?? [])) as R[] }))!;
        expect(row.credential_key_fingerprint).toBe(loadCredentialCipher({ keyPath }).fingerprint());
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses an existing key (preexisting) when the DB has no ciphertext and the key exists', async () => {
    const dir = tempDir('dnd-enroll-preexisting-');
    try {
      const databasePath = join(dir, 'existing.sqlite');
      const keyPath = join(dir, '.dnd-ai-credential-key');
      await createExistingDb001_010(databasePath);
      const preexisting = createCredentialCipher({ keyPath });
      const result = await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'enroll'));
      expect(result.keyOrigin).toBe('preexisting');
      expect(result.createdKey).toBe(false);
      expect(result.keyFingerprint).toBe(preexisting.fingerprint());
      // key 内容未旋转。
      expect(loadCredentialCipher({ keyPath }).fingerprint()).toBe(preexisting.fingerprint());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires a pre-existing key when ciphertext exists and refuses to create an alternative', async () => {
    const dir = tempDir('dnd-enroll-ciphertext-');
    try {
      const databasePath = join(dir, 'existing.sqlite');
      const keyPath = join(dir, '.dnd-ai-credential-key');
      await createExistingDb001_010(databasePath);
      // 手工写一条密文（先建 key 加密，再删除 key）。010 的 campaign_id 有 FK，需要先建 user/campaign。
      const tempKey = join(dir, 'temp.key');
      const cipher = createCredentialCipher({ keyPath: tempKey });
      const raw = new Database(databasePath);
      try {
        const now = new Date().toISOString();
        raw.prepare('INSERT INTO users (id, login, password_hash, created_at) VALUES (?, ?, ?, ?)')
          .run('u1', 'owner1', 'h', now);
        raw.prepare('INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run('c1', 'u1', 'c', 'active', 'dnd5e', now, now);
        raw.prepare('INSERT INTO platform_ai_provider_configs (campaign_id, provider, base_url, model, encrypted_api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run('c1', 'openai-compatible', 'https://p.example/v1', 'm', cipher.encrypt('sk-real'), now, now);
      } finally {
        raw.close();
      }

      // 无 key：拒绝并保持 DB/key 不变。
      await expect(runEnrollmentCommand(opts(dir, databasePath, keyPath, 'enroll'))).rejects.toThrow(/拒绝自动生成替代密钥/);
      expect(existsSync(keyPath)).toBe(false);

      // 错误 key：解密失败拒绝，DB 不被修改（012 不应用）。
      const wrongKey = createCredentialCipher({ keyPath });
      await expect(runEnrollmentCommand(opts(dir, databasePath, keyPath, 'enroll'))).rejects.toThrow(/无法用本地密钥解密/);
      const raw2 = new Database(databasePath, { readonly: true });
      try {
        const versions = raw2.prepare('SELECT version FROM platform_migrations').all().map((r) => (r as { version: string }).version);
        expect(versions.includes('012')).toBe(false);
      } finally {
        raw2.close();
      }
      expect(wrongKey.fingerprint()).toBe(loadCredentialCipher({ keyPath }).fingerprint());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a DB that already has 012 applied or an instance row', async () => {
    const dir = tempDir('dnd-enroll-reject-');
    try {
      const databasePath = join(dir, 'existing.sqlite');
      const keyPath = join(dir, '.dnd-ai-credential-key');
      await createExistingDb001_010(databasePath);
      await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'enroll'));
      // 已应用 012（或已存在行）时 enroll 必须拒绝。
      await expect(runEnrollmentCommand(opts(dir, databasePath, keyPath, 'enroll'))).rejects.toThrow(/只接受精确应用 current Phase 1 baseline|已存在 platform_instance/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** 构建含当前 021 与未来 022 迁移的临时目录，验证 021 会被精确 allowlist 应用而 022 不会。 */
function migrationsWithFuture021(): { dir: string; manifestPath: string } {
  const dir = tempDir('dnd-enroll-mig21-');
  const names = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021']
    .map((version) => readdirSync(COMMITTED_MIGRATIONS_DIR).find((name) => name.startsWith(`${version}_`))!)
    .sort();
  for (const name of names) {
    cpSync(join(COMMITTED_MIGRATIONS_DIR, name), join(dir, name));
  }
  writeFileSync(join(dir, '022_future_phase.sql'), 'CREATE TABLE IF NOT EXISTS future_phase_table (id INTEGER PRIMARY KEY);', 'utf8');
  const allNames = [...names, '022_future_phase.sql'].sort();
  const manifest = {
    format: 1,
    files: allNames.map((name) => ({
      name,
      sha256: sha256OfMigrationText(readFileSync(join(dir, name), 'utf8')),
    })),
  };
  const manifestPath = join(dir, 'migrations.manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { dir, manifestPath };
}

describe('EnrollmentCoordinator init (final secure-ready contract)', () => {
  it('creates a fresh DB with current approved migration set, enrolls ready, session security ready, and the normal server gate accepts it', async () => {
    const dir = tempDir('dnd-init-');
    try {
      const databasePath = join(dir, 'fresh.sqlite');
      const keyPath = join(dir, '.dnd-ai-credential-key');
      const result = await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'init'));
      expect(result.enrollmentState).toBe('ready');
      expect(result.createdKey).toBe(true);
      expect(result.sessionSecurityState).toBe('ready');
      expect(existsSync(databasePath)).toBe(true);

      // 普通 server 安全门接受 secure-ready 实例。
      const db = createSqliteDatabase(databasePath);
      try {
        const gate = await runStartupSecurityGate({
          db,
          keyPath,
          approvedMigrationFilenames: APPROVED_MIGRATION_FILENAMES,
        });
        expect(gate.instance.session_security_state).toBe('ready');
        expect(gate.instance.session_security_cutover_at).not.toBeNull();
      } finally {
        await db.close();
      }

      // 不创建 admin（bootstrap 前）。
      const raw = new Database(databasePath, { readonly: true });
      try {
        const admins = raw.prepare('SELECT COUNT(*) AS c FROM platform_administrators').get() as { c: number };
        expect(admins.c).toBe(0);
        const versions = raw.prepare('SELECT version FROM platform_migrations ORDER BY version').all().map((r) => (r as { version: string }).version);
        expect(versions).toEqual(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021']);
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('init applies exactly the frozen current approved migration set and never silently applies a future 022 from the manifest', async () => {
    const dir = tempDir('dnd-init-frozen-');
    try {
      const { dir: migrationsDir, manifestPath } = migrationsWithFuture021();
      const databasePath = join(dir, 'fresh.sqlite');
      const keyPath = join(dir, '.dnd-ai-credential-key');
      const result = await runEnrollmentCommand({
        command: 'init',
        databasePath,
        keyPath,
        migrationsDir,
        manifestPath,
        now: () => NOW,
        databaseId: DATABASE_ID,
      });
      expect(result.enrollmentState).toBe('ready');
      expect(result.sessionSecurityState).toBe('ready');
      // 022 不得被静默应用（即使 manifest/迁移目录已含 022）。
      const raw = new Database(databasePath, { readonly: true });
      try {
        const versions = raw.prepare('SELECT version FROM platform_migrations ORDER BY version').all().map((r) => (r as { version: string }).version);
        expect(versions).toEqual(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021']);
        const future = raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'future_phase_table'").get() as { c: number };
        expect(future.c).toBe(0);
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses init when the target DB already exists', async () => {
    const dir = tempDir('dnd-init-exists-');
    try {
      const databasePath = join(dir, 'fresh.sqlite');
      const keyPath = join(dir, '.dnd-ai-credential-key');
      writeFileSync(databasePath, '', 'utf8');
      await expect(runEnrollmentCommand(opts(dir, databasePath, keyPath, 'init'))).rejects.toThrow(/已存在/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('EnrollmentCoordinator crash window (012 applied, no singleton row)', () => {
  /** 精确应用当前 Phase 1 基线 + 012（无 platform_instance 行）的 crash-window DB。 */
  async function createCrashWindowDb(dir: string, extraVersions: string[] = []): Promise<string> {
    const databasePath = join(dir, 'crash.sqlite');
    await createExistingDb001_010(databasePath);
    await applyMigrationsToFileDb(databasePath, ['012', ...extraVersions]);
    return databasePath;
  }

  it('enroll safely resumes a crash window (exactly baseline + 012 applied, no singleton row): skips 012 re-apply and reaches ready+pending', async () => {
    const dir = tempDir('dnd-enroll-crash-');
    try {
      const databasePath = await createCrashWindowDb(dir);
      const keyPath = join(dir, '.dnd-ai-credential-key');

      const result = await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'enroll'));
      expect(result.enrollmentState).toBe('ready');
      expect(result.sessionSecurityState).toBe('pending');
      expect(result.keyOrigin).toBe('generated');
      expect(result.createdKey).toBe(true);
      expect(result.databaseId).toBe(DATABASE_ID);

      // 012 未被重放（无重复 tracking 行），版本集合仍精确为当前 Phase 1 基线 + 012。
      const raw = new Database(databasePath, { readonly: true });
      try {
        const versions = raw.prepare('SELECT version FROM platform_migrations ORDER BY version').all().map((r) => (r as { version: string }).version);
        expect(versions).toEqual(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '012']);
        const instance = new PlatformInstanceStore();
        const row = (await instance.read({ query: async <R>(sql: string, p?: unknown[]) => raw.prepare(sql).all(...(p ?? [])) as R[] }))!;
        expect(row.credential_key_fingerprint).toBe(loadCredentialCipher({ keyPath }).fingerprint());
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enroll preserves key disposition rules on the crash window (preexisting key reused, no rotation)', async () => {
    const dir = tempDir('dnd-enroll-crash-key-');
    try {
      const databasePath = await createCrashWindowDb(dir);
      const keyPath = join(dir, '.dnd-ai-credential-key');
      const preexisting = createCredentialCipher({ keyPath });
      const result = await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'enroll'));
      expect(result.keyOrigin).toBe('preexisting');
      expect(result.createdKey).toBe(false);
      expect(result.keyFingerprint).toBe(preexisting.fingerprint());
      expect(loadCredentialCipher({ keyPath }).fingerprint()).toBe(preexisting.fingerprint());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enroll fails closed on a contradictory applied set (baseline + 012 + 013, no singleton row)', async () => {
    const dir = tempDir('dnd-enroll-crash-contra-');
    try {
      const databasePath = await createCrashWindowDb(dir, ['013']);
      const keyPath = join(dir, '.dnd-ai-credential-key');
      await expect(runEnrollmentCommand(opts(dir, databasePath, keyPath, 'enroll')))
        .rejects.toThrow(/当前 Phase 1 基线或 crash 窗口/);
      // fail closed：无 key 被创建。
      expect(existsSync(keyPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status/resume/rollback stay coherent on the crash window before enroll (all reject with actionable hints)', async () => {
    const dir = tempDir('dnd-enroll-crash-coherent-');
    try {
      const databasePath = await createCrashWindowDb(dir);
      const keyPath = join(dir, '.dnd-ai-credential-key');
      await expect(runEnrollmentCommand(opts(dir, databasePath, keyPath, 'status'))).rejects.toThrow(/尚未 enrollment/);
      await expect(runEnrollmentCommand(opts(dir, databasePath, keyPath, 'resume'))).rejects.toThrow(/请先运行 platform enroll/);
      await expect(runEnrollmentCommand(opts(dir, databasePath, keyPath, 'rollback'))).rejects.toThrow(/rollback 只清除 initializing 状态的行/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('EnrollmentCoordinator resume/rollback provenance', () => {
  async function initDb(dir: string): Promise<{ databasePath: string; keyPath: string }> {
    const databasePath = join(dir, 'db.sqlite');
    const keyPath = join(dir, '.dnd-ai-credential-key');
    await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'init'));
    return { databasePath, keyPath };
  }

  it('resume completes a crash after generated key publish (initializing + matching key)', async () => {
    const dir = tempDir('dnd-resume-after-publish-');
    try {
      const { databasePath, keyPath } = await initDb(dir);
      // 模拟 crash：回到 initializing（真实中 key 已发布）。
      const db = createSqliteDatabase(databasePath);
      const store = new PlatformInstanceStore();
      const row = (await store.read(db))!;
      await db.transaction(async (tx) => {
        await tx.execute("UPDATE platform_instance SET enrollment_state = 'initializing' WHERE singleton_id = 1");
      });
      await db.close();

      const result = await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'resume'));
      expect(result.enrollmentState).toBe('ready');
      expect(result.databaseId).toBe(DATABASE_ID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resume refuses when generated key was never published; rollback clears the row', async () => {
    const dir = tempDir('dnd-resume-before-publish-');
    try {
      const { databasePath, keyPath } = await initDb(dir);
      // 模拟 crash：initializing + generated 但磁盘无 key。
      rmSync(keyPath, { force: true });
      const db = createSqliteDatabase(databasePath);
      await db.transaction(async (tx) => {
        await tx.execute("UPDATE platform_instance SET enrollment_state = 'initializing' WHERE singleton_id = 1");
      });
      await db.close();

      await expect(runEnrollmentCommand(opts(dir, databasePath, keyPath, 'resume'))).rejects.toThrow(/不能 resume/);

      // rollback 清除行；key 已不存在无需删除。
      const result = await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'rollback'));
      expect(result.enrollmentState).toBe('initializing');
      const db2 = createSqliteDatabase(databasePath);
      try {
        expect(await new PlatformInstanceStore().read(db2)).toBeNull();
      } finally {
        await db2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rollback never deletes a preexisting key', async () => {
    const dir = tempDir('dnd-rollback-preexisting-');
    try {
      const { databasePath, keyPath } = await initDb(dir);
      // 转为 preexisting provenance 并回 initializing。
      const db = createSqliteDatabase(databasePath);
      await db.transaction(async (tx) => {
        await tx.execute("UPDATE platform_instance SET enrollment_state = 'initializing', enrollment_key_origin = 'preexisting' WHERE singleton_id = 1");
      });
      await db.close();
      const keyBefore = readFileSync(keyPath, 'utf8');

      await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'rollback'));
      expect(readFileSync(keyPath, 'utf8')).toBe(keyBefore);
      const db2 = createSqliteDatabase(databasePath);
      try {
        expect(await new PlatformInstanceStore().read(db2)).toBeNull();
      } finally {
        await db2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rollback refuses when the instance is already ready', async () => {
    const dir = tempDir('dnd-rollback-ready-');
    try {
      const { databasePath, keyPath } = await initDb(dir);
      await expect(runEnrollmentCommand(opts(dir, databasePath, keyPath, 'rollback'))).rejects.toThrow(/已 ready/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resume is idempotent when already ready', async () => {
    const dir = tempDir('dnd-resume-ready-');
    try {
      const { databasePath, keyPath } = await initDb(dir);
      const result = await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'resume'));
      expect(result.enrollmentState).toBe('ready');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('EnrollmentCoordinator status', () => {
  it('reports state without leaking the key', async () => {
    const dir = tempDir('dnd-status-');
    try {
      const { databasePath, keyPath } = await (async () => {
        const databasePath = join(dir, 'db.sqlite');
        const keyPath = join(dir, '.dnd-ai-credential-key');
        await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'init'));
        return { databasePath, keyPath };
      })();
      const result = await runEnrollmentCommand(opts(dir, databasePath, keyPath, 'status'));
      expect(result.databaseId).toBe(DATABASE_ID);
      expect(result.keyFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.enrollmentState).toBe('ready');
      expect(result.sessionSecurityState).toBe('ready');
      // 不得输出 key 内容。
      expect(JSON.stringify(result)).not.toContain(readFileSync(keyPath, 'utf8').trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unenrolled DBs', async () => {
    const dir = tempDir('dnd-status-unenrolled-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      const keyPath = join(dir, '.dnd-ai-credential-key');
      await createExistingDb001_010(databasePath);
      await expect(runEnrollmentCommand(opts(dir, databasePath, keyPath, 'status'))).rejects.toThrow(EnrollmentError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
