import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

/** 稳定、coarse、不含敏感数据的路径错误。 */
export class PlatformPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformPathError';
  }
}

/**
 * canonical 绝对路径：CLI 与 server 在 open 前统一使用。
 * 相对路径一律 resolve 为绝对路径。此处不做仓库默认数据路径拒绝——
 * 该 hard rejection 由 Phase 2 测试 fixture（phase2TempFixture）对测试调用方执行；
 * 生产路径安全由 InstanceLock、普通文件/非 symlink 检查与 fail-closed 门保证。
 */
export function canonicalAbsolutePath(path: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new PlatformPathError('路径不能为空。');
  }
  return resolve(path);
}

/**
 * 要求目标为已存在的普通文件且不是 symlink。
 * 数据库文件与 credential key 在 open/load 前必须通过本检查。
 */
export function assertExistingRegularFileNotSymlink(path: string): void {
  const abs = canonicalAbsolutePath(path);
  let stats;
  try {
    stats = lstatSync(abs);
  } catch {
    throw new PlatformPathError(`路径不存在：${abs}`);
  }
  if (stats.isSymbolicLink()) {
    throw new PlatformPathError(`拒绝 symlink 路径：${abs}`);
  }
  if (!stats.isFile()) {
    throw new PlatformPathError(`路径不是普通文件：${abs}`);
  }
}

/** 要求目标不存在（fresh init 的 DB 必须不存在）。只有 ENOENT 视为 absent；其它 lstat 错误 fail closed。 */
export function assertPathAbsent(path: string): void {
  const abs = canonicalAbsolutePath(path);
  try {
    lstatSync(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return; // 不存在，允许。
    }
    // 非 ENOENT（如 EACCES/EPERM）不能当作 absent：继续会误触真实文件，fail closed。
    throw new PlatformPathError(`无法检查路径 ${abs}（${code ?? 'unknown'}）：fail closed。`);
  }
  throw new PlatformPathError(`路径已存在：${abs}`);
}
