import { z } from 'zod';

/** 认证与授权相关 contract。 */

export const roleSchema = z.enum(['owner', 'player']);

export type Role = z.infer<typeof roleSchema>;

export const sessionSchema = z.object({
  sessionId: z.string().min(1),
  expiresAt: z.string(),
});

export type Session = z.infer<typeof sessionSchema>;

export const authContextSchema = z.object({
  userId: z.string().min(1),
  role: roleSchema.optional(),
  playerId: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
});

/** 已解析的请求上下文：路由中间件填充后传给应用服务。 */
export type AuthContext = z.infer<typeof authContextSchema>;

export const authenticatedUserSchema = z.object({
  userId: z.string().min(1),
  login: z.string().min(1),
});

export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

export const registerInputSchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1),
});

export type RegisterInput = z.infer<typeof registerInputSchema>;

export const loginInputSchema = registerInputSchema;

export type LoginInput = z.infer<typeof loginInputSchema>;

/** 会话中间件填充到 AuthContext 的公开用户信息。 */
export const sessionUserSchema = z.object({
  userId: z.string().min(1),
  login: z.string().min(1),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;
