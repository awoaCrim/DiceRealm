import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import type { SqliteDatabaseAdapter } from '../../platform/database/SqliteDatabaseAdapter.js';
import { IdentityService, type User } from './IdentityService.js';
import { hashPassword, verifyPassword } from './passwords.js';

/** 内存 SQLite 平台数据库（真实跑迁移）。 */
async function makeIdentityService(): Promise<{ db: SqliteDatabaseAdapter; service: IdentityService }> {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const service = new IdentityService(db);
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

  it('authenticates with the correct password and returns a session', async () => {
    const { db, service } = await registeredService();
    const session = await service.login({ login: 'owner@example.test', password: 'correct-password' });
    expect(session.sessionId).toBeTruthy();
    expect(session.expiresAt).toBeTruthy();

    const rows = await db.query<{ id: string; user_id: string; expires_at: string }>('SELECT id, user_id, expires_at FROM sessions WHERE id = ?', [session.sessionId]);
    expect(rows).toHaveLength(1);
    await db.close();
  });

  it('normalizes login case and surrounding whitespace', async () => {
    const { service } = await makeIdentityService();
    await registerUser(service, ' Owner@Example.TEST ');
    const session = await service.login({ login: 'owner@example.test', password: 'correct-password' });
    expect(session.sessionId).toBeTruthy();
  });

  it('resolves a live session to the authenticated user', async () => {
    const { service } = await registeredService();
    const user = await registerUser(service, 'resolve@example.test');
    const session = await service.login({ login: 'resolve@example.test', password: 'correct-password' });
    const resolved = await service.resolveSession(session.sessionId);
    expect(resolved).toEqual({ userId: user.userId, login: 'resolve@example.test' });
  });

  it('resolves null for an unknown session id', async () => {
    const { service } = await makeIdentityService();
    await expect(service.resolveSession('does-not-exist')).resolves.toBeNull();
  });

  it('resolves null for an expired session and deletes it', async () => {
    const { db, service } = await makeIdentityService();
    const user = await registerUser(service, 'expired@example.test');
    const now = Date.now();
    await db.execute(
      'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      ['expired-session', user.userId, new Date(now - 1000).toISOString(), new Date(now - 2000).toISOString()],
    );
    await expect(service.resolveSession('expired-session')).resolves.toBeNull();
    const remaining = await db.query<{ id: string }>('SELECT id FROM sessions WHERE id = ?', ['expired-session']);
    expect(remaining).toEqual([]);
    await db.close();
  });

  it('deletes a session on logout', async () => {
    const { db, service } = await registeredService();
    const session = await service.login({ login: 'owner@example.test', password: 'correct-password' });
    await service.logout(session.sessionId);
    await expect(service.resolveSession(session.sessionId)).resolves.toBeNull();
    const rows = await db.query<{ id: string }>('SELECT id FROM sessions WHERE id = ?', [session.sessionId]);
    expect(rows).toEqual([]);
    await db.close();
  });
});
