import { nanoid } from 'nanoid';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { AuthenticatedUser, Session, SessionUser } from '@dnd/contracts';

/**
 * 平台身份表行。password_hash 仅在服务内部使用，绝不通过 DTO 暴露。
 */
export interface StoredUserRow {
  id: string;
  login: string;
  password_hash: string;
  created_at: string;
}

export interface StoredSessionRow {
  id: string;
  user_id: string;
  login: string;
  expires_at: string;
}

/**
 * IdentityRepository：通过 QueryExecutor 端口访问平台身份表。
 * 业务规则（密码校验、会话过期策略）不属于本层。
 */
export class IdentityRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async findByLogin(login: string): Promise<StoredUserRow | null> {
    const rows = await this.executor.query<StoredUserRow>(
      'SELECT id, login, password_hash, created_at FROM users WHERE login = ?',
      [login],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<StoredUserRow | null> {
    const rows = await this.executor.query<StoredUserRow>(
      'SELECT id, login, password_hash, created_at FROM users WHERE id = ?',
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

  async findSession(sessionId: string): Promise<StoredSessionRow | null> {
    const rows = await this.executor.query<StoredSessionRow>(
      `SELECT s.id, s.user_id, u.login, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
      [sessionId],
    );
    return rows[0] ?? null;
  }

  async insertSession(sessionId: string, userId: string, expiresAt: string, now: string): Promise<void> {
    await this.executor.execute(
      'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [sessionId, userId, expiresAt, now],
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.executor.execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
  }
}

/** 生成不可猜测的 session id（URL 安全、默认 128 bits 熵）。 */
export function generateSessionId(): string {
  return nanoid(32);
}

/** 生成不可猜测的用户 id。 */
export function generateUserId(): string {
  return nanoid(24);
}
