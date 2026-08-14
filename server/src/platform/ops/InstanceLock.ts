import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';

export type InstanceLockPurpose = 'server' | 'cli';

/** 锁文件内容：单行 JSON；不包含任何业务数据或凭据。 */
export interface InstanceLockMetadata {
  format: 1;
  token: string;
  pid: number;
  hostname: string;
  purpose: InstanceLockPurpose;
  startedAt: string;
}

/** 已取得的实例锁：release() 幂等，且只在文件 token 等于本实例 token 时删除。 */
export interface InstanceLock {
  /** 锁文件绝对路径；`:memory:` no-op 锁为 null。 */
  readonly path: string | null;
  readonly token: string;
  release(): void;
}

export const INSTANCE_LOCK_FILE_NAME = '.dnd-instance.lock';

/** 稳定、可人工处理、不含敏感数据的锁错误。 */
export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceLockError';
  }
}

function lockPathForDatabase(databasePath: string): string {
  if (databasePath === ':memory:') return '';
  return resolve(dirname(resolve(databasePath)), INSTANCE_LOCK_FILE_NAME);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function readOwnerToken(lockPath: string): string {
  // 读取失败/损坏一律 fail closed，绝不覆盖其它 owner 的文件。
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    throw new InstanceLockError(
      `无法读取实例锁文件（${lockPath}）。请确认没有其它 DND 进程正在运行，删除该文件后重试。`,
    );
  }
  try {
    const metadata = JSON.parse(raw) as Partial<InstanceLockMetadata>;
    if (typeof metadata.token !== 'string' || metadata.token.length === 0) {
      throw new Error('missing token');
    }
    return metadata.token;
  } catch {
    throw new InstanceLockError(
      `实例锁文件内容损坏（${lockPath}）。Phase 1 不自动接管锁；请人工确认没有其它进程后删除该文件。`,
    );
  }
}

/**
 * 在数据库所在数据目录取得单实例锁（`O_EXCL` 原子创建，目录内 `.dnd-instance.lock`）。
 *
 * 顺序约束：必须在打开 SQLite 之前取得；release() 在数据库 close 之后调用。
 *
 * Phase 1 锁策略：无论持有者 PID 看似已死、metadata 陈旧还是文件损坏，一律 fail closed，
 * 不自动 unlink。原因：Windows 允许 unlink 仍在运行的持有者文件，PID 复用或并发 break
 * 会制造双 owner；自动 stale recovery 不在已批准范围。
 *
 * `:memory:` 数据库返回 no-op 锁（path=null），不创建任何文件。
 */
export function acquireInstanceLock(options: {
  databasePath: string;
  purpose: InstanceLockPurpose;
}): InstanceLock {
  const lockPath = lockPathForDatabase(options.databasePath);
  if (!lockPath) {
    return {
      path: null,
      token: randomUUID(),
      release: () => undefined,
    };
  }

  const token = randomUUID();
  const metadata: InstanceLockMetadata = {
    format: 1,
    token,
    pid: process.pid,
    hostname: hostname(),
    purpose: options.purpose,
    startedAt: new Date().toISOString(),
  };

  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(metadata)}\n`, 'utf8');
      fsyncSync(fd); // 先落盘再 close：崩溃后不会留下空/半写的锁文件（fail-closed 提示不变，但避免误报“内容损坏”）。
      closeSync(fd);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不掩盖原始写入错误。
      }
      // 写入/fsync 失败：删除本进程用 wx 创建的 partial 文件，避免下次启动误报“实例锁已存在”。
      try {
        unlinkSync(lockPath);
      } catch {
        // 删除失败：保持 fail-closed，由人工处理。
      }
      throw error;
    }
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      // 已有 owner（无论 live/stale/corrupt）——fail closed。
      readOwnerToken(lockPath); // 只为产生稳定错误分类；结果不用于覆盖。
      throw new InstanceLockError(
        `实例锁已存在（${lockPath}）。同一数据目录只能运行一个 DND 服务进程；` +
          'Phase 1 不会自动接管陈旧锁，请人工确认没有其它进程后处理该文件。',
      );
    }
    throw new InstanceLockError(
      `无法创建实例锁（${lockPath}）。请确认目录可写后重试。`,
    );
  }

  let released = false;
  return {
    path: lockPath,
    token,
    release: () => {
      if (released) return;
      released = true;
      if (!existsSync(lockPath)) return; // 已被（异常）删除：视为已释放。
      let ownerToken: string;
      try {
        ownerToken = readOwnerToken(lockPath);
      } catch {
        // 文件损坏：不删除，留给人工处理；本实例视为已释放（不持有有效锁）。
        return;
      }
      if (ownerToken !== token) {
        // token 已被替换：锁已被其它 owner 接管，绝不能删除其文件。
        return;
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // 删除失败：静默（释放已是幂等收敛点），锁文件可由下个 acquire 失败提示人工处理。
      }
    },
  };
}
