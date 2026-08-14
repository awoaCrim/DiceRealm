import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from './SqliteDatabaseAdapter.js';

/** SQLite 应用数据端口的事务、参数化查询与只读队列契约。 */
export function defineSqliteDatabaseContractSuite(): void {
  describe('sqlite database port contract', () => {
    it('rolls back a failed transaction', async () => {
      const db = createSqliteDatabase(':memory:');
      try {
        await db.migrate();
        const id = randomUUID();
        await expect(db.transaction(async (tx) => {
          await tx.execute(
            'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
            [id, `rollback-${id}`, 'hash'],
          );
          throw new Error('abort');
        })).rejects.toThrow('abort');
        const rows = await db.query<{ count: number }>(
          'SELECT COUNT(*) AS count FROM users WHERE id = ?',
          [id],
        );
        expect(Number(rows[0].count)).toBe(0);
      } finally {
        await db.close();
      }
    });

    it('commits a transaction when the callback succeeds', async () => {
      const db = createSqliteDatabase(':memory:');
      try {
        await db.migrate();
        const id = randomUUID();
        await db.transaction(async (tx) => {
          await tx.execute(
            'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
            [id, `commit-${id}`, 'hash'],
          );
        });
        const rows = await db.query<{ count: number }>(
          'SELECT COUNT(*) AS count FROM users WHERE id = ?',
          [id],
        );
        expect(Number(rows[0].count)).toBe(1);
      } finally {
        await db.close();
      }
    });

    it('supports parameterised query and execute with correct changes', async () => {
      const db = createSqliteDatabase(':memory:');
      try {
        await db.migrate();
        const id = randomUUID();
        const login = `param-${id}`;
        const insert = await db.execute(
          'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
          [id, login, 'hash'],
        );
        expect(insert.changes).toBe(1);
        const rows = await db.query<{ id: string; login: string }>(
          'SELECT id, login FROM users WHERE login = ?',
          [login],
        );
        expect(rows).toEqual([{ id, login }]);
      } finally {
        await db.close();
      }
    });

    it('runs migrations only once', async () => {
      const db = createSqliteDatabase(':memory:');
      try {
        await db.migrate();
        await db.migrate();
        const versionRows = await db.query<{ version: string }>('SELECT version FROM platform_migrations');
        const versions = versionRows.map((row) => row.version);
        expect(versions).toEqual([...new Set(versions)]);
      } finally {
        await db.close();
      }
    });

    it('readCommitted provides a query-only reader and never sees rolled-back rows', async () => {
      const db = createSqliteDatabase(':memory:');
      try {
        await db.migrate();
        const id = randomUUID();
        // 事务写入后 rollback；并发 readCommitted 绝不能看到该行。
        const writer = db.transaction(async (tx) => {
          await tx.execute(
            'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
            [id, `rollback-visible-${id}`, 'hash'],
          );
          // 暂停 writer，让 readCommitted 并发执行，再回滚。
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error('abort-after-pause');
        });
        const reader = db.readCommitted(async (reader) => {
          const rows = await reader.query<{ count: number }>(
            'SELECT COUNT(*) AS count FROM users WHERE id = ?',
            [id],
          );
          return Number(rows[0].count);
        });
        const [writeResult, readCount] = await Promise.allSettled([writer, reader]);
        expect(writeResult.status).toBe('rejected'); // writer 抛 abort
        expect(readCount.status).toBe('fulfilled');
        // SQLite 读队列排在 writer 后面，因此只能看到回滚后的状态。
        expect((readCount as PromiseFulfilledResult<number>).value).toBe(0);
      } finally {
        await db.close();
      }
    });

    it('readCommitted reader cannot execute writes (query-only API)', async () => {
      const db = createSqliteDatabase(':memory:');
      try {
        await db.migrate();
        await db.readCommitted(async (reader) => {
          const v = await reader.query<{ v: number }>('SELECT 1 AS v');
          expect(v[0].v).toBe(1);
          // QueryReader 类型上没有 execute：运行期也不提供该方法。
          expect(typeof (reader as unknown as { execute?: unknown }).execute).toBe('undefined');
        });
      } finally {
        await db.close();
      }
    });

    it('rejects transaction->readCommitted nesting with a clear error and keeps serving', async () => {
      const db = createSqliteDatabase(':memory:');
      try {
        await db.migrate();
        await expect(
          db.transaction(async (tx) => {
            await tx.query<{ v: number }>('SELECT 1 AS v');
            await db.readCommitted(async (reader) => reader.query<{ v: number }>('SELECT 1 AS v'));
          }),
        ).rejects.toThrow();
        // 嵌套错误后 adapter 继续服务。
        const result = await db.transaction(async (tx) => {
          const rows = await tx.query<{ v: number }>('SELECT 1 AS v');
          return rows[0].v;
        });
        expect(result).toBe(1);
        const read = await db.readCommitted(async (reader) => {
          const rows = await reader.query<{ v: number }>('SELECT 1 AS v');
          return rows[0].v;
        });
        expect(read).toBe(1);
      } finally {
        await db.close();
      }
    });

    it('rejects readCommitted->transaction nesting with a clear error and keeps serving', async () => {
      const db = createSqliteDatabase(':memory:');
      try {
        await db.migrate();
        await expect(
          db.readCommitted(async (reader) => {
            await reader.query<{ v: number }>('SELECT 1 AS v');
            await db.transaction(async (tx) => {
              await tx.query<{ v: number }>('SELECT 1 AS v');
            });
          }),
        ).rejects.toThrow();
        const result = await db.readCommitted(async (reader) => {
          const rows = await reader.query<{ v: number }>('SELECT 1 AS v');
          return rows[0].v;
        });
        expect(result).toBe(1);
      } finally {
        await db.close();
      }
    });

    it('rejects readCommitted->readCommitted nesting with a clear error and keeps serving', async () => {
      const db = createSqliteDatabase(':memory:');
      try {
        await db.migrate();
        await expect(
          db.readCommitted(async (reader) => {
            await reader.query<{ v: number }>('SELECT 1 AS v');
            await db.readCommitted(async (inner) => inner.query<{ v: number }>('SELECT 1 AS v'));
          }),
        ).rejects.toThrow();
        const result = await db.readCommitted(async (reader) => {
          const rows = await reader.query<{ v: number }>('SELECT 1 AS v');
          return rows[0].v;
        });
        expect(result).toBe(1);
      } finally {
        await db.close();
      }
    });

    it('continues serving the queue after a readCommitted rejects', async () => {
      const db = createSqliteDatabase(':memory:');
      try {
        await db.migrate();
        const failing = db.readCommitted(async () => {
          throw new Error('read-abort');
        });
        const succeeding = db.readCommitted(async (reader) => {
          const rows = await reader.query<{ v: number }>('SELECT 1 AS v');
          return rows[0].v;
        });
        await expect(failing).rejects.toThrow('read-abort');
        await expect(succeeding).resolves.toBe(1);
      } finally {
        await db.close();
      }
    });
  });
}

/**
 * 读取仓库根 package.json 的 engines.node 与 .nvmrc，断言两者都存在且一致。
 * 任一缺失都会抛出明确错误，作为配置一致性测试的失败原因。
 */
export function readNodePins(repoRoot: string): { engines: string; nvmrc: string } {
  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { engines?: { node?: string } };
  if (!root.engines?.node) {
    throw new Error('package.json 缺少 engines.node 约束');
  }
  let nvmrc = '';
  try {
    nvmrc = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim();
  } catch {
    throw new Error('.nvmrc 缺失：请先固定 Node 版本');
  }
  if (!nvmrc) {
    throw new Error('.nvmrc 为空：请写入已验证的 Node 版本');
  }
  return { engines: root.engines.node, nvmrc };
}
