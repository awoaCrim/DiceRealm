import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { sessionEnvelopeSchema } from '../lib/contractSchemas';
import { PlatformHttpError, platformRequest } from './platformHttp';

const demoSchema = z.object({ ok: z.literal(true), value: z.string() });

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('platformRequest', () => {
  it('rejects a leaked top-level sessionId in the strict login envelope', () => {
    expect(() => sessionEnvelopeSchema.parse({
      session: { expiresAt: '2026-08-19T00:00:00.000Z' },
      sessionId: 'leaked-bearer',
    })).toThrow();
  });
  it('成功解析 JSON 响应体', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, value: 'hi' })));
    const result = await platformRequest('/api/x', { responseSchema: demoSchema });
    expect(result).toEqual({ ok: true, value: 'hi' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/x',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('204 无响应体时按 void schema 解析', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(
      platformRequest('/api/x', { method: 'DELETE', responseSchema: z.void() }),
    ).resolves.toBeUndefined();
  });

  it('超时（AbortError/TimeoutError）抛脱敏超时错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'TimeoutError');
    }));
    await expect(
      platformRequest('/api/x', { responseSchema: demoSchema, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: 'PlatformHttpError', code: 'INTERNAL_ERROR', status: 0 });
  });

  it('成功状态但 malformed body 抛 INTERNAL_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops', { status: 200 })));
    await expect(platformRequest('/api/x', { responseSchema: demoSchema }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('平台错误 envelope 解析为 PlatformHttpError（code/message）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(
      { error: { code: 'CAMPAIGN_NOT_FOUND', message: '战役不存在。' } },
      404,
    )));
    const error = await platformRequest('/api/x', { responseSchema: demoSchema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformHttpError);
    expect(error).toMatchObject({ code: 'CAMPAIGN_NOT_FOUND', status: 404 });
    expect((error as PlatformHttpError).message).toBe('战役不存在。');
  });

  it('非 JSON 500 错误正文不拼接 stack/HTML 进用户消息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><body>Error: TypeError at server.js:12</body></html>',
      { status: 500 },
    )));
    const error = await platformRequest('/api/x', { responseSchema: demoSchema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformHttpError);
    expect((error as PlatformHttpError).message).not.toContain('<html>');
    expect((error as PlatformHttpError).message).not.toContain('server.js');
    expect((error as PlatformHttpError).message).not.toContain('TypeError');
  });

  it('POST includes readable authenticated CSRF cookie and never uses bearer storage', async () => {
    vi.stubGlobal('document', { cookie: '__Host-dnd_csrf=csrf-value' });
    const localSpy = vi.fn();
    vi.stubGlobal('localStorage', { getItem: localSpy });
    vi.stubGlobal('sessionStorage', { getItem: localSpy });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, value: 'x' })));
    await platformRequest('/api/y', { method: 'POST', body: { name: 'a' }, responseSchema: demoSchema });
    expect(fetch).toHaveBeenCalledWith('/api/y', expect.objectContaining({
      credentials: 'include',
      headers: expect.objectContaining({ 'x-csrf-token': 'csrf-value' }),
    }));
    expect(localSpy).not.toHaveBeenCalled();
  });

  it('POST 发送 JSON body 与 Content-Type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, value: 'x' })));
    await platformRequest('/api/y', {
      method: 'POST',
      body: { name: 'a' },
      responseSchema: demoSchema,
    });
    expect(fetch).toHaveBeenCalledWith('/api/y', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'a' }),
      headers: expect.objectContaining({ 'content-type': 'application/json' }),
    }));
  });

  it('网络错误（fetch reject 非超时）抛脱敏 INTERNAL_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3000');
    }));
    const error = await platformRequest('/api/x', { responseSchema: demoSchema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformHttpError);
    expect((error as PlatformHttpError).message).not.toContain('ECONNREFUSED');
  });
});
