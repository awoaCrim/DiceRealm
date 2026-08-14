import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabaseAdapter } from '../database/SqliteDatabaseAdapter.js';
import { createSqliteDatabase } from '../database/SqliteDatabaseAdapter.js';
import { loadMigrationFile } from '../database/migrations/MigrationRunner.js';
import { acquireInstanceLock } from './InstanceLock.js';
import { verifyMigrationManifest } from './migrationManifest.js';
import { PlatformInstanceStore, type PlatformInstanceRow } from './PlatformInstanceStore.js';
import { assertExistingRegularFileNotSymlink, canonicalAbsolutePath } from './platformPaths.js';
import { loadCredentialCipher } from '../../modules/ai-runtime/CredentialKeyStore.js';
import {
  createSensitiveSnapshot,
  readLegacySessionTokensFromSnapshot,
  verifySensitiveSnapshot,
  SensitiveBackupError,
} from './OfflineBackupPrimitives.js';
import { SecurityAuditWriter } from '../../modules/security-audit/SecurityAuditWriter.js';

/** 稳定、coarse、不含敏感数据的 cutover 错误。 */
export class SecurityCutoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityCutoverError';
  }
}

/**
 * security-cutover hash-bound allowlist：只接受 committed 012/013/014 三个
 * filename/hash。不接受 015+；012 由 enrollment 预先应用，实际 pending apply 只可为 013/014。
 */
export const SECURITY_CUTOVER_ALLOWLIST: ReadonlyArray<{ name: string; sha256: string }> = [
  { name: '012_platform_foundation.sql', sha256: '3dab3ce75d06ef68f80cb6ebb5e78fb00cdf06d176ddfac544c27669ce6168e6' },
  { name: '013_secure_sessions.sql', sha256: 'f9fdabf1a41f00502896f004162b9ec4dcfce8ee33ac5b73541bdd09e0bb68f6' },
  { name: '014_security_audit.sql', sha256: 'f86b8d86853bbd9f61ced3416f971634393f738fea8a19fff7db245bcff2c7b8' },
];

export interface SecurityCutoverResult {
  sessionSecurityState: 'pending' | 'cleaning' | 'ready';
  backupVerified: boolean;
  oldSessionCount: number;
  appliedMigrations: string[];
  messages: string[];
}

export interface SecurityCutoverOptions {
  databasePath: string;
  keyPath: string;
  backupTargetDir: string;
  migrationsDir: string;
  manifestPath: string;
  now?: () => string;
  openDatabase?: (path: string) => SqliteDatabaseAdapter;
}

const SESSION_CUTOVER_AUDIT_TYPE = 'security.cutover' as const;

/** 计算 committed 文件 normalized-LF SHA-256（与 manifest 同一算法）。 */
function normalizedSha256(text: string): string {
  const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('sha256').update(norm, 'utf8').digest('hex');
}

export async function runSecurityCutover(options: SecurityCutoverOptions): Promise<SecurityCutoverResult> {
  const databasePath = canonicalAbsolutePath(options.databasePath);
  const keyPath = canonicalAbsolutePath(options.keyPath);
  const backupTarget = canonicalAbsolutePath(options.backupTargetDir);
  const now = options.now ?? (() => new Date().toISOString());
  const openDatabase = options.openDatabase ?? ((path: string) => createSqliteDatabase(path));
  const store = new PlatformInstanceStore();

  assertExistingRegularFileNotSymlink(databasePath);
  const lock = acquireInstanceLock({ databasePath, purpose: 'cli' });
  let database: SqliteDatabaseAdapter | null = null;
  try {
    verifyMigrationManifest({ migrationsDir: options.migrationsDir, manifestPath: options.manifestPath });

    database = openDatabase(databasePath);
    const applied = await appliedVersions(database);
    const hasFoundation = applied.includes('012');
    const instance = hasFoundation ? await store.read(database) : null;
    if (instance === null) {
      throw new SecurityCutoverError('数据库未 enrollment：请先运行 platform enroll。');
    }
    if (instance.enrollment_state !== 'ready') {
      throw new SecurityCutoverError('enrollment 未完成：当前状态不是 ready。');
    }
    // key fingerprint + decrypt-all。
    const cipher = loadCredentialCipher({ keyPath });
    if (cipher.fingerprint() !== instance.credential_key_fingerprint) {
      throw new SecurityCutoverError('本地凭证密钥指纹与 enrollment 记录不匹配。');
    }
    const ciphertext = await database.query<{ encrypted_api_key: string }>(
      'SELECT encrypted_api_key FROM platform_ai_provider_configs ORDER BY campaign_id',
    );
    for (const row of ciphertext) {
      try {
        cipher.decrypt(row.encrypted_api_key);
      } catch {
        throw new SecurityCutoverError('无法用本地密钥解密全部 provider ciphertext。');
      }
    }

    if (instance.session_security_state === 'ready') {
      return {
        sessionSecurityState: 'ready',
        backupVerified: false,
        oldSessionCount: 0,
        appliedMigrations: [],
        messages: ['session security 已 ready，无需 cutover'],
      };
    }

    const has013 = applied.includes('013');
    const has014 = applied.includes('014');

    // ---- 1) backup（pending/partial 可新建或复用已验证 backup；cleaning 必须复用，缺失即 fail closed）----
    const backupDirectory = await ensureVerifiedBackup({
      backupTarget,
      databasePath,
      keyPath,
      databaseId: instance.database_id,
      keyFingerprint: instance.credential_key_fingerprint,
      migrationsDir: options.migrationsDir,
      sessionSecurityState: instance.session_security_state,
    });

    // ---- 2) 只按 allowlist 应用 pending 的 013/014 ----
    const appliedMigrations: string[] = [];
    for (const entry of SECURITY_CUTOVER_ALLOWLIST) {
      if (entry.name === '012_platform_foundation.sql') continue; // enrollment 已应用
      if (applied.includes(entry.name.slice(0, 3))) continue;
      const sql = readFileSync(join(options.migrationsDir, entry.name), 'utf8');
      if (normalizedSha256(sql) !== entry.sha256) {
        throw new SecurityCutoverError(`cutover allowlist hash 与 committed 文件不一致：${entry.name}`);
      }
      await database.applyMigration(loadMigrationFile(options.migrationsDir, entry.name), now());
      appliedMigrations.push(entry.name);
    }

    // ---- 3) logical cutover（cleaning 时不得重做）----
    let oldTokens: string[] = [];
    if (instance.session_security_state === 'pending') {
      oldTokens = readLegacySessionTokensFromSnapshot(backupDirectory);
      await database.transaction(async (tx) => {
        const oldSessions = await tx.query<{ id: string }>('SELECT id FROM sessions');
        // 精确比较完整 ID 集合（内容而非仅数量）：live 与 pre-cutover backup 必须逐 id 一致。
        const liveIds = oldSessions.map((row) => row.id).sort();
        const backupIds = [...oldTokens].sort();
        if (liveIds.length !== backupIds.length || liveIds.some((id, index) => id !== backupIds[index])) {
          throw new SecurityCutoverError('live DB 与 pre-cutover backup 的 session 集合不一致。');
        }
        await tx.execute('DELETE FROM sessions');
        const writer = new SecurityAuditWriter();
        await writer.writeIn(tx, {
          type: SESSION_CUTOVER_AUDIT_TYPE,
          outcome: 'success',
          metadata: { backupVerified: true },
        });
        await store.beginSessionCleaning(tx, now());
      });
    } else if (instance.session_security_state === 'cleaning') {
      if (!has013 || !has014 || instance.session_security_cutover_at === null) {
        throw new SecurityCutoverError('cleaning 状态但 013/014 未齐备或缺少 cutover 时间戳：状态矛盾，需要人工诊断。');
      }
      // 不重新 backup、不重新删 session、不重写 logical audit；从 verified backup 恢复 old-token 集合。
      oldTokens = readLegacySessionTokensFromSnapshot(backupDirectory);
    } else {
      throw new SecurityCutoverError(`未知 session_security_state：${instance.session_security_state}`);
    }

    // ---- 4) 物理清理（idempotent）----
    const raw = (database as SqliteDatabaseAdapter).raw;
    raw.pragma('secure_delete = ON');
    raw.pragma('wal_checkpoint(TRUNCATE)');
    raw.exec('VACUUM');
    raw.pragma('wal_checkpoint(TRUNCATE)');

    // ---- 5) byte scan + auth/integrity verification ----
    verifyNoOldTokens(databasePath, oldTokens);
    const dbCopy = openDatabase(databasePath);
    try {
      for (const oldToken of oldTokens) {
        const legacy = await dbCopy.query<{ id: string }>('SELECT id FROM sessions WHERE id = ?', [oldToken]);
        const digest = createHash('sha256').update(oldToken, 'utf8').digest('hex');
        const secure = await dbCopy.query<{ token_digest: string }>(
          'SELECT token_digest FROM sessions WHERE token_digest = ?', [digest],
        );
        if (legacy.length > 0 || secure.length > 0) {
          throw new SecurityCutoverError('旧 token 仍可认证：cutover 验证失败。');
        }
      }
      const integrity = await dbCopy.query<{ integrity_check: string }>('SELECT * FROM pragma_integrity_check');
      if (integrity.length === 0 || integrity.some((row) => row.integrity_check !== 'ok')) {
        throw new SecurityCutoverError('cutover 后 DB integrity_check 失败。');
      }
      const fk = await dbCopy.query('SELECT * FROM pragma_foreign_key_check');
      if (fk.length > 0) {
        throw new SecurityCutoverError('cutover 后 DB foreign_key_check 失败。');
      }
    } finally {
      await dbCopy.close();
    }

    // ---- 6) cleaning -> ready ----
    await database.transaction(async (tx) => {
      await store.markSessionSecurityReady(tx, now());
    });

    return {
      sessionSecurityState: 'ready',
      backupVerified: true,
      oldSessionCount: oldTokens.length,
      appliedMigrations,
      messages: ['session security cutover 完成'],
    };
  } finally {
    if (database !== null) {
      await database.close();
    }
    lock.release();
  }
}

async function ensureVerifiedBackup(options: {
  backupTarget: string;
  databasePath: string;
  keyPath: string;
  databaseId: string;
  keyFingerprint: string;
  migrationsDir: string;
  sessionSecurityState: PlatformInstanceRow['session_security_state'];
}): Promise<string> {
  const { backupTarget, databaseId, keyFingerprint, sessionSecurityState } = options;
  const manifestPath = join(backupTarget, 'snapshot.manifest.json');
  if (sessionSecurityState === 'cleaning') {
    // M2：cleaning 状态必须复用原始 verified pre-cutover backup（保留旧 token 集合与
    // durable 证据）。backup 缺失/不匹配一律 fail closed；绝不从已删 session 的 live DB 重建快照。
    if (!existsSync(manifestPath)) {
      throw new SecurityCutoverError(
        'cleaning 状态但 pre-cutover sensitive backup 缺失：拒绝从已删 session 的 live DB 重建备份。请人工诊断并恢复原始备份后重试。',
      );
    }
    verifySensitiveSnapshot({ snapshotDir: backupTarget, databaseId, keyFingerprint });
    return backupTarget;
  }
  if (!existsSync(manifestPath)) {
    // pending/partial：空/不存在 target → 创建完整 backup（失败即停止，013 不得应用）。
    // createSensitiveSnapshot 已改为 async：官方 backup() API await 完成后才原子发布。
    const created = await createSensitiveSnapshot({
      databasePath: options.databasePath,
      keyPath: options.keyPath,
      targetDirectory: backupTarget,
      databaseId,
      keyFingerprint,
    });
    return created.targetDirectory;
  }
  // 已发布 backup：完整复验后复用，绝不覆盖。
  verifySensitiveSnapshot({ snapshotDir: backupTarget, databaseId, keyFingerprint });
  return backupTarget;
}

async function appliedVersions(database: SqliteDatabaseAdapter): Promise<string[]> {
  const rows = await database.query<{ version: string }>('SELECT version FROM platform_migrations');
  return rows.map((row) => row.version).sort();
}

/** 字节级扫描 DB/WAL/SHM，验证全部 old tokens 不存在；命中一律 fail closed。 */
function verifyNoOldTokens(databasePath: string, oldTokens: string[]): void {
  const paths = [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ];
  const needles = oldTokens.map((token) => Buffer.from(token, 'utf8'));
  for (const filePath of paths) {
    let content: Buffer;
    try {
      content = readFileSync(filePath);
    } catch {
      continue; // WAL/SHM 可能不存在。
    }
    for (let i = 0; i < needles.length; i += 1) {
      if (content.includes(needles[i])) {
        throw new SecurityCutoverError(
          `byte scan 命中旧 token（${filePath}，token 序号 ${i}）：fail closed，需要 operator 诊断。`,
        );
      }
    }
  }
}
