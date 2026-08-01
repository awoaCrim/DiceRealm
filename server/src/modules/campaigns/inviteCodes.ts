import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 邀请码模块：生成高熵随机邀请码，库中只保存 SHA-256 摘要。
 * 邀请码永不落库，也不出现在任何列表/详情 DTO 中；join 通过
 * timing-safe 比较摘要完成校验。
 */

const INVITE_CODE_BYTES = 16; // 128 bit

/** 生成随机邀请码（128 bit，base64url 编码，约 22 字符）。 */
export function generateInviteCode(): string {
  return randomBytes(INVITE_CODE_BYTES).toString('base64url');
}

/** 仅保存邀请码的 SHA-256 摘要（hex）。 */
export function hashInviteCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * 安全比较邀请码与存储摘要。旧战役（摘要为空）视为无邀请码，拒绝加入；
 * 摘要格式非法或长度不匹配时返回 false，不抛异常避免信息泄露。
 */
export function verifyInviteCode(code: unknown, storedHash: string | null | undefined): boolean {
  if (typeof code !== 'string' || !code.trim() || !storedHash) {
    return false;
  }
  const candidate = Buffer.from(hashInviteCode(code.trim()), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  if (candidate.length === 0 || candidate.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(candidate, expected);
}
