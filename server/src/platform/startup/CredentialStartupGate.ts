import type { DatabasePort } from '../../platform/database/DatabasePort.js';
import { CredentialCipher } from '../../modules/ai-runtime/CredentialCipher.js';
import {
  createCredentialCipher,
  loadCredentialCipher,
} from '../../modules/ai-runtime/CredentialKeyStore.js';

export interface CredentialStartupGateResult {
  cipher: CredentialCipher;
  /** 本次启动是否创建了新的 key 文件（仅 zero-ciphertext 过渡代理会创建）。 */
  createdKey: boolean;
}

/** 稳定、coarse、不携带密文/API key/base URL 的启动凭证错误。 */
export class CredentialStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialStartupError';
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

/**
 * 启动 credential fail-closed 门。必须在当前基础 migration 之后、listener 之前运行。
 *
 * 固定算法：
 * 1. 查询 `platform_ai_provider_configs` 全部 `(campaign_id, encrypted_api_key)`，按 campaign_id 稳定排序。
 * 2. 有至少一行密文：只允许 load 既有 key；missing/非 regular/symlink/格式错误直接失败；
 *    使用该 key 解密每一行，任一 envelope 损坏或 wrong key 即失败；绝不写 key 文件、不改密文。
 * 3. 零密文：若 key 存在则 load（不轮换）；若 key 缺失则用 `wx` + 0600 创建。
 *    这是 012 前唯一可判定的 Phase 1 过渡代理，不宣称“显式 initialized”；
 *    Phase 2 enrollment/fingerprint 会替换此分支。
 */
export async function runCredentialStartupGate(options: {
  db: DatabasePort;
  keyPath: string;
}): Promise<CredentialStartupGateResult> {
  const rows = await options.db.query<{ campaign_id: string; encrypted_api_key: string }>(
    'SELECT campaign_id, encrypted_api_key FROM platform_ai_provider_configs ORDER BY campaign_id',
  );

  if (rows.length > 0) {
    let cipher: CredentialCipher;
    try {
      cipher = loadCredentialCipher({ keyPath: options.keyPath });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new CredentialStartupError(
          `启动凭证门失败：数据库已保存 Provider 凭证但本地密钥文件缺失（${options.keyPath}）。拒绝自动生成替代密钥。`,
        );
      }
      throw new CredentialStartupError(
        `启动凭证门失败：无法加载本地凭证密钥（${options.keyPath}）。拒绝自动覆盖。`,
      );
    }
    for (const row of rows) {
      try {
        cipher.decrypt(row.encrypted_api_key);
      } catch {
        // 只给 coarse reason；绝不含密文/API key/base URL。
        throw new CredentialStartupError(
          '启动凭证门失败：无法用本地密钥解密全部已保存的 AI Provider 凭证（密钥不匹配或密文损坏）。',
        );
      }
    }
    return { cipher, createdKey: false };
  }

  // 零密文：过渡性 load/create。
  try {
    return { cipher: loadCredentialCipher({ keyPath: options.keyPath }), createdKey: false };
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw new CredentialStartupError(
        `启动凭证门失败：本地凭证密钥存在但无法加载（${options.keyPath}）。拒绝自动覆盖。`,
      );
    }
  }
  try {
    return { cipher: createCredentialCipher({ keyPath: options.keyPath }), createdKey: true };
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      // 并发窗口内其它进程创建了 key：直接加载。
      try {
        return { cipher: loadCredentialCipher({ keyPath: options.keyPath }), createdKey: false };
      } catch (loadError) {
        throw new CredentialStartupError(
          `启动凭证门失败：并发创建的本地凭证密钥无法加载（${options.keyPath}）。`,
        );
      }
    }
    throw new CredentialStartupError(
      `启动凭证门失败：无法创建本地凭证密钥（${options.keyPath}）。`,
    );
  }
}
