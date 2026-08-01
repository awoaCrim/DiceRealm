import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../platform/http/AppError.js';

/** 哈希字符串参数编码；自含版本与参数，便于未来无损升级。 */
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

const MIN_PASSWORD_LENGTH = 8;

/**
 * 校验密码强度。任务计划示例密码（'correct-password'）可通过此最小值。
 */
export function assertPasswordPolicy(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError('VALIDATION_ERROR', `密码长度至少为 ${MIN_PASSWORD_LENGTH} 个字符`);
  }
}

/**
 * 使用 Node crypto.scrypt 派生密钥。所有盐随机生成，与哈希一并持久化。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
  });
  return [
    'scrypt',
    PARAMS.N.toString(16),
    PARAMS.r.toString(16),
    PARAMS.p.toString(16),
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * 校验密码。即使存储格式不合法也返回 false，避免抛异常造成时序或信息泄露。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      return false;
    }
    const n = Number.parseInt(parts[1], 16);
    const r = Number.parseInt(parts[2], 16);
    const p = Number.parseInt(parts[3], 16);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || salt.length === 0 || expected.length === 0) {
      return false;
    }
    const derived = await scryptAsync(password, salt, expected.length, { N: n, r, p });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}
