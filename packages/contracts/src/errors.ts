import { z } from 'zod';

/** 统一错误码：所有 HTTP 错误响应和前端恢复 UI 共享。 */
export const appErrorCodes = [
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'CAMPAIGN_NOT_FOUND',
  'TURN_NOT_ACTIVE',
  'TURN_LOCKED',
  'CHARACTER_NOT_APPROVED',
  'AI_PROVIDER_FAILED',
  'AI_OUTPUT_INVALID',
  'GM_ADJUDICATION_REQUIRED',
  'CREDENTIAL_ENCRYPTION_UNAVAILABLE',
  'CREDENTIAL_DECRYPTION_FAILED',
  'ACCOUNT_DISABLED',
  'CSRF_INVALID',
  'STATE_CONFLICT',
  'STALE_STATE_REVISION',
  'MUTATION_REPLAY',
  'REALTIME_DISCONNECTED',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
  'NOT_FOUND',
  'BOOTSTRAP_UNAVAILABLE',
  'INVITE_INVALID',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'MAINTENANCE_MODE',
] as const;

export type AppErrorCode = (typeof appErrorCodes)[number];

/** 统一错误响应体，路由层转换并返回给浏览器。 */
export const appErrorSchema = z.object({
  error: z.object({
    code: z.enum(appErrorCodes),
    message: z.string(),
  }),
});

export type AppError = z.infer<typeof appErrorSchema>;
