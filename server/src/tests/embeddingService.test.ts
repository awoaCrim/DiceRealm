import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { seedBuiltinRules } from '../db/seedRules.js';
import { createEmbeddingProviderFromConfig, testEmbeddingProviderConfig } from '../services/embeddingService.js';

async function createEmbeddingStub(handler: (body: any) => unknown | Promise<unknown>) {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      requests.push(body);
      const result = await handler(body);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result));
    })().catch((error) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No stub port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

describe('embeddingService', () => {
  it('creates deterministic finite mock embeddings with configured dimensions', async () => {
    const provider = createEmbeddingProviderFromConfig({ provider: 'mock', baseUrl: '', apiKey: '', model: '', dimensions: 4 });

    const first = await provider.embed('same text');
    const second = await provider.embed('same text');
    const different = await provider.embed('different text');

    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
    expect(first).toHaveLength(4);
    expect(first.every(Number.isFinite)).toBe(true);
  });

  it('posts OpenAI-compatible embedding requests and validates connection tests', async () => {
    const stub = await createEmbeddingStub((body) => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      model: body.model
    }));
    const config = { provider: 'openai-compatible' as const, baseUrl: stub.baseUrl, apiKey: 'embedding-key', model: 'embed-model', dimensions: 3 };

    try {
      const provider = createEmbeddingProviderFromConfig(config);

      await expect(provider.embed('测试文本')).resolves.toEqual([0.1, 0.2, 0.3]);
      expect(stub.requests[0]).toEqual({ model: 'embed-model', input: '测试文本', dimensions: 3 });
      await expect(testEmbeddingProviderConfig(config)).resolves.toBeUndefined();
    } finally {
      await stub.close();
    }
  });

  it('rejects malformed embedding response vectors', async () => {
    const stub = await createEmbeddingStub((body) => ({
      data: [{ embedding: ['bad'] }],
      model: body.model
    }));
    const config = { provider: 'openai-compatible' as const, baseUrl: stub.baseUrl, apiKey: 'embedding-key', model: 'embed-model', dimensions: 3 };

    try {
      const provider = createEmbeddingProviderFromConfig(config);
      await expect(provider.embed('测试文本')).rejects.toThrow('Embedding provider returned invalid embedding vector');
    } finally {
      await stub.close();
    }
  });

  it('tests embedding provider configs through the admin route without saving object payloads', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const stub = await createEmbeddingStub((body) => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      model: body.model
    }));
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const testRes = await fetch(`${base}/api/admin/config/embedding-provider/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'embedding-key', model: 'embed-model', dimensions: 3 })
      });
      expect(testRes.status).toBe(200);
      expect(await testRes.json()).toEqual({ ok: true });

      const savedRes = await fetch(`${base}/api/admin/config/embedding-provider`);
      expect(await savedRes.json()).toEqual({
        provider: 'mock',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'text-embedding-3-small',
        dimensions: 8
      });

      const invalidArrayRes = await fetch(`${base}/api/admin/config/embedding-provider/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([])
      });
      expect(invalidArrayRes.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('returns 502 for embedding provider admin route provider failures', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const stub = await createEmbeddingStub((body) => ({
      data: [{ embedding: ['bad'] }],
      model: body.model
    }));
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const res = await fetch(`${base}/api/admin/config/embedding-provider/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'embedding-key', model: 'embed-model', dimensions: 3 })
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Embedding provider returned invalid embedding vector' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });
});
