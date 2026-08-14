import http from 'node:http';
import { describe, expect, it } from 'vitest';
import type { AiPrompt } from '@dnd/contracts';
import { OpenAiCompatibleAiProvider } from './OpenAiCompatibleAiProvider.js';
import type { AiPreviewHooks } from './AiProviderPort.js';

async function createChatStub(handler: (body: unknown, count: number) => { status?: number; body?: unknown; rawBody?: string; contentType?: string }) {
  let count = 0;
  let lastBody: unknown = null;
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      count += 1;
      const result = handler(lastBody, count);
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
    lastBody: () => lastBody,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const prompt: AiPrompt = {
  campaignId: 'c1',
  audience: 'owner_only',
  messages: [
    { role: 'system', content: '你是 DND AI 地城主持人。' },
    { role: 'user', content: '玩家行动：我搜索房间。' },
  ],
  characters: [{ id: 'ch1', playerId: 'p1', name: '薇拉' }],
};

const EMPTY_HOOKS: AiPreviewHooks = {
  onDelta: async () => {},
};

function jsonContent(content: string): string {
  // content 字段必须是未二次编码的正文文本（可能是纯 JSON / fence / 嵌入散文）。
  return JSON.stringify({ choices: [{ message: { content } }] });
}

describe('OpenAiCompatibleAiProvider', () => {
  it('forwards the AiPrompt messages to the chat completions endpoint and returns the parsed JSON object', async () => {
    const stub = await createChatStub(() => ({
      body: { choices: [{ message: { content: '{"publicNarrative":"雨停了。","privateUpdates":[],"diceResults":[],"stateChanges":[],"interactionRequests":[]}' } }] },
    }));
    try {
      const provider = new OpenAiCompatibleAiProvider({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'gpt-test-model' });
      const result = await provider.stream(prompt, EMPTY_HOOKS);
      expect(result).toMatchObject({ publicNarrative: '雨停了。' });
      const body = stub.lastBody() as { model: string; messages: unknown };
      expect(body.model).toBe('gpt-test-model');
      expect(body.messages).toEqual(prompt.messages);
      expect(stub.count()).toBe(1);
    } finally {
      await stub.close();
    }
  });

  it('exposes provider kind and model identity separately', () => {
    const provider = new OpenAiCompatibleAiProvider({ baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'gpt-4o-mini' });
    expect(provider.name).toBe('openai-compatible');
    expect(provider.model).toBe('gpt-4o-mini');
  });

  it('decodes a Markdown fenced JSON response', async () => {
    const stub = await createChatStub(() => ({
      rawBody: jsonContent('```json\n{"publicNarrative":"围栏里的 JSON。","privateUpdates":[],"diceResults":[],"stateChanges":[],"interactionRequests":[]}\n```'),
    }));
    try {
      const provider = new OpenAiCompatibleAiProvider({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'gpt-test-model' });
      const result = await provider.stream(prompt, EMPTY_HOOKS);
      expect(result).toMatchObject({ publicNarrative: '围栏里的 JSON。' });
    } finally {
      await stub.close();
    }
  });

  it('decodes a JSON object embedded inside prose, ignoring unrelated balanced braces', async () => {
    const stub = await createChatStub(() => ({
      rawBody: jsonContent('提示里的示例 {} 不属于结果。结算如下：{"publicNarrative":"嵌入的 JSON。","privateUpdates":[],"diceResults":[],"stateChanges":[],"interactionRequests":[]} 请继续。'),
    }));
    try {
      const provider = new OpenAiCompatibleAiProvider({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'gpt-test-model' });
      const result = await provider.stream(prompt, EMPTY_HOOKS);
      expect(result).toMatchObject({ publicNarrative: '嵌入的 JSON。' });
    } finally {
      await stub.close();
    }
  });

  it('emits a preview delta only for the public narrative, never the raw JSON', async () => {
    const deltas: string[] = [];
    const hooks: AiPreviewHooks = { onDelta: async (d) => { deltas.push(d.text); } };
    const stub = await createChatStub(() => ({
      rawBody: jsonContent(JSON.stringify({
        publicNarrative: '雨停了。',
        privateUpdates: [{ playerId: 'p1', content: '你发现墙上有暗门。' }],
        diceResults: [], stateChanges: [], interactionRequests: [],
      })),
    }));
    try {
      const provider = new OpenAiCompatibleAiProvider({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'gpt-test-model' });
      await provider.stream(prompt, hooks);
      expect(deltas).toEqual(['雨停了。']);
      expect(deltas.join('')).not.toContain('privateUpdates');
      expect(deltas.join('')).not.toContain('playerId');
    } finally {
      await stub.close();
    }
  });

  it('returns the parsed object without any preview delta when publicNarrative is missing', async () => {
    const deltas: string[] = [];
    const hooks: AiPreviewHooks = { onDelta: async (d) => { deltas.push(d.text); } };
    const stub = await createChatStub(() => ({
      rawBody: jsonContent(JSON.stringify({ publicNarrative: '', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] })),
    }));
    try {
      const provider = new OpenAiCompatibleAiProvider({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'gpt-test-model' });
      const result = await provider.stream(prompt, hooks);
      expect(result).toEqual({ publicNarrative: '', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] });
      expect(deltas).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it('rejects a non-JSON response with a fixed sanitized error that never contains the raw body or api key', async () => {
    const stub = await createChatStub(() => ({ rawBody: jsonContent('这不是 JSON，只是散文。'), }));
    try {
      const provider = new OpenAiCompatibleAiProvider({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'gpt-test-model' });
      const error = await provider.stream(prompt, EMPTY_HOOKS).then(
        () => null,
        (err: unknown) => err instanceof Error ? err : new Error(String(err)),
      );
      expect(error).not.toBeNull();
      expect(error!.message).toContain('invalid response');
      expect(error!.message).not.toContain('这不是 JSON');
      expect(error!.message).not.toContain('test-key');
    } finally {
      await stub.close();
    }
  });

  it('rejects a provider redirect instead of following it', async () => {
    const stub = await createChatStub(() => ({ status: 302, body: { redirected: true } }));
    try {
      const provider = new OpenAiCompatibleAiProvider({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'gpt-test-model' });
      await expect(provider.stream(prompt, EMPTY_HOOKS)).rejects.toThrow(/redirects are not allowed/);
      expect(stub.count()).toBe(1);
    } finally {
      await stub.close();
    }
  });

  it('keeps upstream error messages free of the api key', async () => {
    const stub = await createChatStub(() => ({ status: 500, body: { error: { message: 'boom test-key' } } }));
    try {
      const provider = new OpenAiCompatibleAiProvider({ baseUrl: stub.baseUrl, apiKey: 'test-key', model: 'gpt-test-model' });
      const error = await provider.stream(prompt, EMPTY_HOOKS).then(
        () => null,
        (err: unknown) => err instanceof Error ? err : new Error(String(err)),
      );
      expect(error).not.toBeNull();
      expect(error!.message).not.toContain('test-key');
    } finally {
      await stub.close();
    }
  });
});
