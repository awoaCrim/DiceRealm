import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PHASE2_APPROVED_MIGRATION_FILENAMES } from '../platform/ops/approvedMigrations.js';

/**
 * Phase 2 测试隔离 fixture（Task 0）。
 *
 * 全部 Phase 2 测试必须使用本 helper 创建 `mkdtemp` 绝对路径下的 DB/key/backup/migrations，
 * 并使用 ephemeral HTTP/HTTPS listener。helper 对仓库默认 DB/key 绝对路径做 hard rejection，
 * 防止任何测试/CLI 冒烟误触真实 `server/dnd.sqlite*` 或真实 credential key。
 */

/** 仓库默认危险路径集合（全部 resolve 为绝对路径后比较）。 */
export const REPO_DEFAULT_PATHS: string[] = [
  resolve('dnd.sqlite'),
  resolve('server/dnd.sqlite'),
  resolve('server/dnd.sqlite-wal'),
  resolve('server/dnd.sqlite-shm'),
  resolve('.dnd-ai-credential-key'),
  resolve('server/.dnd-ai-credential-key'),
];

/** hard rejection：任何 Phase 2 测试传入仓库默认 DB/key 绝对路径一律抛错。 */
export function assertSafePhase2Path(path: string): void {
  const abs = resolve(path);
  if (REPO_DEFAULT_PATHS.includes(abs)) {
    throw new Error(`phase2TempFixture: 拒绝仓库默认路径（可能触碰真实数据）: ${abs}`);
  }
}

/** 当前 Phase 批准的 migration 集合（与生产 frozen constant 同源；001–011 与 Phase 1 baseline 一致，012/013/014 在对应 Task 加入）。 */
export const APPROVED_MIGRATION_FILENAMES: string[] = [...PHASE2_APPROVED_MIGRATION_FILENAMES];

export interface Phase2TempFixture {
  /** 唯一 mkdtemp 根目录（绝对路径）。 */
  dir: string;
  databasePath: string;
  keyPath: string;
  /** 敏感备份 target 目录（已创建）。 */
  backupDir: string;
  /** 固定 cleanup 顺序：由测试显式调用；仅删除本 fixture 自己的临时目录。 */
  cleanup(): void;
}

/**
 * 创建隔离的 Phase 2 临时 fixture。
 *
 * 约定：
 * - 所有路径均为 mkdtemp 绝对路径，绝不允许相对路径或仓库默认路径。
 * - backupDir 与 databasePath 同 parent filesystem（同 dir），满足 backup rename 约束。
 */
export function createPhase2TempFixture(prefix = 'dnd-phase2-'): Phase2TempFixture {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const databasePath = join(dir, 'db.sqlite');
  const keyPath = join(dir, '.dnd-ai-credential-key');
  const backupDir = join(dir, 'backup');
  for (const p of [databasePath, keyPath, backupDir]) {
    assertSafePhase2Path(p);
  }
  mkdirSync(backupDir, { recursive: true });
  return {
    dir,
    databasePath,
    keyPath,
    backupDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
