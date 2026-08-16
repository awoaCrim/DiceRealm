import type { DatabasePort } from '../database/DatabasePort.js';
import { CredentialCipher } from '../../modules/ai-runtime/CredentialCipher.js';
import { loadCredentialCipher } from '../../modules/ai-runtime/CredentialKeyStore.js';
import { PlatformInstanceStore, type PlatformInstanceRow } from '../../platform/ops/PlatformInstanceStore.js';

/** 稳定、coarse、不携带密文/API key/base URL 的启动安全门错误。 */
export class StartupSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupSecurityError';
  }
}

export interface StartupSecurityGateResult {
  cipher: CredentialCipher;
  instance: PlatformInstanceRow;
}

/**
 * 普通 server 启动安全门（Phase 2）。
 *
 * 在 manifest verify 与 DB open 之后、app 组合之前运行。普通 startup 永不：
 * 创建 DB、创建 key、插 singleton、从 pending/cleaning 变 ready、删除旧 session、
 * 执行 sensitive backup、执行未批准的 pending migration。
 *
 * 固定检查：
 * 1. applied migration 必须精确等于当前 Phase 批准集合；001-010 → 提示 enrollment；
 *    001-010 + 012 → 提示 security-cutover；完整集合但 pending/cleaning → 拒绝。
 * 2. platform_instance 必须存在且 enrollment_state=ready。
 * 3. 本地 key 指纹必须等于 singleton 记录的 credential_key_fingerprint。
 * 4. 全部 Provider ciphertext 必须用该 key 逐行解密成功。
 * 5. session_security_state 必须为 ready 且 session_security_cutover_at 非空。
 */
export async function runStartupSecurityGate(options: {
  db: DatabasePort;
  keyPath: string;
  /** 当前维护基线批准的全部迁移文件名。 */
  approvedMigrationFilenames: string[];
}): Promise<StartupSecurityGateResult> {
  const { db, keyPath, approvedMigrationFilenames } = options;

  const applied = await appliedMigrationVersions(db);
  const expectedVersions = approvedMigrationFilenames.map((name) => name.slice(0, 3)).sort();
  const appliedSet = new Set(applied);

  if (applied.length === 0) {
    throw new StartupSecurityError('数据库没有任何已应用迁移：请先运行 platform enroll / platform init。');
  }

  // 已应用集合的分流诊断必须按 membership 判断，不能只看数量：
  // 应用集合不完整或含未批准迁移时，绝不能得到 security-cutover 提示。
  const phaseVersions = expectedVersions;
  const baseVersions = phaseVersions.filter((version) => Number(version) < 12);
  const hasFullBase = baseVersions.every((version) => appliedSet.has(version));
  const hasForeign = applied.some((version) => !phaseVersions.includes(version));
  const enrolledVersionCount = baseVersions.length + 1;
  if (applied.length < enrolledVersionCount) {
    if (!hasFullBase || hasForeign) {
      throw new StartupSecurityError(`已应用迁移集合异常（${applied.length} 个）：缺少完整 Phase 1 基线。普通启动不执行未批准的迁移。`);
    }
    throw new StartupSecurityError('数据库尚未 enrollment：请先运行 platform enroll。');
  }
  if (applied.length === enrolledVersionCount) {
    if (hasFullBase && appliedSet.has('012')) {
      throw new StartupSecurityError('数据库已 enrollment 但尚未完成 session security cutover：请先运行 platform security-cutover。');
    }
    throw new StartupSecurityError(`已应用迁移集合异常：${enrolledVersionCount} 个已应用迁移但并非精确基线 + 012。普通启动不执行未批准的迁移。`);
  }
  if (!expectedVersions.every((version) => appliedSet.has(version)) || appliedSet.size !== expectedVersions.length) {
    throw new StartupSecurityError('已应用迁移与当前 Phase 批准集合不一致：普通启动不执行未批准的迁移。');
  }

  const store = new PlatformInstanceStore();
  const instance = await store.read(db);
  if (instance === null) {
    throw new StartupSecurityError('数据库缺少 platform_instance 行：请先运行 platform enroll。');
  }
  if (instance.enrollment_state !== 'ready') {
    throw new StartupSecurityError('enrollment 未完成：当前状态不是 ready。');
  }

  let cipher: CredentialCipher;
  try {
    cipher = loadCredentialCipher({ keyPath });
  } catch (error) {
    throw new StartupSecurityError(
      `启动凭证门失败：无法加载本地凭证密钥（${keyPath}）。拒绝自动生成替代密钥。`,
    );
  }
  if (cipher.fingerprint() !== instance.credential_key_fingerprint) {
    throw new StartupSecurityError('启动凭证门失败：本地凭证密钥指纹与 enrollment 记录不匹配。');
  }

  const ciphertext = await db.query<{ campaign_id: string; encrypted_api_key: string }>(
    'SELECT campaign_id, encrypted_api_key FROM platform_ai_provider_configs ORDER BY campaign_id',
  );
  for (const row of ciphertext) {
    try {
      cipher.decrypt(row.encrypted_api_key);
    } catch {
      throw new StartupSecurityError(
        '启动凭证门失败：无法用本地密钥解密全部已保存的 AI Provider 凭证（密钥不匹配或密文损坏）。',
      );
    }
  }

  if (instance.session_security_state !== 'ready' || instance.session_security_cutover_at === null) {
    throw new StartupSecurityError('session security 尚未 ready：请先运行 platform security-cutover。');
  }

  return { cipher, instance };
}

async function appliedMigrationVersions(db: DatabasePort): Promise<string[]> {
  try {
    const rows = await db.query<{ version: string }>('SELECT version FROM platform_migrations');
    return rows.map((row) => row.version).sort();
  } catch {
    return [];
  }
}
