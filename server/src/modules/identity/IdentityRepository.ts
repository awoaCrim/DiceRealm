import { nanoid } from 'nanoid';
import type { QueryExecutor, QueryReader } from '../../platform/database/DatabasePort.js';

export interface StoredUserRow {
  id: string;
  login: string;
  password_hash: string;
  created_at: string;
  status: 'active' | 'disabled';
  auth_revision: number;
}

export interface StoredSecureSessionRow {
  id: string;
  user_id: string;
  login: string;
  token_digest: string;
  csrf_digest: string;
  captured_auth_revision: number;
  user_auth_revision: number;
  user_status: 'active' | 'disabled';
  revoke_epoch: number;
  revoked_at: string | null;
  absolute_expires_at: string;
  idle_expires_at: string;
  last_seen_at: string;
}

export interface SecureSessionInsert {
  id: string;
  userId: string;
  tokenDigest: string;
  csrfDigest: string;
  capturedAuthRevision: number;
  revokeEpoch: number;
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  lastSeenAt: string;
  createdAt: string;
}

/** Identity persistence constrained to the additive 013 secure-session columns. */
export class IdentityRepository {
  constructor(readonly executor: QueryExecutor) {}

  async findByLogin(login: string): Promise<StoredUserRow | null> {
    const rows = await this.executor.query<StoredUserRow>(
      'SELECT id, login, password_hash, created_at, status, auth_revision FROM users WHERE login = ?',
      [login],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<StoredUserRow | null> {
    const rows = await this.executor.query<StoredUserRow>(
      'SELECT id, login, password_hash, created_at, status, auth_revision FROM users WHERE id = ?',
      [id],
    );
    return rows[0] ?? null;
  }

  async insertUser(id: string, login: string, passwordHash: string, now: string): Promise<void> {
    await this.executor.execute(
      'INSERT INTO users (id, login, password_hash, created_at) VALUES (?, ?, ?, ?)',
      [id, login, passwordHash, now],
    );
  }

  async findSecureSessionByDigest(tokenDigest: string): Promise<StoredSecureSessionRow | null> {
    return IdentityRepository.readSecureSessionByDigest(this.executor, tokenDigest);
  }

  static async readSecureSessionByDigest(
    reader: QueryReader,
    tokenDigest: string,
  ): Promise<StoredSecureSessionRow | null> {
    const rows = await reader.query<StoredSecureSessionRow>(
      `SELECT s.id, s.user_id, u.login, s.token_digest, s.csrf_digest,
              s.captured_auth_revision, u.auth_revision AS user_auth_revision,
              u.status AS user_status, s.revoke_epoch, s.revoked_at,
              s.absolute_expires_at, s.idle_expires_at, s.last_seen_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_digest = ?
          AND s.csrf_digest IS NOT NULL
          AND s.captured_auth_revision IS NOT NULL
          AND s.absolute_expires_at IS NOT NULL
          AND s.idle_expires_at IS NOT NULL
          AND s.last_seen_at IS NOT NULL`,
      [tokenDigest],
    );
    return rows[0] ?? null;
  }

  async findSecureSessionByInternalId(internalSessionId: string): Promise<StoredSecureSessionRow | null> {
    const rows = await this.executor.query<StoredSecureSessionRow>(
      `SELECT s.id, s.user_id, u.login, s.token_digest, s.csrf_digest,
              s.captured_auth_revision, u.auth_revision AS user_auth_revision,
              u.status AS user_status, s.revoke_epoch, s.revoked_at,
              s.absolute_expires_at, s.idle_expires_at, s.last_seen_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?
          AND s.token_digest IS NOT NULL
          AND s.csrf_digest IS NOT NULL
          AND s.captured_auth_revision IS NOT NULL
          AND s.absolute_expires_at IS NOT NULL
          AND s.idle_expires_at IS NOT NULL
          AND s.last_seen_at IS NOT NULL`,
      [internalSessionId],
    );
    return rows[0] ?? null;
  }

  async insertSecureSession(input: SecureSessionInsert): Promise<void> {
    await this.executor.execute(
      `INSERT INTO sessions
         (id, user_id, expires_at, created_at, token_digest, csrf_digest,
          captured_auth_revision, revoke_epoch, revoked_at, absolute_expires_at,
          idle_expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        input.id,
        input.userId,
        input.absoluteExpiresAt,
        input.createdAt,
        input.tokenDigest,
        input.csrfDigest,
        input.capturedAuthRevision,
        input.revokeEpoch,
        input.absoluteExpiresAt,
        input.idleExpiresAt,
        input.lastSeenAt,
      ],
    );
  }

  async updateLastSeenIfCurrent(
    row: StoredSecureSessionRow,
    lastSeenAt: string,
    idleExpiresAt: string,
  ): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE sessions SET last_seen_at = ?, idle_expires_at = ?
        WHERE id = ?
          AND token_digest = ?
          AND csrf_digest = ?
          AND captured_auth_revision = ?
          AND revoke_epoch = ?
          AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1 FROM users u
             WHERE u.id = sessions.user_id
               AND u.status = 'active'
               AND u.auth_revision = sessions.captured_auth_revision
          )`,
      [
        lastSeenAt,
        idleExpiresAt,
        row.id,
        row.token_digest,
        row.csrf_digest,
        row.captured_auth_revision,
        row.revoke_epoch,
      ],
    );
    return result.changes === 1;
  }

  async revokeSession(internalSessionId: string, now: string): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE sessions
          SET revoked_at = ?, revoke_epoch = revoke_epoch + 1
        WHERE id = ? AND revoked_at IS NULL`,
      [now, internalSessionId],
    );
    return result.changes === 1;
  }

  async advanceAuthRevision(userId: string): Promise<boolean> {
    const result = await this.executor.execute(
      'UPDATE users SET auth_revision = auth_revision + 1 WHERE id = ?',
      [userId],
    );
    return result.changes === 1;
  }

  async revokeAllUserSessions(userId: string, now: string): Promise<number> {
    const result = await this.executor.execute(
      `UPDATE sessions
          SET revoked_at = ?, revoke_epoch = revoke_epoch + 1
        WHERE user_id = ? AND revoked_at IS NULL`,
      [now, userId],
    );
    return result.changes;
  }

  async readMaintenanceState(): Promise<'active' | 'draining' | 'quiescent'> {
    const rows = await this.executor.query<{ maintenance_state: 'active' | 'draining' | 'quiescent' }>(
      'SELECT maintenance_state FROM platform_instance WHERE singleton_id = 1',
    );
    // Compatibility for in-memory/unit databases without the enrolled singleton. Production startup
    // gates never serve such a database, so tests retain the operationally-active behavior.
    return rows[0]?.maintenance_state ?? 'active';
  }

  async rotateCsrfDigest(internalSessionId: string, expectedDigest: string, nextDigest: string): Promise<boolean> {
    const result = await this.executor.execute(
      `UPDATE sessions SET csrf_digest = ?
        WHERE id = ? AND csrf_digest = ? AND revoked_at IS NULL`,
      [nextDigest, internalSessionId, expectedDigest],
    );
    return result.changes === 1;
  }
}

export function generateUserId(): string {
  return nanoid(24);
}
