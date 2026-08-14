import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import type { DatabasePort, QueryExecutor, QueryReader } from '../../platform/database/DatabasePort.js';
import type { SqliteDatabaseAdapter } from '../../platform/database/SqliteDatabaseAdapter.js';
import type { AuditActor } from '../security-audit/SecurityAuditWriter.js';
import type { SecurityAuditEvent } from '../security-audit/SecurityAuditEvent.js';
import { IdentityService, type IdentityServiceOptions, type User } from './IdentityService.js';
import { hashPassword, verifyPassword } from './passwords.js';

class ControllableAuditWriter {
  readonly failingTypes = new Set<string>();

  async writeIn(_tx: QueryExecutor, event: SecurityAuditEvent, _actor?: AuditActor): Promise<void> {
    if (this.failingTypes.has(event.type)) throw new Error(`forced audit failure: ${event.type}`);
    const metadata = JSON.stringify(event.metadata);
    await _tx.execute(
      `INSERT INTO platform_security_audit_events
         (id, event_type, outcome, actor_user_id, subject_user_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`test-audit-${Date.now()}-${Math.random()}`, event.type, event.outcome,
        _actor?.actorUserId ?? null, _actor?.subjectUserId ?? null, metadata, new Date().toISOString()],
    );
  }
}

interface AuditRow {
  event_type: string;
  outcome: string;
  actor_user_id: string | null;
  subject_user_id: string | null;
  metadata_json: string;
}

class PausingAuthorityDatabase implements DatabasePort {
  private releaseAuthorityRead!: () => void;
  private authorityReadObserved!: () => void;
  readonly authorityRead = new Promise<void>((resolve) => { this.authorityReadObserved = resolve; });
  private readonly releaseGate = new Promise<void>((resolve) => { this.releaseAuthorityRead = resolve; });
  private paused = false;

  constructor(private readonly delegate: DatabasePort) {}

  query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.pauseAuthorityRead(this.delegate.query<T>(sql, params), sql);
  }

  execute(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    return this.delegate.execute(sql, params);
  }

  migrate(): Promise<void> { return this.delegate.migrate(); }
  close(): Promise<void> { return this.delegate.close(); }

  transaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    return this.delegate.transaction((tx) => work({
      query: <R>(sql: string, params?: unknown[]) => this.pauseAuthorityRead(tx.query<R>(sql, params), sql),
      execute: (sql: string, params?: unknown[]) => tx.execute(sql, params),
    }));
  }

  readCommitted<T>(work: (reader: QueryReader) => Promise<T>): Promise<T> {
    return this.delegate.readCommitted((reader) => work({
      query: <R>(sql: string, params?: unknown[]) => this.pauseAuthorityRead(reader.query<R>(sql, params), sql),
    }));
  }

  release(): void { this.releaseAuthorityRead(); }

  private async pauseAuthorityRead<T>(result: Promise<T>, sql: string): Promise<T> {
    const value = await result;
    if (!this.paused && sql.includes('FROM sessions s') && sql.includes('JOIN users u')) {
      this.paused = true;
      this.authorityReadObserved();
      await this.releaseGate;
    }
    return value;
  }
}

async function setMaintenanceState(
  db: QueryExecutor,
  state: 'active' | 'draining' | 'quiescent',
  now: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO platform_instance
       (singleton_id, database_id, enrollment_state, credential_key_fingerprint, enrollment_key_origin,
        maintenance_state, maintenance_epoch, platform_rules_revision, session_security_state,
        session_security_cutover_at, created_at, updated_at)
     VALUES (1, 'test-db', 'ready', ?, 'preexisting', ?, 1, 0, 'ready', ?, ?, ?)`,
    [`sha256:${'0'.repeat(64)}`, state, now, now, now],
  );
}

/** 内存 SQLite 平台数据库（真实跑迁移）。 */
async function makeIdentityService(options: IdentityServiceOptions = {}): Promise<{ db: SqliteDatabaseAdapter; service: IdentityService }> {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const service = new IdentityService(db, options);
  return { db, service };
}

async function registeredService(): Promise<{ db: SqliteDatabaseAdapter; service: IdentityService }> {
  const fixture = await makeIdentityService();
  await registerUser(fixture.service);
  return fixture;
}

async function registerUser(service: IdentityService, login = 'owner@example.test', password = 'correct-password'): Promise<User> {
  return service.register({ login, password });
}

describe('passwords', () => {
  it('hashes a password with a random salt and verifies it', async () => {
    const stored = await hashPassword('correct-password');
    expect(stored).not.toContain('correct-password');
    expect(stored.startsWith('scrypt$')).toBe(true);
    await expect(verifyPassword('correct-password', stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', stored)).resolves.toBe(false);
  });

  it('produces a different hash for the same password (random salt)', async () => {
    const a = await hashPassword('correct-password');
    const b = await hashPassword('correct-password');
    expect(a).not.toBe(b);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    await expect(verifyPassword('whatever', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('whatever', 'scrypt$10$10$1$!badbase64$too$many')).resolves.toBe(false);
  });

  it('enforces a minimum password length with VALIDATION_ERROR', async () => {
    const { service } = await makeIdentityService();
    await expect(service.register({ login: 'short@example.test', password: 'short' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });
});

describe('identity', () => {
  it('registers a user and stores a hash (not the plaintext password)', async () => {
    const { db, service } = await makeIdentityService();
    const user = await registerUser(service);
    expect(user.userId).toBeTruthy();
    expect(user.login).toBe('owner@example.test');

    const rows = await db.query<{ login: string; password_hash: string }>('SELECT login, password_hash FROM users WHERE id = ?', [user.userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].password_hash).not.toBe('correct-password');
    expect(rows[0].password_hash.startsWith('scrypt$')).toBe(true);
    await db.close();
  });

  it('rejects a duplicate login', async () => {
    const { db, service } = await registeredService();
    await expect(service.register({ login: 'owner@example.test', password: 'another-password' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await db.close();
  });

  it('does not authenticate with an invalid password', async () => {
    const { service } = await registeredService();
    await expect(service.login({ login: 'owner@example.test', password: 'wrong-password' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('rejects login for an unknown login with the same error code', async () => {
    const { service } = await makeIdentityService();
    await expect(service.login({ login: 'ghost@example.test', password: 'correct-password' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('stores only secure digests with the exact 013 columns and resolves by raw cookie token', async () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    const randomChunks = [Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3)];
    const { db, service } = await makeIdentityService({
      clock: () => now,
      randomBytes: () => randomChunks.shift()!,
    });
    const user = await registerUser(service);
    const login = await service.login({ login: user.login, password: 'correct-password' });

    expect(login.publicSession).toEqual({ expiresAt: '2026-08-19T00:00:00.000Z' });
    expect(login.cookieMaterial.rawToken).toBe(Buffer.alloc(32, 2).toString('base64url'));
    expect(login.cookieMaterial.rawCsrfToken).toBe(Buffer.alloc(32, 3).toString('base64url'));

    const rows = await db.query<{
      id: string; token_digest: string; csrf_digest: string; captured_auth_revision: number;
      revoke_epoch: number; revoked_at: string | null; expires_at: string; absolute_expires_at: string;
      idle_expires_at: string; last_seen_at: string;
    }>('SELECT id, token_digest, csrf_digest, captured_auth_revision, revoke_epoch, revoked_at, expires_at, absolute_expires_at, idle_expires_at, last_seen_at FROM sessions');
    expect(rows).toEqual([{
      id: Buffer.alloc(32, 1).toString('base64url'),
      token_digest: createHash('sha256').update(login.cookieMaterial.rawToken).digest('hex'),
      csrf_digest: createHash('sha256').update(login.cookieMaterial.rawCsrfToken).digest('hex'),
      captured_auth_revision: 0,
      revoke_epoch: 0,
      revoked_at: null,
      expires_at: '2026-08-19T00:00:00.000Z',
      absolute_expires_at: '2026-08-19T00:00:00.000Z',
      idle_expires_at: '2026-08-12T12:00:00.000Z',
      last_seen_at: '2026-08-12T00:00:00.000Z',
    }]);
    expect(JSON.stringify(rows)).not.toContain(login.cookieMaterial.rawToken);
    expect(JSON.stringify(rows)).not.toContain(login.cookieMaterial.rawCsrfToken);
    await expect(service.resolveSession(login.cookieMaterial.rawToken)).resolves.toMatchObject({
      userId: user.userId,
      login: user.login,
      internalSessionId: rows[0].id,
    });
    await db.close();
  });

  it('does not dual-read a legacy raw session id', async () => {
    const { db, service } = await makeIdentityService();
    const user = await registerUser(service);
    await db.execute(
      'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      ['legacy-raw-token', user.userId, '2099-01-01T00:00:00.000Z', '2026-08-12T00:00:00.000Z'],
    );
    await expect(service.resolveSession('legacy-raw-token')).resolves.toBeNull();
    await db.close();
  });

  it('rejects disabled, auth-revision-mismatched, idle-expired, absolute-expired, and revoked sessions', async () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    const { db, service } = await makeIdentityService({ clock: () => now });
    const user = await registerUser(service);

    for (const mutation of [
      "UPDATE users SET status = 'disabled' WHERE id = ?",
      'UPDATE users SET auth_revision = auth_revision + 1 WHERE id = ?',
      "UPDATE sessions SET idle_expires_at = '2026-08-11T23:59:59.000Z' WHERE user_id = ?",
      "UPDATE sessions SET absolute_expires_at = '2026-08-11T23:59:59.000Z' WHERE user_id = ?",
      "UPDATE sessions SET revoked_at = '2026-08-12T00:00:00.000Z' WHERE user_id = ?",
    ]) {
      await db.execute("UPDATE users SET status = 'active', auth_revision = 0 WHERE id = ?", [user.userId]);
      await db.execute('DELETE FROM sessions WHERE user_id = ?', [user.userId]);
      const session = await service.login({ login: user.login, password: 'correct-password' });
      await db.execute(mutation, [user.userId]);
      await expect(service.resolveSession(session.cookieMaterial.rawToken)).resolves.toBeNull();
    }
    await db.close();
  });

  it('makes concurrent CSRF recovery deterministic: exactly one conditional rotation wins', async () => {
    const chunks = [Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3), Buffer.alloc(32, 4), Buffer.alloc(32, 5)];
    const { db, service } = await makeIdentityService({ randomBytes: () => chunks.shift()! });
    const user = await registerUser(service);
    const session = await service.login({ login: user.login, password: 'correct-password' });
    const resolved = await service.resolveSession(session.cookieMaterial.rawToken);
    const results = await Promise.all([
      service.recoverCsrf(resolved!.internalSessionId, resolved!.csrfDigest),
      service.recoverCsrf(resolved!.internalSessionId, resolved!.csrfDigest),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.find(Boolean)!;
    const rows = await db.query<{ csrf_digest: string }>('SELECT csrf_digest FROM sessions');
    expect(rows[0].csrf_digest).toBe(createHash('sha256').update(winner).digest('hex'));
    await db.close();
  });

  it('authenticates with the correct password and returns a session', async () => {
    const { db, service } = await registeredService();
    const session = await service.login({ login: 'owner@example.test', password: 'correct-password' });
    expect(session.cookieMaterial.rawToken).toBeTruthy();
    expect(session.publicSession.expiresAt).toBeTruthy();

    const rows = await db.query<{ token_digest: string }>('SELECT token_digest FROM sessions');
    expect(rows).toHaveLength(1);
    await db.close();
  });

  it('normalizes login case and surrounding whitespace', async () => {
    const { service } = await makeIdentityService();
    await registerUser(service, ' Owner@Example.TEST ');
    const session = await service.login({ login: 'owner@example.test', password: 'correct-password' });
    expect(session.cookieMaterial.rawToken).toBeTruthy();
  });

  it('resolves a live session to the authenticated user', async () => {
    const { service } = await registeredService();
    const user = await registerUser(service, 'resolve@example.test');
    const session = await service.login({ login: 'resolve@example.test', password: 'correct-password' });
    const resolved = await service.resolveSession(session.cookieMaterial.rawToken);
    expect(resolved).toMatchObject({ userId: user.userId, login: 'resolve@example.test' });
  });

  it('resolves null for an unknown session id', async () => {
    const { service } = await makeIdentityService();
    await expect(service.resolveSession('does-not-exist')).resolves.toBeNull();
  });

  it('does not authenticate an expired legacy row', async () => {
    const { db, service } = await makeIdentityService();
    const user = await registerUser(service, 'expired@example.test');
    const now = Date.now();
    await db.execute(
      'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      ['expired-session', user.userId, new Date(now - 1000).toISOString(), new Date(now - 2000).toISOString()],
    );
    await expect(service.resolveSession('expired-session')).resolves.toBeNull();
    const remaining = await db.query<{ id: string }>('SELECT id FROM sessions WHERE id = ?', ['expired-session']);
    expect(remaining).toEqual([{ id: 'expired-session' }]);
    await db.close();
  });

  it('creates a session and coarse session.created audit atomically without secret metadata', async () => {
    const audit = new ControllableAuditWriter();
    const { db, service } = await makeIdentityService({ auditWriter: audit });
    const user = await registerUser(service);
    const session = await service.login({ login: user.login, password: 'correct-password' });
    const rows = await db.query<AuditRow>('SELECT event_type, outcome, actor_user_id, subject_user_id, metadata_json FROM platform_security_audit_events');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: 'session.created', outcome: 'success', actor_user_id: user.userId, subject_user_id: user.userId });
    expect(JSON.parse(rows[0].metadata_json)).toEqual({ sessionId: session.cookieMaterial.internalSessionId });
    expect(rows[0].metadata_json).not.toContain(session.cookieMaterial.rawToken);
    expect(rows[0].metadata_json).not.toContain(session.cookieMaterial.rawCsrfToken);
    expect(rows[0].metadata_json).not.toContain('correct-password');
    await db.close();
  });

  it('rolls back session creation when session.created audit fails', async () => {
    const audit = new ControllableAuditWriter();
    audit.failingTypes.add('session.created');
    const { db, service } = await makeIdentityService({ auditWriter: audit });
    const user = await registerUser(service);
    await expect(service.login({ login: user.login, password: 'correct-password' })).rejects.toThrow('forced audit failure');
    expect(await db.query('SELECT id FROM sessions')).toEqual([]);
    expect(await db.query('SELECT id FROM platform_security_audit_events')).toEqual([]);
    await db.close();
  });

  it('post-commit notifier failures never change logout-current, logout-all, or expiry outcomes', async () => {
    const throwingNotifier = {
      revokeSession: () => { throw new Error('forced notifier failure'); },
      revokeUser: () => { throw new Error('forced notifier failure'); },
    };
    const { db, service } = await makeIdentityService({ revocationNotifier: throwingNotifier });
    const user = await registerUser(service, 'notifier-failure@example.test');
    const first = await service.login({ login: user.login, password: 'correct-password' });
    const second = await service.login({ login: user.login, password: 'correct-password' });

    await expect(service.logoutCurrent(first.cookieMaterial.internalSessionId)).resolves.toBeUndefined();
    await expect(service.logoutAll(user.userId)).resolves.toBe(1);
    expect(await db.query<{ revoked: number }>('SELECT revoked_at IS NOT NULL AS revoked FROM sessions ORDER BY id'))
      .toEqual([{ revoked: 1 }, { revoked: 1 }]);
    await db.close();

    const now = new Date('2026-08-12T00:00:00.000Z');
    const expiry = await makeIdentityService({ clock: () => now, revocationNotifier: throwingNotifier });
    const expiringUser = await registerUser(expiry.service, 'notifier-expiry@example.test');
    const expiring = await expiry.service.login({ login: expiringUser.login, password: 'correct-password' });
    await expiry.db.execute("UPDATE sessions SET idle_expires_at = '2026-08-11T23:59:59.000Z' WHERE id = ?", [expiring.cookieMaterial.internalSessionId]);
    await expect(expiry.service.resolveSession(expiring.cookieMaterial.rawToken)).resolves.toBeNull();
    expect((await expiry.db.query<{ revoked: number }>('SELECT revoked_at IS NOT NULL AS revoked FROM sessions'))[0].revoked).toBe(1);
    await expiry.db.close();
  });

  it('emits revocation notifications only after commit and stays silent on audit rollback', async () => {
    const audit = new ControllableAuditWriter();
    const notifications: string[] = [];
    const { db, service } = await makeIdentityService({
      auditWriter: audit,
      revocationNotifier: {
        revokeSession: (id) => { notifications.push(`session:${id}`); },
        revokeUser: (id) => { notifications.push(`user:${id}`); },
      },
    });
    const user = await registerUser(service);
    const first = await service.login({ login: user.login, password: 'correct-password' });
    const second = await service.login({ login: user.login, password: 'correct-password' });

    audit.failingTypes.add('session.logout');
    await expect(service.logoutCurrent(first.cookieMaterial.internalSessionId)).rejects.toThrow('forced audit failure');
    expect(notifications).toEqual([]);
    audit.failingTypes.delete('session.logout');
    await service.logoutCurrent(first.cookieMaterial.internalSessionId);
    expect(notifications).toEqual([`session:${first.cookieMaterial.internalSessionId}`]);

    audit.failingTypes.add('session.logout_all');
    await expect(service.logoutAll(user.userId)).rejects.toThrow('forced audit failure');
    expect(notifications).toEqual([`session:${first.cookieMaterial.internalSessionId}`]);
    audit.failingTypes.delete('session.logout_all');
    await service.logoutAll(user.userId);
    expect(notifications).toEqual([`session:${first.cookieMaterial.internalSessionId}`, `user:${user.userId}`]);
    await expect(service.resolveSession(second.cookieMaterial.rawToken)).resolves.toBeNull();
    await db.close();
  });

  it('logout-current revokes only the current device, increments only its epoch, and audits atomically', async () => {
    const audit = new ControllableAuditWriter();
    const { db, service } = await makeIdentityService({ auditWriter: audit });
    const user = await registerUser(service);
    const first = await service.login({ login: user.login, password: 'correct-password' });
    const second = await service.login({ login: user.login, password: 'correct-password' });

    await service.logoutCurrent(first.cookieMaterial.internalSessionId);

    await expect(service.resolveSession(first.cookieMaterial.rawToken)).resolves.toBeNull();
    await expect(service.resolveSession(second.cookieMaterial.rawToken)).resolves.toMatchObject({ userId: user.userId, revokeEpoch: 0 });
    const sessions = await db.query<{ id: string; revoked_at: string | null; revoke_epoch: number }>(
      'SELECT id, revoked_at, revoke_epoch FROM sessions ORDER BY id',
    );
    expect(sessions.find((row) => row.id === first.cookieMaterial.internalSessionId)).toMatchObject({ revoke_epoch: 1 });
    expect(sessions.find((row) => row.id === first.cookieMaterial.internalSessionId)?.revoked_at).toBeTruthy();
    expect(sessions.find((row) => row.id === second.cookieMaterial.internalSessionId)).toMatchObject({ revoked_at: null, revoke_epoch: 0 });
    const logout = (await db.query<AuditRow>("SELECT event_type, outcome, actor_user_id, subject_user_id, metadata_json FROM platform_security_audit_events WHERE event_type = 'session.logout'"))[0];
    expect(logout).toMatchObject({ outcome: 'success', actor_user_id: user.userId, subject_user_id: user.userId });
    expect(JSON.parse(logout.metadata_json)).toEqual({ sessionId: first.cookieMaterial.internalSessionId });
    await db.close();
  });

  it('rolls back current logout and epoch when session.logout audit fails', async () => {
    const audit = new ControllableAuditWriter();
    const { db, service } = await makeIdentityService({ auditWriter: audit });
    const user = await registerUser(service);
    const session = await service.login({ login: user.login, password: 'correct-password' });
    audit.failingTypes.add('session.logout');
    await expect(service.logoutCurrent(session.cookieMaterial.internalSessionId)).rejects.toThrow('forced audit failure');
    await expect(service.resolveSession(session.cookieMaterial.rawToken)).resolves.toMatchObject({ userId: user.userId, revokeEpoch: 0 });
    expect((await db.query<{ revoked_at: string | null; revoke_epoch: number }>('SELECT revoked_at, revoke_epoch FROM sessions'))[0])
      .toEqual({ revoked_at: null, revoke_epoch: 0 });
    await db.close();
  });

  it('logout-all advances auth revision, revokes every live device, increments epochs, and writes one coarse audit', async () => {
    const audit = new ControllableAuditWriter();
    const { db, service } = await makeIdentityService({ auditWriter: audit });
    const user = await registerUser(service);
    const first = await service.login({ login: user.login, password: 'correct-password' });
    const second = await service.login({ login: user.login, password: 'correct-password' });

    await expect(service.logoutAll(user.userId)).resolves.toBe(2);

    await expect(service.resolveSession(first.cookieMaterial.rawToken)).resolves.toBeNull();
    await expect(service.resolveSession(second.cookieMaterial.rawToken)).resolves.toBeNull();
    expect((await db.query<{ auth_revision: number }>('SELECT auth_revision FROM users WHERE id = ?', [user.userId]))[0].auth_revision).toBe(1);
    expect(await db.query<{ revoked: number; revoke_epoch: number }>(
      'SELECT revoked_at IS NOT NULL AS revoked, revoke_epoch FROM sessions ORDER BY id',
    )).toEqual([{ revoked: 1, revoke_epoch: 1 }, { revoked: 1, revoke_epoch: 1 }]);
    const logoutAll = (await db.query<AuditRow>("SELECT event_type, outcome, actor_user_id, subject_user_id, metadata_json FROM platform_security_audit_events WHERE event_type = 'session.logout_all'"))[0];
    expect(logoutAll).toMatchObject({ outcome: 'success', actor_user_id: user.userId, subject_user_id: user.userId });
    expect(JSON.parse(logoutAll.metadata_json)).toEqual({ userId: user.userId, count: 2 });
    await db.close();
  });

  it('rolls back logout-all revision, revocations, and epochs when audit fails', async () => {
    const audit = new ControllableAuditWriter();
    const { db, service } = await makeIdentityService({ auditWriter: audit });
    const user = await registerUser(service);
    const first = await service.login({ login: user.login, password: 'correct-password' });
    const second = await service.login({ login: user.login, password: 'correct-password' });
    audit.failingTypes.add('session.logout_all');

    await expect(service.logoutAll(user.userId)).rejects.toThrow('forced audit failure');

    expect((await db.query<{ auth_revision: number }>('SELECT auth_revision FROM users WHERE id = ?', [user.userId]))[0].auth_revision).toBe(0);
    expect(await db.query<{ revoked_at: string | null; revoke_epoch: number }>('SELECT revoked_at, revoke_epoch FROM sessions ORDER BY id'))
      .toEqual([{ revoked_at: null, revoke_epoch: 0 }, { revoked_at: null, revoke_epoch: 0 }]);
    await expect(service.resolveSession(first.cookieMaterial.rawToken)).resolves.not.toBeNull();
    await expect(service.resolveSession(second.cookieMaterial.rawToken)).resolves.not.toBeNull();
    await db.close();
  });

  it('linearizes login after a concurrent logout-all and captures the transaction-time auth revision', async () => {
    let releaseFirstVerification!: () => void;
    let verificationStarted!: () => void;
    const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirstVerification = resolve; });
    let calls = 0;
    const { db, service } = await makeIdentityService({
      passwordVerifier: async (password, storedHash) => {
        calls += 1;
        if (calls === 1) {
          verificationStarted();
          await release;
        }
        return verifyPassword(password, storedHash);
      },
    });
    const user = await registerUser(service);

    const pendingLogin = service.login({ login: user.login, password: 'correct-password' });
    await started;
    await service.logoutAll(user.userId);
    releaseFirstVerification();
    const login = await pendingLogin;

    expect((await db.query<{ captured_auth_revision: number }>('SELECT captured_auth_revision FROM sessions'))[0].captured_auth_revision).toBe(1);
    await expect(service.resolveSession(login.cookieMaterial.rawToken)).resolves.toMatchObject({ authRevision: 1 });
    expect(calls).toBe(2);
    await db.close();
  });

  it.each([
    ['disabled account', "UPDATE users SET status = 'disabled' WHERE id = ?"],
    ['auth revision mismatch', 'UPDATE users SET auth_revision = auth_revision + 1 WHERE id = ?'],
    ['idle expiry', "UPDATE sessions SET idle_expires_at = '2026-08-11T23:59:59.000Z' WHERE user_id = ?"],
    ['absolute expiry', "UPDATE sessions SET absolute_expires_at = '2026-08-11T23:59:59.000Z' WHERE user_id = ?"],
  ])('normal resolve invalidates, audits, and notifies exactly once for %s', async (_label, mutation) => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    const audit = new ControllableAuditWriter();
    const notifications: string[] = [];
    const { db, service } = await makeIdentityService({
      clock: () => now,
      auditWriter: audit,
      revocationNotifier: {
        revokeSession: (id) => { notifications.push(id); },
        revokeUser: () => { throw new Error('unexpected user notification'); },
      },
    });
    const user = await registerUser(service);
    const session = await service.login({ login: user.login, password: 'correct-password' });
    await db.execute(mutation, [user.userId]);

    await expect(service.resolveSession(session.cookieMaterial.rawToken)).resolves.toBeNull();
    await expect(service.resolveSession(session.cookieMaterial.rawToken)).resolves.toBeNull();

    expect((await db.query<{ revoked_at: string | null; revoke_epoch: number }>('SELECT revoked_at, revoke_epoch FROM sessions'))[0])
      .toEqual({ revoked_at: now.toISOString(), revoke_epoch: 1 });
    const expired = await db.query<AuditRow>("SELECT event_type, outcome, actor_user_id, subject_user_id, metadata_json FROM platform_security_audit_events WHERE event_type = 'session.expired'");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ outcome: 'success', actor_user_id: user.userId, subject_user_id: user.userId });
    expect(JSON.parse(expired[0].metadata_json)).toEqual({ sessionId: session.cookieMaterial.internalSessionId });
    expect(expired[0].metadata_json).not.toContain(session.cookieMaterial.rawToken);
    expect(expired[0].metadata_json).not.toContain(session.cookieMaterial.rawCsrfToken);
    expect(notifications).toEqual([session.cookieMaterial.internalSessionId]);
    await db.close();
  });

  it('rolls back invalid-session cleanup and audit together and emits no notification when session.expired audit fails', async () => {
    const audit = new ControllableAuditWriter();
    const notifications: string[] = [];
    const { db, service } = await makeIdentityService({
      auditWriter: audit,
      revocationNotifier: {
        revokeSession: (id) => { notifications.push(id); },
        revokeUser: (id) => { notifications.push(id); },
      },
    });
    const user = await registerUser(service);
    const session = await service.login({ login: user.login, password: 'correct-password' });
    await db.execute("UPDATE users SET status = 'disabled' WHERE id = ?", [user.userId]);
    audit.failingTypes.add('session.expired');

    await expect(service.resolveSession(session.cookieMaterial.rawToken)).rejects.toThrow('forced audit failure');

    expect((await db.query<{ revoked_at: string | null; revoke_epoch: number }>('SELECT revoked_at, revoke_epoch FROM sessions'))[0])
      .toEqual({ revoked_at: null, revoke_epoch: 0 });
    expect(await db.query("SELECT id FROM platform_security_audit_events WHERE event_type = 'session.expired'"))
      .toEqual([]);
    expect(notifications).toEqual([]);
    await db.close();
  });

  it.each(['logout-current', 'logout-all'] as const)(
    'linearizes a valid resolve wholly before or after concurrent %s',
    async (revocation) => {
      let now = new Date('2026-08-12T00:00:00.000Z');
      const db = createSqliteDatabase(':memory:');
      await db.migrate();
      const pausingDb = new PausingAuthorityDatabase(db);
      const service = new IdentityService(pausingDb, { clock: () => now });
      const user = await registerUser(service);
      const session = await service.login({ login: user.login, password: 'correct-password' });
      now = new Date('2026-08-12T00:01:00.000Z');

      let revocationCommitted = false;
      let staleAfterRevocation = false;
      const resolving = service.resolveSession(session.cookieMaterial.rawToken).then((resolved) => {
        staleAfterRevocation = revocationCommitted && resolved !== null;
        return resolved;
      });
      await pausingDb.authorityRead;
      const revoking = (
        revocation === 'logout-current'
          ? service.logoutCurrent(session.cookieMaterial.internalSessionId)
          : service.logoutAll(user.userId)
      ).then(() => {
        revocationCommitted = true;
      });
      const revocationFinishedBeforeRelease = await Promise.race([
        revoking.then(() => true),
        new Promise<false>((resolve) => setImmediate(() => resolve(false))),
      ]);
      pausingDb.release();

      const resolved = await resolving;
      await revoking;
      expect(revocationFinishedBeforeRelease).toBe(false);
      expect(staleAfterRevocation).toBe(false);
      expect(resolved).toMatchObject({ userId: user.userId });
      await expect(service.resolveSession(session.cookieMaterial.rawToken)).resolves.toBeNull();
      await db.close();
    },
  );

  it('serializes side-effect-free CSRF authority reads against concurrent logout', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const pausingDb = new PausingAuthorityDatabase(db);
    const service = new IdentityService(pausingDb);
    const user = await registerUser(service);
    const session = await service.login({ login: user.login, password: 'correct-password' });

    let logoutCommitted = false;
    let staleAfterLogout = false;
    const resolving = service.resolveSessionForCsrf(session.cookieMaterial.rawToken).then((resolved) => {
      staleAfterLogout = logoutCommitted && resolved !== null;
      return resolved;
    });
    await pausingDb.authorityRead;
    const loggingOut = service.logoutCurrent(session.cookieMaterial.internalSessionId).then(() => {
      logoutCommitted = true;
    });
    const logoutFinishedBeforeRelease = await Promise.race([
      loggingOut.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    pausingDb.release();

    const resolved = await resolving;
    await loggingOut;
    expect(logoutFinishedBeforeRelease).toBe(false);
    expect(staleAfterLogout).toBe(false);
    expect(resolved).toMatchObject({ userId: user.userId });
    expect(await db.query("SELECT id FROM platform_security_audit_events WHERE event_type = 'session.expired'"))
      .toEqual([]);
    await db.close();
  });

  it('valid quiescent resolve returns the binding without changing session or audit columns', async () => {
    let now = new Date('2026-08-12T00:00:00.000Z');
    const { db, service } = await makeIdentityService({ clock: () => now });
    const user = await registerUser(service);
    const session = await service.login({ login: user.login, password: 'correct-password' });
    await setMaintenanceState(db, 'quiescent', now.toISOString());
    const beforeSession = await db.query('SELECT * FROM sessions');
    const beforeAudit = await db.query('SELECT * FROM platform_security_audit_events');
    now = new Date('2026-08-12T00:05:00.000Z');

    await expect(service.resolveSession(session.cookieMaterial.rawToken)).resolves.toMatchObject({ userId: user.userId });

    expect(await db.query('SELECT * FROM sessions')).toEqual(beforeSession);
    expect(await db.query('SELECT * FROM platform_security_audit_events')).toEqual(beforeAudit);
    await db.close();
  });

  it.each(['active', 'draining'] as const)('valid %s resolve conditionally refreshes last-seen and idle expiry', async (state) => {
    let now = new Date('2026-08-12T00:00:00.000Z');
    const { db, service } = await makeIdentityService({ clock: () => now });
    const user = await registerUser(service);
    const session = await service.login({ login: user.login, password: 'correct-password' });
    await setMaintenanceState(db, state, now.toISOString());
    now = new Date('2026-08-12T00:05:00.000Z');

    await expect(service.resolveSession(session.cookieMaterial.rawToken)).resolves.toMatchObject({ userId: user.userId });

    expect((await db.query<{ last_seen_at: string; idle_expires_at: string; revoked_at: string | null; revoke_epoch: number }>(
      'SELECT last_seen_at, idle_expires_at, revoked_at, revoke_epoch FROM sessions',
    ))[0]).toEqual({
      last_seen_at: '2026-08-12T00:05:00.000Z',
      idle_expires_at: '2026-08-12T12:05:00.000Z',
      revoked_at: null,
      revoke_epoch: 0,
    });
    expect(await db.query("SELECT id FROM platform_security_audit_events WHERE event_type = 'session.expired'"))
      .toEqual([]);
    await db.close();
  });

  it('quiescent invalid lookup performs zero session, audit, or notification writes', async () => {
    const now = new Date('2026-08-12T00:00:00.000Z');
    const audit = new ControllableAuditWriter();
    const notifications: string[] = [];
    const { db, service } = await makeIdentityService({
      clock: () => now,
      auditWriter: audit,
      revocationNotifier: {
        revokeSession: (id) => { notifications.push(id); },
        revokeUser: (id) => { notifications.push(id); },
      },
    });
    const user = await registerUser(service);
    const session = await service.login({ login: user.login, password: 'correct-password' });
    await db.execute("UPDATE sessions SET idle_expires_at = '2026-08-11T23:59:59.000Z' WHERE user_id = ?", [user.userId]);
    await setMaintenanceState(db, 'quiescent', now.toISOString());
    const beforeSession = await db.query('SELECT * FROM sessions');
    const beforeAudit = await db.query('SELECT * FROM platform_security_audit_events');

    await expect(service.resolveSession(session.cookieMaterial.rawToken)).resolves.toBeNull();

    expect(await db.query('SELECT * FROM sessions')).toEqual(beforeSession);
    expect(await db.query('SELECT * FROM platform_security_audit_events')).toEqual(beforeAudit);
    expect(notifications).toEqual([]);
    await db.close();
  });

  it('already-revoked and unknown rows never produce duplicate cleanup audit', async () => {
    const audit = new ControllableAuditWriter();
    const { db, service } = await makeIdentityService({ auditWriter: audit });
    const user = await registerUser(service);
    const session = await service.login({ login: user.login, password: 'correct-password' });
    await service.logoutCurrent(session.cookieMaterial.internalSessionId);
    await expect(service.resolveSession(session.cookieMaterial.rawToken)).resolves.toBeNull();
    await expect(service.resolveSession('unknown-token')).resolves.toBeNull();
    expect(await db.query("SELECT id FROM platform_security_audit_events WHERE event_type = 'session.expired'"))
      .toEqual([]);
    await db.close();
  });

  it('revokes a session on logout', async () => {
    const { db, service } = await registeredService();
    const session = await service.login({ login: 'owner@example.test', password: 'correct-password' });
    await service.logoutCurrent(session.cookieMaterial.internalSessionId);
    await expect(service.resolveSession(session.cookieMaterial.rawToken)).resolves.toBeNull();
    const rows = await db.query<{ revoked_at: string | null }>('SELECT revoked_at FROM sessions WHERE id = ?', [session.cookieMaterial.internalSessionId]);
    expect(rows[0].revoked_at).toBeTruthy();
    await db.close();
  });
});
