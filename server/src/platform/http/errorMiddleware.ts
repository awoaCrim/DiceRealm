import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { isAppError } from './AppError.js';

/**
 * 统一错误中间件：已挂载的全部平台 route 的错误都由此收敛。
 * 已知 AppError 转换为契约错误响应，其余错误收敛为安全响应，不泄漏堆栈/SQL/原始 HTML。
 * legacy 路由已在 Phase 1 删除，不再需要 prefix 转发分支。
 */
export const errorMiddleware: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (isAppError(error)) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '请求参数无效' } });
    return;
  }

  if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大。' } });
    return;
  }

  // 客户端可预期的 4xx（如 body-parser 的畸形 JSON），固定文案、不泄漏细节。
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
    res.status(error.status).json({ error: { code: 'VALIDATION_ERROR', message: '请求参数无效' } });
    return;
  }

  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
};

/**
 * 包装 async 路由处理器，把 rejection 交给错误中间件。
 * Express 5 虽然原生处理 async rejection，但当前 app 依赖 Express 5.2，
 * 显式包装可保证旧版本与同步路径行为一致。
 */
export function asyncHandler(
  handler: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
