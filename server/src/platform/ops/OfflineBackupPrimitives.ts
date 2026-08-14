import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCredentialCipher } from '../../modules/ai-runtime/CredentialKeyStore.js';
import { canonicalAbsolutePath } from './platformPaths.js';

/** 稳定、coarse、不含敏感数据的 backup 错误。 */
export class SensitiveBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SensitiveBackupError';
  }
}

export interface SnapshotFileEntry {
  name: string;
  size: number;
  sha256: string;
}

export interface SensitiveSnapshotManifest {
  format: 'dnd-sensitive-snapshot-v1';
  sensitive: true;
  databaseId: string;
  keyFingerprint: string;
  createdAt: string;
  migrations: string[];
  files: SnapshotFileEntry[];
}

const KEY_COPY_NAME = '.dnd-ai-credential-key';
const MANIFEST_NAME = 'snapshot.manifest.json';

function sha256File(path: string): { sha256: string; size: number } {
  const content = readFileSync(path);
  return { sha256: createHash('sha256').update(content).digest('hex'), size: content.length };
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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
    // Windows 目录 fsync best-effort（沿用 CredentialKeyStore 跨平台风格）；POSIX 必须成功。
    if (process.platform !== 'win32') {
      throw new SensitiveBackupError(`无法 fsync 备份目录：${directoryPath}`);
    }
  }
}

export function parseSnapshotManifest(json: string): SensitiveSnapshotManifest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SensitiveBackupError('snapshot.manifest.json 不是合法 JSON。');
  }
  if (
    value === null || typeof value !== 'object'
    || (value as Record<string, unknown>).format !== 'dnd-sensitive-snapshot-v1'
    || (value as Record<string, unknown>).sensitive !== true
    || typeof (value as Record<string, unknown>).databaseId !== 'string'
    || typeof (value as Record<string, unknown>).keyFingerprint !== 'string'
    || !Array.isArray((value as Record<string, unknown>).migrations)
    || !Array.isArray((value as Record<string, unknown>).files)
  ) {
    throw new SensitiveBackupError('snapshot.manifest.json 格式无效。');
  }
  return value as unknown as SensitiveSnapshotManifest;
}

function migrationNamesOf(databasePath: string): string[] {
  const db = new Database(databasePath, { readonly: true });
  try {
    const rows = db.prepare('SELECT name FROM platform_migrations ORDER BY version').all() as Array<{ name: string }>;
    if (rows.length === 0) {
      throw new SensitiveBackupError('备份数据库没有 platform_migrations 记录。');
    }
    return rows.map((row) => row.name);
  } finally {
    db.close();
  }
}

/**
 * 创建 sensitive snapshot：better-sqlite3 官方 backup() API（sqlite3_backup）生成一致 DB 副本 +
 * 同一 credential key 副本 + manifest（databaseId/keyFingerprint/migration list/
 * per-file size/SHA-256）。temp 新建；final 目录已存在（非空）一律拒绝静默覆盖。
 *
 * 生命周期契约（decisions.md §10.2）：async 函数内 `await source.backup(dbCopyPath)` 完成前
 * 源连接保持打开，close 只发生在 finally（await 之后）；备份完成后才规范化归档 journal mode，
 * 并对 temp 实际副本全量复验通过后才原子 rename 发布。
 */
export async function createSensitiveSnapshot(options: {
  databasePath: string;
  keyPath: string;
  targetDirectory: string;
  databaseId: string;
  keyFingerprint: string;
}): Promise<{ manifest: SensitiveSnapshotManifest; targetDirectory: string }> {
  const databasePath = canonicalAbsolutePath(options.databasePath);
  const keyPath = canonicalAbsolutePath(options.keyPath);
  const target = canonicalAbsolutePath(options.targetDirectory);

  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new SensitiveBackupError(`备份目标目录已存在且非空：${target}。拒绝静默覆盖。`);
  }

  // temp 与 final 必须同 parent filesystem（rename 原子性要求）；parent 必须先存在（mkdtemp 依赖）。
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const tempDir = mkdtempSync(join(parent, `.dnd-backup-tmp-`));
  let source: Database.Database | null = null;
  try {
    // 1) 一致 DB 副本：SQLite 官方 backup API（better-sqlite3 `backup()`，sqlite3_backup），
    //    符合 decisions.md §10.2（备份固定使用官方 backup API；禁止裸复制活动单文件）。
    //    源连接可写打开：enrollment 后的源是 WAL 模式，readonly 打开会在源目录留下
    //    -shm/-wal sidecar（实测 close 不清理），可写打开+close 会正确 checkpoint 并移除；
    //    cutover 持有 InstanceLock，无并发写者。
    //    生命周期契约：`await source.backup(dbCopyPath)` 完成前 source 保持打开；close
    //    只发生在 finally（await 之后）。曾因同步包装 + 未 await 的 floating promise +
    //    提前 close source + 提前发布 → “promise resolve 但目标未落盘”+ 迟发
    //    “connection is not open”（本机 ledger root-cause，serialize() 替代已撤销）。
    source = new Database(databasePath);
    const dbCopyPath = join(tempDir, 'database.sqlite');
    await source.backup(dbCopyPath);

    // 规范化归档副本 journal mode（backup 完成后才进行）：WAL 源备份副本的 header
    // 保留 WAL 格式字节，归档副本不应携带 -wal/-shm sidecar；DELETE 源无需规范化。
    const sourceJournalMode = source.pragma('journal_mode', { simple: true }) as string;
    if (sourceJournalMode !== 'delete') {
      const normalize = new Database(dbCopyPath);
      try {
        normalize.pragma('journal_mode = DELETE');
      } finally {
        normalize.close();
      }
    }
    fsyncFile(dbCopyPath);

    // 2) credential key 副本。
    const keyStats = lstatSync(keyPath);
    if (!keyStats.isFile() || keyStats.isSymbolicLink()) {
      throw new SensitiveBackupError('credential key 路径不是普通文件。');
    }
    cpSync(keyPath, join(tempDir, KEY_COPY_NAME));
    chmodSync(join(tempDir, KEY_COPY_NAME), 0o600);

    // 3) manifest。
    const files = readdirSync(tempDir)
      .filter((name) => name !== MANIFEST_NAME)
      .sort()
      .map((name) => {
        const hash = sha256File(join(tempDir, name));
        return { name, size: hash.size, sha256: hash.sha256 };
      });
    const manifest: SensitiveSnapshotManifest = {
      format: 'dnd-sensitive-snapshot-v1',
      sensitive: true,
      databaseId: options.databaseId,
      keyFingerprint: options.keyFingerprint,
      createdAt: new Date().toISOString(),
      migrations: migrationNamesOf(dbCopyPath),
      files,
    };
    writeFileSync(join(tempDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    files.forEach((file) => fsyncFile(join(tempDir, file.name)));
    fsyncFile(join(tempDir, MANIFEST_NAME));

    // 4) 发布前复验（decisions.md §10.2：发布前必须用实际备份副本完成完整性/迁移/
    //    密钥解密复验）：对 temp 实际副本做全量 verify（integrity/fk/migrations/
    //    逐文件 hash/key decrypt-all），通过后才原子发布；失败则 finally 清理 temp，
    //    target 不被创建。coordinator 的 verify-and-reuse 行为保持不变。
    verifySensitiveSnapshot({
      snapshotDir: tempDir,
      databaseId: options.databaseId,
      keyFingerprint: options.keyFingerprint,
    });

    // 5) 原子发布：temp 目录 rename 到 final；POSIX 要求 parent dir fsync（parent 已在此函数开头确保存在）。
    renameSync(tempDir, target);
    fsyncDirectory(parent);
    return { manifest, targetDirectory: target };
  } finally {
    // close 只发生在 finally，且一定在 `await source.backup()` 完成之后（成功或失败都一样）。
    if (source !== null) {
      source.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * 完整复验已发布的 sensitive snapshot：
 * - manifest 存在、databaseId/keyFingerprint/migrations 匹配；
 * - 每个文件 name/size/SHA-256 与 manifest 一致；
 * - 备份 DB integrity_check + foreign_key_check + migration inventory；
 * - 备份内 key 能解密全部 provider ciphertext。
 */
export function verifySensitiveSnapshot(options: {
  snapshotDir: string;
  databaseId: string;
  keyFingerprint: string;
}): { manifest: SensitiveSnapshotManifest } {
  const snapshotDir = canonicalAbsolutePath(options.snapshotDir);
  const manifestPath = join(snapshotDir, MANIFEST_NAME);
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new SensitiveBackupError(`snapshot 缺少 manifest：${manifestPath}`);
  }
  const manifest = parseSnapshotManifest(raw);

  if (manifest.sensitive !== true) {
    throw new SensitiveBackupError('snapshot 未标记 sensitive，拒绝作为敏感备份使用。');
  }
  if (manifest.databaseId !== options.databaseId) {
    throw new SensitiveBackupError('snapshot databaseId 与期望不一致。');
  }
  if (manifest.keyFingerprint !== options.keyFingerprint) {
    throw new SensitiveBackupError('snapshot keyFingerprint 与期望不一致。');
  }

  // 逐文件 hash/size 校验。
  const actualNames = readdirSync(snapshotDir).sort();
  const manifestNames = manifest.files.map((file) => file.name).sort();
  const expectedNames = [MANIFEST_NAME, ...manifestNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new SensitiveBackupError(`snapshot 目录与 manifest 文件集合不一致：actual=${JSON.stringify(actualNames)} expected=${JSON.stringify(expectedNames)}`);
  }
  for (const entry of manifest.files) {
    const hash = sha256File(join(snapshotDir, entry.name));
    if (hash.sha256 !== entry.sha256 || hash.size !== entry.size) {
      throw new SensitiveBackupError(`snapshot 文件与 manifest hash/size 不一致：${entry.name}`);
    }
  }

  // DB 完整性与迁移 inventory。
  const dbCopyPath = join(snapshotDir, 'database.sqlite');
  const db = new Database(dbCopyPath, { readonly: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') {
      throw new SensitiveBackupError('snapshot DB integrity_check 失败。');
    }
    const fk = db.pragma('foreign_key_check') as unknown[];
    if (fk.length > 0) {
      throw new SensitiveBackupError('snapshot DB foreign_key_check 失败。');
    }
    const migrations = db.prepare('SELECT name FROM platform_migrations ORDER BY version').all() as Array<{ name: string }>;
    if (JSON.stringify(migrations.map((row) => row.name)) !== JSON.stringify(manifest.migrations)) {
      throw new SensitiveBackupError('snapshot DB migration inventory 与 manifest 不一致。');
    }
    // key 副本 decrypt-all。
    const cipher = loadCredentialCipher({ keyPath: join(snapshotDir, KEY_COPY_NAME) });
    if (cipher.fingerprint() !== options.keyFingerprint) {
      throw new SensitiveBackupError('snapshot key 副本指纹与期望不一致。');
    }
    const ciphertext = db.prepare(
      'SELECT campaign_id, encrypted_api_key FROM platform_ai_provider_configs ORDER BY campaign_id',
    ).all() as Array<{ campaign_id: string; encrypted_api_key: string }>;
    for (const row of ciphertext) {
      try {
        cipher.decrypt(row.encrypted_api_key);
      } catch {
        throw new SensitiveBackupError('snapshot key 无法解密全部 provider ciphertext。');
      }
    }
  } finally {
    db.close();
  }
  return { manifest };
}

/** 从 snapshot DB 读取 legacy sessions.id 集合（pre-cutover 原始 token 全量）。 */
export function readLegacySessionTokensFromSnapshot(snapshotDir: string): string[] {
  const snapshotDirResolved = canonicalAbsolutePath(snapshotDir);
  const db = new Database(join(snapshotDirResolved, 'database.sqlite'), { readonly: true });
  try {
    const rows = db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  } finally {
    db.close();
  }
}
