import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthContext } from '@dnd/contracts';
import type { CampaignAuthContext } from '../../modules/campaigns/CampaignAccess.js';
import type { ResolvedSession } from '../../modules/identity/IdentityService.js';
import { AppError } from './AppError.js';
import { SESSION_COOKIE_NAME } from './authCookies.js';

/** Cookie-only auth. Authorization/Bearer is deliberately ignored. */
export function createSessionMiddleware(identity: {
  resolveSession(rawToken: string): Promise<ResolvedSession | null>;
}): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const rawToken = readCookie(req, SESSION_COOKIE_NAME);
      const sessionUser = rawToken ? await identity.resolveSession(rawToken) : null;
      if (sessionUser) {
        const request = req as AuthenticatedRequest;
        request.sessionUser = sessionUser;
        request.sessionBinding = sessionUser;
        request.authContext = {
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
  sessionBinding?: ResolvedSession;
  campaignContext?: CampaignAuthContext;
}

export function getAuthContext(req: Request): AuthContext {
  const context = (req as AuthenticatedRequest).authContext;
  if (!context?.userId) throw new AppError('AUTH_REQUIRED', '请先登录。');
  return context;
}

export function getSessionBinding(req: Request): ResolvedSession {
  const binding = (req as AuthenticatedRequest).sessionBinding;
  if (!binding) throw new AppError('AUTH_REQUIRED', '请先登录。');
  return binding;
}

export function readCookie(req: Request, name: string): string {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || !header) return '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}
