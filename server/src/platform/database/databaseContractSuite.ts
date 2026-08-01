import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabasePort } from './DatabasePort.js';

export interface DatabaseFactory {
  label: string;
  create(): Promise<DatabasePort>;
}

/**
 * 同一组契约测试在 SQLite 与 PostgreSQL 上都必须通过。
 * 测试资源一律使用 randomUUID() 生成唯一 id/login，并在 try/finally 中 close，
 * 避免在共享 Postgres 测试库上重复运行撞唯一约束或泄漏连接。
 */
export function defineDatabaseContractSuite(factory: DatabaseFactory): void {
  describe(`${factory.label} database port contract`, () => {
    it('rolls back a failed transaction', async () => {
      const db = await factory.create();
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
      const db = await factory.create();
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
      const db = await factory.create();
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
      const db = await factory.create();
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
