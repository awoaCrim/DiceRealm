import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { IdentityService } from '../../modules/identity/IdentityService.js';
import { digestSessionSecret } from '../../modules/identity/sessionTokens.js';
import { AppError } from './AppError.js';
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from './authCookies.js';
import { getSessionBinding, readCookie } from './sessionMiddleware.js';

/** Minimal authenticated synchronizer check, before later global policy work. */
export function requireAuthenticatedCsrf(identity: IdentityService) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const binding = getSessionBinding(req);
      const current = await identity.resolveSessionForCsrf(readCookie(req, SESSION_COOKIE_NAME));
      const cookieToken = readCookie(req, CSRF_COOKIE_NAME);
      const headerToken = typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : '';
      if (!current || current.internalSessionId !== binding.internalSessionId
        || !cookieToken || !headerToken || cookieToken !== headerToken
        || !safeDigestEqual(digestSessionSecret(headerToken), current.csrfDigest)) {
        throw new AppError('CSRF_INVALID', 'CSRF 校验失败。');
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

function safeDigestEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
