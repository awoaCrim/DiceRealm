import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createSqliteDatabase } from '../database/SqliteDatabaseAdapter.js';
import { MigrationRunner } from '../database/migrations/MigrationRunner.js';
import { runEnrollmentCommand } from './EnrollmentCoordinator.js';
import { runSecurityCutover, SecurityCutoverError } from './SecurityCutoverCoordinator.js';
import { createSensitiveSnapshot } from './OfflineBackupPrimitives.js';
import { PlatformInstanceStore } from './PlatformInstanceStore.js';
import { createCredentialCipher, loadCredentialCipher } from '../../modules/ai-runtime/CredentialKeyStore.js';
import { CredentialCipher } from '../../modules/ai-runtime/CredentialCipher.js';
import { commitMigrationsDir, commitManifestPath, createExistingDb001_011, copyMigrations, tempDir, applyMigrationsToFileDb } from '../../tests/phase2StartupHelpers.js';
import { captureLegacySnapshot, makeLegacyFixture } from '../../tests/phase2LegacySentinel.js';

const COMMITTED_MIGRATIONS_DIR = commitMigrationsDir();
const COMMITTED_MANIFEST_PATH = commitManifestPath();

interface CutoverFixture {
  dir: string;
  databasePath: string;
  keyPath: string;
  backupDir: string;
  cleanup(): void;
}

/** 建 existing 001-011 DB（可选 legacy fixture）+ users/campaigns/sessions/ciphertext，并 enroll。 */
async function buildEnrolledPending(options: { legacy?: boolean; sessionCount?: number; crashWindow?: boolean } = {}): Promise<CutoverFixture> {
  const dir = tempDir('dnd-cutover-');
  const databasePath = join(dir, 'db.sqlite');
  const keyPath = join(dir, '.dnd-ai-credential-key');
  const backupDir = join(dir, 'backup');
  createExistingDb001_011(databasePath);
  if (options.crashWindow) {
    // M1 crash 窗口：012 已应用但无 platform_instance 行（enroll 必须能安全恢复）。
    applyMigrationsToFileDb(databasePath, ['012']);
  }
  const raw = new Database(databasePath);
  try {
    if (options.legacy) {
      raw.pragma('foreign_keys = ON');
      makeLegacyFixture(raw);
    }
    const now = new Date().toISOString();
    raw.prepare('INSERT INTO users (id, login, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('u1', 'owner', 'h', now);
    raw.prepare('INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('c1', 'u1', 'c', 'active', 'dnd5e', now, now);
    const cipher = createCredentialCipher({ keyPath });
    raw.prepare('INSERT INTO platform_ai_provider_configs (campaign_id, provider, base_url, model, encrypted_api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('c1', 'openai-compatible', 'https://p.example/v1', 'm', cipher.encrypt('sk-1'), now, now);
    const count = options.sessionCount ?? 2;
    for (let i = 0; i < count; i += 1) {
      raw.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run(`old-token-${i}-abcdef`, 'u1', '2099-01-01T00:00:00.000Z', now);
    }
  } finally {
    raw.close();
  }
  await runEnrollmentCommand({
    command: 'enroll',
    databasePath,
    keyPath,
    migrationsDir: COMMITTED_MIGRATIONS_DIR,
    manifestPath: COMMITTED_MANIFEST_PATH,
  });
  return {
    dir,
    databasePath,
    keyPath,
    backupDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('SecurityCutoverCoordinator full cutover', () => {
  it('backup → 013/014 → delete sessions → cleanup → ready, with byte/auth verification and audit', async () => {
    const fixture = await buildEnrolledPending({ sessionCount: 2 });
    try {
      const result = await runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: fixture.backupDir,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      });
      expect(result.sessionSecurityState).toBe('ready');
      expect(result.oldSessionCount).toBe(2);
      expect(result.appliedMigrations.sort()).toEqual(['013_secure_sessions.sql', '014_security_audit.sql']);
      expect(result.backupVerified).toBe(true);

      // 备份存在且完整。
      expect(existsSync(join(fixture.backupDir, 'snapshot.manifest.json'))).toBe(true);
      expect(existsSync(join(fixture.backupDir, 'database.sqlite'))).toBe(true);

      const db = createSqliteDatabase(fixture.databasePath);
      try {
        const instance = (await new PlatformInstanceStore().read(db))!;
        expect(instance.session_security_state).toBe('ready');
        expect(instance.session_security_cutover_at).not.toBeNull();
        // sessions 已全部删除。
        const sessions = await db.query('SELECT COUNT(*) AS c FROM sessions');
        expect((sessions[0] as { c: number }).c).toBe(0);
        // 审计行存在。
        const audits = await db.query("SELECT event_type FROM platform_security_audit_events WHERE event_type = 'security.cutover'");
        expect(audits.length).toBe(1);
        // 013/014 applied。
        const versions = await db.query("SELECT version FROM platform_migrations WHERE version IN ('013', '014')");
        expect(versions.length).toBe(2);
      } finally {
        await db.close();
      }

      // byte scan：DB 文件不再包含 old tokens。
      const bytes = readFileSync(fixture.databasePath);
      for (const token of ['old-token-0-abcdef', 'old-token-1-abcdef']) {
        expect(bytes.includes(Buffer.from(token, 'utf8'))).toBe(false);
      }
      // 旧 token 无法认证。
      const reopen = new Database(fixture.databasePath, { readonly: true });
      try {
        for (const token of ['old-token-0-abcdef', 'old-token-1-abcdef']) {
          const byId = reopen.prepare('SELECT id FROM sessions WHERE id = ?').all(token);
          const byDigest = reopen.prepare('SELECT token_digest FROM sessions WHERE token_digest = ?').all(
            require('node:crypto').createHash('sha256').update(token, 'utf8').digest('hex'),
          );
          expect(byId).toEqual([]);
          expect(byDigest).toEqual([]);
        }
      } finally {
        reopen.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('creates a verified backup even when there are zero legacy sessions', async () => {
    const fixture = await buildEnrolledPending({ sessionCount: 0 });
    try {
      const result = await runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: fixture.backupDir,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      });
      expect(result.oldSessionCount).toBe(0);
      expect(result.sessionSecurityState).toBe('ready');
      expect(existsSync(join(fixture.backupDir, 'snapshot.manifest.json'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('fails before applying 013 when the backup cannot be created; DB/key untouched', async () => {
    const fixture = await buildEnrolledPending({ sessionCount: 2 });
    try {
      // backup target 是不可写文件路径 → backup 失败。
      const badTarget = join(fixture.dir, 'blocked');
      writeFileSync(badTarget, 'x', 'utf8');
      await expect(runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: badTarget,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      })).rejects.toThrow();
      const db = createSqliteDatabase(fixture.databasePath);
      try {
        const versions = await db.query("SELECT version FROM platform_migrations WHERE version IN ('013', '014')");
        expect(versions.length).toBe(0);
        const sessions = await db.query('SELECT COUNT(*) AS c FROM sessions');
        expect((sessions[0] as { c: number }).c).toBe(2);
        const instance = (await new PlatformInstanceStore().read(db))!;
        expect(instance.session_security_state).toBe('pending');
      } finally {
        await db.close();
      }
      expect(loadCredentialCipher({ keyPath: fixture.keyPath }).fingerprint()).toBe(
        CredentialCipher.fromSerializedKey(readFileSync(fixture.keyPath, 'utf8').trim()).fingerprint(),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('preserves legacy schema and rows byte-identically through enrollment + cutover', async () => {
    const fixture = await buildEnrolledPending({ legacy: true, sessionCount: 1 });
    try {
      const beforeRaw = new Database(fixture.databasePath, { readonly: true });
      const before = captureLegacySnapshot(beforeRaw);
      beforeRaw.close();
      await runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: fixture.backupDir,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      });
      const afterRaw = new Database(fixture.databasePath, { readonly: true });
      try {
        const after = captureLegacySnapshot(afterRaw);
        expect(after.ddl).toBe(before.ddl);
        expect(after.rows).toBe(before.rows);
      } finally {
        afterRaw.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('is a no-op when session security is already ready', async () => {
    const fixture = await buildEnrolledPending({ sessionCount: 1 });
    try {
      const first = await runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: fixture.backupDir,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      });
      expect(first.sessionSecurityState).toBe('ready');
      const second = await runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: fixture.backupDir,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      });
      expect(second.sessionSecurityState).toBe('ready');
      expect(second.appliedMigrations).toEqual([]);
      expect(second.backupVerified).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('SecurityCutoverCoordinator crash resume', () => {
  it('full recovery: crash-window 001-012 DB enrolls as a fresh attempt and completes cutover to ready', async () => {
    const fixture = await buildEnrolledPending({ sessionCount: 2, crashWindow: true });
    try {
      const result = await runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: fixture.backupDir,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      });
      expect(result.sessionSecurityState).toBe('ready');
      expect(result.oldSessionCount).toBe(2);
      expect(result.backupVerified).toBe(true);
      const db = createSqliteDatabase(fixture.databasePath);
      try {
        const instance = (await new PlatformInstanceStore().read(db))!;
        expect(instance.session_security_state).toBe('ready');
      } finally {
        await db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('M2: cleaning with a missing pre-cutover backup fails closed and NEVER creates a snapshot from the post-delete live DB', async () => {
    const fixture = await buildEnrolledPending({ sessionCount: 2 });
    try {
      // 构造 cleaning 状态（013/014 applied + sessions 已删 + cutover_at + cleaning），backup 目录从未创建。
      const db = createSqliteDatabase(fixture.databasePath);
      const migrateDir = join(fixture.dir, 'mig1314');
      copyMigrations(['013', '014'], migrateDir);
      await new MigrationRunner(db, migrateDir).run();
      await db.transaction(async (tx) => {
        await tx.execute('DELETE FROM sessions');
        const store = new PlatformInstanceStore();
        await store.beginSessionCleaning(tx, new Date().toISOString());
      });
      await db.close();

      await expect(runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: fixture.backupDir,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      })).rejects.toThrow(/pre-cutover sensitive backup 缺失/);

      // 未从 post-delete live DB 生成任何新快照。
      expect(existsSync(join(fixture.backupDir, 'snapshot.manifest.json'))).toBe(false);
      expect(existsSync(join(fixture.backupDir, 'database.sqlite'))).toBe(false);
      // 状态保持 cleaning（fail closed）。
      const db2 = createSqliteDatabase(fixture.databasePath);
      try {
        const instanceAfter = (await new PlatformInstanceStore().read(db2))!;
        expect(instanceAfter.session_security_state).toBe('cleaning');
      } finally {
        await db2.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('M2: cleaning with a mismatched published backup fails closed and does not replace it', async () => {
    const fixture = await buildEnrolledPending({ sessionCount: 2 });
    try {
      // 先发布正确 backup。
      const cipher = loadCredentialCipher({ keyPath: fixture.keyPath });
      const db = createSqliteDatabase(fixture.databasePath);
      const instance = (await new PlatformInstanceStore().read(db))!;
      await createSensitiveSnapshot({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        targetDirectory: fixture.backupDir,
        databaseId: instance.database_id,
        keyFingerprint: cipher.fingerprint(),
      });
      // 构造 cleaning。
      const migrateDir = join(fixture.dir, 'mig1314');
      copyMigrations(['013', '014'], migrateDir);
      await new MigrationRunner(db, migrateDir).run();
      await db.transaction(async (tx) => {
        await tx.execute('DELETE FROM sessions');
        const store = new PlatformInstanceStore();
        await store.beginSessionCleaning(tx, new Date().toISOString());
      });
      await db.close();
      // 篡改 backup：删掉 DB 副本（manifest 仍在 → 文件集合复验失败）。
      rmSync(join(fixture.backupDir, 'database.sqlite'));

      await expect(runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: fixture.backupDir,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      })).rejects.toThrow();

      // 未重建 backup：database.sqlite 依然缺失（没有从 post-delete live DB 生成新快照）。
      expect(existsSync(join(fixture.backupDir, 'database.sqlite'))).toBe(false);
      // 状态保持 cleaning（fail closed）。
      const db2 = createSqliteDatabase(fixture.databasePath);
      try {
        const instanceAfter = (await new PlatformInstanceStore().read(db2))!;
        expect(instanceAfter.session_security_state).toBe('cleaning');
      } finally {
        await db2.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('logical cutover compares live vs backup session ID sets exactly (content parity, not count only)', async () => {
    const fixture = await buildEnrolledPending({ sessionCount: 2 });
    try {
      const cipher = loadCredentialCipher({ keyPath: fixture.keyPath });
      const db = createSqliteDatabase(fixture.databasePath);
      const instance = (await new PlatformInstanceStore().read(db))!;
      // 先发布 pre-cutover backup（含 old-token-0 / old-token-1）。
      await createSensitiveSnapshot({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        targetDirectory: fixture.backupDir,
        databaseId: instance.database_id,
        keyFingerprint: cipher.fingerprint(),
      });
      // 保持 count 相同但集合内容不同：把 old-token-1 换成 old-token-other。
      await db.execute("DELETE FROM sessions WHERE id = 'old-token-1-abcdef'");
      await db.execute(
        'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
        ['old-token-other', 'u1', '2099-01-01T00:00:00.000Z', new Date().toISOString()],
      );
      await db.close();

      await expect(runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: fixture.backupDir,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      })).rejects.toThrow(/集合不一致/);

      // fail closed：sessions 未删除、状态仍 pending。
      const db2 = createSqliteDatabase(fixture.databasePath);
      try {
        const instanceAfter = (await new PlatformInstanceStore().read(db2))!;
        expect(instanceAfter.session_security_state).toBe('pending');
        const sessions = await db2.query('SELECT COUNT(*) AS c FROM sessions');
        expect((sessions[0] as { c: number }).c).toBe(2);
      } finally {
        await db2.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('partial inventory: 013 applied / 014 missing → rerun completes via allowlist without re-backup', async () => {
    const fixture = await buildEnrolledPending({ sessionCount: 2 });
    try {
      // 第一次运行只应用 013（模拟 crash：backup 已发布、013 已应用、014 未应用、logical tx 未提交）。
      const db = createSqliteDatabase(fixture.databasePath);
      const migrateDir = join(fixture.dir, 'mig013');
      copyMigrations(['013'], migrateDir);
      await new MigrationRunner(db, migrateDir).run();
      await db.close();

      // 先发布 backup（等价于第一次 crash 前已完成的 backup）。
      const cipher = loadCredentialCipher({ keyPath: fixture.keyPath });
      const probeDb = createSqliteDatabase(fixture.databasePath);
      const instance = (await new PlatformInstanceStore().read(probeDb))!;
      await probeDb.close();
      await createSensitiveSnapshot({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        targetDirectory: fixture.backupDir,
        databaseId: instance.database_id,
        keyFingerprint: cipher.fingerprint(),
      });

      const result = await runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: fixture.backupDir,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      });
      expect(result.sessionSecurityState).toBe('ready');
      expect(result.appliedMigrations).toEqual(['014_security_audit.sql']);
      expect(result.oldSessionCount).toBe(2);
      const db2 = createSqliteDatabase(fixture.databasePath);
      try {
        const sessions = await db2.query('SELECT COUNT(*) AS c FROM sessions');
        expect((sessions[0] as { c: number }).c).toBe(0);
      } finally {
        await db2.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('cleaning resume: verifies published backup, redoes cleanup verification, never re-deletes sessions', async () => {
    const fixture = await buildEnrolledPending({ sessionCount: 2 });
    try {
      // 构造 cleaning 状态：backup 已发布 + 013/014 已应用 + sessions 已删 + audit 已写 + cutover_at + cleaning。
      const cipher = loadCredentialCipher({ keyPath: fixture.keyPath });
      const db = createSqliteDatabase(fixture.databasePath);
      const instance = (await new PlatformInstanceStore().read(db))!;
      await createSensitiveSnapshot({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        targetDirectory: fixture.backupDir,
        databaseId: instance.database_id,
        keyFingerprint: cipher.fingerprint(),
      });
      const migrateDir = join(fixture.dir, 'mig1314');
      copyMigrations(['013', '014'], migrateDir);
      await new MigrationRunner(db, migrateDir).run();
      await db.transaction(async (tx) => {
        await tx.execute('DELETE FROM sessions');
        await tx.execute(
          "INSERT INTO platform_security_audit_events (id, event_type, outcome, metadata_json, created_at) VALUES ('a1', 'security.cutover', 'success', '{\"backupVerified\":true}', ?)",
          [new Date().toISOString()],
        );
        const store = new PlatformInstanceStore();
        await store.beginSessionCleaning(tx, new Date().toISOString());
      });
      await db.close();

      const result = await runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: fixture.backupDir,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      });
      expect(result.sessionSecurityState).toBe('ready');
      expect(result.oldSessionCount).toBe(2); // 从 verified backup 恢复的 old-token 集合。
      expect(result.appliedMigrations).toEqual([]);

      const db2 = createSqliteDatabase(fixture.databasePath);
      try {
        const sessions = await db2.query('SELECT COUNT(*) AS c FROM sessions');
        expect((sessions[0] as { c: number }).c).toBe(0);
        // 只有一条 security.cutover audit（未重写）。
        const audits = await db2.query("SELECT COUNT(*) AS c FROM platform_security_audit_events WHERE event_type = 'security.cutover'");
        expect((audits[0] as { c: number }).c).toBe(1);
      } finally {
        await db2.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('cleanup verification failure fails closed and stays cleaning', async () => {
    const fixture = await buildEnrolledPending({ sessionCount: 1 });
    try {
      // 构造 cleaning 状态，但在 logical tx 之后又把旧 token 塞回 sessions（模拟 cleanup 漏删）。
      const cipher = loadCredentialCipher({ keyPath: fixture.keyPath });
      const db = createSqliteDatabase(fixture.databasePath);
      const instance = (await new PlatformInstanceStore().read(db))!;
      await createSensitiveSnapshot({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        targetDirectory: fixture.backupDir,
        databaseId: instance.database_id,
        keyFingerprint: cipher.fingerprint(),
      });
      const migrateDir = join(fixture.dir, 'mig1314');
      copyMigrations(['013', '014'], migrateDir);
      await new MigrationRunner(db, migrateDir).run();
      await db.transaction(async (tx) => {
        // 模拟 real cutover 的 logical tx：删除 sessions + cleaning。
        await tx.execute('DELETE FROM sessions');
        const store = new PlatformInstanceStore();
        await store.beginSessionCleaning(tx, new Date().toISOString());
      });
      // 模拟 cleanup 漏删：logical tx 之后又把旧 token 塞回 sessions。
      await db.execute(
        'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
        ['old-token-0-abcdef', 'u1', '2099-01-01T00:00:00.000Z', new Date().toISOString()],
      );
      await db.close();

      await expect(runSecurityCutover({
        databasePath: fixture.databasePath,
        keyPath: fixture.keyPath,
        backupTargetDir: fixture.backupDir,
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      })).rejects.toThrow(/fail closed|旧 token/);
      // 状态保持 cleaning（fail closed）。
      const db2 = createSqliteDatabase(fixture.databasePath);
      try {
        const instanceAfter = (await new PlatformInstanceStore().read(db2))!;
        expect(instanceAfter.session_security_state).toBe('cleaning');
      } finally {
        await db2.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses cutover when the DB is not enrolled', async () => {
    const dir = tempDir('dnd-cutover-unenrolled-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      createExistingDb001_011(databasePath);
      await expect(runSecurityCutover({
        databasePath,
        keyPath: join(dir, '.dnd-ai-credential-key'),
        backupTargetDir: join(dir, 'backup'),
        migrationsDir: COMMITTED_MIGRATIONS_DIR,
        manifestPath: COMMITTED_MANIFEST_PATH,
      })).rejects.toThrow(SecurityCutoverError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
