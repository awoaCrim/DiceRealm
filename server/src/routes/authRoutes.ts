import { jsonBodyBudget } from '../platform/http/jsonBodyBudget.js';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { loginInputSchema, registerInputSchema } from '@dnd/contracts';
import type { IdentityService } from '../modules/identity/IdentityService.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import { clearAuthCookies, CSRF_COOKIE_NAME, setAuthCookies, setCsrfCookie } from '../platform/http/authCookies.js';
import { requireAuthenticatedCsrf } from '../platform/http/authenticatedCsrf.js';
import {
  getAuthContext,
  getSessionBinding,
  readCookie,
  requireAuth,
  type AuthenticatedRequest,
} from '../platform/http/sessionMiddleware.js';

export function createAuthRouter(identity: IdentityService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/register', jsonBodyBudget('auth'), asyncHandler(async (req: Request, res: Response) => {
    const input = registerInputSchema.parse(req.body);
    const user = await identity.register(input);
    res.status(201).json({ user });
  }));

  router.post('/login', jsonBodyBudget('auth'), asyncHandler(async (req: Request, res: Response) => {
    const input = loginInputSchema.parse(req.body);
    const result = await identity.login(input);
    setAuthCookies(res, result.cookieMaterial.rawToken, result.cookieMaterial.rawCsrfToken);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ session: result.publicSession });
  }));

  router.post('/logout', requireAuth, requireAuthenticatedCsrf(identity), asyncHandler(async (req: Request, res: Response) => {
    await identity.logoutCurrent(getSessionBinding(req).internalSessionId);
    clearAuthCookies(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  }));

  router.post('/logout-all', requireAuth, requireAuthenticatedCsrf(identity), asyncHandler(async (req: Request, res: Response) => {
    await identity.logoutAll(getAuthContext(req).userId);
    clearAuthCookies(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  }));

  router.get('/me', requireAuth, asyncHandler(async (req: Request, res: Response) => {
    const context = getAuthContext(req);
    const binding = getSessionBinding(req);
    if (!readCookie(req, CSRF_COOKIE_NAME)) {
      const recovered = await identity.recoverCsrf(binding.internalSessionId, binding.csrfDigest);
      if (recovered) setCsrfCookie(res, recovered);
    }
    const sessionUser = (req as AuthenticatedRequest).sessionUser;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ user: { userId: context.userId, login: sessionUser?.login ?? '' } });
  }));

  return router;
}
