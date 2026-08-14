import type { AuthenticatedUser, SessionUser } from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import { AppError } from '../../platform/http/AppError.js';
import type { SecurityAuditEvent } from '../security-audit/SecurityAuditEvent.js';
import { SecurityAuditWriter, type AuditActor } from '../security-audit/SecurityAuditWriter.js';
import type { StoredSecureSessionRow, StoredUserRow } from './IdentityRepository.js';
import { IdentityRepository, generateUserId } from './IdentityRepository.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from './passwords.js';
import {
  createRawSessionSecret,
  createSessionSecrets,
  digestSessionSecret,
  type RandomBytes,
} from './sessionTokens.js';

export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 12 * 60 * 60 * 1000;

export interface User extends SessionUser {}
export interface RegisterInput { login: string; password: string }
export interface LoginInput { login: string; password: string }

export interface SessionCookieMaterial {
  internalSessionId: string;
  rawToken: string;
  rawCsrfToken: string;
}

export interface LoginResult {
  publicSession: { expiresAt: string };
  cookieMaterial: SessionCookieMaterial;
}

export interface ResolvedSession extends AuthenticatedUser {
  internalSessionId: string;
  authRevision: number;
  revokeEpoch: number;
  csrfDigest: string;
}

export interface SessionAuditWriter {
  writeIn(tx: QueryExecutor, event: SecurityAuditEvent, actor?: AuditActor): Promise<void>;
}

export interface SessionRevocationNotifier {
  revokeSession(internalSessionId: string): void;
  revokeUser(userId: string): void;
}

export interface IdentityServiceOptions {
  clock?: () => Date;
  randomBytes?: RandomBytes;
  passwordVerifier?: (password: string, storedHash: string) => Promise<boolean>;
  auditWriter?: SessionAuditWriter;
  revocationNotifier?: SessionRevocationNotifier;
}

/** Account and digest-session lifecycle. Raw token material never crosses the route-private result. */
export class IdentityService {
  private readonly repository: IdentityRepository;
  private readonly database: DatabasePort | null;
  private readonly clock: () => Date;
  private readonly randomBytes: RandomBytes | undefined;
  private readonly passwordVerifier: (password: string, storedHash: string) => Promise<boolean>;
  private readonly auditWriter: SessionAuditWriter;
  private readonly revocationNotifier: SessionRevocationNotifier | undefined;

  constructor(executor: QueryExecutor, options: IdentityServiceOptions = {}) {
    this.repository = new IdentityRepository(executor);
    this.database = isDatabasePort(executor) ? executor : null;
    this.clock = options.clock ?? (() => new Date());
    this.randomBytes = options.randomBytes;
    this.passwordVerifier = options.passwordVerifier ?? verifyPassword;
    this.auditWriter = options.auditWriter ?? new SecurityAuditWriter();
    this.revocationNotifier = options.revocationNotifier;
  }

  async register(input: RegisterInput): Promise<User> {
    const login = normalizeLogin(input.login);
    if (await this.repository.findByLogin(login)) {
      throw new AppError('AUTH_REQUIRED', '该登录名已被注册。');
    }
    assertPasswordPolicy(input.password);
    const id = generateUserId();
    const now = this.clock().toISOString();
    const passwordHash = await hashPassword(input.password);
    try {
      await this.repository.insertUser(id, login, passwordHash, now);
    } catch {
      throw new AppError('AUTH_REQUIRED', '该登录名已被注册。');
    }
    return { userId: id, login };
  }

  async login(input: LoginInput): Promise<LoginResult> {
    if (!this.database) {
      throw new Error('安全 session login 需要支持事务的 DatabasePort。');
    }
    const login = normalizeLogin(input.login);
    const initiallyReadUser = await this.repository.findByLogin(login);
    if (
      !initiallyReadUser
      || initiallyReadUser.status !== 'active'
      || !(await this.passwordVerifier(input.password, initiallyReadUser.password_hash))
    ) {
      throw new AppError('AUTH_REQUIRED', '登录名或密码错误。');
    }

    const now = this.clock();
    const absoluteExpiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS).toISOString();
    const idleExpiresAt = new Date(now.getTime() + SESSION_IDLE_TTL_MS).toISOString();
    const secrets = createSessionSecrets(this.randomBytes);

    await this.runTransaction(async (repository) => {
      // This authoritative transaction-time re-read is the login linearization point. Rechecking the
      // password hash also prevents a concurrent password recovery/change from authorizing stale input.
      const authoritativeUser = await repository.findById(initiallyReadUser.id);
      if (
        !authoritativeUser
        || authoritativeUser.status !== 'active'
        || authoritativeUser.login !== login
        || !(await this.passwordVerifier(input.password, authoritativeUser.password_hash))
      ) {
        throw new AppError('AUTH_REQUIRED', '登录名或密码错误。');
      }
      await repository.insertSecureSession({
        id: secrets.internalSessionId,
        userId: authoritativeUser.id,
        tokenDigest: secrets.tokenDigest,
        csrfDigest: secrets.csrfDigest,
        capturedAuthRevision: authoritativeUser.auth_revision,
        revokeEpoch: 0,
        absoluteExpiresAt,
        idleExpiresAt,
        lastSeenAt: now.toISOString(),
        createdAt: now.toISOString(),
      });
      await this.auditWriter.writeIn(
        repository.executor,
        { type: 'session.created', outcome: 'success', metadata: { sessionId: secrets.internalSessionId } },
        selfActor(authoritativeUser.id),
      );
    });

    return {
      publicSession: { expiresAt: absoluteExpiresAt },
      cookieMaterial: {
        internalSessionId: secrets.internalSessionId,
        rawToken: secrets.rawToken,
        rawCsrfToken: secrets.rawCsrfToken,
      },
    };
  }

  async logoutCurrent(internalSessionId: string): Promise<void> {
    if (!this.database) {
      throw new Error('安全 session logout 需要支持事务的 DatabasePort。');
    }
    if (!internalSessionId) return;
    const now = this.clock().toISOString();
    let revokedUserId: string | null = null;
    await this.runTransaction(async (repository) => {
      const row = await repository.findSecureSessionByInternalId(internalSessionId);
      if (!row || row.revoked_at !== null) return;
      if (!(await repository.revokeSession(internalSessionId, now))) return;
      await this.auditWriter.writeIn(
        repository.executor,
        { type: 'session.logout', outcome: 'success', metadata: { sessionId: internalSessionId } },
        selfActor(row.user_id),
      );
      revokedUserId = row.user_id;
    });
    if (revokedUserId !== null) this.notifyRevokedSession(internalSessionId);
  }

  async logoutAll(userId: string): Promise<number> {
    if (!this.database) {
      throw new Error('安全 session bulk logout 需要支持事务的 DatabasePort。');
    }
    const now = this.clock().toISOString();
    const count = await this.runTransaction(async (repository) => {
      if (!(await repository.advanceAuthRevision(userId))) return 0;
      const revokedCount = await repository.revokeAllUserSessions(userId, now);
      await this.auditWriter.writeIn(
        repository.executor,
        { type: 'session.logout_all', outcome: 'success', metadata: { userId, count: revokedCount } },
        selfActor(userId),
      );
      return revokedCount;
    });
    this.notifyRevokedUser(userId);
    return count;
  }

  async resolveSession(rawToken: string): Promise<ResolvedSession | null> {
    if (!rawToken) return null;
    if (!this.database) {
      throw new Error('安全 session resolve 需要支持事务的 DatabasePort。');
    }
    const tokenDigest = digestSessionSecret(rawToken);
    let expiredSessionId: string | null = null;
    const resolved = await this.runTransaction(async (repository) => {
      const row = await repository.findSecureSessionByDigest(tokenDigest);
      if (!row) return null;
      if (this.isInvalid(row)) {
        const result = await this.invalidateResolvedSessionIn(repository, row);
        if (result.revoked) expiredSessionId = row.id;
        return result.session;
      }
      if (await repository.readMaintenanceState() === 'quiescent') return resolvedSession(row);

      const now = this.clock();
      const idleExpiresAt = new Date(now.getTime() + SESSION_IDLE_TTL_MS).toISOString();
      if (!(await repository.updateLastSeenIfCurrent(row, now.toISOString(), idleExpiresAt))) return null;
      return resolvedSession({ ...row, last_seen_at: now.toISOString(), idle_expires_at: idleExpiresAt });
    });
    if (expiredSessionId !== null) this.notifyRevokedSession(expiredSessionId);
    return resolved;
  }

  /** Side-effect-free lookup for authenticated CSRF revalidation, serialized with revocations. */
  async resolveSessionForCsrf(rawToken: string): Promise<ResolvedSession | null> {
    if (!rawToken) return null;
    if (!this.database) {
      throw new Error('安全 session CSRF resolve 需要支持 readCommitted 的 DatabasePort。');
    }
    return this.database.readCommitted(async (reader) => {
      const row = await IdentityRepository.readSecureSessionByDigest(reader, digestSessionSecret(rawToken));
      if (!row || this.isInvalid(row)) return null;
      return resolvedSession(row);
    });
  }

  private isInvalid(row: StoredSecureSessionRow): boolean {
    const now = this.clock();
    return row.user_status !== 'active'
      || row.revoked_at !== null
      || row.captured_auth_revision !== row.user_auth_revision
      || isExpired(row.absolute_expires_at, now)
      || isExpired(row.idle_expires_at, now);
  }

  private async invalidateResolvedSessionIn(
    repository: IdentityRepository,
    current: StoredSecureSessionRow,
  ): Promise<{ session: null; revoked: boolean }> {
    if (current.revoked_at !== null) return { session: null, revoked: false };
    if (await repository.readMaintenanceState() === 'quiescent') return { session: null, revoked: false };
    const now = this.clock().toISOString();
    if (!(await repository.revokeSession(current.id, now))) return { session: null, revoked: false };
    await this.auditWriter.writeIn(
      repository.executor,
      { type: 'session.expired', outcome: 'success', metadata: { sessionId: current.id } },
      selfActor(current.user_id),
    );
    return { session: null, revoked: true };
  }

  /** Missing-CSRF-cookie recovery: conditional update makes concurrent rotation deterministic. */
  async recoverCsrf(internalSessionId: string, expectedDigest: string): Promise<string | null> {
    const raw = createRawSessionSecret(this.randomBytes);
    const updated = await this.runTransaction((repository) =>
      repository.rotateCsrfDigest(internalSessionId, expectedDigest, digestSessionSecret(raw)));
    return updated ? raw : null;
  }

  async findUserById(id: string): Promise<StoredUserRow | null> {
    return this.repository.findById(id);
  }

  private notifyRevokedSession(internalSessionId: string): void {
    try { this.revocationNotifier?.revokeSession(internalSessionId); }
    catch { /* Revocation is already durable; notification is best-effort and must not change HTTP semantics. */ }
  }

  private notifyRevokedUser(userId: string): void {
    try { this.revocationNotifier?.revokeUser(userId); }
    catch { /* Revocation is already durable; notification is best-effort and must not change HTTP semantics. */ }
  }

  private async runTransaction<T>(work: (repository: IdentityRepository) => Promise<T>): Promise<T> {
    if (!this.database) return work(this.repository);
    return this.database.transaction((tx) => work(new IdentityRepository(tx)));
  }
}

function normalizeLogin(login: string): string {
  const trimmed = typeof login === 'string' ? login.trim().toLowerCase() : '';
  if (!trimmed) throw new AppError('AUTH_REQUIRED', '登录名不能为空。');
  return trimmed;
}

function isExpired(value: string, now: Date): boolean {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) || parsed <= now.getTime();
}

function resolvedSession(row: StoredSecureSessionRow): ResolvedSession {
  return {
    userId: row.user_id,
    login: row.login,
    internalSessionId: row.id,
    authRevision: row.user_auth_revision,
    revokeEpoch: row.revoke_epoch,
    csrfDigest: row.csrf_digest,
  };
}

function selfActor(userId: string): AuditActor {
  return { actorUserId: userId, subjectUserId: userId };
}

function isDatabasePort(executor: QueryExecutor): executor is DatabasePort {
  return typeof (executor as Partial<DatabasePort>).transaction === 'function';
}
