import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireInstanceLock,
  InstanceLockError,
  type InstanceLockMetadata,
} from './InstanceLock.js';

// 只对 node:fs 做 spy 包装（保留真实行为），以便定向测试 writeFileSync 失败时
// InstanceLock 会清理自己用 wx 创建的 partial 锁文件；不改变其它测试语义。
vi.mock('node:fs', { spy: true });

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 写一个死 PID 的陈旧锁文件（Phase 1 必须同样 fail closed，不自动 break）。 */
function writeFixtureLock(lockPath: string, overrides: Partial<InstanceLockMetadata> = {}): InstanceLockMetadata {
  const metadata: InstanceLockMetadata = {
    format: 1,
    token: 'fixture-token',
    pid: 2_147_483_647,
    hostname: 'fixture-host',
    purpose: 'server',
    startedAt: '2000-01-01T00:00:00.000Z',
    ...overrides,
  };
  writeFileSync(lockPath, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', mode: 0o600 });
  return metadata;
}

describe('InstanceLock', () => {
  it('acquires once and writes format/token/pid/hostname/purpose/startedAt with 0600 on non-Windows', () => {
    const dir = tempDir('dnd-instance-lock-acquire-');
    try {
      mkdirSync(join(dir, 'data'), { recursive: true });
      const databasePath = join(dir, 'data', 'campaign.sqlite');
      const lock = acquireInstanceLock({ databasePath, purpose: 'server' });
      try {
        expect(lock.path).toBe(resolve(dir, 'data', '.dnd-instance.lock'));
        const raw = JSON.parse(readFileSync(lock.path!, 'utf8')) as InstanceLockMetadata;
        expect(raw.format).toBe(1);
        expect(raw.token).toBe(lock.token);
        expect(typeof raw.pid).toBe('number');
        expect(typeof raw.hostname).toBe('string');
        expect(raw.purpose).toBe('server');
        expect(Number.isNaN(Date.parse(raw.startedAt))).toBe(false);
        if (process.platform !== 'win32') {
          expect(statSync(lock.path!).mode & 0o777).toBe(0o600);
        }
      } finally {
        lock.release();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a second acquire on the same data directory and never auto-breaks a dead-PID lock', () => {
    const dir = tempDir('dnd-instance-lock-second-');
    try {
      const databasePath = join(dir, 'campaign.sqlite');
      const first = acquireInstanceLock({ databasePath, purpose: 'server' });
      try {
        let error: unknown;
        try {
          acquireInstanceLock({ databasePath, purpose: 'cli' });
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(InstanceLockError);
        const message = error instanceof Error ? error.message : String(error);
        // 错误不得包含任意数据库内容/密文；只给稳定的人工处理提示。
        expect(message).toContain('.dnd-instance.lock');
        expect(message).not.toContain('sqlite');
      } finally {
        first.release();
      }

      // dead-PID / 非常陈旧 fixture：Phase 1 一律 fail closed，不自动 unlink/break。
      mkdirSync(join(dir, 'stale'), { recursive: true });
      const stalePath = join(dir, 'stale', '.dnd-instance.lock');
      writeFixtureLock(stalePath, { pid: 1, startedAt: '1999-01-01T00:00:00.000Z' });
      expect(() => acquireInstanceLock({ databasePath: join(dir, 'stale', 'db.sqlite'), purpose: 'server' }))
        .toThrow(InstanceLockError);
      expect(readFileSync(stalePath, 'utf8')).toContain('fixture-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows re-acquire after release and makes double release idempotent', () => {
    const dir = tempDir('dnd-instance-lock-release-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      const first = acquireInstanceLock({ databasePath, purpose: 'server' });
      first.release();
      first.release(); // double release 幂等
      const second = acquireInstanceLock({ databasePath, purpose: 'server' });
      expect(second.token).not.toBe(first.token);
      second.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not unlink a lock file whose token was replaced by another owner', () => {
    const dir = tempDir('dnd-instance-lock-token-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      const oldOwner = acquireInstanceLock({ databasePath, purpose: 'server' });
      const lockPath = oldOwner.path!;
      // 模拟另一个进程取走了锁（替换了文件内容与 token）。
      writeFixtureLock(lockPath, { token: 'new-owner-token' });
      oldOwner.release();
      // 旧 owner 不得删除新 owner 的文件。
      expect(readFileSync(lockPath, 'utf8')).toContain('new-owner-token');
      rmSync(dir, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a no-op lock for :memory: databases and creates no file in cwd', () => {
    const lock = acquireInstanceLock({ databasePath: ':memory:', purpose: 'server' });
    lock.release();
    lock.release();
    expect(lock.path).toBeNull();
    const cwdFiles = process.cwd();
    // 不创建任何 lock 文件（不能假设 cwd 无其它文件，只断言 lock 不存在）。
    expect(require('node:fs').existsSync(join(resolve(cwdFiles), '.dnd-instance.lock'))).toBe(false);
  });

  it('fails closed on a corrupt lock file without overwriting it', () => {
    const dir = tempDir('dnd-instance-lock-corrupt-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      const lockPath = join(dir, '.dnd-instance.lock');
      writeFileSync(lockPath, 'not-json-at-all\n', { encoding: 'utf8' });
      let error: unknown;
      try {
        acquireInstanceLock({ databasePath, purpose: 'server' });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(InstanceLockError);
      expect(readFileSync(lockPath, 'utf8')).toBe('not-json-at-all\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unlinks the partial lock file this process created when the write fails after wx creation', () => {
    const dir = tempDir('dnd-instance-lock-writefail-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      // 仅让下一次 writeFileSync 失败（模拟磁盘满/中断），其余 fs 调用保持真实行为。
      vi.mocked(writeFileSync).mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      expect(() => acquireInstanceLock({ databasePath, purpose: 'server' })).toThrow(InstanceLockError);
      // partial 文件已被本进程清理：下次 acquire 不再误报“实例锁已存在”。
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
      // 清理后可以正常重新获取。
      const retry = acquireInstanceLock({ databasePath, purpose: 'server' });
      retry.release();
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
