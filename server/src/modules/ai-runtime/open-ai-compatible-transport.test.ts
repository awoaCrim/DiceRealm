import { describe, expect, it, vi } from 'vitest';
import {
  OpenAiCompatibleTransportError,
  requestOpenAiCompatibleMessage,
  type OpenAiCompatibleConfig,
  type OpenAiCompatibleRequestSettings,
} from './OpenAiCompatibleTransport.js';

const config: OpenAiCompatibleConfig = {
  baseUrl: 'https://api.provider.example/v1',
  apiKey: 'sk-secret-key-123',
  model: 'gpt-test',
};
const settings: OpenAiCompatibleRequestSettings = { timeoutMs: 5000, temperature: 0.7 };

const okBody = { choices: [{ message: { content: 'hello from provider' } }] };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function recordStub(): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse(200, okBody);
  };
  return { fetchImpl, calls };
}

describe('OpenAiCompatibleTransport', () => {
  it('returns the chat-completions content for a normal JSON response', async () => {
    const { fetchImpl, calls } = recordStub();
    const content = await requestOpenAiCompatibleMessage(
      config,
      [{ role: 'user', content: 'hi' }],
      settings,
      fetchImpl,
    );
    expect(content).toBe('hello from provider');
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init?.body)) as { model: string; stream: boolean; temperature: number };
    expect(body.model).toBe('gpt-test');
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.7);
    expect(calls[0].init?.headers).toMatchObject({
      authorization: 'Bearer sk-secret-key-123',
      'content-type': 'application/json',
    });
  });

  it('joins the base URL to a single /chat/completions with or without trailing slash', async () => {
    const cases: Array<{ baseUrl: string; expected: string }> = [
      { baseUrl: 'https://api.provider.example/v1', expected: 'https://api.provider.example/v1/chat/completions' },
      { baseUrl: 'https://api.provider.example/v1/', expected: 'https://api.provider.example/v1/chat/completions' },
      { baseUrl: 'https://api.provider.example', expected: 'https://api.provider.example/chat/completions' },
    ];
    for (const testCase of cases) {
      const { fetchImpl, calls } = recordStub();
      await requestOpenAiCompatibleMessage(
        { ...config, baseUrl: testCase.baseUrl },
        [{ role: 'user', content: 'hi' }],
        settings,
        fetchImpl,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(testCase.expected);
    }
  });

  it('makes exactly ONE request for 429, 500, EOF-body and network failure (no retry)', async () => {
    const cases: Array<{ label: string; fetchImpl: typeof fetch }> = [
      {
        label: '429',
        fetchImpl: async () => jsonResponse(429, { error: { message: 'rate limited' } }),
      },
      {
        label: '500',
        fetchImpl: async () => jsonResponse(500, { error: { message: 'boom' } }),
      },
      {
        label: 'EOF body',
        fetchImpl: async () => jsonResponse(500, { error: { message: 'unexpected EOF' } }),
      },
      {
        label: 'network rejection',
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        },
      },
    ];
    for (const testCase of cases) {
      let calls = 0;
      const wrapped: typeof fetch = async (input, init) => {
        calls += 1;
        return testCase.fetchImpl(input, init);
      };
      await expect(requestOpenAiCompatibleMessage(config, [{ role: 'user', content: 'x' }], settings, wrapped)).rejects.toThrow();
      expect(calls, testCase.label).toBe(1);
    }
  });

  it('rejects 3xx redirects without following them and with exactly one request', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response('redirecting', { status: 302, headers: { location: 'https://evil.example/chat/completions' } });
    };
    await expect(requestOpenAiCompatibleMessage(config, [{ role: 'user', content: 'x' }], settings, fetchImpl))
      .rejects.toThrow(/redirect/i);
    expect(calls).toBe(1);
  });

  it('rejects an opaque-redirect response (status 0 / opaqueredirect) with the stable redirect error and one request', async () => {
    let calls = 0;
    // 真实 undici fetch 在 redirect:'manual' 下会把 3xx 折叠成 opaque-redirect（status 0）；
    // 用真实形状 stub 验证该分支得到稳定的 redirect 错误且只请求一次。
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return {
        status: 0,
        type: 'opaqueredirect',
        ok: false,
        text: async () => '',
      } as unknown as Response;
    };
    await expect(requestOpenAiCompatibleMessage(config, [{ role: 'user', content: 'x' }], settings, fetchImpl))
      .rejects.toThrow(/redirect/i);
    expect(calls).toBe(1);
  });

  it('never includes the raw response statusText in error messages', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'boom' } }), {
        status: 500,
        statusText: 'sk-secret-key-123 top-secret-reason',
      });
    };
    const error = await requestOpenAiCompatibleMessage(config, [{ role: 'user', content: 'x' }], settings, fetchImpl)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/AI provider failed with 500/);
    expect(message).not.toContain('sk-secret-key-123');
    expect(message).not.toContain('top-secret-reason');
    expect(calls).toBe(1);
  });

  it('aborts on timeout and never leaks the api key or base URL in the error', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    const error = await requestOpenAiCompatibleMessage(
      config, [{ role: 'user', content: 'x' }], { timeoutMs: 30, temperature: 0 }, fetchImpl,
    ).then(() => null).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/timed out|超时/);
    expect(message).not.toContain('sk-secret-key-123');
    expect(message).not.toContain('api.provider.example');
  });

  it('tolerates upstream data: SSE frames and concatenates content', async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      'data: {"choices":[{"delta":{"content":"世界"}}]}',
      'data: [DONE]',
    ].join('\n');
    const fetchImpl: typeof fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const content = await requestOpenAiCompatibleMessage(config, [{ role: 'user', content: 'x' }], settings, fetchImpl);
    expect(content).toContain('你好');
    expect(content).toContain('世界');
  });

  it('redacts the api key from upstream error bodies and caps the body at 1000 chars', async () => {
    // key 出现在 body 开头：必须被替换为占位符。
    const shortBody = `sk-secret-key-123 ${'y'.repeat(50)}`;
    const fetchImplShort: typeof fetch = async () => new Response(JSON.stringify({ error: { message: shortBody } }), { status: 500 });
    await expect(requestOpenAiCompatibleMessage(config, [{ role: 'user', content: 'x' }], settings, fetchImplShort))
      .rejects.toThrow(/\[REDACTED_API_KEY\]/);

    // 超长 body：错误正文预算 ≤1000 chars，且绝不含原始密钥。
    const longBody = `${'x'.repeat(2000)} sk-secret-key-123 ${'y'.repeat(500)}`;
    const fetchImplLong: typeof fetch = async () => new Response(JSON.stringify({ error: { message: longBody } }), { status: 500 });
    const error = await requestOpenAiCompatibleMessage(config, [{ role: 'user', content: 'x' }], settings, fetchImplLong)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('sk-secret-key-123');
    expect(message.length).toBeLessThan(1200);
    expect(message).not.toContain(Array(2000).fill('x').join(''));
  });

  it('does not export Mock, retry/backoff or tool-calling APIs from the transport module', async () => {
    const mod = await import('./OpenAiCompatibleTransport.js');
    const exportedNames = Object.keys(mod).sort();
    expect(exportedNames).not.toContain('MockAiProvider');
    expect(exportedNames).not.toContain('OpenAiCompatibleProvider');
    expect(exportedNames).not.toContain('ChatTool');
    expect(exportedNames).not.toContain('parseTurnResultFromProviderText');
    expect(exportedNames).toEqual(['OpenAiCompatibleTransportError', 'requestOpenAiCompatibleMessage'].sort());
  });

  it('rejects a missing api key with a clear error', async () => {
    await expect(
      requestOpenAiCompatibleMessage(
        { baseUrl: 'https://api.provider.example/v1', apiKey: '', model: 'm' },
        [{ role: 'user', content: 'x' }],
        settings,
        async () => jsonResponse(200, okBody),
      ),
    ).rejects.toThrow(/apiKey/i);
  });

  it('rejects non-http(s) base URLs without issuing a request', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(200, okBody);
    };
    await expect(
      requestOpenAiCompatibleMessage(
        { baseUrl: 'ftp://provider.example/v1', apiKey: 'k', model: 'm' },
        [{ role: 'user', content: 'x' }],
        settings,
        fetchImpl,
      ),
    ).rejects.toThrow(/http/i);
    expect(calls).toBe(0);
  });

  it('drops query/hash from the base URL and keeps the path segment when joining chat/completions', async () => {
    const cases: Array<{ baseUrl: string; expected: string }> = [
      // 无尾斜杠 + query：不得丢 /v1，也不得把 query 泄漏到请求 URL。
      { baseUrl: 'https://proxy.example/v1?token=secret', expected: 'https://proxy.example/v1/chat/completions' },
      // 尾斜杠 + query + hash：全部清理后再 join。
      { baseUrl: 'https://proxy.example/v1/?token=secret#frag', expected: 'https://proxy.example/v1/chat/completions' },
    ];
    for (const testCase of cases) {
      const { fetchImpl, calls } = recordStub();
      await requestOpenAiCompatibleMessage(
        { ...config, baseUrl: testCase.baseUrl },
        [{ role: 'user', content: 'x' }],
        settings,
        fetchImpl,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(testCase.expected);
      expect(calls[0].url).not.toContain('?');
      expect(calls[0].url).not.toContain('#');
    }
  });

  it('exposes invalid base URL shape failures as OpenAiCompatibleTransportError with zero requests', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      return jsonResponse(200, okBody);
    };
    for (const badUrl of [
      'ftp://provider.example/v1',
      'https://user:pass@provider.example/v1',
      'not-a-url',
    ]) {
      await expect(
        requestOpenAiCompatibleMessage(
          { ...config, baseUrl: badUrl },
          [{ role: 'user', content: 'x' }],
          settings,
          fetchImpl,
        ),
      ).rejects.toThrow(OpenAiCompatibleTransportError);
      expect(calls).toBe(0);
    }
  });
});
