import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createCredentialCipher, loadCredentialCipher } from '../../modules/ai-runtime/CredentialKeyStore.js';
import { CredentialCipher } from '../../modules/ai-runtime/CredentialCipher.js';
import {
  createSensitiveSnapshot,
  parseSnapshotManifest,
  readLegacySessionTokensFromSnapshot,
  SensitiveBackupError,
  verifySensitiveSnapshot,
} from './OfflineBackupPrimitives.js';
import { createExistingDb001_010, applyMigrationsToFileDb, commitMigrationsDir, tempDir } from '../../tests/phase2StartupHelpers.js';

function buildSourceDb(dir: string): { databasePath: string; keyPath: string; databaseId: string; keyFingerprint: string } {
  const databasePath = join(dir, 'db.sqlite');
  const keyPath = join(dir, '.dnd-ai-credential-key');
  createExistingDb001_010(databasePath);
  const cipher = createCredentialCipher({ keyPath });
  // 一条 provider ciphertext + legacy session rows。
  const raw = new Database(databasePath);
  try {
    const now = new Date().toISOString();
    raw.prepare('INSERT INTO users (id, login, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('u1', 'owner', 'h', now);
    raw.prepare('INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('c1', 'u1', 'c', 'active', 'dnd5e', now, now);
    raw.prepare('INSERT INTO platform_ai_provider_configs (campaign_id, provider, base_url, model, encrypted_api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('c1', 'openai-compatible', 'https://p.example/v1', 'm', cipher.encrypt('sk-1'), now, now);
    raw.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run('old-token-alpha', 'u1', '2099-01-01T00:00:00.000Z', now);
    raw.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run('old-token-beta', 'u1', '2099-01-01T00:00:00.000Z', now);
  } finally {
    raw.close();
  }
  return { databasePath, keyPath, databaseId: 'db-test-1', keyFingerprint: cipher.fingerprint() };
}

describe('OfflineBackupPrimitives create+verify', () => {
  it('creates a consistent snapshot with DB copy, key copy and manifest; verify passes', async () => {
    const dir = tempDir('dnd-backup-ok-');
    try {
      const src = buildSourceDb(dir);
      const target = join(dir, 'snapshot');
      const { manifest, targetDirectory } = await createSensitiveSnapshot({
        databasePath: src.databasePath,
        keyPath: src.keyPath,
        targetDirectory: target,
        databaseId: src.databaseId,
        keyFingerprint: src.keyFingerprint,
      });
      expect(targetDirectory).toBe(target);
      expect(manifest.sensitive).toBe(true);
      expect(manifest.databaseId).toBe(src.databaseId);
      expect(manifest.migrations).toContain('001_initial_platform.sql');
      expect(manifest.migrations.length).toBe(10);
      // manifest 有 database.sqlite + key copy 两个文件条目。
      expect(manifest.files.some((f) => f.name === 'database.sqlite')).toBe(true);
      expect(manifest.files.some((f) => f.name === '.dnd-ai-credential-key')).toBe(true);
      expect(existsSync(join(target, 'database.sqlite'))).toBe(true);
      // temp 目录已清理。
      expect(readdirSync(dir).filter((n) => n.includes('dnd-backup-tmp')).length).toBe(0);

      const verified = verifySensitiveSnapshot({ snapshotDir: target, databaseId: src.databaseId, keyFingerprint: src.keyFingerprint });
      expect(verified.manifest.format).toBe('dnd-sensitive-snapshot-v1');
      // 备份内 key 可解密原 ciphertext。
      const backupKey = loadCredentialCipher({ keyPath: join(target, '.dnd-ai-credential-key') });
      const backupDb = new Database(join(target, 'database.sqlite'), { readonly: true });
      try {
        const row = backupDb.prepare('SELECT encrypted_api_key FROM platform_ai_provider_configs').get() as { encrypted_api_key: string };
        expect(backupKey.decrypt(row.encrypted_api_key)).toBe('sk-1');
      } finally {
        backupDb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a non-empty existing target (no silent overwrite)', async () => {
    const dir = tempDir('dnd-backup-exists-');
    try {
      const src = buildSourceDb(dir);
      const target = join(dir, 'snapshot');
      mkdirSync(target);
      writeFileSync(join(target, 'stale.txt'), 'x', 'utf8');
      await expect(createSensitiveSnapshot({
        databasePath: src.databasePath,
        keyPath: src.keyPath,
        targetDirectory: target,
        databaseId: src.databaseId,
        keyFingerprint: src.keyFingerprint,
      })).rejects.toThrow(SensitiveBackupError);
      expect(readFileSync(join(target, 'stale.txt'), 'utf8')).toBe('x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verify rejects wrong databaseId, wrong keyFingerprint, and a tampered copy', async () => {
    const dir = tempDir('dnd-backup-verify-');
    try {
      const src = buildSourceDb(dir);
      const target = join(dir, 'snapshot');
      await createSensitiveSnapshot({
        databasePath: src.databasePath,
        keyPath: src.keyPath,
        targetDirectory: target,
        databaseId: src.databaseId,
        keyFingerprint: src.keyFingerprint,
      });
      expect(() => verifySensitiveSnapshot({ snapshotDir: target, databaseId: 'other', keyFingerprint: src.keyFingerprint }))
        .toThrow(/databaseId/);
      expect(() => verifySensitiveSnapshot({ snapshotDir: target, databaseId: src.databaseId, keyFingerprint: 'sha256:' + 'ab'.repeat(32) }))
        .toThrow(/keyFingerprint/);
      // tamper：修改 DB 副本。
      const dbCopyPath = join(target, 'database.sqlite');
      const content = readFileSync(dbCopyPath);
      writeFileSync(dbCopyPath, Buffer.concat([content.subarray(0, 64), Buffer.from('TAMPER'), content.subarray(69)]));
      expect(() => verifySensitiveSnapshot({ snapshotDir: target, databaseId: src.databaseId, keyFingerprint: src.keyFingerprint }))
        .toThrow(SensitiveBackupError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parseSnapshotManifest rejects malformed manifests', () => {
    for (const bad of ['not-json', JSON.stringify({ format: 'x' }), JSON.stringify({ format: 'dnd-sensitive-snapshot-v1', sensitive: false })]) {
      expect(() => parseSnapshotManifest(bad)).toThrow(SensitiveBackupError);
    }
  });

  it('creates missing backup parent directories (target under a non-existent nested parent)', async () => {
    const dir = tempDir('dnd-backup-parent-');
    try {
      const src = buildSourceDb(dir);
      const target = join(dir, 'nested', 'a', 'b', 'snapshot');
      const { targetDirectory } = await createSensitiveSnapshot({
        databasePath: src.databasePath,
        keyPath: src.keyPath,
        targetDirectory: target,
        databaseId: src.databaseId,
        keyFingerprint: src.keyFingerprint,
      });
      expect(targetDirectory).toBe(target);
      expect(existsSync(join(target, 'snapshot.manifest.json'))).toBe(true);
      expect(verifySensitiveSnapshot({ snapshotDir: target, databaseId: src.databaseId, keyFingerprint: src.keyFingerprint }).manifest.format)
        .toBe('dnd-sensitive-snapshot-v1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('snapshot captures WAL-visible committed session rows (source-vs-snapshot parity pin)', async () => {
    const dir = tempDir('dnd-backup-walparity-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      const keyPath = join(dir, '.dnd-ai-credential-key');
      createExistingDb001_010(databasePath);
      const cipher = createCredentialCipher({ keyPath });
      const raw = new Database(databasePath);
      raw.pragma('journal_mode = WAL');
      const now = new Date().toISOString();
      raw.prepare('INSERT INTO users (id, login, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run('u1', 'owner', 'h', now);
      raw.prepare('INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('c1', 'u1', 'c', 'active', 'dnd5e', now, now);
      raw.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run('old-wal-a', 'u1', '2099-01-01T00:00:00.000Z', now);
      raw.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run('old-wal-b', 'u1', '2099-01-01T00:00:00.000Z', now);
      // 连接保持打开：行已提交但仍在 WAL（未 checkpoint），证明存在未落盘的 WAL 帧。
      expect(existsSync(`${databasePath}-wal`)).toBe(true);
      expect(statSync(`${databasePath}-wal`).size).toBeGreaterThan(0);

      const target = join(dir, 'snapshot');
      await createSensitiveSnapshot({
        databasePath,
        keyPath,
        targetDirectory: target,
        databaseId: 'db-test-wal',
        keyFingerprint: cipher.fingerprint(),
      });
      raw.close();

      // 确定性安全行为：官方 backup() API（sqlite3_backup）快照必须包含 WAL-visible
      // 已提交行（与源精确一致）——backup API 从源（含未 checkpoint 的 WAL 帧）复制。
      expect(readLegacySessionTokensFromSnapshot(target).sort()).toEqual(['old-wal-a', 'old-wal-b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes only after the official backup() Promise completes (never a partial copy; source closes only after the await)', async () => {
    const dir = tempDir('dnd-backup-backupapi-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      const keyPath = join(dir, '.dnd-ai-credential-key');
      createExistingDb001_010(databasePath);
      const cipher = createCredentialCipher({ keyPath });
      const raw = new Database(databasePath);
      raw.pragma('journal_mode = WAL');
      const now = new Date().toISOString();
      raw.prepare('INSERT INTO users (id, login, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run('u1', 'owner', 'h', now);
      raw.prepare('INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('c1', 'u1', 'c', 'active', 'dnd5e', now, now);
      raw.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run('old-backup-api-a', 'u1', '2099-01-01T00:00:00.000Z', now);
      raw.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run('old-backup-api-b', 'u1', '2099-01-01T00:00:00.000Z', now);
      // 已提交但未 checkpoint 的 WAL 帧存在（raw 连接保持打开）→ backup API 必须读到 WAL。
      expect(existsSync(`${databasePath}-wal`)).toBe(true);
      expect(statSync(`${databasePath}-wal`).size).toBeGreaterThan(0);

      const target = join(dir, 'snapshot');
      const { targetDirectory } = await createSensitiveSnapshot({
        databasePath,
        keyPath,
        targetDirectory: target,
        databaseId: 'db-test-backupapi',
        keyFingerprint: cipher.fingerprint(),
      });
      expect(targetDirectory).toBe(target);
      // 生命周期 pin：await 返回时官方 backup() Promise 必须已 resolve——发布副本完整、可复验，
      // 且包含全部 WAL-visible 已提交行。若发布早于 backup() 完成（floating promise +
      // 提前 close source），database.sqlite 缺失/空或 backup 迟发 “connection is not open”
      // → 以下断言 RED。
      expect(statSync(join(target, 'database.sqlite')).size).toBeGreaterThan(0);
      expect(
        verifySensitiveSnapshot({ snapshotDir: target, databaseId: 'db-test-backupapi', keyFingerprint: cipher.fingerprint() })
          .manifest.databaseId,
      ).toBe('db-test-backupapi');
      expect(readLegacySessionTokensFromSnapshot(target).sort()).toEqual(['old-backup-api-a', 'old-backup-api-b']);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readLegacySessionTokensFromSnapshot returns the full raw session id set', async () => {
    const dir = tempDir('dnd-backup-tokens-');
    try {
      const src = buildSourceDb(dir);
      const target = join(dir, 'snapshot');
      await createSensitiveSnapshot({
        databasePath: src.databasePath,
        keyPath: src.keyPath,
        targetDirectory: target,
        databaseId: src.databaseId,
        keyFingerprint: src.keyFingerprint,
      });
      expect(readLegacySessionTokensFromSnapshot(target).sort()).toEqual(['old-token-alpha', 'old-token-beta']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
