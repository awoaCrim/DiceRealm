import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthContext } from '@dnd/contracts';
import { AppError } from './AppError.js';

export const SESSION_COOKIE_NAME = 'dnd_session';

/**
 * 从 HttpOnly session cookie（或 Authorization: Bearer，供非浏览器客户端）
 * 解析认证上下文。绝不信任 header 或 body 中的 userId。
 */
export function createSessionMiddleware(identity: {
  resolveSession(sessionId: string): Promise<{ userId: string; login: string } | null>;
}): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const sessionId = readSessionId(req);
      const sessionUser = sessionId ? await identity.resolveSession(sessionId) : null;
      if (sessionUser) {
        (req as AuthenticatedRequest).sessionUser = sessionUser;
        (req as AuthenticatedRequest).authContext = {
          userId: sessionUser.userId,
          role: undefined,
          playerId: undefined,
          campaignId: undefined,
        };
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** 认证中间件：未登录请求直接拒绝，不允许继续访问受保护路由。 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const context = (req as AuthenticatedRequest).authContext;
  if (!context?.userId) {
    next(new AppError('AUTH_REQUIRED', '请先登录。'));
    return;
  }
  next();
}

export interface AuthenticatedRequest extends Request {
  authContext?: AuthContext;
  sessionUser?: { userId: string; login: string };
}

export function getAuthContext(req: Request): AuthContext {
  const context = (req as AuthenticatedRequest).authContext;
  if (!context?.userId) {
    throw new AppError('AUTH_REQUIRED', '请先登录。');
  }
  return context;
}

/** 返回请求携带的会话 id（cookie 优先，其次 Bearer）。 */
export function readSessionId(req: Request): string {
  const fromCookie = readCookie(req, SESSION_COOKIE_NAME);
  if (fromCookie) {
    return fromCookie;
  }
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }
  return '';
}

/** 手工解析 Cookie 头，避免引入 cookie-parser 依赖。 */
export function readCookie(req: Request, name: string): string {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || !header) {
    return '';
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === name) {
      return value;
    }
  }
  return '';
}
