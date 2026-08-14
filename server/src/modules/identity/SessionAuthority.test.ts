import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import type { DatabasePort } from '../../platform/database/DatabasePort.js';
import { IdentityService } from './IdentityService.js';
import { SessionAuthority, type SessionAuthorityBinding } from './SessionAuthority.js';

const viewer = { role: 'owner' as const, playerId: null };

describe('SessionAuthority', () => {
  it('uses side-effect-free authoritative state and fails closed for stale or checker-error bindings', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    try {
      const identity = new IdentityService(db);
      const user = await identity.register({ login: 'authority@example.test', password: 'correct-password' });
      const login = await identity.login({ login: user.login, password: 'correct-password' });
      const resolved = await identity.resolveSessionForCsrf(login.cookieMaterial.rawToken);
      const binding: SessionAuthorityBinding = {
        internalSessionId: resolved!.internalSessionId,
        userId: resolved!.userId,
        authRevision: resolved!.authRevision,
        revokeEpoch: resolved!.revokeEpoch,
        campaignId: 'campaign-authority',
        viewer,
      };
      const before = await db.query('SELECT last_seen_at, idle_expires_at, revoked_at, revoke_epoch FROM sessions');
      const authority = new SessionAuthority(db);

      await expect(authority.isCurrent(binding)).resolves.toBe(true);
      expect(await db.query('SELECT last_seen_at, idle_expires_at, revoked_at, revoke_epoch FROM sessions')).toEqual(before);

      await expect(authority.isCurrent({ ...binding, authRevision: 99 })).resolves.toBe(false);
      await expect(authority.isCurrent({ ...binding, userId: 'other-user' })).resolves.toBe(false);
      await db.execute("UPDATE users SET status = 'disabled' WHERE id = ?", [binding.userId]);
      await expect(authority.isCurrent(binding)).resolves.toBe(false);
      await db.execute("UPDATE users SET status = 'active', auth_revision = auth_revision + 1 WHERE id = ?", [binding.userId]);
      await expect(authority.isCurrent(binding)).resolves.toBe(false);
      await db.execute('UPDATE users SET auth_revision = ? WHERE id = ?', [binding.authRevision, binding.userId]);
      await db.execute("UPDATE sessions SET idle_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [binding.internalSessionId]);
      await expect(authority.isCurrent(binding)).resolves.toBe(false);
      await db.execute("UPDATE sessions SET idle_expires_at = '2099-01-01T00:00:00.000Z', revoke_epoch = revoke_epoch + 1 WHERE id = ?", [binding.internalSessionId]);
      await expect(authority.isCurrent(binding)).resolves.toBe(false);

      await db.execute('DELETE FROM sessions WHERE id = ?', [binding.internalSessionId]);
      await expect(authority.isCurrent(binding)).resolves.toBe(false);

      const throwing = new SessionAuthority({
        ...db,
        readCommitted: async () => { throw new Error('checker unavailable'); },
      } as unknown as DatabasePort);
      await expect(throwing.isCurrent(binding)).resolves.toBe(false);
    } finally {
      await db.close();
    }
  });
});
