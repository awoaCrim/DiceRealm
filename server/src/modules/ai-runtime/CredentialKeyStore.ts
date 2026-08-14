import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CredentialCipher } from './CredentialCipher.js';

const KEY_FILE_NAME = '.dnd-ai-credential-key';
const KEY_BYTES = 32;

export interface CredentialKeyStoreOptions {
  keyPath: string;
}

/** 密钥文件与数据库放在同一数据目录，路径无需用户配置。 */
export function credentialKeyPathForDatabase(databasePath: string): string {
  const absoluteDatabasePath = databasePath === ':memory:'
    ? resolve('dnd.sqlite')
    : resolve(databasePath);
  return resolve(dirname(absoluteDatabasePath), KEY_FILE_NAME);
}

/** 只加载既有本地凭证密钥；缺失时抛出底层 ENOENT（由调用方决定策略）。 */
export function loadCredentialCipher(options: CredentialKeyStoreOptions): CredentialCipher {
  return readCredentialCipher(options.keyPath);
}

/** key 文件是否存在（普通文件或 symlink 均计为存在；由 read 做拒绝）。 */
export function credentialKeyFileExists(keyPath: string): boolean {
  return existsSync(keyPath);
}

/**
 * 使用安全随机数创建权限受限的密钥文件，并做 durable atomic publish：
 * same-dir temp + 0600 + file fsync → atomic rename → POSIX dir fsync
 * （Windows dir fsync best-effort，沿用 Phase 1 跨平台风格）。
 * 文件已存在时返回 EEXIST 错误（调用方必须显式决定创建语义）。
 */
export function createCredentialCipher(options: CredentialKeyStoreOptions): CredentialCipher {
  const cipher = CredentialCipher.generate();
  publishCredentialCipher({ cipher, keyPath: options.keyPath });
  return cipher;
}

/**
 * 把既有 candidate cipher 做 durable atomic publish（enrollment Phase B 使用，
 * 保证落盘 key 与 initializing 行记录的 fingerprint 一致）。
 */
export function publishCredentialCipher(options: { cipher: CredentialCipher; keyPath: string }): void {
  const serializedKey = options.cipher.serialized();
  const keyPath = options.keyPath;
  const parent = dirname(keyPath);
  // The temporary file must be on the same filesystem as the destination:
  // Windows commonly places %TEMP% on C: while the repository/database may
  // live on another drive, and cross-device rename is not atomic (EXDEV).
  const tempDir = mkdtempSync(join(parent, '.dnd-key-'));
  const tempPath = join(tempDir, KEY_FILE_NAME);
  try {
    writeFileSync(tempPath, `${serializedKey}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tempPath, 0o600);
    const fd = openSync(tempPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // 目标已存在：清理 temp 后抛 EEXIST（原子窗口内竞争同样处理）。
      if (existsSync(keyPath)) {
        throw Object.assign(new Error(`目标密钥文件已存在：${keyPath}`), { code: 'EEXIST' });
      }
      renameSync(tempPath, keyPath);
    } catch (error) {
      if (existsSync(keyPath)) {
        throw Object.assign(new Error(`目标密钥文件已存在：${keyPath}`), { code: 'EEXIST' });
      }
      throw error;
    }
    fsyncDirectory(parent);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  enforcePrivatePermissions(keyPath);
}

function readCredentialCipher(keyPath: string): CredentialCipher {
  const stats = lstatSync(keyPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`本地凭证密钥路径不是普通文件：${keyPath}`);
  }
  enforcePrivatePermissions(keyPath);
  const serializedKey = readFileSync(keyPath, 'utf8').trim();
  try {
    return CredentialCipher.fromSerializedKey(serializedKey);
  } catch {
    throw new Error(`本地凭证密钥文件无效，拒绝自动覆盖：${keyPath}`);
  }
}

function fsyncDirectory(directoryPath: string): void {
  try {
    const fd = openSync(directoryPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Windows 不提供完整目录 fsync 语义；Unix 上失败则必须报错，否则 key 的 durability 不可保证。
    if (process.platform !== 'win32') {
      throw new Error(`无法 fsync 密钥目录：${directoryPath}`);
    }
  }
}

function enforcePrivatePermissions(keyPath: string): void {
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Windows 不提供完整 POSIX mode 语义；Unix 上则必须成功收紧权限。
    if (process.platform !== 'win32') {
      throw new Error(`无法收紧本地凭证密钥文件权限：${keyPath}`);
    }
  }
}
