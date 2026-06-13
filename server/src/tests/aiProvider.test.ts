import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { requestOpenAiCompatibleMessage } from '../services/aiProvider.js';

async function createChatStub(handler: (body: unknown, count: number) => { status?: number; body?: unknown; rawBody?: string; contentType?: string }) {
  let count = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      count += 1;
      const result = handler(requestBody, count);
      res.statusCode = result.status ?? 200;
      res.setHeader('content-type', result.contentType ?? 'application/json');
      res.end(result.rawBody ?? JSON.stringify(result.body));
    })().catch((error) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No stub port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    count: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

describe('aiProvider', () => {
  it('retries transient upstream 500/EOF responses', async () => {
    const stub = await createChatStub((_body, count) => count === 1
      ? { status: 500, body: { error: { message: 'Post "https://example.test" EOF' } } }
      : { body: { choices: [{ message: { content: 'ok' } }] } });

    try {
      const content = await requestOpenAiCompatibleMessage({
        provider: 'openai-compatible',
        baseUrl: stub.baseUrl,
        apiKey: 'test-key',
        model: 'test-model'
      }, [
        { role: 'system', content: 'test' },
        { role: 'user', content: 'hello' }
      ]);

      expect(content).toBe('ok');
      expect(stub.count()).toBe(2);
    } finally {
      await stub.close();
    }
  });

  it('parses OpenAI-compatible streaming responses when upstream sends SSE anyway', async () => {
    const stub = await createChatStub(() => ({
      rawBody: [
        'data: {"choices":[{"delta":{"content":"o"},"index":0}]}',
        '',
        'data: {"choices":[{"delta":{"content":"k"},"index":0}]}',
        '',
        'data: [DONE]',
        ''
      ].join('\n'),
      contentType: 'text/event-stream'
    }));

    try {
      const content = await requestOpenAiCompatibleMessage({
        provider: 'openai-compatible',
        baseUrl: stub.baseUrl,
        apiKey: 'test-key',
        model: 'test-model'
      }, [
        { role: 'system', content: 'test' },
        { role: 'user', content: 'hello' }
      ]);

      expect(content).toBe('ok');
    } finally {
      await stub.close();
    }
  });
});
