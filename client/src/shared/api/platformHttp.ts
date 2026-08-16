import { z } from 'zod';
import { appErrorSchema, type AppErrorCode } from '@dnd/contracts';

/** HTTP 平台层错误：统一错误 envelope 的 code/message 与 HTTP status。 */
export class PlatformHttpError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;

  constructor(code: AppErrorCode, message: string, status: number) {
    super(message);
    this.name = 'PlatformHttpError';
    this.code = code;
    this.status = status;
  }
}

export interface PlatformRequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  responseSchema: z.ZodType<T>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const NO_RETRY_CODES = new Set<AppErrorCode>([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'CAMPAIGN_NOT_FOUND',
  'VALIDATION_ERROR',
  'NOT_FOUND',
]);

/** 该错误是否不应自动重试（认证/权限/校验/不存在）。 */
export function shouldNotRetry(error: unknown): boolean {
  if (error instanceof PlatformHttpError) {
    return NO_RETRY_CODES.has(error.code) || [401, 403, 404].includes(error.status);
  }
  return false;
}

/**
 * 平台 HTTP 深模块：负责 JSON/credentials/超时/204/错误 envelope/contract parse。
 * 成功响应体必须通过 responseSchema 解析；错误正文永不拼接 stack/HTML。
 */
export async function platformRequest<T>(
  path: string,
  options: PlatformRequestOptions<T>,
): Promise<T> {
  const { method = 'GET', body, responseSchema, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (isStateChanging(method)) {
    const csrfToken = readCookie('__Host-dnd_csrf');
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
  }
  const response = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error: unknown) => {
    throw normalizeNetworkError(error);
  });

  if (response.status === 204) {
    return parseBody(undefined, responseSchema, response.status);
  }

  const text = await response.text();
  if (!response.ok) {
    throw parseErrorEnvelope(text, response.status);
  }
  if (text.length === 0) {
    return parseBody(undefined, responseSchema, response.status);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PlatformHttpError('INTERNAL_ERROR', '响应格式无效。', response.status);
  }
  return parseBody(json, responseSchema, response.status);
}

function parseBody<T>(body: unknown, schema: z.ZodType<T>, status: number): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new PlatformHttpError('INTERNAL_ERROR', '响应格式无效。', status);
  }
  return parsed.data;
}

function parseErrorEnvelope(text: string, status: number): PlatformHttpError {
  let code: AppErrorCode = 'INTERNAL_ERROR';
  let message = '请求失败。';
  if (text.length > 0) {
    try {
      const json: unknown = JSON.parse(text);
      const envelope = appErrorSchema.safeParse(json);
      if (envelope.success) {
        code = envelope.data.error.code;
        message = envelope.data.error.message;
      }
    } catch {
      // 非 JSON 错误正文：保持脱敏默认消息。
    }
  }
  return new PlatformHttpError(code, message, status);
}

function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  for (const part of document.cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

function isStateChanging(method: string): boolean {
  return method !== 'GET';
}

function normalizeNetworkError(error: unknown): PlatformHttpError {
  if (error instanceof PlatformHttpError) {
    return error;
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new PlatformHttpError('INTERNAL_ERROR', '请求超时。', 0);
  }
  return new PlatformHttpError('INTERNAL_ERROR', '网络请求失败。', 0);
}
