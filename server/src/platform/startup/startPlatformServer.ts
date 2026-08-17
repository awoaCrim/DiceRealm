import type express from 'express';
import type { Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../../config.js';
import { migrateLegacyRuleSourcesDatabase } from '../../platform/database/legacyRuleSourcesMigration.js';
import type { DatabasePort } from '../../platform/database/DatabasePort.js';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { acquireInstanceLock, type InstanceLock } from '../../platform/ops/InstanceLock.js';
import { verifyMigrationManifest } from '../../platform/ops/migrationManifest.js';
import { PHASE3_APPROVED_MIGRATION_FILENAMES } from '../../platform/ops/approvedMigrations.js';
import { assertExistingRegularFileNotSymlink } from '../../platform/ops/platformPaths.js';
import type { EventStreamRuntime } from '../../platform/realtime/EventStreamService.js';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { createPlatformApp, type CreatePlatformAppOptions, type PlatformApp } from '../../app.js';
import { createConfiguredAiProvider } from '../../modules/ai-runtime/createAiProvider.js';
import { NarrativeClaimLeaseSweeper } from '../../modules/narrative-runtime/NarrativeClaimLeaseSweeper.js';
import { NarrativeWorkCoordinator } from '../../modules/narrative-runtime/NarrativeWorkCoordinator.js';
import { credentialKeyPathForDatabase } from '../../modules/ai-runtime/CredentialKeyStore.js';
import { runStartupSecurityGate } from './StartupSecurityGate.js';

/** 默认 migrations 目录：dev 为 src、dist 为编译产物同目录（相对 import.meta.url，不做 NODE_ENV 分支）。 */
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../database/migrations/', import.meta.url));

/**
 * Listener 生命周期 seam：生产监听器把 shutdown 拆成两个阶段，使 coordinator 能在
 * realtimeRuntime 关闭之后再强制断开剩余连接：
 *   stopAccepting()（server.close，停止接受新连接）
 *   → realtimeRuntime.closeAll()
 *   → destroyConnections()（server.closeAllConnections + 等待 server close 完成）
 * 测试 seam 用同样的双阶段形状，不暴露生产 server 内部。
 */
export interface PlatformListener {
  stopAccepting(): Promise<void>;
  destroyConnections(): Promise<void>;
  /** 底层 HTTP server（仅供测试/观测；coordinator 不使用）。 */
  readonly server?: HttpServer;
}

export interface StartPlatformServerOptions {
  config: AppConfig;
  env: Record<string, string | undefined>;
  /** 测试注入数据库 factory（生产用 createSqliteDatabase(config.databasePath)）。 */
  createDatabase?: (databasePath: string) => DatabasePort & { close(): Promise<void> };
  /** 测试注入 migrations 目录（生产用默认运行时目录）。 */
  migrationsDir?: string;
  /** 测试注入 credential key path（生产与 databasePath 同目录）。 */
  credentialKeyPath?: string;
  /** 测试注入 listen（生产 app.listen(port, host)）。 */
  listen?: (app: express.Express, port: number, host: string) => Promise<PlatformListener>;
  /** 测试注入 app factory（生产 createPlatformApp）。 */
  appFactory?: (options: CreatePlatformAppOptions) => PlatformApp;
  /** 测试注入事件记录（startup/close 顺序断言）。 */
  emit?: (event: string) => void;
}

export interface RunningPlatformServer {
  close(): Promise<void>;
}

/**
 * 生产 HTTP listener：把 shutdown 拆成 stopAccepting（停止接受新连接）与
 * destroyConnections（强制断连并等待 server 'close'）两个阶段，供 coordinator
 * 在 realtimeRuntime 关闭之后再断开剩余连接。导出仅为直接测试真实 Node 语义。
 */
export async function defaultListen(app: express.Express, port: number, host: string): Promise<PlatformListener> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.once('listening', () => {
      // 成功监听后移除 pre-listening error handler：post-listen 错误不得被已 settled 的 promise 静默吞掉。
      server.removeListener('error', onError);
      // 'close' 在 server.close() 之后且所有连接结束时触发；promise 一旦 resolve 即保持，
      // 所以 destroyConnections 在 close 已完成时立即返回、未完成时等待剩余连接被强制关闭。
      const closedPromise = new Promise<void>((resolveClosed) => {
        server.once('close', resolveClosed);
      });
      resolve({
        server,
        stopAccepting: async () => {
          server.close(); // 停止接受新连接；现有连接等待 finish 或后续 closeAllConnections。
        },
        destroyConnections: async () => {
          server.closeAllConnections?.();
          await closedPromise;
        },
      });
    });
  });
}

/**
 * 可测试启动 coordinator（生产 `index.ts` 的薄入口只调用它）。
 *
 * Production startup order is fixed:
 *   load config / canonicalize DB path
 *   → require existing regular non-symlink DB（普通 startup 永不创建 DB）
 *   → acquire InstanceLock（在 new Database 之前）
 *   → verify current runtime migration directory manifest
 *   → open one SqliteDatabaseAdapter（不执行 migrate）
 *   → narrow legacy 011 compatibility bridge（backup, then atomic removal）
 *   → startup security gate（applied set / enrollment ready / key fingerprint / decrypt-all / session security ready）
 *   → create env fallback provider
 *   → createPlatformApp({ database, ... })
 *   → listen
 *   → start Narrative outbox worker
 *   → start Narrative claim lease sweeper
 *
 * 任一步失败：已打开的 DB 必须 close，锁最后 release，listener 不得留下。
 * 正常 shutdown 固定为：
 *   stop Narrative outbox worker → stop Narrative claim lease sweeper → server.close（停止新连接）→ realtimeRuntime.closeAll()
 *   → server.closeAllConnections() → 等待 server close 完成 → database.close() → InstanceLock.release()。
 * 每一步异常隔离：前面步骤抛出也不阻止 DB/lock 清理。
 */
export async function startPlatformServer(options: StartPlatformServerOptions): Promise<RunningPlatformServer> {
  const { config } = options;
  const emit = options.emit ?? (() => undefined);
  const createDatabase = options.createDatabase
    ?? ((databasePath: string): DatabasePort & { close(): Promise<void> } => createSqliteDatabase(databasePath));
  const appFactory = options.appFactory ?? createPlatformApp;
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const manifestPath = join(migrationsDir, 'migrations.manifest.json');
  const credentialKeyPath = options.credentialKeyPath ?? credentialKeyPathForDatabase(config.databasePath);
  const listen = options.listen ?? defaultListen;

  let lock: InstanceLock | null = null;
  let database: (DatabasePort & { close(): Promise<void> }) | null = null;
  let realtimeRuntime: EventStreamRuntime | null = null;
  let listener: PlatformListener | null = null;
  let narrativeWorkRuntime: PlatformApp['narrativeWorkRuntime'] | null = null;
  let narrativeClaimLeaseSweeper: NarrativeClaimLeaseSweeper | null = null;

  // 统一关闭序列（正常 shutdown 与失败清理共用），每步异常隔离：
  // outbox worker → lease sweeper → server.close → realtime closeAll → server.closeAllConnections → database.close → lock.release。
  const shutdownAll = async (): Promise<void> => {
    try {
      if (narrativeWorkRuntime !== null) {
        await narrativeWorkRuntime.stop();
      }
    } catch {
      // Background Provider work must not prevent the database/lock cleanup.
    }
    try {
      if (narrativeClaimLeaseSweeper !== null) {
        await narrativeClaimLeaseSweeper.stop();
      }
    } catch {
      // Background recovery must not prevent the database/lock cleanup.
    }
    try {
      if (listener !== null) {
        await listener.stopAccepting();
        emit('close.server');
      }
    } catch {
      // 监听器关闭失败不阻止后续清理。
    }
    try {
      if (realtimeRuntime !== null) {
        realtimeRuntime.closeAll();
        emit('close.realtime');
      }
    } catch {
      // realtime 关闭失败不阻止后续清理。
    }
    try {
      if (listener !== null) {
        await listener.destroyConnections();
        emit('close.connections');
      }
    } catch {
      // 强制断连失败不阻止后续清理。
    }
    try {
      if (database !== null) {
        await database.close();
        emit('close.database');
      }
    } catch {
      // DB 关闭失败不阻止锁释放。
    }
    try {
      if (lock !== null) {
        lock.release();
        emit('close.lock');
      }
    } catch {
      // 锁释放失败不再叠加掩盖原始错误。
    }
  };

  try {
    // Ordinary startup never silently creates a database; it requires an existing regular non-symlink file.
    assertExistingRegularFileNotSymlink(config.databasePath);
    emit('path.verify');

    lock = acquireInstanceLock({ databasePath: config.databasePath, purpose: 'server' });
    emit('lock.acquire');

    verifyMigrationManifest({ migrationsDir, manifestPath });
    emit('manifest.verify');

    database = createDatabase(config.databasePath);
    emit('database.open');

    // Compatibility bridge for databases created before rule-material removal.
    // It runs before the security gate and before app/listener creation.
    const legacyMigration = await migrateLegacyRuleSourcesDatabase({
      databasePath: config.databasePath,
      credentialKeyPath,
      // The retired-rule bridge accepts only the current maintained schema (and
      // its one explicitly supported pre-016 compatibility shape); it never
      // applies the new adjudication migration as a side effect.
      approvedMigrationFilenames: PHASE3_APPROVED_MIGRATION_FILENAMES,
    });
    if (legacyMigration.migrated) {
      emit('legacy-rule-sources.migrate');
    }

    // Ordinary startup does not apply arbitrary pending migrations; the bridge handles only the exact retired-rule compatibility shape before the security gate.
    // The application gate uses the explicit current approved set. It never
    // derives approval from the manifest, so future migrations remain fail-closed.
    const gate = await runStartupSecurityGate({
      db: database,
      keyPath: credentialKeyPath,
      approvedMigrationFilenames: [...PHASE3_APPROVED_MIGRATION_FILENAMES],
    });
    emit('security.verify');

    const aiProvider = createConfiguredAiProvider(options.env);
    const composed = appFactory({
      database,
      securityConfig: config.security!,
      credentialCipher: gate.cipher,
      aiProvider,
    });
    realtimeRuntime = composed.realtimeRuntime;
    narrativeWorkRuntime = composed.narrativeWorkRuntime;
    emit('app.create');

    listener = await listen(composed.app, config.port, config.host);
    emit('listen');

    narrativeWorkRuntime.start();
    narrativeClaimLeaseSweeper = new NarrativeClaimLeaseSweeper(
      new NarrativeWorkCoordinator(database, new OutboxRepository(database)),
    );
    narrativeClaimLeaseSweeper.start();

    let closed = false;
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        await shutdownAll();
      },
    };
  } catch (error) {
    await shutdownAll();
    throw error;
  }
}
