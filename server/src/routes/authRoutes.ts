import { Router } from 'express';
import type { Request, Response } from 'express';
import { loginInputSchema, registerInputSchema } from '@dnd/contracts';
import type { IdentityService } from '../modules/identity/IdentityService.js';
import { asyncHandler } from '../platform/http/errorMiddleware.js';
import {
  getAuthContext,
  readSessionId,
  requireAuth,
  SESSION_COOKIE_NAME,
  type AuthenticatedRequest,
} from '../platform/http/sessionMiddleware.js';

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

/**
 * 认证路由：注册、登录、注销与当前用户。
 * 路由只解析请求、调用 service、设置会话 cookie，不包含任何业务逻辑。
 */
export function createAuthRouter(identity: IdentityService): Router {
  const router = Router();

  router.post(
    '/register',
    asyncHandler(async (req: Request, res: Response) => {
      const input = registerInputSchema.parse(req.body);
      const user = await identity.register(input);
      res.status(201).json({ user });
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (req: Request, res: Response) => {
      const input = loginInputSchema.parse(req.body);
      const session = await identity.login(input);
      res.cookie(SESSION_COOKIE_NAME, session.sessionId, COOKIE_OPTIONS);
      res.json({ session: { sessionId: session.sessionId, expiresAt: session.expiresAt } });
    }),
  );

  router.post(
    '/logout',
    requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = readSessionId(req);
      await identity.logout(sessionId);
      res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      res.json({ ok: true });
    }),
  );

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const context = getAuthContext(req);
      const sessionUser = (req as AuthenticatedRequest).sessionUser;
      res.json({
        user: {
          userId: context.userId,
          login: sessionUser?.login ?? '',
        },
      });
    }),
  );

  return router;
}
