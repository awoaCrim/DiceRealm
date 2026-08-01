import type { AppErrorCode } from '@dnd/contracts';
import { appErrorCodes } from '@dnd/contracts';

const DEFAULT_HTTP_STATUS: Record<AppErrorCode, number> = {
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  CAMPAIGN_NOT_FOUND: 404,
  TURN_NOT_ACTIVE: 409,
  TURN_LOCKED: 409,
  CHARACTER_NOT_APPROVED: 403,
  AI_PROVIDER_FAILED: 502,
  AI_OUTPUT_INVALID: 422,
  STATE_CONFLICT: 409,
  REALTIME_DISCONNECTED: 409,
  VALIDATION_ERROR: 400,
  INTERNAL_ERROR: 500,
  NOT_FOUND: 404,
};

/**
 * 服务端统一应用错误。code 必须是 @dnd/contracts 中定义的 AppErrorCode；
 * status 为对应 HTTP 状态码（可覆盖），message 为面向用户的提示文案。
 * HTTP 错误中间件把该错误转换为 `{ "error": { code, message } }`。
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;

  constructor(code: AppErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? DEFAULT_HTTP_STATUS[code];
  }

  static from(code: AppErrorCode, message: string, status?: number): AppError {
    return new AppError(code, message, status);
  }
}

/** 便于测试与路由层判定：错误 code 是否为契约内的 AppErrorCode。 */
export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === 'string' && (appErrorCodes as readonly string[]).includes(value);
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
