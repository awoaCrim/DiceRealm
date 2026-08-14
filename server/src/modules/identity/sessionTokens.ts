import { createHash, randomBytes } from 'node:crypto';

export type RandomBytes = (size: number) => Buffer;

export interface SessionSecrets {
  internalSessionId: string;
  rawToken: string;
  rawCsrfToken: string;
  tokenDigest: string;
  csrfDigest: string;
}

/** Generate route-private session material from three independent 32-byte values. */
export function createSessionSecrets(random: RandomBytes = randomBytes): SessionSecrets {
  const internalSessionId = canonicalBase64Url(random(32));
  const rawToken = canonicalBase64Url(random(32));
  const rawCsrfToken = canonicalBase64Url(random(32));
  return {
    internalSessionId,
    rawToken,
    rawCsrfToken,
    tokenDigest: digestSessionSecret(rawToken),
    csrfDigest: digestSessionSecret(rawCsrfToken),
  };
}

/** Digest a canonical raw token before any persistence or lookup. */
export function digestSessionSecret(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function createRawSessionSecret(random: RandomBytes = randomBytes): string {
  return canonicalBase64Url(random(32));
}

function canonicalBase64Url(bytes: Buffer): string {
  if (bytes.length !== 32) {
    throw new Error('Session random source must return exactly 32 bytes.');
  }
  return bytes.toString('base64url');
}
