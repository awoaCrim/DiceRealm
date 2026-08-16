import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { MigrationRunner } from '../../platform/database/migrations/MigrationRunner.js';
import { SecurityAuditWriter } from './SecurityAuditWriter.js';
import { AuditMetadataError, parseAuditEvent, type SecurityAuditEvent } from './SecurityAuditEvent.js';
import { assertAuditMetadataSafe } from './securityAuditSentinel.js';
import { createExistingDb001_010, copyMigrations, commitMigrationsDir, commitManifestPath, tempDir } from '../../tests/phase2StartupHelpers.js';
import { runEnrollmentCommand } from '../../platform/ops/EnrollmentCoordinator.js';

/** 把 013/014 单独应用到已存在当前 Phase 1 基线的 DB。 */
async function applySecureMigrations(db: ReturnType<typeof createSqliteDatabase>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dnd-audit-mig-'));
  try {
    copyMigrations(['013', '014'], dir);
    await new MigrationRunner(db, dir).run();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('014 append-only audit triggers', () => {
  it('allows INSERT and rejects UPDATE/DELETE at the DB level', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      await db.execute(
        `INSERT INTO platform_security_audit_events (id, event_type, outcome, actor_user_id, subject_user_id, metadata_json, created_at)
         VALUES (?, 'session.logout', 'success', NULL, NULL, '{}', ?)`,
        ['audit-1', '2026-08-12T00:00:00.000Z'],
      );
      await expect(
        db.execute("UPDATE platform_security_audit_events SET metadata_json = '{}' WHERE id = 'audit-1'"),
      ).rejects.toThrow(/append-only/);
      await expect(
        db.execute("DELETE FROM platform_security_audit_events WHERE id = 'audit-1'"),
      ).rejects.toThrow(/append-only/);
      const rows = await db.query('SELECT COUNT(*) AS c FROM platform_security_audit_events');
      expect((rows[0] as { c: number }).c).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('013/014 are additive: legacy raw session rows survive untouched with NULL secure columns', async () => {
    const dir = tempDir('dnd-audit-additive-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      createExistingDb001_010(databasePath);
      const db = createSqliteDatabase(databasePath);
      try {
        // legacy raw session row（001 原始形状：id=raw token）。
        await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u1', 'legacy', 'h']);
        await db.execute(
          'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
          ['legacy-raw-token', 'u1', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
        );
        await applySecureMigrations(db);
        const rows = await db.query<{ id: string; token_digest: string | null; csrf_digest: string | null; revoke_epoch: number }>(
          'SELECT id, token_digest, csrf_digest, revoke_epoch FROM sessions WHERE id = ?',
          ['legacy-raw-token'],
        );
        expect(rows[0]).toEqual({ id: 'legacy-raw-token', token_digest: null, csrf_digest: null, revoke_epoch: 0 });
      } finally {
        await db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SecurityAuditWriter typed events', () => {
  it('writes each Phase 2 event type with strict coarse metadata', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      // actor/subject FK：先建用户。
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u1', 'admin', 'h']);
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u2', 'member', 'h']);
      const writer = new SecurityAuditWriter();
      const events: Array<[SecurityAuditEvent, { actorUserId?: string; subjectUserId?: string }]> = [
        [{ type: 'bootstrap.completed', outcome: 'success', metadata: { accountId: 'u1' } }, {}],
        [{ type: 'bootstrap.rejected', outcome: 'rejected', metadata: { reason: 'wrong_secret' } }, {}],
        [{ type: 'invite.created', outcome: 'success', metadata: { inviteId: 'inv-1' } }, { actorUserId: 'u1' }],
        [{ type: 'invite.revoked', outcome: 'success', metadata: { inviteId: 'inv-1' } }, { actorUserId: 'u1' }],
        [{ type: 'invite.consumed', outcome: 'success', metadata: { inviteId: 'inv-1', userId: 'u2' } }, { subjectUserId: 'u2' }],
        [{ type: 'invite.rejected', outcome: 'rejected', metadata: { reason: 'expired' } }, {}],
        [{ type: 'account.created', outcome: 'success', metadata: { userId: 'u2' } }, {}],
        [{ type: 'account.disabled', outcome: 'success', metadata: { userId: 'u2' } }, { actorUserId: 'u1', subjectUserId: 'u2' }],
        [{ type: 'account.enabled', outcome: 'success', metadata: { userId: 'u2' } }, { actorUserId: 'u1', subjectUserId: 'u2' }],
        [{ type: 'admin.protection_rejected', outcome: 'rejected', metadata: { reason: 'sole_admin' } }, { actorUserId: 'u1' }],
        [{ type: 'password.recovered', outcome: 'success', metadata: { userId: 'u1' } }, {}],
        [{ type: 'session.created', outcome: 'success', metadata: { sessionId: 's1' } }, {}],
        [{ type: 'session.logout', outcome: 'success', metadata: { sessionId: 's1' } }, {}],
        [{ type: 'session.logout_all', outcome: 'success', metadata: { userId: 'u2', count: 3 } }, {}],
        [{ type: 'session.admin_revoked', outcome: 'success', metadata: { userId: 'u2', count: 2 } }, { actorUserId: 'u1' }],
        [{ type: 'session.expired', outcome: 'failure', metadata: { sessionId: 's2' } }, {}],
        [{ type: 'provider.saved', outcome: 'success', metadata: { campaignId: 'c1' } }, {}],
        [{ type: 'provider.test', outcome: 'success', metadata: { ok: true } }, {}],
        [{ type: 'maintenance.entered', outcome: 'success', metadata: { state: 'draining', epoch: 1 } }, {}],
        [{ type: 'maintenance.exited', outcome: 'success', metadata: { epoch: 2 } }, {}],
        [{ type: 'security.cutover', outcome: 'success', metadata: { backupVerified: true } }, {}],
      ];
      await db.transaction(async (tx) => {
        for (const [event, actor] of events) {
          await writer.writeIn(tx, event, actor);
        }
      });
      const rows = await db.query<{ event_type: string; outcome: string }>('SELECT event_type, outcome FROM platform_security_audit_events');
      expect(rows.length).toBe(events.length);
      expect(parseAuditEvent(events[0][0])).toBeTruthy();
    } finally {
      await db.close();
    }
  });

  it('rejects unknown event types and unknown metadata keys (strict)', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      const writer = new SecurityAuditWriter();
      await db.transaction(async (tx) => {
        await expect(writer.writeIn(tx, {
          type: 'bogus.event',
          outcome: 'success',
          metadata: {},
        } as unknown as SecurityAuditEvent)).rejects.toThrow(AuditMetadataError);
        await expect(writer.writeIn(tx, {
          type: 'session.logout',
          outcome: 'success',
          metadata: { sessionId: 's1', extra: 'x' },
        } as unknown as SecurityAuditEvent)).rejects.toThrow(AuditMetadataError);
      });
      const rows = await db.query('SELECT COUNT(*) AS c FROM platform_security_audit_events');
      expect((rows[0] as { c: number }).c).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe('recursive secret sentinel', () => {
  it('rejects nested secrets in field names and values', () => {
    const negatives: unknown[] = [
      { apiKey: 'sk-abc' },
      { token: 'abc' },
      { csrf: 'abc' },
      { password: 'hunter2' },
      { nested: { password: 'x' } },
      { outer: [{ inner: { api_key: 'y' } }] },
      { snapshot: {} },
      { context: {} },
      { data: 'Bearer abcdef' },
      { body: 'raw' },
      { secretValue: 'top-secret' },
    ];
    for (const sample of negatives) {
      expect(() => assertAuditMetadataSafe(sample), JSON.stringify(sample)).toThrow(AuditMetadataError);
    }
  });

  it('accepts per-event coarse metadata (ids/counts/enums) without false positives', () => {
    const positives: unknown[] = [
      { accountId: 'u1' },
      { userId: 'u2', count: 3 },
      { inviteId: 'inv-1' },
      { sessionId: 's-1' },
      { campaignId: 'c1' },
      { ok: true },
      { state: 'draining', epoch: 1 },
      { reason: 'expired' },
      { backupVerified: true },
      { total: 5, role: 'admin' },
    ];
    for (const sample of positives) {
      expect(() => assertAuditMetadataSafe(sample), JSON.stringify(sample)).not.toThrow();
    }
  });

  it('does not stringify raw payload in the error', () => {
    let message = '';
    try {
      assertAuditMetadataSafe({ token: 'super-secret-value-xyz' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('super-secret-value-xyz');
  });
});

describe('SecurityAuditWriter surface', () => {
  it('exposes only writeIn (no update/delete mutation methods)', () => {
    const writer = new SecurityAuditWriter();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(writer)).filter((m) => m !== 'constructor');
    expect(methods).toEqual(['writeIn']);
  });
});
