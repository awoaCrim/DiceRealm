import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import type { DatabasePort } from '../database/DatabasePort.js';
import { createSqliteDatabase, type SqliteDatabaseAdapter } from '../database/SqliteDatabaseAdapter.js';
import { loadMigrationFile, TRACKING_TABLE_DDL } from '../database/migrations/MigrationRunner.js';
import { acquireInstanceLock } from './InstanceLock.js';
import { verifyMigrationManifest } from './migrationManifest.js';
import { PHASE2_APPROVED_MIGRATION_FILENAMES } from './approvedMigrations.js';
import {
  credentialKeyFileExists,
  loadCredentialCipher,
  publishCredentialCipher,
} from '../../modules/ai-runtime/CredentialKeyStore.js';
import { CredentialCipher } from '../../modules/ai-runtime/CredentialCipher.js';import {
  PlatformInstanceStore,
  type EnrollmentKeyOrigin,
  type PlatformInstanceRow,
} from './PlatformInstanceStore.js';
import { assertExistingRegularFileNotSymlink, assertPathAbsent, canonicalAbsolutePath } from './platformPaths.js';

export type EnrollmentCommand = 'init' | 'enroll' | 'resume' | 'rollback' | 'status';

/** 稳定、coarse、不含敏感数据的 enrollment 错误。 */
export class EnrollmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrollmentError';
  }
}

export interface EnrollmentResult {
  command: EnrollmentCommand;
  databaseId: string;
  keyFingerprint: string;
  enrollmentState: 'initializing' | 'ready';
  keyOrigin: EnrollmentKeyOrigin;
  createdKey: boolean;
  sessionSecurityState: PlatformInstanceRow['session_security_state'] | null;
  maintenanceState: PlatformInstanceRow['maintenance_state'] | null;
  messages: string[];
}

export interface EnrollmentCoordinatorOptions {
  command: EnrollmentCommand;
  /** 必须为绝对路径；相对路径 canonicalize。 */
  databasePath: string;
  keyPath: string;
  migrationsDir: string;
  manifestPath: string;
  /** 测试注入确定性时钟；缺省 new Date().toISOString()。 */
  now?: () => string;
  /** 测试注入确定性 database ID；缺省 randomUUID()。 */
  databaseId?: string;
  /** 测试注入 DB factory（生产 createSqliteDatabase；需暴露 applyMigration 供 enroll 单步应用 012）。 */
  openDatabase?: (path: string) => SqliteDatabaseAdapter;
}

/**
 * 离线 enrollment coordinator（Task 2：existing enroll/resume/rollback/status +
 * fresh-init 的 test-only 012 阶段 seam；公开 `platform init` 由 Task 4 组装 013/014 后启用）。
 *
 * 统一规则：绝对路径、拒绝 DB/key symlink、InstanceLock purpose='cli'、
 * manifest verify 在 DB open 前、coarse stderr、secret 不进入 argv/stdout。
 *
 * 两阶段（init/enroll 共用）：
 *   Phase A：tx 插入 initializing（durable enrollment_key_origin）
 *   Phase B：generated key 的 durable atomic publish（preexisting 为 no-op）
 *   Phase C：tx markEnrollmentReady（指纹匹配）
 *
 * crash 语义：A 后 crash → resume 需磁盘 key 指纹匹配；generated 且未发布则
 * 不能 resume，只能 rollback 后重试；preexisting 永不删除 key。
 */
export async function runEnrollmentCommand(options: EnrollmentCoordinatorOptions): Promise<EnrollmentResult> {
  const databasePath = canonicalAbsolutePath(options.databasePath);
  const keyPath = canonicalAbsolutePath(options.keyPath);
  const now = options.now ?? (() => new Date().toISOString());
  const openDatabase = options.openDatabase ?? ((path: string) => createSqliteDatabase(path));
  const store = new PlatformInstanceStore();

  const lock = acquireInstanceLock({ databasePath, purpose: 'cli' });
  let database: SqliteDatabaseAdapter | null = null;
  try {
    verifyMigrationManifest({ migrationsDir: options.migrationsDir, manifestPath: options.manifestPath });

    if (options.command === 'init') {
      assertPathAbsent(databasePath);
      assertPathAbsent(keyPath);
      database = openDatabase(databasePath);
      // init：只应用 literal 当前批准集合（frozen），
      // 不因 manifest 未来新增 015+ 而静默扩展（015+ 需未来显式 hash-bound allowlist）。
      await database.exec(TRACKING_TABLE_DDL);
      const freshApplied = await appliedMigrationVersions(database);
      for (const filename of PHASE2_APPROVED_MIGRATION_FILENAMES) {
        const version = filename.slice(0, 3);
        if (freshApplied.includes(version)) {
          continue;
        }
        await database.applyMigration(loadMigrationFile(options.migrationsDir, filename), now());
      }
    } else {
      assertExistingRegularFileNotSymlink(databasePath);
      database = openDatabase(databasePath);
    }

    const applied = await appliedMigrationVersions(database);
    // 只有 012（platform_instance 表）已应用才能读 singleton；否则视为未 enrollment。
    const hasFoundation = applied.includes('012');
    const instance = hasFoundation ? await store.read(database) : null;

    // ---- command-specific guards ----
    if (options.command === 'enroll') {
      const phase1Versions = PHASE2_APPROVED_MIGRATION_FILENAMES
        .map((filename) => filename.slice(0, 3))
        .filter((version) => Number(version) < 12);
      // M1 crash 窗口：012 已应用但无 platform_instance 行 → 允许以 fresh enrollment 安全恢复（跳过 012 重放）。
      const crashWindowVersions = [...phase1Versions, '012'];
      if (!isAppliedSet(applied, phase1Versions) && !isAppliedSet(applied, crashWindowVersions)) {
        throw new EnrollmentError('enroll 只接受精确应用当前 Phase 1 基线或 crash 窗口（基线 + 012）的 existing 数据库。');
      }
      if (instance !== null) {
        throw new EnrollmentError('数据库已存在 platform_instance 行，请使用 enroll-resume / enroll-rollback / status。');
      }
    } else if (options.command === 'status') {
      if (instance === null) {
        throw new EnrollmentError('数据库尚未 enrollment：请先运行 platform enroll。');
      }
      return buildResult('status', instance, { createdKey: false, messages: ['status ok'] });
    } else if (options.command === 'rollback') {
      if (instance === null || instance.enrollment_state !== 'initializing') {
        throw new EnrollmentError('rollback 只清除 initializing 状态的行；当前行不存在或已 ready。');
      }
    } else if (options.command === 'resume') {
      if (instance === null) {
        throw new EnrollmentError('没有可 resume 的 initializing 行：请先运行 platform enroll。');
      }
    }
    // init：fresh DB，允许任何 applied set == 全部迁移文件。

    // ---- key disposition ----
    const ciphertext = await database.query<{ campaign_id: string; encrypted_api_key: string }>(
      'SELECT campaign_id, encrypted_api_key FROM platform_ai_provider_configs ORDER BY campaign_id',
    );
    const hasCiphertext = ciphertext.length > 0;
    const keyExists = credentialKeyFileExists(keyPath);

    if (options.command === 'enroll' || options.command === 'init') {
      const { cipher, keyOrigin, createdKey } = resolveFreshKeyDisposition({
        hasCiphertext,
        keyExists,
        keyPath,
        ciphertext,
      });
      const databaseId = options.databaseId ?? randomUUID();
      const keyFingerprint = cipher.fingerprint();

      if (options.command === 'enroll') {
        // key disposition 通过后才应用 012（wrong/missing key 不得修改 DB）。
        // M1 crash 窗口（当前 Phase 1 基线 + 012 已应用）：跳过 012 重放（tracking 行 PRIMARY KEY 防重，DDL 幂等）。
        if (!applied.includes('012')) {
          await database.applyMigration(loadMigrationFile(options.migrationsDir, '012_platform_foundation.sql'), now());
        }
      }

      // Phase A：tx 插入 initializing。
      await database.transaction(async (tx) => {
        await store.insertInitializing(tx, { databaseId, keyFingerprint, keyOrigin, now: now() });
      });

      // Phase B：generated key durable publish（preexisting 已存在，no-op）。
      if (createdKey && !keyExists) {
        publishCredentialCipher({ cipher, keyPath });
      }

      // Phase C：tx mark ready（指纹必须匹配）。
      await database.transaction(async (tx) => {
        await store.markEnrollmentReady(tx, keyFingerprint, now());
      });

      if (options.command === 'init') {
        // 最终公开 init：fresh DB 无旧 session，直接进入 secure-ready
        // （同一事务写 cutover_at + ready；不做 destructive cleanup，不写 existing-DB cutover audit）。
        await database.transaction(async (tx) => {
          await store.beginSessionCleaning(tx, now());
          await store.markSessionSecurityReady(tx, now());
        });
      }

      const updated = (await store.read(database))!;
      return buildResult(options.command, updated, { createdKey, messages: ['enrollment ready'] });
    }

    if (options.command === 'resume') {
      if (instance!.enrollment_state === 'ready') {
        return buildResult('resume', instance!, { createdKey: false, messages: ['already ready'] });
      }
      // initializing：key 必须存在且指纹匹配。
      if (!keyExists) {
        if (instance!.enrollment_key_origin === 'generated') {
          throw new EnrollmentError('generated key 尚未发布（crash 于发布前），不能 resume：请先 enroll-rollback 后重新 enroll。');
        }
        throw new EnrollmentError('resume 需要与 initializing 指纹匹配的既有 key，但 key 文件缺失。');
      }
      const cipher = loadCredentialCipher({ keyPath });
      if (cipher.fingerprint() !== instance!.credential_key_fingerprint) {
        throw new EnrollmentError('resume 失败：磁盘 key 指纹与 initializing 行不匹配。');
      }
      if (hasCiphertext) {
        decryptAll(ciphertext, cipher);
      }
      await database.transaction(async (tx) => {
        await store.markEnrollmentReady(tx, instance!.credential_key_fingerprint, now());
      });
      const updated = (await store.read(database))!;
      return buildResult('resume', updated, { createdKey: false, messages: ['enrollment resumed'] });
    }

    if (options.command === 'rollback') {
      const row = instance!;
      if (row.enrollment_key_origin === 'generated' && keyExists) {
        let matches = false;
        try {
          matches = loadCredentialCipher({ keyPath }).fingerprint() === row.credential_key_fingerprint;
        } catch {
          matches = false;
        }
        if (matches) {
          unlinkSync(keyPath);
        }
      }
      await database.transaction(async (tx) => {
        await store.rollbackInitializing(tx, row.credential_key_fingerprint);
      });
      return buildResult('rollback', row, { createdKey: false, messages: ['initializing row rolled back'] });
    }

    throw new EnrollmentError(`未知命令：${options.command}`);
  } finally {
    if (database !== null) {
      await database.close();
    }
    lock.release();
  }
}

function resolveFreshKeyDisposition(input: {
  hasCiphertext: boolean;
  keyExists: boolean;
  keyPath: string;
  ciphertext: Array<{ campaign_id: string; encrypted_api_key: string }>;
}): { cipher: CredentialCipher; keyOrigin: EnrollmentKeyOrigin; createdKey: boolean } {
  if (input.hasCiphertext) {
    if (!input.keyExists) {
      throw new EnrollmentError('数据库已保存 Provider 凭证但本地密钥缺失；拒绝自动生成替代密钥。');
    }
    const cipher = loadCredentialCipher({ keyPath: input.keyPath });
    decryptAll(input.ciphertext, cipher);
    return { cipher, keyOrigin: 'preexisting', createdKey: false };
  }
  if (input.keyExists) {
    return { cipher: loadCredentialCipher({ keyPath: input.keyPath }), keyOrigin: 'preexisting', createdKey: false };
  }
  // 无密文且无 key：生成 candidate（Phase B 才落盘）。
  return { cipher: CredentialCipher.generate(), keyOrigin: 'generated', createdKey: true };
}

function decryptAll(
  ciphertext: Array<{ campaign_id: string; encrypted_api_key: string }>,
  cipher: CredentialCipher,
): void {
  for (const row of ciphertext) {
    try {
      cipher.decrypt(row.encrypted_api_key);
    } catch {
      throw new EnrollmentError('无法用本地密钥解密全部已保存的 AI Provider 凭证（密钥不匹配或密文损坏）。');
    }
  }
}

async function appliedMigrationVersions(database: DatabasePort): Promise<string[]> {
  try {
    const rows = await database.query<{ version: string }>('SELECT version FROM platform_migrations');
    return rows.map((row) => row.version).sort();
  } catch {
    return [];
  }
}

function isAppliedSet(applied: string[], expected: string[]): boolean {
  if (applied.length !== expected.length) return false;
  return expected.every((version) => applied.includes(version));
}

function buildResult(
  command: EnrollmentCommand,
  instance: PlatformInstanceRow,
  extra: { createdKey: boolean; messages: string[] },
): EnrollmentResult {
  return {
    command,
    databaseId: instance.database_id,
    keyFingerprint: instance.credential_key_fingerprint,
    enrollmentState: instance.enrollment_state,
    keyOrigin: instance.enrollment_key_origin,
    createdKey: extra.createdKey,
    sessionSecurityState: instance.session_security_state,
    maintenanceState: instance.maintenance_state,
    messages: extra.messages,
  };
}
