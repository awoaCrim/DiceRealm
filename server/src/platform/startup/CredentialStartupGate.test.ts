import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { CredentialCipher } from '../../modules/ai-runtime/CredentialCipher.js';
import { CredentialStartupError, runCredentialStartupGate } from './CredentialStartupGate.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function makeDb(): Promise<ReturnType<typeof createSqliteDatabase>> {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const now = new Date().toISOString();
  await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u-gate', 'gate-user', 'hash']);
  await db.execute(
    'INSERT INTO campaigns (id, owner_id, name, ruleset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['c-gate', 'u-gate', '门战役', 'dnd5e', 'active', now, now],
  );
  return db;
}

async function insertCiphertext(db: ReturnType<typeof createSqliteDatabase>, campaignId: string, ciphertext: string): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(
    "INSERT INTO platform_ai_provider_configs (campaign_id, provider, base_url, model, encrypted_api_key, created_at, updated_at) VALUES (?, 'openai-compatible', 'https://provider.example/v1', 'm', ?, ?, ?)",
    [campaignId, ciphertext, now, now],
  );
}

function serializeKey(cipher: CredentialCipher): string {
  // CredentialCipher 无法反序列化 key；从 test-only 的加密回环无法导出 key 文本。
  // 因此 fixture 直接用已知 key 字符串构造：base64(32 bytes)。
  return Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
}

describe('CredentialStartupGate', () => {
  it('fails closed on ciphertext with a missing key and never creates a replacement key', async () => {
    const db = await makeDb();
    const dir = tempDir('dnd-cred-gate-missing-');
    try {
      const cipher = CredentialCipher.generate();
      await insertCiphertext(db, 'c-gate', cipher.encrypt('sk-row-1'));
      const keyPath = join(dir, '.dnd-ai-credential-key');
      await expect(runCredentialStartupGate({ db, keyPath })).rejects.toThrow(CredentialStartupError);
      expect(existsSync(keyPath)).toBe(false); // 不会被创建
    } catch (error) {
      if (!(error instanceof CredentialStartupError)) throw error;
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on ciphertext with a corrupt key file and leaves the file bytes untouched', async () => {
    const db = await makeDb();
    const dir = tempDir('dnd-cred-gate-corrupt-');
    try {
      const cipher = CredentialCipher.generate();
      await insertCiphertext(db, 'c-gate', cipher.encrypt('sk-row-1'));
      const keyPath = join(dir, '.dnd-ai-credential-key');
      writeFileSync(keyPath, 'not-a-valid-key\n', 'utf8');
      await expect(runCredentialStartupGate({ db, keyPath })).rejects.toThrow(CredentialStartupError);
      expect(readFileSync(keyPath, 'utf8')).toBe('not-a-valid-key\n');
    } catch (error) {
      if (!(error instanceof CredentialStartupError)) throw error;
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the key cannot decrypt every ciphertext row (wrong key), leaving rows unchanged', async () => {
    const db = await makeDb();
    const dir = tempDir('dnd-cred-gate-wrongkey-');
    try {
      const rowCipher = CredentialCipher.generate();
      await insertCiphertext(db, 'c-gate', rowCipher.encrypt('sk-row-1'));
      const stored = (await db.query<{ encrypted_api_key: string }>('SELECT encrypted_api_key FROM platform_ai_provider_configs'))[0].encrypted_api_key;
      // 用另一个 key 写 key 文件（wrong key）。
      const keyPath = join(dir, '.dnd-ai-credential-key');
      writeFileSync(keyPath, randomBytes(32).toString('base64') + '\n', 'utf8');
      await expect(runCredentialStartupGate({ db, keyPath })).rejects.toThrow(CredentialStartupError);
      const rows = await db.query<{ encrypted_api_key: string }>('SELECT encrypted_api_key FROM platform_ai_provider_configs');
      expect(rows[0].encrypted_api_key).toBe(stored);
    } catch (error) {
      if (!(error instanceof CredentialStartupError)) throw error;
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when any single envelope is corrupted even if others decrypt', async () => {
    const db = await makeDb();
    const dir = tempDir('dnd-cred-gate-corrupt-env-');
    try {
      const keyBytes = Buffer.from(new Uint8Array(32).fill(9));
      const keyPath = join(dir, '.dnd-ai-credential-key');
      writeFileSync(keyPath, keyBytes.toString('base64') + '\n', 'utf8');
      const cipher = CredentialCipher.fromSerializedKey(keyBytes.toString('base64'));
      await insertCiphertext(db, 'c-gate', cipher.encrypt('sk-good-row'));
      // 第二条损坏 envelope（同一 campaign 的覆盖写不需要；直接用第二 campaign）。
      const now = new Date().toISOString();
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u-gate-2', 'gate-user-2', 'hash']);
      await db.execute(
        'INSERT INTO campaigns (id, owner_id, name, ruleset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['c-gate-2', 'u-gate-2', '门战役2', 'dnd5e', 'active', now, now],
      );
      await insertCiphertext(db, 'c-gate-2', 'v1.corrupt.envelope.data');
      await expect(runCredentialStartupGate({ db, keyPath })).rejects.toThrow(CredentialStartupError);
    } catch (error) {
      if (!(error instanceof CredentialStartupError)) throw error;
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decrypts every ciphertext row offline with the correct key and returns the cipher', async () => {
    const db = await makeDb();
    const dir = tempDir('dnd-cred-gate-ok-');
    try {
      const keyBytes = Buffer.from(new Uint8Array(32).fill(11));
      const keyPath = join(dir, '.dnd-ai-credential-key');
      writeFileSync(keyPath, keyBytes.toString('base64') + '\n', 'utf8');
      const cipher = CredentialCipher.fromSerializedKey(keyBytes.toString('base64'));
      await insertCiphertext(db, 'c-gate', cipher.encrypt('sk-row-1'));
      const now = new Date().toISOString();
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u-gate-3', 'gate-user-3', 'hash']);
      await db.execute(
        'INSERT INTO campaigns (id, owner_id, name, ruleset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['c-gate-3', 'u-gate-3', '门战役3', 'dnd5e', 'active', now, now],
      );
      await insertCiphertext(db, 'c-gate-3', cipher.encrypt('sk-row-2'));
      const result = await runCredentialStartupGate({ db, keyPath });
      expect(result.cipher.decrypt((await db.query<{ encrypted_api_key: string }>('SELECT encrypted_api_key FROM platform_ai_provider_configs WHERE campaign_id = ?', ['c-gate']))[0].encrypted_api_key)).toBe('sk-row-1');
      expect(result.cipher.decrypt((await db.query<{ encrypted_api_key: string }>('SELECT encrypted_api_key FROM platform_ai_provider_configs WHERE campaign_id = ?', ['c-gate-3']))[0].encrypted_api_key)).toBe('sk-row-2');
      expect(result.createdKey).toBe(false);
    } catch (error) {
      if (!(error instanceof CredentialStartupError)) throw error;
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a key on zero ciphertext and reloads the same key on restart', async () => {
    const db = await makeDb();
    const dir = tempDir('dnd-cred-gate-zero-');
    try {
      const keyPath = join(dir, '.dnd-ai-credential-key');
      const first = await runCredentialStartupGate({ db, keyPath });
      expect(first.createdKey).toBe(true);
      const second = await runCredentialStartupGate({ db, keyPath });
      expect(second.createdKey).toBe(false);
      const envelope = first.cipher.encrypt('persisted');
      expect(second.cipher.decrypt(envelope)).toBe('persisted');
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads an existing valid key on zero ciphertext without rotation', async () => {
    const db = await makeDb();
    const dir = tempDir('dnd-cred-gate-load-');
    try {
      const keyBytes = Buffer.from(new Uint8Array(32).fill(13));
      const keyPath = join(dir, '.dnd-ai-credential-key');
      writeFileSync(keyPath, keyBytes.toString('base64') + '\n', 'utf8');
      const before = readFileSync(keyPath, 'utf8');
      const result = await runCredentialStartupGate({ db, keyPath });
      expect(result.createdKey).toBe(false);
      expect(readFileSync(keyPath, 'utf8')).toBe(before);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
