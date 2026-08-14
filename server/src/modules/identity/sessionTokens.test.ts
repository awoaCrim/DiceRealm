import { describe, expect, it } from 'vitest';
import { createSessionSecrets, digestSessionSecret } from './sessionTokens.js';

describe('sessionTokens', () => {
  it('creates independent canonical 32-byte base64url token/csrf values and SHA-256 digests', () => {
    const chunks = [Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22), Buffer.alloc(32, 0x33)];
    const secrets = createSessionSecrets((size) => {
      expect(size).toBe(32);
      return chunks.shift()!;
    });

    expect(secrets.internalSessionId).toBe(Buffer.alloc(32, 0x11).toString('base64url'));
    expect(secrets.rawToken).toBe(Buffer.alloc(32, 0x22).toString('base64url'));
    expect(secrets.rawCsrfToken).toBe(Buffer.alloc(32, 0x33).toString('base64url'));
    expect(secrets.rawToken).not.toBe(secrets.rawCsrfToken);
    expect(secrets.tokenDigest).toBe(digestSessionSecret(secrets.rawToken));
    expect(secrets.csrfDigest).toBe(digestSessionSecret(secrets.rawCsrfToken));
    expect(secrets.tokenDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
