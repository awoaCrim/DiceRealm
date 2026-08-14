import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialCipher } from './CredentialCipher.js';
import {
  credentialKeyFileExists,
  credentialKeyPathForDatabase,
  createCredentialCipher,
  loadCredentialCipher,
} from './CredentialKeyStore.js';

describe('CredentialKeyStore', () => {
  it('creates a local key once and reloads the same key on later startups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dnd-credential-key-'));
    try {
      const keyPath = join(dir, '.dnd-ai-credential-key');
      const first = createCredentialCipher({ keyPath });
      const envelope = first.encrypt('sk-persisted-across-restart');
      const second = loadCredentialCipher({ keyPath });

      expect(second.decrypt(envelope)).toBe('sk-persisted-across-restart');
      expect(readFileSync(keyPath, 'utf8').trim()).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      if (process.platform !== 'win32') {
        expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects corrupt key files without replacing them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dnd-credential-corrupt-'));
    try {
      const keyPath = join(dir, '.dnd-ai-credential-key');
      writeFileSync(keyPath, 'not-a-key\n');
      expect(() => loadCredentialCipher({ keyPath })).toThrow(/拒绝自动覆盖/);
      expect(readFileSync(keyPath, 'utf8')).toBe('not-a-key\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives the key path beside the database', () => {
    const databasePath = join('data', 'campaign.sqlite');
    expect(credentialKeyPathForDatabase(databasePath)).toBe(join(process.cwd(), 'data', '.dnd-ai-credential-key'));
  });

  it('createCredentialCipher refuses to overwrite an existing file (EEXIST)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dnd-credential-exist-'));
    try {
      const keyPath = join(dir, '.dnd-ai-credential-key');
      createCredentialCipher({ keyPath });
      const before = readFileSync(keyPath, 'utf8');
      expect(() => createCredentialCipher({ keyPath })).toThrow();
      expect(readFileSync(keyPath, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes a stable fingerprint: sha256 of the canonical 32-byte key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dnd-credential-fp-'));
    try {
      const keyPath = join(dir, '.dnd-ai-credential-key');
      const created = createCredentialCipher({ keyPath });
      const loaded = loadCredentialCipher({ keyPath });
      const fingerprint = created.fingerprint();
      expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      // 同 key 两次加载 fingerprint 稳定；不同 key 不同 fingerprint。
      expect(loaded.fingerprint()).toBe(fingerprint);
      const other = CredentialCipher.generate();
      expect(other.fingerprint()).not.toBe(fingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('credentialKeyFileExists reports presence only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dnd-credential-exists-'));
    try {
      const keyPath = join(dir, '.dnd-ai-credential-key');
      expect(credentialKeyFileExists(keyPath)).toBe(false);
      createCredentialCipher({ keyPath });
      expect(credentialKeyFileExists(keyPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
