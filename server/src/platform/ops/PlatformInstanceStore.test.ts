import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../database/SqliteDatabaseAdapter.js';
import type { QueryExecutor } from '../database/DatabasePort.js';
import {
  PlatformInstanceStore,
  PlatformInstanceStoreError,
  type PlatformInstanceRow,
} from './PlatformInstanceStore.js';

const NOW = '2026-08-12T00:00:00.000Z';
const LATER = '2026-08-12T01:00:00.000Z';
const FINGERPRINT = 'sha256:' + 'ab'.repeat(32);

async function openEnrolledDb(): Promise<{ db: ReturnType<typeof createSqliteDatabase>; instance: PlatformInstanceRow }> {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const store = new PlatformInstanceStore();
  await db.transaction(async (tx) => {
    await store.insertInitializing(tx, {
      databaseId: 'db-1',
      keyFingerprint: FINGERPRINT,
      keyOrigin: 'generated',
      now: NOW,
    });
    await store.markEnrollmentReady(tx, FINGERPRINT, NOW);
  });
  const row = (await store.read(db))!;
  return { db, instance: row };
}

describe('PlatformInstanceStore', () => {
  it('returns null (unenrolled) when no singleton row exists', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      const store = new PlatformInstanceStore();
      expect(await store.read(db)).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('inserts an initializing row and marks it ready with the exact fingerprint', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      const store = new PlatformInstanceStore();
      await db.transaction(async (tx) => {
        await store.insertInitializing(tx, {
          databaseId: 'db-1',
          keyFingerprint: FINGERPRINT,
          keyOrigin: 'preexisting',
          now: NOW,
        });
        await store.markEnrollmentReady(tx, FINGERPRINT, LATER);
      });
      const row = await store.read(db);
      expect(row).toMatchObject({
        database_id: 'db-1',
        enrollment_state: 'ready',
        credential_key_fingerprint: FINGERPRINT,
        enrollment_key_origin: 'preexisting',
        session_security_state: 'pending',
        maintenance_state: 'active',
        maintenance_epoch: 0,
        bootstrap_completed_at: null,
        session_security_cutover_at: null,
      });
    } finally {
      await db.close();
    }
  });

  it('rejects a second singleton row and a second administrator row at the DB level', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      const store = new PlatformInstanceStore();
      await db.transaction(async (tx) => {
        await store.insertInitializing(tx, {
          databaseId: 'db-1',
          keyFingerprint: FINGERPRINT,
          keyOrigin: 'generated',
          now: NOW,
        });
      });
      await expect(
        db.transaction(async (tx) => {
          await store.insertInitializing(tx, {
            databaseId: 'db-2',
            keyFingerprint: FINGERPRINT,
            keyOrigin: 'generated',
            now: NOW,
          });
        }),
      ).rejects.toThrow();

      // 唯一管理员 singleton 约束。
      const now = new Date().toISOString();
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u1', 'admin1', 'h']);
      await db.execute('INSERT INTO platform_administrators (singleton_id, user_id, created_at) VALUES (1, ?, ?)', ['u1', now]);
      await expect(
        db.execute('INSERT INTO platform_administrators (singleton_id, user_id, created_at) VALUES (1, ?, ?)', ['u1', now]),
      ).rejects.toThrow();
      await expect(
        db.execute('INSERT INTO platform_administrators (singleton_id, user_id, created_at) VALUES (2, ?, ?)', ['u1', now]),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('rejects invalid states and negative epochs at the DB level', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      await expect(
        db.execute(
          "INSERT INTO platform_instance (singleton_id, database_id, enrollment_state, credential_key_fingerprint, enrollment_key_origin, maintenance_epoch, created_at, updated_at) VALUES (1, 'db-x', 'bogus', 'sha256:' + 'ab'.repeat(32), 'generated', -1, ?, ?)",
          [NOW, NOW],
        ),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('transition helpers are conditional winners (changes===1) and refuse wrong state/fingerprint', async () => {
    const { db } = await openEnrolledDb();
    try {
      const store = new PlatformInstanceStore();
      // ready 后再 markEnrollmentReady 必须失败（状态已推进）。
      await expect(
        db.transaction(async (tx) => store.markEnrollmentReady(tx, FINGERPRINT, LATER)),
      ).rejects.toThrow(PlatformInstanceStoreError);
      // 错误 fingerprint 的 rollback 必须失败。
      await expect(
        db.transaction(async (tx) => store.rollbackInitializing(tx, 'sha256:' + 'cd'.repeat(32))),
      ).rejects.toThrow(PlatformInstanceStoreError);

      // pending -> cleaning（cutover 逻辑事务）。
      await db.transaction(async (tx) => store.beginSessionCleaning(tx, LATER));
      const cleaning = (await store.read(db))!;
      expect(cleaning.session_security_state).toBe('cleaning');
      expect(cleaning.session_security_cutover_at).toBe(LATER);
      // 再次 beginSessionCleaning 必须失败。
      await expect(
        db.transaction(async (tx) => store.beginSessionCleaning(tx, LATER)),
      ).rejects.toThrow(PlatformInstanceStoreError);

      // cleaning -> ready。
      await db.transaction(async (tx) => store.markSessionSecurityReady(tx, LATER));
      const ready = (await store.read(db))!;
      expect(ready.session_security_state).toBe('ready');

      // maintenance transition：active epoch0 -> draining epoch1；wrong epoch 拒绝。
      await db.transaction(async (tx) =>
        store.transitionMaintenance(tx, 'active', 0, 'draining', LATER),
      );
      const draining = (await store.read(db))!;
      expect(draining.maintenance_state).toBe('draining');
      expect(draining.maintenance_epoch).toBe(1);
      await expect(
        db.transaction(async (tx) =>
          store.transitionMaintenance(tx, 'active', 0, 'draining', LATER),
        ),
      ).rejects.toThrow(PlatformInstanceStoreError);
    } finally {
      await db.close();
    }
  });

  it('rollback only removes an initializing row with matching fingerprint', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      const store = new PlatformInstanceStore();
      await db.transaction(async (tx) => {
        await store.insertInitializing(tx, {
          databaseId: 'db-1',
          keyFingerprint: FINGERPRINT,
          keyOrigin: 'generated',
          now: NOW,
        });
      });
      expect(await store.read(db)).not.toBeNull();
      await db.transaction(async (tx) => store.rollbackInitializing(tx, FINGERPRINT));
      expect(await store.read(db)).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('cannot clear the bootstrap timestamp through the store', async () => {
    const { db } = await openEnrolledDb();
    try {
      const store = new PlatformInstanceStore();
      // 只有外部直接 SQL 才能改 bootstrap_completed_at；store 没有任何清空方法（无方法可调用即验证接口面）。
      const tx: QueryExecutor = db;
      await tx.execute(
        "UPDATE platform_instance SET bootstrap_completed_at = ? WHERE singleton_id = 1",
        [LATER],
      );
      const row = (await store.read(db))!;
      expect(row.bootstrap_completed_at).toBe(LATER);
      // store 只读/推进 enrollment，不存在 bootstrap 清空方法（类型层面已经保证，这里断言接口方法集合）。
      const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter((m) => m !== 'constructor');
      expect(methodNames.sort()).toEqual([
        'beginSessionCleaning',
        'insertInitializing',
        'markEnrollmentReady',
        'markSessionSecurityReady',
        'read',
        'rollbackInitializing',
        'transitionMaintenance',
      ]);
    } finally {
      await db.close();
    }
  });
});
