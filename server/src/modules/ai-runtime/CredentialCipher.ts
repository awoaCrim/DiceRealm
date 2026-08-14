import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../platform/http/AppError.js';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Authenticated credential encryption for persisted Provider API keys.
 * Key material is supplied by the local credential key store; stored envelopes
 * contain only version + IV + auth tag + ciphertext. No plaintext is logged or exposed.
 */
export class CredentialCipher {
  private constructor(private readonly key: Buffer) {}

  static generate(): CredentialCipher {
    return new CredentialCipher(randomBytes(KEY_BYTES));
  }

  static fromSerializedKey(encoded: string): CredentialCipher {
    if (!encoded.trim()) {
      throw new Error('Credential encryption key is required.');
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('Credential encryption key must be canonical base64.');
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.toString('base64') !== encoded) {
      throw new Error('Credential encryption key must be canonical base64.');
    }
    if (key.length !== KEY_BYTES) {
      throw new Error('Credential encryption key must decode to exactly 32 bytes.');
    }
    return new CredentialCipher(key);
  }

  /** canonical serialized key（不带换行）：`fromSerializedKey(serialized())` 恒等还原。 */
  serialized(): string {
    return this.key.toString('base64');
  }

  /**
   * 冻结 fingerprint：对 canonical 解码后的 32 raw bytes 做 SHA-256，编码 `sha256:<lowercase hex>`。
   * 不含任何可还原 key 的信息（单向 hash）。
   */
  fingerprint(): string {
    return `sha256:${createHash('sha256').update(this.key).digest('hex')}`;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), authTag.toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt(envelope: string): string {
    try {
      const [version, ivPart, tagPart, ciphertextPart, extra] = envelope.split('.');
      if (version !== VERSION || !ivPart || !tagPart || ciphertextPart === undefined || extra !== undefined) {
        throw new Error('invalid envelope');
      }
      const iv = Buffer.from(ivPart, 'base64url');
      const authTag = Buffer.from(tagPart, 'base64url');
      const ciphertext = Buffer.from(ciphertextPart, 'base64url');
      if (iv.length !== IV_BYTES || authTag.length !== 16) throw new Error('invalid envelope');
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new AppError('CREDENTIAL_DECRYPTION_FAILED', 'AI Provider 凭证解密失败。');
    }
  }
}
