import type { AuthenticatedUser, Session, SessionUser } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import type { StoredUserRow } from './IdentityRepository.js';
import { IdentityRepository, generateSessionId, generateUserId } from './IdentityRepository.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from './passwords.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

/** 注册结果的公开用户信息（不含密码哈希）。 */
export interface User extends SessionUser {}

export interface RegisterInput {
  login: string;
  password: string;
}

export interface LoginInput {
  login: string;
  password: string;
}

/**
 * IdentityService：账号注册、登录、会话解析与注销。
 * 所有持久化都通过 IdentityRepository（其内部使用 QueryExecutor 端口），
 * 业务层不接触任何 SQL 或驱动 API。
 */
export class IdentityService {
  private readonly repository: IdentityRepository;

  constructor(executor: QueryExecutor) {
    this.repository = new IdentityRepository(executor);
  }

  async register(input: RegisterInput): Promise<User> {
    const login = normalizeLogin(input.login);
    const existing = await this.repository.findByLogin(login);
    if (existing) {
      throw new AppError('AUTH_REQUIRED', '该登录名已被注册。');
    }
    assertPasswordPolicy(input.password);
    const id = generateUserId();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(input.password);
    try {
      await this.repository.insertUser(id, login, passwordHash, now);
    } catch {
      // 并发注册时唯一索引冲突。
      throw new AppError('AUTH_REQUIRED', '该登录名已被注册。');
    }
    return { userId: id, login };
  }

  async login(input: LoginInput): Promise<Session> {
    const login = normalizeLogin(input.login);
    const user = await this.repository.findByLogin(login);
    if (!user) {
      // 与密码错误返回同一错误，避免泄露登录名是否存在。
      throw new AppError('AUTH_REQUIRED', '登录名或密码错误。');
    }
    const ok = await verifyPassword(input.password, user.password_hash);
    if (!ok) {
      throw new AppError('AUTH_REQUIRED', '登录名或密码错误。');
    }
    const sessionId = generateSessionId();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await this.repository.insertSession(sessionId, user.id, expiresAt, now);
    return { sessionId, expiresAt };
  }

  async logout(sessionId: string): Promise<void> {
    if (sessionId) {
      await this.repository.deleteSession(sessionId);
    }
  }

  async resolveSession(sessionId: string): Promise<AuthenticatedUser | null> {
    if (!sessionId) {
      return null;
    }
    const row = await this.repository.findSession(sessionId);
    if (!row) {
      return null;
    }
    const expiresAt = Date.parse(row.expires_at);
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
      // 过期会话立即删除。
      await this.repository.deleteSession(sessionId);
      return null;
    }
    return { userId: row.user_id, login: row.login };
  }

  /** 供测试与内部使用的弱引用解析。 */
  async findUserById(id: string): Promise<StoredUserRow | null> {
    return this.repository.findById(id);
  }
}

function normalizeLogin(login: string): string {
  const trimmed = typeof login === 'string' ? login.trim().toLowerCase() : '';
  if (!trimmed) {
    throw new AppError('AUTH_REQUIRED', '登录名不能为空。');
  }
  return trimmed;
}
