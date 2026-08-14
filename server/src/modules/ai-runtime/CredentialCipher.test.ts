import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialCipher } from './CredentialCipher.js';

const SERIALIZED_KEY = randomBytes(32).toString('base64');

describe('CredentialCipher', () => {
  it('encrypts credentials with authenticated encryption and decrypts them', () => {
    const cipher = CredentialCipher.fromSerializedKey(SERIALIZED_KEY);
    const encrypted = cipher.encrypt('sk-super-secret');

    expect(encrypted).not.toContain('sk-super-secret');
    expect(cipher.decrypt(encrypted)).toBe('sk-super-secret');
  });

  it('uses a fresh IV so equal credentials do not produce equal ciphertext', () => {
    const cipher = CredentialCipher.fromSerializedKey(SERIALIZED_KEY);
    expect(cipher.encrypt('same-secret')).not.toBe(cipher.encrypt('same-secret'));
  });

  it('can generate a fresh in-memory cipher', () => {
    const cipher = CredentialCipher.generate();
    expect(cipher.decrypt(cipher.encrypt('sk-generated'))).toBe('sk-generated');
  });

  it('rejects missing or malformed serialized 32-byte keys', () => {
    expect(() => CredentialCipher.fromSerializedKey('')).toThrow(/required/);
    expect(() => CredentialCipher.fromSerializedKey('!!!!' + SERIALIZED_KEY)).toThrow(/canonical base64/);
    const nonCanonicalTrailingBits = `${SERIALIZED_KEY.slice(0, -2)}B=`;
    expect(() => CredentialCipher.fromSerializedKey(nonCanonicalTrailingBits)).toThrow(/canonical base64/);
    expect(() => CredentialCipher.fromSerializedKey(Buffer.from('too-short').toString('base64'))).toThrow(/32/);
  });

  it('rejects tampered ciphertext without exposing plaintext', () => {
    const cipher = CredentialCipher.fromSerializedKey(SERIALIZED_KEY);
    const encrypted = cipher.encrypt('sk-never-echo');
    const tampered = `${encrypted.slice(0, -2)}aa`;
    const error = catchError(() => cipher.decrypt(tampered));

    expect(error.message).toBe('AI Provider 凭证解密失败。');
    expect(error.message).not.toContain('sk-never-echo');
  });
});

function catchError(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('Expected work to throw');
}
