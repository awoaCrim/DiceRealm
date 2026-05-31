import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { seedBuiltinRules } from '../db/seedRules.js';
import { defaultAiConfig, renderDndOutputContract } from '../services/aiContextBuilder.js';
import { GlobalConfigResourceError, normalizeAiProviderConfig, saveGlobalPreset } from '../services/globalConfigService.js';
import { createResourceImportJob, reviewResourceImportDraft } from '../services/resourceReviewService.js';
import type { AiTurnResult } from '../domain/types.js';

type PromptPreviewPayload = {
  mode: 'native' | 'sillytavern-compatible';
  prompt: string;
  messages: Array<{ role: string; content: string }>;
  slots: Array<{ key: string; source: string; content: string }>;
  worldBookMatches: Array<{ entryId: string; keys: string[]; content: string }>;
  ruleMatches: Array<{ title: string; category: string; score: number; reasons: string[]; summary: string }>;
  promptBlocks: Array<{ identifier: string; source: string; content: string }>;
  warnings: string[];
};

function aiTurnResult(overrides: Partial<AiTurnResult>): AiTurnResult {
  return {
    objectiveLog: overrides.objectiveLog ?? overrides.publicLog ?? '',
    publicLog: overrides.publicLog ?? '',
    privateUpdatesByPlayer: overrides.privateUpdatesByPlayer ?? {},
    ruleResults: overrides.ruleResults ?? [],
    interactionRequests: overrides.interactionRequests ?? [],
    diceRequests: overrides.diceRequests ?? [],
    suggestedStateChanges: overrides.suggestedStateChanges ?? [],
    characterResourceChanges: overrides.characterResourceChanges ?? [],
    diceResults: overrides.diceResults
  };
}

function occurrenceCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const legacyProcessTurnInit = {
  method: 'POST',
  headers: { 'x-test-allow-legacy-process-turn': '1' }
};

type OpenAiStubResponse = { status?: number; statusText?: string; body?: unknown; rawBody?: string };

async function createOpenAiStub(handler: (body: any) => OpenAiStubResponse | Promise<OpenAiStubResponse>) {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
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
      res.statusCode = result.status ?? 200;
      if (result.statusText) res.statusMessage = result.statusText;
      res.setHeader('content-type', 'application/json');
      res.end(result.rawBody ?? JSON.stringify(result.body));
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

describe('DND AI-DM integration', () => {
  it('stores global embedding provider config separately from chat provider config', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    const defaultConfig = {
      provider: 'mock',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'text-embedding-3-small',
      dimensions: 8
    };
    const savedConfig = {
      provider: 'openai-compatible',
      baseUrl: 'https://embedding.example.test/v1',
      apiKey: 'embedding-key',
      model: 'text-embedding-3-small',
      dimensions: 1536
    };

    try {
      const defaultRes = await fetch(`${base}/api/admin/config/embedding-provider`);
      expect(defaultRes.status).toBe(200);
      expect(await defaultRes.json()).toEqual(defaultConfig);

      const updateRes = await fetch(`${base}/api/admin/config/embedding-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(savedConfig)
      });
      expect(updateRes.status).toBe(200);
      expect(await updateRes.json()).toEqual(savedConfig);

      const configRes = await fetch(`${base}/api/admin/config`);
      expect(configRes.status).toBe(200);
      const snapshot = await configRes.json() as { embeddingProviderConfig?: unknown; aiProviderConfig?: unknown };
      expect(snapshot.embeddingProviderConfig).toEqual(savedConfig);
      expect(snapshot.aiProviderConfig).not.toEqual(savedConfig);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('stores global AI provider config', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    const defaultAiProviderConfig = {
      provider: 'mock',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini'
    };
    const savedAiProviderConfig = {
      provider: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-api-key',
      model: 'test-model'
    };

    try {
      const defaultRes = await fetch(`${base}/api/admin/config/ai-provider`);
      expect(defaultRes.status).toBe(200);
      expect(await defaultRes.json()).toEqual(defaultAiProviderConfig);

      const invalidRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '' })
      });
      expect(invalidRes.status).toBe(400);
      expect(invalidRes.headers.get('content-type')).toContain('application/json');
      const whitespaceApiKeyRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: 'https://example.test/v1', apiKey: '   ', model: 'test-model' })
      });
      expect(whitespaceApiKeyRes.status).toBe(400);
      expect(whitespaceApiKeyRes.headers.get('content-type')).toContain('application/json');
      expect(() => normalizeAiProviderConfig({ provider: 'invalid-provider', baseUrl: '', apiKey: '', model: '' }))
        .toThrowError(GlobalConfigResourceError);

      const updateRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(savedAiProviderConfig)
      });
      expect(updateRes.status).toBe(200);
      expect(await updateRes.json()).toEqual(savedAiProviderConfig);

      const savedRes = await fetch(`${base}/api/admin/config/ai-provider`);
      expect(savedRes.status).toBe(200);
      expect(await savedRes.json()).toEqual(savedAiProviderConfig);

      const configRes = await fetch(`${base}/api/admin/config`);
      expect(configRes.status).toBe(200);
      const config = await configRes.json() as { aiProviderConfig?: unknown };
      expect(config.aiProviderConfig).toEqual(savedAiProviderConfig);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('tests openai-compatible config without writing ai_generations', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const stub = await createOpenAiStub(() => ({
      body: { choices: [{ message: { content: 'ok' } }] }
    }));
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const testRes = await fetch(`${base}/api/admin/config/ai-provider/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'test-api-key', model: 'test-model' })
      });
      expect(testRes.status).toBe(200);
      expect(await testRes.json()).toEqual({ ok: true });
      expect(stub.requests).toHaveLength(1);
      const generationCount = db.prepare('SELECT COUNT(*) as count FROM ai_generations').get() as { count: number };
      expect(generationCount.count).toBe(0);

      const invalidRes = await fetch(`${base}/api/admin/config/ai-provider/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: 'not-a-url', apiKey: 'test-api-key', model: 'test-model' })
      });
      expect(invalidRes.status).toBe(400);

      const invalidProtocolRes = await fetch(`${base}/api/admin/config/ai-provider/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: 'file:///tmp/provider', apiKey: 'test-api-key', model: 'test-model' })
      });
      expect(invalidProtocolRes.status).toBe(400);

      const invalidArrayRes = await fetch(`${base}/api/admin/config/ai-provider/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([])
      });
      expect(invalidArrayRes.status).toBe(400);

      const invalidNullRes = await fetch(`${base}/api/admin/config/ai-provider/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(null)
      });
      expect(invalidNullRes.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('returns stable AI provider test errors for malformed provider responses', async () => {
    const cases: Array<{ name: string; response: OpenAiStubResponse; expectedError: string }> = [
      { name: 'non-json response body', response: { rawBody: 'not json' }, expectedError: 'AI provider returned invalid JSON response' },
      { name: 'missing message content', response: { body: { choices: [{ message: {} }] } }, expectedError: 'AI provider returned no choices[0].message.content' }
    ];

    for (const testCase of cases) {
      const db = createMemoryDb();
      migrate(db);
      seedBuiltinRules(db);
      const stub = await createOpenAiStub(() => testCase.response);
      const app = createApp(db);
      const server = app.listen(0);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test port');
      const base = `http://127.0.0.1:${address.port}`;

      try {
        const res = await fetch(`${base}/api/admin/config/ai-provider/test`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'test-api-key', model: 'test-model' })
        });
        expect(res.status, testCase.name).toBe(502);
        const payload = await res.json() as { error: string };
        expect(payload.error).toBe(testCase.expectedError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await stub.close();
        db.close();
      }
    }
  });

  it('sanitizes and truncates AI provider non-2xx errors', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const apiKey = 'secret-provider-key';
    const stub = await createOpenAiStub(() => ({ status: 502, statusText: 'Bad Gateway', rawBody: `${apiKey}:${'x'.repeat(5000)}` }));
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const res = await fetch(`${base}/api/admin/config/ai-provider/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey, model: 'test-model' })
      });
      expect(res.status).toBe(502);
      const payload = await res.json() as { error: string };
      expect(payload.error).toContain('AI provider failed with 502 Bad Gateway:');
      expect(payload.error).not.toContain(apiKey);
      expect(payload.error).toContain('[REDACTED_API_KEY]');
      expect(payload.error.length).toBeLessThan(1200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('uses the saved AI provider config for an existing room on the next process-turn', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const resultJson = aiTurnResult({ publicLog: 'Runtime stub public log.', ruleResults: ['stub rule'] });
    const stub = await createOpenAiStub((body) => {
      expect(body.model).toBe('runtime-model');
      return { body: { choices: [{ message: { content: JSON.stringify(resultJson) } }] } };
    });
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Runtime Provider Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const player = await playerRes.json() as { token: string };
      const configRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'runtime-key', model: 'runtime-model' })
      });
      expect(configRes.status).toBe(200);
      await fetch(`${base}/api/player/${player.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I test the runtime provider.' })
      });

      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
      expect(processRes.status).toBe(200);
      expect(stub.requests).toHaveLength(1);
      const generation = db.prepare('SELECT provider, output FROM ai_generations WHERE room_id = ?').get(room.roomId) as { provider: string; output: string };
      expect(generation.provider).toBe('openai-compatible');
      expect(generation.output).toContain('Runtime stub public log.');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('creates a room, isolates player state, accepts actions, and processes a turn', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Test Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const ariRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const ari = await ariRes.json() as { token: string };

      const boRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bo' })
      });
      const bo = await boRes.json() as { token: string };

      const boRow = db.prepare('SELECT id FROM players WHERE token = ?').get(bo.token) as { id: string };
      db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('secret-bo', room.roomId, null, 'private', boRow.id, 'Secret', 'Bo knows the passphrase.', new Date().toISOString());

      const ariStateRes = await fetch(`${base}/api/player/${ari.token}/state`);
      const ariStateText = await ariStateRes.text();
      expect(ariStateText).not.toContain('Bo knows the passphrase');

      await fetch(`${base}/api/player/${ari.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I inspect the gate.' })
      });
      await fetch(`${base}/api/player/${bo.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I watch the shadows.' })
      });

      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
      expect(processRes.status).toBe(200);
      const adminRes = await fetch(`${base}/api/admin/rooms/${room.roomId}`);
      const adminText = await adminRes.text();
      expect(adminText).toContain('The party');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('keeps one current action per player and rejects edits after the turn is ready', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Action Gate Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const ariRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const ari = await ariRes.json() as { token: string };

      const boRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bo' })
      });
      const bo = await boRes.json() as { token: string };

      const firstAriAction = await fetch(`${base}/api/player/${ari.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I inspect the old door.' })
      });
      expect(firstAriAction.status).toBe(200);

      const editedAriAction = await fetch(`${base}/api/player/${ari.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I listen at the old door instead.' })
      });
      expect(editedAriAction.status).toBe(200);

      const ariRow = db.prepare('SELECT id FROM players WHERE token = ?').get(ari.token) as { id: string };
      const turn = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = 1').get(room.roomId) as { id: string };
      const ariActions = db.prepare('SELECT text FROM actions WHERE turn_id = ? AND player_id = ?').all(turn.id, ariRow.id) as Array<{ text: string }>;
      expect(ariActions).toEqual([{ text: 'I listen at the old door instead.' }]);

      const boAction = await fetch(`${base}/api/player/${bo.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I watch the hallway.' })
      });
      expect(boAction.status).toBe(200);

      const readyRoom = db.prepare('SELECT status FROM rooms WHERE id = ?').get(room.roomId) as { status: string };
      const readyTurn = db.prepare('SELECT status FROM turns WHERE id = ?').get(turn.id) as { status: string };
      expect(readyRoom.status).toBe('ready_to_resolve');
      expect(readyTurn.status).toBe('ready_to_resolve');

      const lateEdit = await fetch(`${base}/api/player/${ari.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I change my mind after everyone is ready.' })
      });
      expect(lateEdit.status).toBe(409);
      const lateEditPayload = await lateEdit.json() as { error: string; roomStatus: string; turnStatus: string };
      expect(lateEditPayload).toMatchObject({
        error: 'ACTIONS_CLOSED',
        roomStatus: 'ready_to_resolve',
        turnStatus: 'ready_to_resolve'
      });

      const ariActionAfterLateEdit = db.prepare('SELECT text FROM actions WHERE turn_id = ? AND player_id = ?').all(turn.id, ariRow.id) as Array<{ text: string }>;
      expect(ariActionAfterLateEdit).toEqual([{ text: 'I listen at the old door instead.' }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('counts skipped player actions as completed actors for turn readiness', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Skip Readiness Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const ariRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const ari = await ariRes.json() as { playerId: string; token: string };

      const boRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bo' })
      });
      const bo = await boRes.json() as { playerId: string; token: string };

      const ariAction = await fetch(`${base}/api/player/${ari.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I check the wagon.', actionType: 'observe', visibility: 'public' })
      });
      expect(ariAction.status).toBe(200);

      const boSkip = await fetch(`${base}/api/player/${bo.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '跳过本回合。', actionType: 'skip', visibility: 'public' })
      });
      expect(boSkip.status).toBe(200);

      const turn = db.prepare('SELECT id, status, submitted_actor_ids_json as submittedActorIdsJson, skipped_actor_ids_json as skippedActorIdsJson FROM turns WHERE room_id = ? AND number = 1').get(room.roomId) as {
        id: string;
        status: string;
        submittedActorIdsJson: string;
        skippedActorIdsJson: string;
      };
      const readyRoom = db.prepare('SELECT status FROM rooms WHERE id = ?').get(room.roomId) as { status: string };
      expect(readyRoom.status).toBe('ready_to_resolve');
      expect(turn.status).toBe('ready_to_resolve');
      expect(JSON.parse(turn.submittedActorIdsJson)).toEqual([ari.playerId]);
      expect(JSON.parse(turn.skippedActorIdsJson)).toEqual([bo.playerId]);

      const previewRes = await fetch(`${base}/api/admin/ai/turn-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId })
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { flatPrompt: string };
      expect(preview.flatPrompt).toContain('Room status: ready_to_resolve');
      expect(preview.flatPrompt).toContain('2. Bo [skip, public] submittedAt=');
      expect(preview.flatPrompt).toContain(': 跳过本回合。 (skip, public)');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('omits incomplete current actions from legacy prompt preview and points admins to turn preview', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Legacy Preview Gate Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const ariRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const ari = await ariRes.json() as { token: string };
      await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bo' })
      });

      const actionRes = await fetch(`${base}/api/player/${ari.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I search the locked chest.' })
      });
      expect(actionRes.status).toBe(200);

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as PromptPreviewPayload;
      expect(preview.prompt).not.toContain('I search the locked chest.');
      expect(preview.prompt).toContain('- No submitted actions yet.');
      expect(preview.warnings).toContain('此配置预览不会包含未完成回合的当前行动；可发送给 AI 的回合提示词只能在所有必需玩家完成后通过 AI-DM 回合调试生成。');

      const turnPreviewRes = await fetch(`${base}/api/admin/ai/turn-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId })
      });
      expect(turnPreviewRes.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('uses preset blocks rather than global ai_config_json for native prompt preview', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Constraint Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const coreBlockUpdate = db.prepare('UPDATE global_prompt_blocks SET content = ? WHERE preset_id = ? AND name = ?')
        .run('核心规则：来自全局预设。', 'default-global-preset', '核心规则');
      const outputBlockUpdate = db.prepare('UPDATE global_prompt_blocks SET content = ? WHERE preset_id = ? AND name = ?')
        .run('输出格式：来自默认预设。', 'default-global-preset', '输出格式规则');
      expect(coreBlockUpdate.changes).toBe(1);
      expect(outputBlockUpdate.changes).toBe(1);

      db.prepare('UPDATE global_config SET ai_config_json = ? WHERE id = ?').run(JSON.stringify({
        coreRules: '毒化核心规则：不应出现在 preview。',
        playerAgencyRules: '毒化玩家自主权规则：不应出现在 preview。',
        visibilityRules: '毒化信息隔离规则：不应出现在 preview。',
        interactionRules: '毒化互动规则：不应出现在 preview。',
        styleRules: '毒化叙事风格：不应出现在 preview。',
        outputFormatRules: '毒化输出格式：不应出现在 preview。'
      }), 'default');

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as PromptPreviewPayload;
      expect(preview.mode).toBe('native');
      expect(preview.messages).toEqual([{ role: 'system', content: preview.prompt }]);
      expect(preview.slots.some((slot) => slot.key === 'dndOutputContract')).toBe(true);
      expect(preview.prompt).toContain('核心规则：来自全局预设。');
      expect(preview.prompt).toContain('输出格式：来自默认预设。');
      expect(preview.prompt).not.toContain('毒化核心规则');
      expect(preview.prompt).not.toContain('毒化输出格式');
      expect(preview.promptBlocks.at(-1)).toMatchObject({ identifier: 'dndOutputContract', source: 'dnd-contract' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('rejects legacy room config fields during room creation', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Legacy Config Room', worldInfo: 'Old world info.', systemPrompt: 'Old system prompt.' })
      });
      expect(roomRes.status).toBe(400);
      const roomCount = db.prepare('SELECT COUNT(*) as count FROM rooms').get() as { count: number };
      expect(roomCount.count).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('lists existing rooms and deletes a room with its related data', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '可删除房间' })
      });
      expect(roomRes.status).toBe(200);
      const room = await roomRes.json() as { roomId: string };

      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '玩家A' })
      });
      expect(playerRes.status).toBe(200);

      const listRes = await fetch(`${base}/api/admin/rooms`);
      expect(listRes.status).toBe(200);
      const listPayload = await listRes.json() as { rooms: Array<{ id: string; name: string; playerCount: number; adminUrl: string }> };
      expect(listPayload.rooms).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: room.roomId,
          name: '可删除房间',
          playerCount: 1,
          adminUrl: `/admin/${room.roomId}`
        })
      ]));

      const deleteRes = await fetch(`${base}/api/admin/rooms/${room.roomId}`, { method: 'DELETE' });
      expect(deleteRes.status).toBe(200);
      await expect(deleteRes.json()).resolves.toMatchObject({ ok: true, roomId: room.roomId });

      const roomCount = db.prepare('SELECT COUNT(*) as count FROM rooms WHERE id = ?').get(room.roomId) as { count: number };
      const playerCount = db.prepare('SELECT COUNT(*) as count FROM players WHERE room_id = ?').get(room.roomId) as { count: number };
      const turnCount = db.prepare('SELECT COUNT(*) as count FROM turns WHERE room_id = ?').get(room.roomId) as { count: number };
      const logCount = db.prepare('SELECT COUNT(*) as count FROM log_entries WHERE room_id = ?').get(room.roomId) as { count: number };
      expect(roomCount.count).toBe(0);
      expect(playerCount.count).toBe(0);
      expect(turnCount.count).toBe(0);
      expect(logCount.count).toBe(0);

      const missingDeleteRes = await fetch(`${base}/api/admin/rooms/${room.roomId}`, { method: 'DELETE' });
      expect(missingDeleteRes.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('does not create a global preset when saveGlobalPreset receives a missing id', () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);

    try {
      expect(() => saveGlobalPreset(db, {
        id: 'missing-preset-id',
        name: 'Missing Preset',
        description: 'Should not be created.',
        isActive: true,
        blocks: [
          { name: 'Block', role: 'system', position: 'before_world', enabled: true, orderIndex: 1, content: 'Block content.' }
        ]
      })).toThrowError(GlobalConfigResourceError);
      const row = db.prepare('SELECT id FROM global_prompt_presets WHERE id = ?').get('missing-preset-id');
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('repairs duplicate active global presets and enforces a single active preset at the database level', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const now = new Date().toISOString();
    db.prepare('DROP INDEX IF EXISTS global_prompt_presets_one_active_idx').run();
    db.prepare('DELETE FROM global_prompt_blocks').run();
    db.prepare('DELETE FROM global_prompt_presets').run();
    db.prepare('INSERT INTO global_prompt_presets (id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('older-active', 'Older Active', '', 1, now, '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO global_prompt_presets (id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('newer-active', 'Newer Active', '', 1, now, '2026-02-01T00:00:00.000Z');
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const configRes = await fetch(`${base}/api/admin/config`);
      expect(configRes.status).toBe(200);
      const activeRows = db.prepare('SELECT id FROM global_prompt_presets WHERE is_active = 1 ORDER BY id ASC').all() as Array<{ id: string }>;
      expect(activeRows).toEqual([{ id: 'newer-active' }]);
      expect(() => db.prepare('INSERT INTO global_prompt_presets (id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('rejected-active', 'Rejected Active', '', 1, now, now)).toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('returns stable 400 JSON for malformed global config payloads', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    async function expectBadRequestJson(response: Response) {
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      const payload = await response.json() as { error?: unknown };
      expect(typeof payload.error).toBe('string');
    }

    try {
      await expectBadRequestJson(await fetch(`${base}/api/admin/config/presets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Malformed Preset' })
      }));
      await expectBadRequestJson(await fetch(`${base}/api/admin/config/script-card`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      }));
      await expectBadRequestJson(await fetch(`${base}/api/admin/config/resource-world-books`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bindings: [{ worldBookId: 'missing-world-book', enabled: 'yes', orderIndex: 0 }] })
      }));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('returns disabled global world book entries in config snapshots but excludes them from native prompt preview', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Disabled Lore Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const bookRes = await fetch(`${base}/api/admin/config/world-books`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '禁用世界书', description: '禁用测试', enabled: false })
      });
      const bookPayload = await bookRes.json() as { worldBook: { id: string } };
      const entryRes = await fetch(`${base}/api/admin/config/world-books/${bookPayload.worldBook.id}/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Disabled Candlekeep', keys: ['Candlekeep'], secondaryKeys: [], content: '禁用世界书内容不应进入提示词。', enabled: true, priority: 200 })
      });
      expect(entryRes.status).toBe(200);
      db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('disabled-lore-trigger-log', room.roomId, null, 'public', null, 'Approach', 'The party approaches Candlekeep.', new Date().toISOString());

      const configRes = await fetch(`${base}/api/admin/config`);
      const config = await configRes.json() as { worldBookEntries: Array<{ title: string; content: string }> };
      expect(config.worldBookEntries.some((entry) => entry.title === 'Disabled Candlekeep')).toBe(true);
      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      const preview = await previewRes.json() as PromptPreviewPayload;
      expect(preview.prompt).not.toContain('禁用世界书内容不应进入提示词。');
      expect(preview.worldBookMatches.some((match) => match.content.includes('禁用世界书内容'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('saves global native presets and injects triggered global world book entries into prompt preview', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Lore Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const presetRes = await fetch(`${base}/api/admin/config/presets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '调查预设',
          description: '强调线索公平性。',
          isActive: false,
          blocks: [
            { name: '调查规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 5, content: '调查规则：线索必须可追踪。' },
            { name: '输出格式', role: 'system', position: 'final', enabled: true, orderIndex: 900, content: '输出格式：只返回 JSON。' }
          ]
        })
      });
      expect(presetRes.status).toBe(200);
      const presetPayload = await presetRes.json() as { preset: { id: string; isActive: boolean } };
      expect(presetPayload.preset.isActive).toBe(false);

      const updatePresetRes = await fetch(`${base}/api/admin/config/presets/${presetPayload.preset.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '调查预设更新',
          description: '强调线索公平性。',
          isActive: false,
          blocks: [
            { name: '调查规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 5, content: '调查规则：线索必须可追踪，且不回写旧日志。' }
          ]
        })
      });
      expect(updatePresetRes.status).toBe(200);
      expect((await fetch(`${base}/api/admin/config/presets/missing-preset/activate`, { method: 'POST' })).status).toBe(404);
      expect((await fetch(`${base}/api/admin/config/presets/${presetPayload.preset.id}/activate`, { method: 'POST' })).status).toBe(200);

      const bookRes = await fetch(`${base}/api/admin/config/world-books`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '主世界书', description: '测试世界书', enabled: true })
      });
      const bookPayload = await bookRes.json() as { worldBook: { id: string } };
      const worldBookId = bookPayload.worldBook.id;

      expect((await fetch(`${base}/api/admin/config/world-books/missing-world-book/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Missing', keys: [], secondaryKeys: [], content: 'Missing content.' })
      })).status).toBe(404);

      const entryRes = await fetch(`${base}/api/admin/config/world-books/${worldBookId}/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Candlekeep Gate',
          keys: ['Candlekeep'],
          secondaryKeys: [],
          content: '旧内容会被更新。',
          enabled: true,
          constant: false,
          selective: false,
          priority: 200,
          position: 'after_world'
        })
      });
      expect(entryRes.status).toBe(200);
      const entryPayload = await entryRes.json() as { entry: { id: string } };
      const updateEntryRes = await fetch(`${base}/api/admin/config/world-books/${worldBookId}/entries/${entryPayload.entry.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Candlekeep Gate',
          keys: ['Candlekeep'],
          secondaryKeys: [],
          content: 'Candlekeep 的月光门会回应银钥匙。',
          enabled: true,
          constant: false,
          selective: false,
          priority: 200,
          position: 'after_world'
        })
      });
      expect(updateEntryRes.status).toBe(200);
      expect((await fetch(`${base}/api/admin/config/world-books/${worldBookId}/entries/missing-entry`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Missing', keys: [], secondaryKeys: [], content: 'Missing content.' })
      })).status).toBe(404);
      db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('lore-trigger-log', room.roomId, null, 'public', null, 'Approach', 'The party approaches Candlekeep gate.', new Date().toISOString());

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      const preview = await previewRes.json() as { prompt: string };
      expect(preview.prompt).toContain('调查规则：线索必须可追踪，且不回写旧日志。');
      expect(preview.prompt).toContain('Candlekeep Gate');
      expect(preview.prompt).toContain('Candlekeep 的月光门会回应银钥匙。');
      expect(preview.prompt.indexOf('调查规则')).toBeLessThan(preview.prompt.indexOf('Room: Lore Room'));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('keeps the full DND contract as the final native prompt section even with a custom final block', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Native Contract Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const presetRes = await fetch(`${base}/api/admin/config/presets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '弱化输出预设',
          description: '测试最终契约追加。',
          isActive: true,
          blocks: [
            { name: '普通最终块', role: 'system', position: 'final', enabled: true, orderIndex: 10, content: '普通最终块：可以描述风格，但不能替代契约。' }
          ]
        })
      });
      expect(presetRes.status).toBe(200);

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as PromptPreviewPayload;
      expect(preview.mode).toBe('native');
      expect(preview.prompt).toContain('普通最终块：可以描述风格，但不能替代契约。');
      expect(preview.prompt).toContain('# DND 输出契约');
      expect(preview.prompt).toContain('严格 JSON 输出：只返回一个 JSON 对象');
      expect(preview.prompt.trim().endsWith(preview.promptBlocks.at(-1)?.content ?? '')).toBe(true);
      expect(preview.promptBlocks.at(-1)).toMatchObject({ identifier: 'dndOutputContract', source: 'dnd-contract' });
      expect(preview.prompt.indexOf('普通最终块：可以描述风格，但不能替代契约。')).toBeLessThan(preview.prompt.lastIndexOf('# DND 输出契约'));
      expect(occurrenceCount(preview.prompt, '# DND 输出契约')).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('deduplicates a native preset block whose content is the full DND contract', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Duplicate Contract Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const fullContract = renderDndOutputContract();

      const presetRes = await fetch(`${base}/api/admin/config/presets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '完整契约重复预设',
          description: '测试完整契约去重。',
          isActive: true,
          blocks: [
            { name: '完整契约复制', role: 'system', position: 'final', enabled: true, orderIndex: 10, content: fullContract }
          ]
        })
      });
      expect(presetRes.status).toBe(200);

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as PromptPreviewPayload;
      expect(occurrenceCount(preview.prompt, '# DND 输出契约')).toBe(1);
      expect(preview.promptBlocks.filter((block) => block.identifier === 'dndOutputContract')).toHaveLength(1);
      expect(preview.promptBlocks.at(-1)).toMatchObject({ identifier: 'dndOutputContract', source: 'dnd-contract' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('marks the current turn as needing admin attention when AI processing fails', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const stub = await createOpenAiStub(() => ({ status: 502, body: { error: 'simulated AI failure' } }));
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Failing AI Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const player = await playerRes.json() as { playerId: string };
      const configRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'failing-key', model: 'failing-model' })
      });
      expect(configRes.status).toBe(200);
      const turn = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?').get(room.roomId, 1) as { id: string };
      db.prepare('INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('failing-action', room.roomId, turn.id, player.playerId, 'I cross the bridge.', new Date().toISOString(), 'submitted');
      await fetch(`${base}/api/admin/rooms/${room.roomId}`);

      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
      expect(processRes.status).toBe(500);
      const roomRow = db.prepare('SELECT status FROM rooms WHERE id = ?').get(room.roomId) as { status: string };
      const turnRow = db.prepare('SELECT status FROM turns WHERE id = ?').get(turn.id) as { status: string };
      const turnCount = db.prepare('SELECT COUNT(*) as count FROM turns WHERE room_id = ?').get(room.roomId) as { count: number };
      const generation = db.prepare('SELECT error FROM ai_generations WHERE room_id = ? AND turn_id = ?').get(room.roomId, turn.id) as { error: string | null };
      expect(roomRow.status).toBe('needs_admin_attention');
      expect(turnRow.status).toBe('needs_admin_attention');
      expect(turnCount.count).toBe(1);
      expect(generation.error).toContain('simulated AI failure');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('disables legacy process-turn unless test compatibility is explicitly requested', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Legacy Disabled Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, { method: 'POST' });
      expect(processRes.status).toBe(410);
      const payload = await processRes.json() as { error: string; message: string };
      expect(payload.error).toBe('PROCESS_TURN_DISABLED');
      expect(payload.message).toContain('/api/admin/ai/turn-preview');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('rejects process-turn when the room is already claimed for processing', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Claimed Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const player = await playerRes.json() as { token: string };
      await fetch(`${base}/api/player/${player.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I open the door.' })
      });
      db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('processing', room.roomId);

      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
      expect(processRes.status).toBe(409);
      const generationCount = db.prepare('SELECT COUNT(*) as count FROM ai_generations WHERE room_id = ?').get(room.roomId) as { count: number };
      expect(generationCount.count).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('rejects process-turn when the current turn is not open', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Turn Claimed Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const player = await playerRes.json() as { token: string };
      await fetch(`${base}/api/player/${player.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I open the door.' })
      });
      db.prepare('UPDATE turns SET status = ? WHERE room_id = ? AND number = ?').run('processing', room.roomId, 1);

      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
      expect(processRes.status).toBe(409);
      const generationCount = db.prepare('SELECT COUNT(*) as count FROM ai_generations WHERE room_id = ?').get(room.roomId) as { count: number };
      expect(generationCount.count).toBe(0);
      const roomStatus = db.prepare('SELECT status FROM rooms WHERE id = ?').get(room.roomId) as { status: string };
      expect(roomStatus.status).toBe('ready_to_resolve');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('uses the current global ST resource config for every room prompt preview', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ST Preview Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const scriptRes = await fetch(`${base}/api/admin/resources/script-cards/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ characterCard: { data: { name: 'Gate Script', description: 'A keeper knows Candlekeep rituals.', scenario: 'The gate is sealed.', first_mes: 'The global gate opens.' } } })
      });
      const scriptPayload = await scriptRes.json() as { scriptCard: { id: string } };

      const worldBookRes = await fetch(`${base}/api/admin/resources/world-books/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worldBook: { name: 'Gate Lore', entries: [{ name: 'Candlekeep Gate', keys: ['Candlekeep'], content: 'The gate needs a silver key.', enabled: true, order: 150, position: 'after' }] } })
      });
      const worldBookPayload = await worldBookRes.json() as { worldBook: { id: string } };

      const presetRes = await fetch(`${base}/api/admin/resources/preset-packages/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          openAiSettings: {
            name: 'DND ST Preset',
            prompts: [
              { identifier: 'main', role: 'system', content: 'Imported main prompt.' },
              { identifier: 'charDescription', role: 'system', content: '' },
              { identifier: 'worldInfoAfter', role: 'system', content: '' }
            ],
            prompt_order: [{ order: [
              { identifier: 'main', enabled: true },
              { identifier: 'charDescription', enabled: true },
              { identifier: 'worldInfoAfter', enabled: true },
              { identifier: 'dndOutputContract', enabled: true }
            ] }]
          }
        })
      });
      const presetPayload = await presetRes.json() as { presetPackage: { id: string } };

      expect((await fetch(`${base}/api/admin/config/script-card`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scriptCardId: 'missing-script-card' })
      })).status).toBe(404);
      expect((await fetch(`${base}/api/admin/config/preset-package`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetPackageId: 'missing-preset-package' })
      })).status).toBe(404);
      expect((await fetch(`${base}/api/admin/config/resource-world-books`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bindings: [{ worldBookId: 'missing-world-book', enabled: true, orderIndex: 0 }] })
      })).status).toBe(404);
      expect((await fetch(`${base}/api/admin/config/resource-world-books`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bindings: [
          { worldBookId: worldBookPayload.worldBook.id, enabled: true, orderIndex: 0 },
          { worldBookId: worldBookPayload.worldBook.id, enabled: true, orderIndex: 1 }
        ] })
      })).status).toBe(400);

      expect((await fetch(`${base}/api/admin/config/script-card`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scriptCardId: scriptPayload.scriptCard.id })
      })).status).toBe(200);
      expect((await fetch(`${base}/api/admin/config/resource-world-books`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bindings: [{ worldBookId: worldBookPayload.worldBook.id, enabled: true, orderIndex: 0 }] })
      })).status).toBe(200);
      expect((await fetch(`${base}/api/admin/config/preset-package`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetPackageId: presetPayload.presetPackage.id })
      })).status).toBe(200);

      db.prepare('UPDATE global_config SET ai_config_json = ? WHERE id = ?').run(JSON.stringify({
        ...defaultAiConfig,
        outputFormatRules: '毒化 ST 输出格式：不应进入固定引擎契约。'
      }), 'default');

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as PromptPreviewPayload;
      expect(preview.mode).toBe('sillytavern-compatible');
      expect(preview.prompt).toContain('Imported main prompt.');
      expect(preview.slots.some((slot) => slot.key === 'scenario' && slot.content.includes('The gate is sealed.'))).toBe(true);
      expect(preview.worldBookMatches.some((match) => match.content.includes('silver key') && match.keys.includes('Candlekeep'))).toBe(true);
      expect(preview.prompt).toContain('The gate needs a silver key.');
      expect(preview.prompt).toContain('# DND 输出契约');
      expect(preview.prompt).not.toContain('毒化 ST 输出格式');

      await fetch(`${base}/api/admin/config/script-card`, { method: 'DELETE' });
      const previewAfterClearRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      const previewAfterClear = await previewAfterClearRes.json() as PromptPreviewPayload;
      expect(previewAfterClear.prompt).not.toContain('keeper knows Candlekeep');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('uses ST preset and fixed DND contract for process-turn without global ai_config_json contamination', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const resultJson = aiTurnResult({ publicLog: 'ST runtime public log.', ruleResults: ['st rule'] });
    const stub = await createOpenAiStub(() => ({
      body: { choices: [{ message: { content: JSON.stringify(resultJson) } }] }
    }));
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ST Process Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const player = await playerRes.json() as { token: string };

      const presetRes = await fetch(`${base}/api/admin/resources/preset-packages/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          openAiSettings: {
            name: 'ST Process Preset',
            prompts: [
              { identifier: 'main', role: 'system', content: 'ST process preset main block.' },
              { identifier: 'chatHistory', role: 'user', content: '' },
              { identifier: 'dndPlayerActions', role: 'user', content: '' },
              { identifier: 'dndOutputContract', role: 'user', content: 'Imported weak contract placeholder.' }
            ],
            prompt_order: [{ order: [
              { identifier: 'main', enabled: true },
              { identifier: 'chatHistory', enabled: true },
              { identifier: 'dndPlayerActions', enabled: true },
              { identifier: 'dndOutputContract', enabled: true }
            ] }]
          }
        })
      });
      expect(presetRes.status).toBe(200);
      const presetPayload = await presetRes.json() as { presetPackage: { id: string } };
      expect((await fetch(`${base}/api/admin/config/preset-package`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetPackageId: presetPayload.presetPackage.id })
      })).status).toBe(200);

      const poison = '毒化 ST process-turn 输出格式：不应进入运行时 prompt。';
      db.prepare('UPDATE global_config SET ai_config_json = ? WHERE id = ?').run(JSON.stringify({
        ...defaultAiConfig,
        outputFormatRules: poison
      }), 'default');

      const providerRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'st-process-key', model: 'st-process-model' })
      });
      expect(providerRes.status).toBe(200);
      const actionRes = await fetch(`${base}/api/player/${player.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I test the ST process prompt.' })
      });
      expect(actionRes.status).toBe(200);

      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
      expect(processRes.status).toBe(200);
      expect(stub.requests).toHaveLength(1);
      const capturedPrompt = stub.requests[0].messages.find((message: { role: string; content: string }) => message.role === 'user')?.content as string;
      expect(capturedPrompt).toContain('ST process preset main block.');
      expect(capturedPrompt).toContain('I test the ST process prompt.');
      expect(capturedPrompt).toContain('# DND 输出契约');
      expect(capturedPrompt).toContain('严格 JSON 输出：只返回一个 JSON 对象');
      expect(capturedPrompt).toContain(renderDndOutputContract());
      expect(capturedPrompt).not.toContain(poison);
      expect(occurrenceCount(capturedPrompt, '# DND 输出契约')).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('does not rewrite existing default global preset blocks during startup ensure', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const now = new Date().toISOString();
    const legacyAiConfig = { ...defaultAiConfig, coreRules: '旧 ai_config_json 不应重新覆盖默认预设。' };
    db.prepare('INSERT INTO global_config (id, ai_config_json, active_script_card_id, active_preset_package_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('default', JSON.stringify(legacyAiConfig), null, null, now, now);
    db.prepare('INSERT INTO global_prompt_presets (id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('default-global-preset', '默认强约束预设', '用户已编辑默认预设。', 1, now, now);
    db.prepare('INSERT INTO global_prompt_blocks (id, preset_id, name, role, position, enabled, order_index, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('user-edited-default-global-block', 'default-global-preset', '用户编辑块', 'system', 'before_world', 1, 1, '用户编辑后的默认预设内容必须保留。');

    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const configRes = await fetch(`${base}/api/admin/config`);
      expect(configRes.status).toBe(200);
      const config = await configRes.json() as { presets: Array<{ id: string; blocks: Array<{ content: string }> }> };
      const defaultPreset = config.presets.find((preset) => preset.id === 'default-global-preset');
      expect(defaultPreset?.blocks).toHaveLength(1);
      expect(defaultPreset?.blocks[0].content).toBe('用户编辑后的默认预设内容必须保留。');
      expect(defaultPreset?.blocks.some((block) => block.content.includes(legacyAiConfig.coreRules))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('seeds missing default global preset blocks from built-in defaults instead of legacy ai_config_json', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const now = new Date().toISOString();
    const legacyAiConfig = {
      coreRules: '毒化缺失默认预设核心规则：不应进入新默认预设。',
      playerAgencyRules: '毒化缺失默认预设玩家自主权：不应进入新默认预设。',
      visibilityRules: '毒化缺失默认预设信息隔离：不应进入新默认预设。',
      interactionRules: '毒化缺失默认预设互动规则：不应进入新默认预设。',
      styleRules: '毒化缺失默认预设叙事风格：不应进入新默认预设。',
      outputFormatRules: '毒化缺失默认预设输出格式：不应进入新默认预设。'
    };
    db.prepare('INSERT INTO global_config (id, ai_config_json, active_script_card_id, active_preset_package_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('default', JSON.stringify(legacyAiConfig), null, null, now, now);

    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const configRes = await fetch(`${base}/api/admin/config`);
      expect(configRes.status).toBe(200);
      const config = await configRes.json() as { presets: Array<{ id: string; blocks: Array<{ content: string }> }> };
      const defaultPreset = config.presets.find((preset) => preset.id === 'default-global-preset');
      const blockContents = defaultPreset?.blocks.map((block) => block.content) ?? [];
      expect(defaultPreset?.blocks).toHaveLength(7);
      expect(blockContents).toContain(defaultAiConfig.coreRules);
      expect(blockContents.some((content) => content.includes('剧情字数硬上限'))).toBe(true);
      expect(blockContents.some((content) => content.includes('毒化缺失默认预设'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('stores AI constraints in a singleton global config instead of a room', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const defaultConfigRes = await fetch(`${base}/api/admin/config`);
      expect(defaultConfigRes.status).toBe(200);
      const defaultConfig = await defaultConfigRes.json() as { aiConfig: typeof defaultAiConfig; activeScriptCardId: string | null; activePresetPackageId: string | null; globalWorldBookBindings: unknown[]; presets: Array<{ name: string }> };
      expect(defaultConfig.aiConfig.coreRules).toBe(defaultAiConfig.coreRules);
      expect(defaultConfig.activeScriptCardId).toBeNull();
      expect(defaultConfig.activePresetPackageId).toBeNull();
      expect(defaultConfig.globalWorldBookBindings).toEqual([]);
      expect(defaultConfig.presets.some((preset) => preset.name === '默认强约束预设')).toBe(true);

      db.prepare('DELETE FROM global_prompt_blocks').run();
      db.prepare('DELETE FROM global_prompt_presets').run();

      const now = new Date().toISOString();
      db.prepare('INSERT INTO global_prompt_presets (id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('custom-active-global-preset', '自定义激活预设', '不应被 AI config 同步覆盖。', 1, now, '9999-01-01T00:00:00.000Z');
      db.prepare('INSERT INTO global_prompt_blocks (id, preset_id, name, role, position, enabled, order_index, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('custom-active-global-block', 'custom-active-global-preset', '自定义块', 'system', 'before_world', 1, 1, '自定义内容必须保留。');
      db.prepare('INSERT INTO global_prompt_presets (id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('same-name-custom-preset', '默认强约束预设', '同名自定义预设不应被当作系统默认预设。', 0, now, now);
      db.prepare('INSERT INTO global_prompt_blocks (id, preset_id, name, role, position, enabled, order_index, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('same-name-custom-block', 'same-name-custom-preset', '同名自定义块', 'system', 'before_world', 1, 2, '同名自定义内容必须保留。');

      const nextAiConfig = {
        coreRules: '核心约束：全局配置会实时影响所有房间。',
        playerAgencyRules: '玩家自主权：全局规则不能替玩家决定。',
        visibilityRules: '信息隔离：全局规则不能泄露秘密。',
        interactionRules: '互动规则：全局规则要求确认互动。',
        styleRules: '叙事风格：全局中文短句。',
        outputFormatRules: '输出格式：全局严格 JSON。'
      };
      const updateRes = await fetch(`${base}/api/admin/config/ai-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(nextAiConfig)
      });
      expect(updateRes.status).toBe(200);
      expect(await updateRes.json()).toEqual(nextAiConfig);

      const updatedConfigRes = await fetch(`${base}/api/admin/config`);
      const updatedConfig = await updatedConfigRes.json() as { aiConfig: typeof nextAiConfig };
      expect(updatedConfig.aiConfig).toEqual(nextAiConfig);
      const customBlock = db.prepare('SELECT content FROM global_prompt_blocks WHERE id = ?').get('custom-active-global-block') as { content: string } | undefined;
      expect(customBlock?.content).toBe('自定义内容必须保留。');
      const sameNameCustomBlock = db.prepare('SELECT content FROM global_prompt_blocks WHERE id = ?').get('same-name-custom-block') as { content: string } | undefined;
      expect(sameNameCustomBlock?.content).toBe('同名自定义内容必须保留。');
      const activeCustomPreset = db.prepare('SELECT is_active FROM global_prompt_presets WHERE id = ?').get('custom-active-global-preset') as { is_active: number } | undefined;
      const defaultGlobalPreset = db.prepare('SELECT is_active FROM global_prompt_presets WHERE id = ?').get('default-global-preset') as { is_active: number } | undefined;
      const defaultGlobalBlocks = db.prepare('SELECT content FROM global_prompt_blocks WHERE preset_id = ? ORDER BY order_index').all('default-global-preset') as Array<{ content: string }>;
      expect(activeCustomPreset?.is_active).toBe(1);
      expect(defaultGlobalPreset?.is_active).toBe(0);
      expect(defaultGlobalBlocks.map((block) => block.content)).toContain(defaultAiConfig.coreRules);
      expect(defaultGlobalBlocks.map((block) => block.content)).not.toContain(nextAiConfig.coreRules);

      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Global Config Room' })
      });
      expect(roomRes.status).toBe(200);
      const room = await roomRes.json() as { roomId: string };

      const roomRow = db.prepare('SELECT ai_config_json FROM rooms WHERE id = ?').get(room.roomId) as { ai_config_json: string };
      expect(JSON.parse(roomRow.ai_config_json)).not.toEqual(nextAiConfig);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('uses the active global script card for room opening logs', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const firstMesScriptRes = await fetch(`${base}/api/admin/resources/script-cards/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ characterCard: { data: { name: 'FirstMes Script', description: 'Opening description', scenario: 'Scenario fallback text.', first_mes: 'First message opening text.' } } })
      });
      const firstMesScript = await firstMesScriptRes.json() as { scriptCard: { id: string } };
      expect((await fetch(`${base}/api/admin/config/script-card`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scriptCardId: firstMesScript.scriptCard.id })
      })).status).toBe(200);
      const firstRoomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'FirstMes Opening Room' })
      });
      const firstRoom = await firstRoomRes.json() as { roomId: string };
      const firstLog = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND title = ?').get(firstRoom.roomId, 'Opening Scene') as { content: string };
      expect(firstLog.content).toBe('First message opening text.');

      const scenarioScriptRes = await fetch(`${base}/api/admin/resources/script-cards/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ characterCard: { data: { name: 'Scenario Script', description: 'Scenario description', scenario: 'Scenario only opening text.', first_mes: '' } } })
      });
      const scenarioScript = await scenarioScriptRes.json() as { scriptCard: { id: string } };
      expect((await fetch(`${base}/api/admin/config/script-card`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scriptCardId: scenarioScript.scriptCard.id })
      })).status).toBe(200);
      const scenarioRoomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Scenario Opening Room' })
      });
      const scenarioRoom = await scenarioRoomRes.json() as { roomId: string };
      const scenarioLog = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND title = ?').get(scenarioRoom.roomId, 'Opening Scene') as { content: string };
      expect(scenarioLog.content).toBe('Scenario only opening text.');

      expect((await fetch(`${base}/api/admin/config/script-card`, { method: 'DELETE' })).status).toBe(200);
      const defaultRoomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Default Opening Room' })
      });
      const defaultRoom = await defaultRoomRes.json() as { roomId: string };
      const defaultLog = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND title = ?').get(defaultRoom.roomId, 'Opening Scene') as { content: string };
      expect(defaultLog.content).toBe('此房间已创建。请在全局配置中选择主剧本卡后开始游戏。');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('uses current global native preset and script card for each process-turn without rewriting prior state', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    let capturedPrompt = '';
    const stub = await createOpenAiStub((body) => {
      capturedPrompt = body.messages?.find((message: { role?: string; content?: string }) => message.role === 'user')?.content ?? '';
      return { body: { choices: [{ message: { content: JSON.stringify(aiTurnResult({ publicLog: 'Resolved from captured prompt.' })) } }] } };
    });
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Global Runtime Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const scriptRes = await fetch(`${base}/api/admin/resources/script-cards/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ characterCard: { data: { name: 'Runtime Script', description: 'Runtime description.', personality: 'Runtime personality.', scenario: 'Runtime scenario in prompt.', first_mes: 'Runtime opening.' } } })
      });
      const script = await scriptRes.json() as { scriptCard: { id: string } };
      await fetch(`${base}/api/admin/config/script-card`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scriptCardId: script.scriptCard.id })
      });
      const coreBlockUpdate = db.prepare('UPDATE global_prompt_blocks SET content = ? WHERE preset_id = ? AND name = ?')
        .run('核心约束：处理回合来自全局预设。', 'default-global-preset', '核心规则');
      const outputBlockUpdate = db.prepare('UPDATE global_prompt_blocks SET content = ? WHERE preset_id = ? AND name = ?')
        .run('输出格式：处理回合默认预设 JSON。', 'default-global-preset', '输出格式规则');
      expect(coreBlockUpdate.changes).toBe(1);
      expect(outputBlockUpdate.changes).toBe(1);
      db.prepare('UPDATE global_config SET ai_config_json = ? WHERE id = ?').run(JSON.stringify({
        ...defaultAiConfig,
        coreRules: '毒化处理回合核心规则：不应进入 prompt。',
        outputFormatRules: '毒化处理回合输出格式：不应进入 prompt。'
      }), 'default');
      await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'runtime-key', model: 'runtime-model' })
      });
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const player = await playerRes.json() as { playerId: string };
      const turn = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?').get(room.roomId, 1) as { id: string };
      db.prepare('INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('runtime-action', room.roomId, turn.id, player.playerId, 'I follow the runtime script.', new Date().toISOString(), 'submitted');
      await fetch(`${base}/api/admin/rooms/${room.roomId}`);

      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
      expect(processRes.status).toBe(200);
      expect(capturedPrompt).toContain('核心约束：处理回合来自全局预设。');
      expect(capturedPrompt).toContain('输出格式：处理回合默认预设 JSON。');
      expect(capturedPrompt).not.toContain('毒化处理回合核心规则');
      expect(capturedPrompt).not.toContain('毒化处理回合输出格式');
      expect(capturedPrompt).toContain('# 全局主剧本卡');
      expect(capturedPrompt).toContain('名称：Runtime Script');
      expect(capturedPrompt).toContain('Runtime scenario in prompt.');

      const generationBefore = db.prepare('SELECT output FROM ai_generations WHERE room_id = ?').get(room.roomId) as { output: string };
      const actionBefore = db.prepare('SELECT text FROM actions WHERE id = ?').get('runtime-action') as { text: string };
      const logBefore = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND title = ?').get(room.roomId, 'Opening Scene') as { content: string };
      await fetch(`${base}/api/admin/config/ai-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...defaultAiConfig, coreRules: '核心约束：变更后不应改写旧状态。' })
      });
      const generationAfter = db.prepare('SELECT output FROM ai_generations WHERE room_id = ?').get(room.roomId) as { output: string };
      const actionAfter = db.prepare('SELECT text FROM actions WHERE id = ?').get('runtime-action') as { text: string };
      const logAfter = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND title = ?').get(room.roomId, 'Opening Scene') as { content: string };
      expect(generationAfter.output).toBe(generationBefore.output);
      expect(actionAfter.text).toBe(actionBefore.text);
      expect(logAfter.content).toBe(logBefore.content);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('indexes approved PHB rules and previews rule retrieval matches', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const importRes = await fetch(`${base}/api/admin/resources/import-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'PHB 规则检索抽取',
          sourceFileName: 'phb.pdf',
          drafts: [
            {
              kind: 'rule_entry',
              title: '攻击检定',
              category: 'combat',
              summary: '攻击时掷 d20 对抗 AC。',
              content: '攻击检定用于判断是否命中。',
              keys: ['攻击检定', 'AC'],
              sourceRef: 'PHB p.194'
            }
          ]
        })
      });
      expect(importRes.status).toBe(200);
      const imported = await importRes.json() as { drafts: Array<{ id: string }> };
      expect(imported.drafts).toHaveLength(1);

      const approveRes = await fetch(`${base}/api/admin/resources/import-drafts/${imported.drafts[0].id}/review`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' })
      });
      expect(approveRes.status).toBe(200);

      const reindexRes = await fetch(`${base}/api/admin/rules/embeddings/reindex`, { method: 'POST' });
      expect(reindexRes.status).toBe(200);
      expect(await reindexRes.json()).toEqual({ indexed: 1, skipped: 0 });

      const previewRes = await fetch(`${base}/api/admin/rules/retrieval-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '我攻击强盗，看是否命中 AC。' })
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { matches: Array<{ title: string; reasons: string[] }> };
      expect(preview.matches[0].title).toBe('攻击检定');
      expect(preview.matches[0].reasons).toContain('keyword');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('injects retrieved PHB rules into native prompt preview silently', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '规则注入房间' })
      });
      expect(roomRes.status).toBe(200);
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '艾拉' })
      });
      expect(playerRes.status).toBe(200);

      const importRes = await fetch(`${base}/api/admin/resources/import-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'PHB prompt 注入抽取',
          sourceFileName: 'phb.pdf',
          drafts: [
            {
              kind: 'rule_entry',
              title: '攻击检定',
              category: 'combat',
              summary: '攻击时掷 d20 对抗 AC。',
              content: '攻击检定用于判断攻击是否命中目标 AC。',
              keys: ['攻击', 'AC'],
              sourceRef: 'PHB p.194'
            }
          ]
        })
      });
      expect(importRes.status).toBe(200);
      const imported = await importRes.json() as { drafts: Array<{ id: string }> };
      expect(imported.drafts).toHaveLength(1);

      const approveRes = await fetch(`${base}/api/admin/resources/import-drafts/${imported.drafts[0].id}/review`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' })
      });
      expect(approveRes.status).toBe(200);
      const reindexRes = await fetch(`${base}/api/admin/rules/embeddings/reindex`, { method: 'POST' });
      expect(reindexRes.status).toBe(200);

      const playerRow = db.prepare('SELECT token FROM players WHERE room_id = ? AND name = ?').get(room.roomId, '艾拉') as { token: string };
      const actionRes = await fetch(`${base}/api/player/${playerRow.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我攻击穿着皮甲的强盗，看看能不能命中 AC。' })
      });
      expect(actionRes.status).toBe(200);

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as PromptPreviewPayload;
      expect(preview.prompt).toContain('# 5e 规则检索命中');
      expect(preview.prompt).toContain('攻击检定');
      expect(preview.ruleMatches).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: '攻击检定', summary: '攻击时掷 d20 对抗 AC。' })
      ]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('stores short rule summaries for players after process-turn retrieval', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '规则摘要房间' })
      });
      expect(roomRes.status).toBe(200);
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '洛林' })
      });
      expect(playerRes.status).toBe(200);
      const player = await playerRes.json() as { token: string };

      const importRes = await fetch(`${base}/api/admin/resources/import-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'PHB 规则摘要抽取',
          sourceFileName: 'phb.pdf',
          drafts: [
            {
              kind: 'rule_entry',
              title: '攻击检定',
              category: 'combat',
              summary: '攻击时掷 d20 对抗 AC。',
              content: '攻击检定用于判断是否命中。',
              keys: ['攻击', 'AC'],
              sourceRef: 'PHB p.194'
            }
          ]
        })
      });
      expect(importRes.status).toBe(200);
      const imported = await importRes.json() as { drafts: Array<{ id: string }> };
      expect(imported.drafts).toHaveLength(1);

      const approveRes = await fetch(`${base}/api/admin/resources/import-drafts/${imported.drafts[0].id}/review`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' })
      });
      expect(approveRes.status).toBe(200);
      const reindexRes = await fetch(`${base}/api/admin/rules/embeddings/reindex`, { method: 'POST' });
      expect(reindexRes.status).toBe(200);

      const actionRes = await fetch(`${base}/api/player/${player.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我攻击强盗。' })
      });
      expect(actionRes.status).toBe(200);

      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
      expect(processRes.status).toBe(200);

      const stateRes = await fetch(`${base}/api/player/${player.token}/state`);
      expect(stateRes.status).toBe(200);
      const state = await stateRes.json() as { ruleSummaries: Array<{ title: string; summary: string; reason: string }> };
      expect(state.ruleSummaries[0]).toMatchObject({
        title: '攻击检定',
        summary: '攻击时掷 d20 对抗 AC。'
      });
      expect(state.ruleSummaries[0].reason).toContain('参考规则');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('imports, reviews, and exposes resource catalogs through admin resource APIs', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const importRes = await fetch(`${base}/api/admin/resources/import-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'PHB API 抽取',
          sourceFileName: 'phb.pdf',
          drafts: [
            {
              kind: 'rule_entry',
              title: '攻击检定',
              category: 'combat',
              summary: '攻击检定摘要。',
              content: '攻击检定正文。',
              keys: ['攻击检定'],
              sourceRef: 'PHB p.194'
            },
            {
              kind: 'character_option',
              optionType: 'class',
              title: '战士',
              summary: '战士摘要。',
              ruleData: { hitDie: 'd10' },
              sourceRef: 'PHB p.70'
            },
            {
              kind: 'resource_rule',
              title: '生命骰',
              category: 'rest',
              summary: '生命骰摘要。',
              ruleData: { resource: 'hit_dice' },
              sourceRef: 'PHB p.186'
            }
          ]
        })
      });
      expect(importRes.status).toBe(200);
      const imported = await importRes.json() as { drafts: Array<{ id: string; status: string }> };
      expect(imported.drafts.map((draft) => draft.status)).toEqual(['pending', 'pending', 'pending']);

      const jobsRes = await fetch(`${base}/api/admin/resources/import-jobs`);
      expect(jobsRes.status).toBe(200);
      const jobs = await jobsRes.json() as { jobs: Array<{ name: string; visibility: string }> };
      expect(jobs.jobs).toEqual([
        expect.objectContaining({ name: 'PHB API 抽取', visibility: 'private' })
      ]);

      const invalidImportRes = await fetch(`${base}/api/admin/resources/import-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '非法导入',
          drafts: [{ kind: 'character_option', title: '缺少类型', summary: '缺少 optionType。' }]
        })
      });
      expect(invalidImportRes.status).toBe(400);
      const invalidImport = await invalidImportRes.json() as { error: string };
      expect(invalidImport.error).toContain('optionType');

      const pendingRes = await fetch(`${base}/api/admin/resources/import-drafts?status=pending`);
      expect(pendingRes.status).toBe(200);
      const pending = await pendingRes.json() as { drafts: Array<{ id: string; title: string; kind: string }> };
      expect(pending.drafts).toHaveLength(3);
      const attackDraft = pending.drafts.find((draft) => draft.title === '攻击检定');
      const fighterDraft = pending.drafts.find((draft) => draft.title === '战士');
      const resourceDraft = pending.drafts.find((draft) => draft.title === '生命骰');
      expect(attackDraft).toBeDefined();
      expect(fighterDraft).toBeDefined();
      expect(resourceDraft).toBeDefined();
      if (!attackDraft || !fighterDraft || !resourceDraft) throw new Error('Expected resource drafts to be importable by title');

      const rulePendingRes = await fetch(`${base}/api/admin/resources/import-drafts?status=pending&kind=rule_entry&sourceType=local_json&ruleset=unknown&language=unknown`);
      expect(rulePendingRes.status).toBe(200);
      const rulePending = await rulePendingRes.json() as { drafts: Array<{ title: string }> };
      expect(rulePending.drafts).toEqual([expect.objectContaining({ title: '攻击检定' })]);

      const approveRes = await fetch(`${base}/api/admin/resources/import-drafts/${attackDraft.id}/review`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' })
      });
      expect(approveRes.status).toBe(200);

      const repeatedReviewRes = await fetch(`${base}/api/admin/resources/import-drafts/${attackDraft.id}/review`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'rejected', rejectionReason: '重复审核' })
      });
      expect(repeatedReviewRes.status).toBe(409);

      const rejectRes = await fetch(`${base}/api/admin/resources/import-drafts/${fighterDraft.id}/review`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'rejected', rejectionReason: '先不开放该职业' })
      });
      expect(rejectRes.status).toBe(200);

      const approveResourceRes = await fetch(`${base}/api/admin/resources/import-drafts/${resourceDraft.id}/review`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' })
      });
      expect(approveResourceRes.status).toBe(200);

      const approvedRes = await fetch(`${base}/api/admin/resources/approved-catalogs`);
      expect(approvedRes.status).toBe(200);
      const approved = await approvedRes.json() as { ruleEntries: unknown[]; characterOptions: unknown[]; resourceRules: unknown[] };
      expect(approved.ruleEntries).toHaveLength(1);
      expect(approved.characterOptions).toHaveLength(0);
      expect(approved.resourceRules).toHaveLength(1);

      const duplicateImportRes = await fetch(`${base}/api/admin/resources/import-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'PHB API 重复项抽取',
          sourceFileName: 'phb.pdf',
          drafts: [
            {
              kind: 'rule_entry',
              title: '重复规则',
              category: 'combat',
              summary: '重复规则摘要一。',
              content: '重复规则正文一。',
              keys: ['重复规则'],
              sourceRef: 'PHB p.1'
            },
            {
              kind: 'rule_entry',
              title: '重复规则',
              category: 'combat',
              summary: '重复规则摘要二。',
              content: '重复规则正文二。',
              keys: ['重复规则'],
              sourceRef: 'PHB p.1'
            }
          ]
        })
      });
      expect(duplicateImportRes.status).toBe(200);
      const duplicateImport = await duplicateImportRes.json() as { drafts: Array<{ id: string }> };
      expect(new Set(duplicateImport.drafts.map((draft) => draft.id)).size).toBe(duplicateImport.drafts.length);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('lets a player save, audit, and confirm a level-1 character builder draft', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);

    const { drafts } = createResourceImportJob(db, {
      name: '建卡选项',
      sourceFileName: 'phb.pdf',
      drafts: [
        { kind: 'character_option', optionType: 'species', title: '人类', summary: '人类种族', category: 'species' },
        { kind: 'character_option', optionType: 'class', title: '战士', summary: '战士职业', category: 'class', ruleData: { hitDie: 'd10' } },
        { kind: 'character_option', optionType: 'background', title: '士兵', summary: '士兵背景', category: 'background' },
        { kind: 'character_option', optionType: 'skill', title: 'Athletics', summary: '运动技能', category: 'skill' },
        { kind: 'character_option', optionType: 'equipment', title: '长剑', summary: '长剑武器', category: 'equipment' },
      ]
    });

    for (const draft of drafts) {
      reviewResourceImportDraft(db, draft.id, { status: 'approved' });
    }

    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '建卡房间' })
      });
      const room = await roomRes.json() as { roomId: string };

      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '洛林玩家' })
      });
      const player = await playerRes.json() as { token: string };

      const optionsRes = await fetch(`${base}/api/player/${player.token}/character-builder/options`);
      expect(optionsRes.status).toBe(200);
      const options = await optionsRes.json() as { options: { classes: Array<{ name: string; ruleData?: unknown }> } };
      expect(options.options.classes.map((option) => option.name)).toContain('战士');
      expect(options.options.classes.find((option) => option.name === '战士')?.ruleData).toEqual({ hitDie: 'd10' });

      const auditRes = await fetch(`${base}/api/player/${player.token}/character-builder/audit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft: { name: '洛林' } })
      });
      expect(auditRes.status).toBe(200);
      const audit = await auditRes.json() as { draft: unknown; audit: { valid: boolean; issues: Array<{ field: string }> } };
      expect(audit.audit.valid).toBe(false);
      expect(audit.audit.issues.some((i) => i.field === 'className')).toBe(true);

      const fullDraft = {
        name: '洛林',
        species: '人类',
        className: '战士',
        background: '士兵',
        abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
        skills: ['Athletics'],
        equipment: ['长剑'],
        spells: [],
        concept: '一名寻求荣耀的年轻战士',
        personality: '勇敢',
        ideal: '保护弱者',
        bond: '对战友忠诚',
        flaw: '冲动',
        notes: ''
      };

      const draftRes = await fetch(`${base}/api/player/${player.token}/character-builder/draft`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft: fullDraft })
      });
      expect(draftRes.status).toBe(200);
      const draftResult = await draftRes.json() as { character: { confirmed: boolean } };
      expect(draftResult.character.confirmed).toBe(false);

      const confirmRes = await fetch(`${base}/api/player/${player.token}/character-builder/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(confirmRes.status).toBe(200);
      const confirmResult = await confirmRes.json() as { character: { confirmed: boolean; sheet: { name: string; className: string; background: string } } };
      expect(confirmResult.character.confirmed).toBe(true);
      expect(confirmResult.character.sheet.name).toBe('洛林');
      expect(confirmResult.character.sheet.className).toBe('战士');
      expect(confirmResult.character.sheet.background).toBe('士兵');

      const stateRes = await fetch(`${base}/api/player/${player.token}/state`);
      expect(stateRes.status).toBe(200);
      const state = await stateRes.json() as { character: { confirmed: boolean; sheet: { name: string } } };
      expect(state.character.confirmed).toBe(true);
      expect(state.character.sheet.name).toBe('洛林');

      const directPlayerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '直确认玩家' })
      });
      const directPlayer = await directPlayerRes.json() as { token: string };
      const directDraft = { ...fullDraft, name: '米拉', concept: '直接确认的角色草稿' };
      const directConfirmRes = await fetch(`${base}/api/player/${directPlayer.token}/character-builder/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft: directDraft })
      });
      expect(directConfirmRes.status).toBe(200);
      const directConfirm = await directConfirmRes.json() as { character: { confirmed: boolean; sheet: { name: string; concept: string } } };
      expect(directConfirm.character.confirmed).toBe(true);
      expect(directConfirm.character.sheet.name).toBe('米拉');
      expect(directConfirm.character.sheet.concept).toBe('直接确认的角色草稿');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('imports ST resources through admin API and binds them to a room', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Import Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const missingScriptDeleteRes = await fetch(`${base}/api/admin/resources/script-cards/missing-script-card`, { method: 'DELETE' });
      expect(missingScriptDeleteRes.status).toBe(404);
      const missingWorldBookDeleteRes = await fetch(`${base}/api/admin/resources/world-books/missing-world-book`, { method: 'DELETE' });
      expect(missingWorldBookDeleteRes.status).toBe(404);
      const missingPresetDeleteRes = await fetch(`${base}/api/admin/resources/preset-packages/missing-preset-package`, { method: 'DELETE' });
      expect(missingPresetDeleteRes.status).toBe(404);

      const scriptRes = await fetch(`${base}/api/admin/resources/script-cards/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ characterCard: { data: { name: 'Gate Script', description: 'Gate background', scenario: 'The gate is sealed.' } } })
      });
      expect(scriptRes.status).toBe(200);
      const scriptPayload = await scriptRes.json() as { scriptCard: { id: string; name: string } };
      expect(scriptPayload.scriptCard.name).toBe('Gate Script');

      const worldBookRes = await fetch(`${base}/api/admin/resources/world-books/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worldBook: { name: 'Gate Lore', entries: [{ name: 'Candlekeep Gate', keys: ['Candlekeep'], content: 'The gate needs a silver key.', enabled: true, order: 150 }] } })
      });
      expect(worldBookRes.status).toBe(200);
      const worldBookPayload = await worldBookRes.json() as { worldBook: { id: string; name: string } };

      const presetRes = await fetch(`${base}/api/admin/resources/preset-packages/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ openAiSettings: { name: 'DND ST Preset', prompts: [{ identifier: 'main', role: 'system', content: 'Imported main prompt.' }], prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }] } })
      });
      expect(presetRes.status).toBe(200);
      const presetPayload = await presetRes.json() as { presetPackage: { id: string; name: string } };

      const scriptBindRes = await fetch(`${base}/api/admin/config/script-card`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scriptCardId: scriptPayload.scriptCard.id })
      });
      expect(scriptBindRes.status).toBe(200);

      const worldBindRes = await fetch(`${base}/api/admin/config/resource-world-books`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bindings: [{ worldBookId: worldBookPayload.worldBook.id, enabled: true, orderIndex: 0 }] })
      });
      expect(worldBindRes.status).toBe(200);

      const presetBindRes = await fetch(`${base}/api/admin/config/preset-package`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetPackageId: presetPayload.presetPackage.id })
      });
      expect(presetBindRes.status).toBe(200);

      const adminRes = await fetch(`${base}/api/admin/rooms/${room.roomId}`);
      const adminState = await adminRes.json() as { scriptCards: unknown[]; resourceWorldBooks: unknown[]; resourceWorldBookEntries: unknown[]; presetPackages: unknown[]; globalScriptCardId: string | null; globalWorldBookBindings: unknown[]; globalPresetPackageId: string | null; roomScriptBinding: null; roomWorldBookBindings: unknown[]; roomPresetBinding: null };
      expect(adminState.scriptCards).toHaveLength(1);
      expect(adminState.resourceWorldBooks).toHaveLength(1);
      expect(adminState.resourceWorldBookEntries).toHaveLength(1);
      expect(adminState.presetPackages).toHaveLength(1);
      expect(adminState.globalScriptCardId).toBe(scriptPayload.scriptCard.id);
      expect(adminState.globalWorldBookBindings).toHaveLength(1);
      expect(adminState.globalPresetPackageId).toBe(presetPayload.presetPackage.id);
      expect(adminState.roomScriptBinding).toBeNull();
      expect(adminState.roomWorldBookBindings).toEqual([]);
      expect(adminState.roomPresetBinding).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('administers character resources through rest and audit APIs', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      // 1. Create room and player
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '资源房间' })
      });
      const room = await roomRes.json() as { roomId: string };

      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '洛林' })
      });
      const player = await playerRes.json() as { playerId: string; token: string };

      // Get character ID and set up resources
      const charRow = db.prepare(
        'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE p.token = ?'
      ).get(player.token) as { id: string };
      const charId = charRow.id;

      const initialResources = {
        hitPoints: { current: 12, max: 12, temp: 0 },
        hitDice: { total: 1, remaining: 1, die: 'd10' },
        spellSlots: { level1: { total: 0, used: 0 } },
        ammo: [],
        consumables: [],
        currency: { gp: 100, sp: 0, cp: 0 },
        conditions: []
      };
      const sheet = {
        name: '洛林',
        species: '人类',
        className: '战士',
        level: 1,
        abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
        hitPoints: { current: 12, max: 12 },
        resources: initialResources
      };
      db.prepare('UPDATE characters SET confirmed = 1, sheet_json = ? WHERE id = ?')
        .run(JSON.stringify(sheet), charId);

      // 2. Short rest with hitDiceSpent:1
      const shortRestRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/characters/${charId}/rest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'short', actorType: 'player', actorId: 'player-1', hitDiceSpent: 1 })
      });
      expect(shortRestRes.status).toBe(200);
      const shortRestResult = await shortRestRes.json() as {
        resources: { hitDice: { remaining: number }; hitPoints: { current: number; max: number } }
      };
      expect(shortRestResult.resources.hitDice.remaining).toBe(0);
      expect(shortRestResult.resources.hitPoints.current).toBe(12);

      // 3. Long rest
      const longRestRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/characters/${charId}/rest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'long' })
      });
      expect(longRestRes.status).toBe(200);
      const longRestResult = await longRestRes.json() as {
        resources: { hitPoints: { current: number }; hitDice: { remaining: number } }
      };
      expect(longRestResult.resources.hitPoints.current).toBe(12);
      // Half of total hit dice: floor(1/2) = 0, max(1, 0) = 1, remaining = min(0 + 1, 1) = 1
      expect(longRestResult.resources.hitDice.remaining).toBe(1);

      // 4. Get resource changes
      const changesRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/character-resource-changes`);
      expect(changesRes.status).toBe(200);
      const changesPayload = await changesRes.json() as {
        changes: Array<{ id: string; changeType: string; path: string }>
      };
      expect(changesPayload.changes.length).toBeGreaterThanOrEqual(2);
      expect(changesPayload.changes.some((c) => c.changeType === 'short_rest')).toBe(true);
      expect(changesPayload.changes.some((c) => c.changeType === 'long_rest')).toBe(true);

      // 5. Rollback a change
      const shortRestChange = changesPayload.changes.find((c) => c.changeType === 'short_rest')!;
      const rollbackRes = await fetch(
        `${base}/api/admin/rooms/${room.roomId}/character-resource-changes/${shortRestChange.id}/rollback`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ revertedBy: 'admin-1' })
        }
      );
      expect(rollbackRes.status).toBe(200);
      const rollbackResult = await rollbackRes.json() as { restored: boolean };
      expect(rollbackResult.restored).toBe(true);

      // 6. Get player state with resources and recentChanges
      const stateRes = await fetch(`${base}/api/player/${player.token}/state`);
      expect(stateRes.status).toBe(200);
      const state = await stateRes.json() as {
        resources: { hitDice: { remaining: number } };
        recentChanges: Array<{ path: string; changeType: string; createdAt: string }>
      };
      expect(state.resources).toBeDefined();
      expect(state.recentChanges).toBeDefined();
      expect(state.recentChanges.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('applies AI-DM resource changes with audit and rejects invalid patches', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);

    // mutable ref so stub response can use real character id for happy path
    let stubCharId = '';

    const happyStub = await createOpenAiStub(() => {
      const result = aiTurnResult({
        publicLog: '强盗挥刀砍中了你，造成4点伤害。',
        characterResourceChanges: [{
          characterId: stubCharId,
          path: 'hitPoints.current',
          before: 12,
          after: 8,
          reason: '盗贼砍伤',
          ruleRefs: ['PHB p.194']
        }],
        suggestedStateChanges: [{
          type: 'suggested_state_change',
          changeType: 'update',
          targetId: 'room:烛堡之门',
          path: 'clues',
          before: ['银色门缝泛着变化系魔法灵光'],
          after: ['银色门缝泛着变化系魔法灵光，疑似需要银钥匙接触激活'],
          reason: '侦测魔法揭示了更多细节',
          ruleRefs: ['侦测魔法']
        }, {
          type: 'character_resource_change',
          characterId: stubCharId,
          path: 'spellSlots.1',
          before: 2,
          after: 1,
          reason: '施放侦测魔法',
          ruleRefs: ['PHB Spellcasting']
        }]
      });
      return { body: { choices: [{ message: { content: JSON.stringify(result) } }] } };
    });

    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      // --- Positive case: valid resource change applied ---
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Resource Change Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '战士' })
      });
      const player = await playerRes.json() as { playerId: string; token: string };

      // Set up confirmed character with resources HP 12/12, level 1 spell slots, currency gp 100
      const charRow = db.prepare(
        'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE p.token = ?'
      ).get(player.token) as { id: string };
      stubCharId = charRow.id;

      const sheet = {
        name: '战士',
        species: '人类',
        className: '战士',
        level: 1,
        abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
        hitPoints: { current: 12, max: 12 },
        resources: {
          hitPoints: { current: 12, max: 12, temp: 0 },
          hitDice: { total: 1, remaining: 1, die: 'd10' },
          spellSlots: { level1: { total: 2, used: 0 } },
          ammo: [],
          consumables: [],
          currency: { gp: 100, sp: 0, cp: 0 },
          conditions: []
        }
      };
      db.prepare('UPDATE characters SET confirmed = 1, sheet_json = ? WHERE id = ?')
        .run(JSON.stringify(sheet), stubCharId);

      // Save AI provider config pointing to happy stub
      const configRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: happyStub.baseUrl, apiKey: 'resource-key', model: 'resource-model' })
      });
      expect(configRes.status).toBe(200);

      // Submit player action
      const actionRes = await fetch(`${base}/api/player/${player.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我攻击强盗。' })
      });
      expect(actionRes.status).toBe(200);

      // Process turn
      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
      expect(processRes.status).toBe(200);
      const processResult = await processRes.json() as { result: { publicLog: string } };
      expect(processResult.result.publicLog).toContain('强盗挥刀砍中了你');
      const generation = db.prepare('SELECT error FROM ai_generations WHERE room_id = ? ORDER BY created_at DESC LIMIT 1').get(room.roomId) as { error: string | null };
      expect(generation.error).toBeNull();

      // Verify HP current = 8
      const charSheetAfter = db.prepare('SELECT sheet_json FROM characters WHERE id = ?').get(stubCharId) as { sheet_json: string };
      const parsedAfter = JSON.parse(charSheetAfter.sheet_json) as { resources: { hitPoints: { current: number; max: number }; spellSlots: { level1: { total: number; used: number } } } };
      expect(parsedAfter.resources.hitPoints.current).toBe(8);
      expect(parsedAfter.resources.hitPoints.max).toBe(12);
      expect(parsedAfter.resources.spellSlots.level1).toEqual({ total: 2, used: 1 });

      // Verify audit change recorded
      const changesRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/character-resource-changes`);
      expect(changesRes.status).toBe(200);
      const changesPayload = await changesRes.json() as {
        changes: Array<{ characterId: string; changeType: string; path: string; beforeJson: string; afterJson: string; reason: string; ruleRefsJson: string }>
      };
      expect(changesPayload.changes.length).toBeGreaterThanOrEqual(1);
      const hpChange = changesPayload.changes.find((c) => c.path === 'hitPoints.current');
      expect(hpChange).toBeDefined();
      expect(hpChange!.changeType).toBe('resource_patch');
      expect(hpChange!.characterId).toBe(stubCharId);
      expect(JSON.parse(hpChange!.beforeJson)).toBe(12);
      expect(JSON.parse(hpChange!.afterJson)).toBe(8);
      expect(hpChange!.reason).toBe('盗贼砍伤');
      expect(JSON.parse(hpChange!.ruleRefsJson)).toEqual(['PHB p.194']);
      const spellSlotChange = changesPayload.changes.find((c) => c.path === 'spellSlots.level1.used');
      expect(spellSlotChange).toBeDefined();
      expect(JSON.parse(spellSlotChange!.beforeJson)).toBe(0);
      expect(JSON.parse(spellSlotChange!.afterJson)).toBe(1);
      expect(spellSlotChange!.reason).toBe('施放侦测魔法');

      // --- Negative case: invalid characterId rejected, turn still succeeds ---
      const badCharStub = await createOpenAiStub(() => {
        const result = aiTurnResult({
          publicLog: '测试非法角色ID。',
          characterResourceChanges: [{
            characterId: 'nonexistent-char-id',
            path: 'hitPoints.current',
            before: 12,
            after: 6,
            reason: '非法角色',
            ruleRefs: ['PHB p.194']
          }]
        });
        return { body: { choices: [{ message: { content: JSON.stringify(result) } }] } };
      });

      const badRoomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bad Char Room' })
      });
      const badRoom = await badRoomRes.json() as { roomId: string };

      const badPlayerRes = await fetch(`${base}/api/admin/rooms/${badRoom.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '测试玩家' })
      });
      const badPlayer = await badPlayerRes.json() as { token: string };

      const badCharRow = db.prepare(
        'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE p.token = ?'
      ).get(badPlayer.token) as { id: string };
      const badSheet = {
        name: '测试',
        species: '人类',
        className: '战士',
        level: 1,
        abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        hitPoints: { current: 12, max: 12 },
        resources: {
          hitPoints: { current: 12, max: 12, temp: 0 },
          hitDice: { total: 1, remaining: 1, die: 'd10' },
          spellSlots: {},
          ammo: [],
          consumables: [],
          currency: { gp: 100, sp: 0, cp: 0 },
          conditions: []
        }
      };
      db.prepare('UPDATE characters SET confirmed = 1, sheet_json = ? WHERE id = ?').run(JSON.stringify(badSheet), badCharRow.id);

      await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: badCharStub.baseUrl, apiKey: 'bad-char-key', model: 'bad-char-model' })
      });

      await fetch(`${base}/api/player/${badPlayer.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我攻击非法目标。' })
      });

      const badProcessRes = await fetch(`${base}/api/admin/rooms/${badRoom.roomId}/process-turn`, legacyProcessTurnInit);
      // Turn should still succeed (invalid patches are logged, not thrown)
      expect(badProcessRes.status).toBe(200);

      // No audit changes for the bad room (invalid characterId was rejected)
      const badChangesRes = await fetch(`${base}/api/admin/rooms/${badRoom.roomId}/character-resource-changes`);
      expect(badChangesRes.status).toBe(200);
      const badChanges = await badChangesRes.json() as { changes: unknown[] };
      expect(badChanges.changes).toHaveLength(0);

      // Verify the error was recorded in ai_generations
      const badGen = db.prepare('SELECT error FROM ai_generations WHERE room_id = ? ORDER BY created_at DESC LIMIT 1').get(badRoom.roomId) as { error: string | null };
      expect(badGen.error).toContain('not found in room');

      await badCharStub.close();

      // --- Negative case: invalid before value rejected ---
      let badBeforeCharId = '';
      const badBeforeStub = await createOpenAiStub(() => {
        const result = aiTurnResult({
          publicLog: '测试非法 before 值。',
          characterResourceChanges: [{
            characterId: badBeforeCharId,
            path: 'hitPoints.current',
            before: 999,
            after: 6,
            reason: '错误before',
            ruleRefs: ['PHB p.194']
          }]
        });
        return { body: { choices: [{ message: { content: JSON.stringify(result) } }] } };
      });

      const badBeforeRoomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bad Before Room' })
      });
      const badBeforeRoom = await badBeforeRoomRes.json() as { roomId: string };

      const badBeforePlayerRes = await fetch(`${base}/api/admin/rooms/${badBeforeRoom.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '战士2' })
      });
      const badBeforePlayer = await badBeforePlayerRes.json() as { token: string };

      const badBeforeCharRow = db.prepare(
        'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE p.token = ?'
      ).get(badBeforePlayer.token) as { id: string };
      badBeforeCharId = badBeforeCharRow.id;

      const badBeforeSheet = {
        name: '战士2',
        species: '人类',
        className: '战士',
        level: 1,
        abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        hitPoints: { current: 12, max: 12 },
        resources: {
          hitPoints: { current: 12, max: 12, temp: 0 },
          hitDice: { total: 1, remaining: 1, die: 'd10' },
          spellSlots: {},
          ammo: [],
          consumables: [],
          currency: { gp: 100, sp: 0, cp: 0 },
          conditions: []
        }
      };
      db.prepare('UPDATE characters SET confirmed = 1, sheet_json = ? WHERE id = ?').run(JSON.stringify(badBeforeSheet), badBeforeCharId);

      await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: badBeforeStub.baseUrl, apiKey: 'bad-before-key', model: 'bad-before-model' })
      });

      await fetch(`${base}/api/player/${badBeforePlayer.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我攻击带着错误before的敌人。' })
      });

      const badBeforeProcessRes = await fetch(`${base}/api/admin/rooms/${badBeforeRoom.roomId}/process-turn`, legacyProcessTurnInit);
      // Turn should still succeed
      expect(badBeforeProcessRes.status).toBe(200);

      // No audit changes written (before mismatch rejected)
      const badBeforeChangesRes = await fetch(`${base}/api/admin/rooms/${badBeforeRoom.roomId}/character-resource-changes`);
      expect(badBeforeChangesRes.status).toBe(200);
      const badBeforeChanges = await badBeforeChangesRes.json() as { changes: unknown[] };
      expect(badBeforeChanges.changes).toHaveLength(0);

      // HP should remain 12 (unchanged)
      const badBeforeSheetAfter = db.prepare('SELECT sheet_json FROM characters WHERE id = ?').get(badBeforeCharId) as { sheet_json: string };
      const badBeforeParsed = JSON.parse(badBeforeSheetAfter.sheet_json) as { resources: { hitPoints: { current: number } } };
      expect(badBeforeParsed.resources.hitPoints.current).toBe(12);

      // Verify error in ai_generations
      const badBeforeGen = db.prepare('SELECT error FROM ai_generations WHERE room_id = ? ORDER BY created_at DESC LIMIT 1').get(badBeforeRoom.roomId) as { error: string | null };
      expect(badBeforeGen.error).toContain('Before value mismatch');

      await badBeforeStub.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await happyStub.close();
      db.close();
    }
  });

  it('executes system dice rolls from AI dice requests', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);

    let diceCharId = '';

    const stub = await createOpenAiStub(() => {
      const result = aiTurnResult({
        publicLog: '你尝试推开沉重的石门。',
        diceRequests: [{
          characterId: diceCharId,
          type: 'abilityCheck',
          ability: 'str',
          dc: 15,
          modifier: null,
          reason: '推开石门'
        }]
      });
      return { body: { choices: [{ message: { content: JSON.stringify(result) } }] } };
    });

    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '骰点房间' })
      });
      const room = await roomRes.json() as { roomId: string };

      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '掷骰玩家' })
      });
      const player = await playerRes.json() as { playerId: string; token: string };

      const charRow = db.prepare(
        'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE p.token = ?'
      ).get(player.token) as { id: string };
      diceCharId = charRow.id;

      const sheet = {
        name: '洛林',
        species: '人类',
        className: '战士',
        level: 1,
        abilityScores: { str: 15, dex: 13, con: 10, int: 10, wis: 10, cha: 10 },
        hitPoints: { current: 12, max: 12 },
        armorClass: 10,
        proficiencyBonus: 2,
        skills: [],
        equipment: [],
        spells: [],
        privateNotes: ''
      };
      db.prepare('UPDATE characters SET confirmed = 1, sheet_json = ? WHERE id = ?')
        .run(JSON.stringify(sheet), diceCharId);

      const configRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'dice-key', model: 'dice-model' })
      });
      expect(configRes.status).toBe(200);

      const actionRes = await fetch(`${base}/api/player/${player.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我推石门。' })
      });
      expect(actionRes.status).toBe(200);

      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
      expect(processRes.status).toBe(200);
      const processResult = await processRes.json() as { result: { publicLog: string } };

      // Verify publicLog contains dice result summary
      const publicLog = processResult.result.publicLog;
      expect(publicLog).toContain('你尝试推开沉重的石门。');
      expect(publicLog).toContain('系统骰点');
      expect(publicLog).toContain('推开石门');
      expect(publicLog).toContain('DC 15');
      expect(publicLog).toMatch(/成功|失败/);

      // Verify dice_logs table has 1 record
      const diceLogCount = db.prepare('SELECT COUNT(*) as count FROM dice_logs').get() as { count: number };
      expect(diceLogCount.count).toBe(1);

      const diceLog = db.prepare('SELECT dice_type as diceType, dc, success, reason, values_json as valuesJson, modifier, total FROM dice_logs WHERE room_id = ?').get(room.roomId) as {
        diceType: string;
        dc: number;
        success: number | null;
        reason: string;
        valuesJson: string;
        modifier: number;
        total: number;
      };
      expect(diceLog.diceType).toBe('abilityCheck');
      expect(diceLog.dc).toBe(15);
      expect(diceLog.success).not.toBeNull();
      expect(diceLog.reason).toBe('推开石门');

      // Verify ai_generations output JSON contains diceResults with actual roll data
      const generation = db.prepare('SELECT output FROM ai_generations WHERE room_id = ? ORDER BY created_at DESC LIMIT 1').get(room.roomId) as { output: string };
      const genOutput = JSON.parse(generation.output) as { diceResults?: Array<{ values: number[]; modifier: number; total: number; diceType: string }> };
      expect(genOutput.diceResults).toBeDefined();
      expect(genOutput.diceResults!.length).toBe(1);
      expect(genOutput.diceResults![0].diceType).toBe('abilityCheck');
      expect(genOutput.diceResults![0].values.length).toBeGreaterThan(0);
      expect(genOutput.diceResults![0].total).toBeGreaterThan(0);
      // The total should be plausible: d20 + modifier (str 15 → mod +2)
      expect(genOutput.diceResults![0].total).toBeGreaterThanOrEqual(3); // min roll 1 + mod 2
      expect(genOutput.diceResults![0].total).toBeLessThanOrEqual(22); // max roll 20 + mod 2

      const playerStateRes = await fetch(`${base}/api/player/${player.token}/state`);
      const playerState = await playerStateRes.json() as { recentDiceLogs?: Array<{ die: string; reason: string; playerName: string; createdAt: string }> };
      expect(playerState.recentDiceLogs?.[0]).toMatchObject({
        die: 'abilityCheck',
        reason: '推开石门',
        playerName: '掷骰玩家'
      });
      expect(playerState.recentDiceLogs?.[0].createdAt).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('ignores AI dice requests with characterId outside the current room', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const stub = await createOpenAiStub(() => ({
      body: {
        choices: [{
          message: {
            content: JSON.stringify(aiTurnResult({
              publicLog: '你尝试检查门锁。',
              diceRequests: [{
                characterId: 'not-in-this-room',
                type: 'skillCheck',
                ability: 'dex',
                skill: 'sleight-of-hand',
                dc: 15,
                modifier: null,
                reason: '检查门锁'
              }]
            }))
          }
        }]
      }
    }));
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Invalid Dice Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Rogue' })
      });
      const player = await playerRes.json() as { token: string };

      await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'dice-key', model: 'dice-model' })
      });

      const actionRes = await fetch(`${base}/api/player/${player.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我检查门锁。' })
      });
      expect(actionRes.status).toBe(200);

      const previewRes = await fetch(`${base}/api/admin/ai/turn-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId })
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { previewId: string; flatPrompt: string };

      const sendRes = await fetch(`${base}/api/admin/ai/send-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId, previewId: preview.previewId, flatPrompt: preview.flatPrompt })
      });
      expect(sendRes.status).toBe(200);
      const sent = await sendRes.json() as { warnings: string[] };
      expect(sent.warnings).toContain("diceRequests[0].characterId 'not-in-this-room' 不属于当前房间，已忽略该骰点请求。");

      const applyRes = await fetch(`${base}/api/admin/ai/apply-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId, previewId: preview.previewId })
      });
      expect(applyRes.status).toBe(200);
      const applied = await applyRes.json() as { warnings: string[] };
      expect(applied.warnings).toContain("diceRequests[0].characterId 'not-in-this-room' 不属于当前房间，已忽略该骰点请求。");

      const diceLogCount = db.prepare('SELECT COUNT(*) as count FROM dice_logs WHERE room_id = ?').get(room.roomId) as { count: number };
      expect(diceLogCount.count).toBe(0);
      const publicLogs = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND visibility_scope = ?').all(room.roomId, 'public') as Array<{ content: string }>;
      expect(publicLogs.map((log) => log.content).join('\n')).not.toContain('系统骰点');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('admins can roll dice, manage combat, and view dice logs', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      // Create room
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '战斗房间' })
      });
      expect(roomRes.status).toBe(200);
      const room = await roomRes.json() as { roomId: string };

      // Add 2 players
      const fighterRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '战士' })
      });
      expect(fighterRes.status).toBe(200);
      const fighter = await fighterRes.json() as { playerId: string; token: string };

      const mageRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '法师' })
      });
      expect(mageRes.status).toBe(200);
      const mage = await mageRes.json() as { playerId: string; token: string };

      // Update character sheets with ability scores
      const fighterChar = db.prepare('SELECT id, sheet_json FROM characters WHERE player_id = ?').get(fighter.playerId) as { id: string; sheet_json: string };
      const fighterSheet = JSON.parse(fighterChar.sheet_json);
      fighterSheet.abilityScores = { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 };
      db.prepare('UPDATE characters SET sheet_json = ? WHERE id = ?').run(JSON.stringify(fighterSheet), fighterChar.id);

      const mageChar = db.prepare('SELECT id, sheet_json FROM characters WHERE player_id = ?').get(mage.playerId) as { id: string; sheet_json: string };
      const mageSheet = JSON.parse(mageChar.sheet_json);
      mageSheet.abilityScores = { str: 8, dex: 14, con: 12, int: 16, wis: 14, cha: 10 };
      db.prepare('UPDATE characters SET sheet_json = ? WHERE id = ?').run(JSON.stringify(mageSheet), mageChar.id);

      // 1) Admin dice roll
      const diceRollRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/dice/roll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diceType: 'd20', modifier: 3, reason: '测试检定', dc: 15 })
      });
      expect(diceRollRes.status).toBe(200);
      const diceResult = await diceRollRes.json() as { values: number[]; modifier: number; total: number; success: boolean; diceLog: { id: string } };
      expect(diceResult.values).toBeDefined();
      expect(diceResult.modifier).toBe(3);
      expect(diceResult.total).toBeDefined();
      expect(typeof diceResult.success).toBe('boolean');
      expect(diceResult.diceLog).toBeDefined();

      // Verify dice_logs has 1 record
      let diceLogCount = db.prepare('SELECT COUNT(*) as count FROM dice_logs').get() as { count: number };
      expect(diceLogCount.count).toBe(1);

      // 2) Start combat
      const combatStartRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/combat/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          combatants: [
            { characterId: fighterChar.id, name: '战士' },
            { characterId: mageChar.id, name: '法师' },
            { characterId: null, npcId: null, name: '地精', hp: 7, ac: 15, dexMod: 2 }
          ]
        })
      });
      expect(combatStartRes.status).toBe(200);
      const combatStart = await combatStartRes.json() as { combatState: { id: string; status: string; combatants: Array<{ name: string; hp: { current: number } }> } };
      expect(combatStart.combatState.status).toBe('active');
      expect(combatStart.combatState.combatants).toHaveLength(3);
      const combatId = combatStart.combatState.id;

      // 3) Roll initiative
      const initRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/combat/roll-initiative`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ combatId })
      });
      expect(initRes.status).toBe(200);
      const initState = await initRes.json() as { combatState: { combatants: Array<{ initiative: number }> } };
      expect(initState.combatState.combatants[0].initiative).toBeGreaterThanOrEqual(initState.combatState.combatants[1].initiative);

      // 4) Attack: fighter (index 0) attacks goblin (index 2)
      const attackRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/combat/attack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ combatId, attackerIndex: 0, targetIndex: 2, weaponDie: 'd8' })
      });
      expect(attackRes.status).toBe(200);
      const attackResult = await attackRes.json() as { combatState: { combatants: Array<{ name: string; hp: { current: number; max: number } }> }; hit: boolean; damageTotal?: number };
      if (attackResult.hit) {
        const goblin = attackResult.combatState.combatants[2];
        expect(goblin.hp.current).toBeLessThan(goblin.hp.max);
      }

      // 5) Next turn
      const nextTurnRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/combat/next-turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ combatId })
      });
      expect(nextTurnRes.status).toBe(200);
      const nextTurnState = await nextTurnRes.json() as { combatState: { currentTurn: number } };
      expect(nextTurnState.combatState.currentTurn).toBe(1);

      // 6) GET dice-logs
      const diceLogsRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/dice-logs`);
      expect(diceLogsRes.status).toBe(200);
      const diceLogsData = await diceLogsRes.json() as { logs: Array<{ diceType: string; reason: string }> };
      expect(diceLogsData.logs).toBeDefined();
      expect(diceLogsData.logs.length).toBeGreaterThanOrEqual(1);

      // 7) Player state includes combat and recent dice
      const playerStateRes = await fetch(`${base}/api/player/${fighter.token}/state`);
      expect(playerStateRes.status).toBe(200);
      const playerState = await playerStateRes.json() as { combatState?: { status: string }; recentDiceLogs?: Array<{ diceType: string }> };
      expect(playerState.combatState).toBeDefined();
      expect(playerState.combatState!.status).toBe('active');
      expect(playerState.recentDiceLogs).toBeDefined();
      expect(playerState.recentDiceLogs!.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('automatically generates session summary after N turns', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);

    let callCount = 0;
    const normalResult = aiTurnResult({ publicLog: '战斗开始' });
    const summaryJson = {
      summary: '队伍击败地精，发现秘密通道。',
      questUpdates: [{ title: '调查矿井', status: 'in_progress', description: '' }],
      npcUpdates: [{ name: '格拉克', role: '地精首领', attitude: 'hostile', notes: '被击败逃跑。', location: '矿井入口' }],
      locationUpdates: [{ name: '废弃矿井', description: '地精占据的矿井深处有异常声响。' }],
      characterUpdates: [{ characterId: 'char-1', update: '洛林用长剑击败格拉克。' }]
    };

    const stub = await createOpenAiStub(() => {
      callCount++;
      if (callCount <= 5) {
        return { body: { choices: [{ message: { content: JSON.stringify(normalResult) } }] } };
      }
      return { body: { choices: [{ message: { content: JSON.stringify(summaryJson) } }] } };
    });

    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      // Create room
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '摘要测试房间' })
      });
      const room = await roomRes.json() as { roomId: string };

      // Add player with confirmed character
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '洛林' })
      });
      const player = await playerRes.json() as { playerId: string; token: string };

      // Confirm character
      const charRow = db.prepare(
        'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE p.token = ?'
      ).get(player.token) as { id: string };
      const sheet = {
        name: '洛林',
        species: '人类',
        className: '战士',
        level: 1,
        abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
        hitPoints: { current: 12, max: 12 },
        armorClass: 10,
        skills: [],
        equipment: [],
        spells: [],
        privateNotes: ''
      };
      db.prepare('UPDATE characters SET confirmed = 1, sheet_json = ? WHERE id = ?')
        .run(JSON.stringify(sheet), charRow.id);

      // Set AI provider to stub
      const configRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'summary-key', model: 'summary-model' })
      });
      expect(configRes.status).toBe(200);

      // Run 5 turns
      for (let i = 0; i < 5; i++) {
        const actionRes = await fetch(`${base}/api/player/${player.token}/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: `第${i + 1}回合行动。` })
        });
        expect(actionRes.status).toBe(200);

        const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
        expect(processRes.status).toBe(200);
      }

      // Verify session_summaries has 1 record
      const summaryCount = db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };
      expect(summaryCount.count).toBe(1);

      // Verify summary suggestions are archived, but do not automatically become long-term campaign facts.
      const questCount = db.prepare('SELECT COUNT(*) as count FROM campaign_quests').get() as { count: number };
      expect(questCount.count).toBe(0);

      const npcCount = db.prepare('SELECT COUNT(*) as count FROM campaign_npcs').get() as { count: number };
      expect(npcCount.count).toBe(0);

      const locationCount = db.prepare('SELECT COUNT(*) as count FROM campaign_locations').get() as { count: number };
      expect(locationCount.count).toBe(0);

      const summaryRow = db.prepare('SELECT quest_updates_json as questUpdatesJson, npc_updates_json as npcUpdatesJson, location_updates_json as locationUpdatesJson FROM session_summaries WHERE room_id = ?')
        .get(room.roomId) as { questUpdatesJson: string; npcUpdatesJson: string; locationUpdatesJson: string };
      expect(JSON.parse(summaryRow.questUpdatesJson)).toEqual(summaryJson.questUpdates);
      expect(JSON.parse(summaryRow.npcUpdatesJson)).toEqual(summaryJson.npcUpdates);
      expect(JSON.parse(summaryRow.locationUpdatesJson)).toEqual(summaryJson.locationUpdates);

      // Verify ai_generations has summary generation record (5 turn gens + 1 summary gen = 6)
      const aiGenCount = db.prepare('SELECT COUNT(*) as count FROM ai_generations WHERE room_id = ?').get(room.roomId) as { count: number };
      expect(aiGenCount.count).toBe(6);

      // Verify prompt preview includes campaign context
      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { prompt: string };
      expect(preview.prompt).toContain('# 战役记忆');
      expect(preview.prompt).toContain('## 最近事件');
      expect(preview.prompt).toContain('队伍击败地精，发现秘密通道。');
      expect(preview.prompt).not.toContain('## 进行中任务');
      expect(preview.prompt).not.toContain('## 已知 NPC');
      expect(preview.prompt).not.toContain('## 已探索地点');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('rejects AI-DM turn preview while required actors are missing', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Blocked Prompt Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const ariRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const boRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bo' })
      });
      const ari = await ariRes.json() as { playerId: string };
      const bo = await boRes.json() as { playerId: string };
      const turn = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?').get(room.roomId, 1) as { id: string };
      db.prepare('INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('ari-only-action', room.roomId, turn.id, ari.playerId, 'I wait by the door.', new Date().toISOString(), 'submitted');

      const previewRes = await fetch(`${base}/api/admin/ai/turn-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId })
      });
      expect(previewRes.status).toBe(409);
      const error = await previewRes.json() as { error: string; requiredActorIds: string[]; completedActorIds: string[]; missingActorIds: string[] };
      expect(error.error).toBe('TURN_NOT_READY');
      expect(error.requiredActorIds).toEqual([ari.playerId, bo.playerId]);
      expect(error.completedActorIds).toEqual([ari.playerId]);
      expect(error.missingActorIds).toEqual([bo.playerId]);
      const previewCount = db.prepare('SELECT COUNT(*) as count FROM ai_turn_previews').get() as { count: number };
      expect(previewCount.count).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('rejects sending a stale AI-DM preview after the current turn changes', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Stale Preview Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const player = await playerRes.json() as { playerId: string };
      const turn1 = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?').get(room.roomId, 1) as { id: string };
      db.prepare('INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('turn-1-action', room.roomId, turn1.id, player.playerId, 'I open the door.', new Date().toISOString(), 'submitted');
      await fetch(`${base}/api/admin/rooms/${room.roomId}`);
      const previewRes = await fetch(`${base}/api/admin/ai/turn-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId })
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { previewId: string; flatPrompt: string };

      const turn2Id = 'turn-two-stale-test';
      db.prepare('INSERT INTO turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(turn2Id, room.roomId, 2, 'open', new Date().toISOString(), null);
      db.prepare('UPDATE rooms SET current_turn = ? WHERE id = ?').run(2, room.roomId);
      db.prepare('INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('turn-2-action', room.roomId, turn2Id, player.playerId, 'I listen.', new Date().toISOString(), 'submitted');
      await fetch(`${base}/api/admin/rooms/${room.roomId}`);

      const sendRes = await fetch(`${base}/api/admin/ai/send-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId, previewId: preview.previewId, flatPrompt: preview.flatPrompt })
      });
      expect(sendRes.status).toBe(409);
      const error = await sendRes.json() as { error: string; currentTurnId: string };
      expect(error.error).toBe('STALE_PROMPT_PREVIEW');
      expect(error.currentTurnId).toBe(turn2Id);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('previews editable AI-DM turn prompts and materializes them after sending', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    let capturedPrompt = '';
    let stubCharId = '';
    const stub = await createOpenAiStub((body) => {
      capturedPrompt = body.messages?.find((message: { role?: string; content?: string }) => message.role === 'user')?.content ?? '';
      return {
        body: {
          choices: [{
            message: {
              content: JSON.stringify(aiTurnResult({
                publicLog: 'The edited prompt was accepted.',
                ruleResults: ['No conflict.'],
                characterResourceChanges: [{
                  characterId: stubCharId,
                  path: 'hitPoints.current',
                  before: 12,
                  after: 10,
                  reason: 'test suggestion',
                  ruleRefs: []
                }]
              }))
            }
          }]
        }
      };
    });
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Prompt Loop Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const player = await playerRes.json() as { playerId: string };
      const charRow = db.prepare(
        'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE p.id = ?'
      ).get(player.playerId) as { id: string };
      stubCharId = charRow.id;
      const sheet = {
        name: 'Ari',
        species: '人类',
        className: '战士',
        level: 1,
        abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
        hitPoints: { current: 12, max: 12 },
        resources: {
          hitPoints: { current: 12, max: 12, temp: 0 },
          hitDice: { total: 1, remaining: 1, die: 'd10' },
          spellSlots: {},
          ammo: [],
          consumables: [],
          currency: { gp: 0, sp: 0, cp: 0 },
          conditions: []
        }
      };
      db.prepare('UPDATE characters SET confirmed = 1, sheet_json = ? WHERE id = ?')
        .run(JSON.stringify(sheet), stubCharId);
      const turn = db.prepare('SELECT id, status FROM turns WHERE room_id = ? AND number = ?').get(room.roomId, 1) as { id: string; status: string };
      db.prepare('INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('preview-action', room.roomId, turn.id, player.playerId, 'I check the old door.', new Date().toISOString(), 'submitted');
      await fetch(`${base}/api/admin/rooms/${room.roomId}`);

      const previewRes = await fetch(`${base}/api/admin/ai/turn-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId })
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { previewId: string; flatPrompt: string; contextSections: Array<{ title: string; content: string }> };
      expect(preview.flatPrompt).toContain('## Character Status');
      expect(preview.flatPrompt).toContain('HP/AC/Proficiency');
      expect(preview.flatPrompt).toContain('I check the old door.');
      expect(preview.flatPrompt.match(/Submitted actions in order/g) ?? []).toHaveLength(0);
      expect(preview.flatPrompt.match(/## Current Turn Actions/g) ?? []).toHaveLength(1);
      expect(preview.flatPrompt.match(/DND 输出契约/g) ?? []).toHaveLength(1);
      expect(preview.flatPrompt).not.toMatch(/### [A-Za-z0-9_-]{16,}/);
      expect(preview.contextSections.some((section) => section.title === 'Character Status')).toBe(true);
      expect(stub.requests).toHaveLength(0);
      const turnReady = db.prepare('SELECT status FROM turns WHERE id = ?').get(turn.id) as { status: string };
      expect(turnReady.status).toBe('ready_to_resolve');

      const logsBefore = db.prepare('SELECT COUNT(*) as count FROM log_entries WHERE room_id = ?').get(room.roomId) as { count: number };
      await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'preview-key', model: 'preview-model' })
      });
      const editedPrompt = `${preview.flatPrompt}\n\nDM edit: make the door ominous.`;
      const sendRes = await fetch(`${base}/api/admin/ai/send-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId, previewId: preview.previewId, flatPrompt: editedPrompt })
      });
      expect(sendRes.status).toBe(200);
      const sent = await sendRes.json() as { responseText: string; suggestedStateChanges: Array<{ type: string }>; applied: boolean };
      expect(sent.responseText).toBe('The edited prompt was accepted.');
      expect(sent.suggestedStateChanges).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'character_resource_change' })]));
      expect(sent.applied).toBe(false);
      expect(capturedPrompt).toContain('DM edit: make the door ominous.');

      const previewAudit = db.prepare('SELECT original_prompt as originalPrompt, edited_prompt as editedPrompt, response_text as responseText, status FROM ai_turn_previews WHERE id = ?')
        .get(preview.previewId) as { originalPrompt: string; editedPrompt: string; responseText: string; status: string };
      expect(previewAudit.originalPrompt).toContain('## Character Status');
      expect(previewAudit.editedPrompt).toContain('DM edit: make the door ominous.');
      expect(previewAudit.responseText).toBe('The edited prompt was accepted.');
      expect(previewAudit.status).toBe('sent');

      const logsAfterSend = db.prepare('SELECT COUNT(*) as count FROM log_entries WHERE room_id = ?').get(room.roomId) as { count: number };
      const turnAfterSend = db.prepare('SELECT status FROM turns WHERE id = ?').get(turn.id) as { status: string };
      const roomAfterSend = db.prepare('SELECT current_turn as currentTurn, status FROM rooms WHERE id = ?').get(room.roomId) as { currentTurn: number; status: string };
      const generationsAfterSend = db.prepare('SELECT COUNT(*) as count FROM ai_generations WHERE room_id = ?').get(room.roomId) as { count: number };
      expect(logsAfterSend.count).toBe(logsBefore.count);
      expect(turnAfterSend.status).toBe('ready_to_resolve');
      expect(roomAfterSend).toMatchObject({ currentTurn: 1, status: 'ready_to_resolve' });
      expect(generationsAfterSend.count).toBe(0);

      const applyRes = await fetch(`${base}/api/admin/ai/apply-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId: room.roomId,
          previewId: preview.previewId,
          confirmedCharacterResourceChangeIndexes: [0]
        })
      });
      expect(applyRes.status).toBe(200);
      const applied = await applyRes.json() as { applied: boolean };
      expect(applied.applied).toBe(true);

      const logsAfter = db.prepare('SELECT COUNT(*) as count FROM log_entries WHERE room_id = ?').get(room.roomId) as { count: number };
      const turnAfter = db.prepare('SELECT status FROM turns WHERE id = ?').get(turn.id) as { status: string };
      const roomAfter = db.prepare('SELECT current_turn as currentTurn, status FROM rooms WHERE id = ?').get(room.roomId) as { currentTurn: number; status: string };
      const generationsAfter = db.prepare('SELECT COUNT(*) as count FROM ai_generations WHERE room_id = ?').get(room.roomId) as { count: number };
      const resourceChangesAfter = db.prepare('SELECT COUNT(*) as count FROM character_resource_changes WHERE room_id = ?').get(room.roomId) as { count: number };
      const materializedLog = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at DESC LIMIT 1')
        .get(room.roomId, 'public') as { content: string };
      const materializedObjectiveLog = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at DESC LIMIT 1')
        .get(room.roomId, 'objective') as { content: string };
      expect(logsAfter.count).toBe(logsBefore.count + 2);
      expect(materializedLog.content).toBe('The edited prompt was accepted.');
      expect(materializedObjectiveLog.content).toBe('The edited prompt was accepted.');
      expect(turnAfter.status).toBe('complete');
      expect(roomAfter).toMatchObject({ currentTurn: 2, status: 'waiting_for_actions' });
      expect(generationsAfter.count).toBe(1);
      expect(resourceChangesAfter.count).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('ignores private AI updates keyed by player name and only writes playerId-keyed private logs', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    let validPlayerId = '';
    const stub = await createOpenAiStub(() => ({
      body: {
        choices: [{
          message: {
            content: JSON.stringify(aiTurnResult({
              publicLog: 'The scene remains quiet.',
              privateUpdatesByPlayer: {
                '托恩': 'This name-keyed secret must not be written.',
                [validPlayerId]: 'This playerId-keyed secret is valid.'
              }
            }))
          }
        }]
      }
    }));
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Private Routing Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const ariRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '托恩' })
      });
      const ari = await ariRes.json() as { playerId: string; token: string };
      validPlayerId = ari.playerId;
      const boRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '托恩' })
      });
      const bo = await boRes.json() as { token: string };

      await fetch(`${base}/api/player/${ari.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我是谁？' })
      });
      await fetch(`${base}/api/player/${bo.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '观察四周' })
      });

      const previewRes = await fetch(`${base}/api/admin/ai/turn-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId })
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { previewId: string; flatPrompt: string };

      await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'preview-key', model: 'preview-model' })
      });

      const sendRes = await fetch(`${base}/api/admin/ai/send-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId, previewId: preview.previewId, flatPrompt: preview.flatPrompt })
      });
      expect(sendRes.status).toBe(200);
      const sent = await sendRes.json() as { warnings: string[] };
      expect(sent.warnings).toContain('privateUpdatesByPlayer.托恩 未使用有效 playerId，已忽略。');

      const applyRes = await fetch(`${base}/api/admin/ai/apply-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId, previewId: preview.previewId })
      });
      expect(applyRes.status).toBe(200);
      const applied = await applyRes.json() as { warnings: string[] };
      expect(applied.warnings).toContain('privateUpdatesByPlayer.托恩 未使用有效 playerId，已忽略。');

      const privateLogs = db.prepare('SELECT player_id as playerId, content FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at ASC')
        .all(room.roomId, 'private') as Array<{ playerId: string; content: string }>;
      expect(privateLogs).toEqual([{
        playerId: validPlayerId,
        content: 'This playerId-keyed secret is valid.'
      }]);
      expect(JSON.stringify(privateLogs)).not.toContain('name-keyed secret');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('ignores AI interaction requests that do not use playerId references', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    let sourcePlayerId = '';
    let targetPlayerId = '';
    const stub = await createOpenAiStub(() => ({
      body: {
        choices: [{
          message: {
            content: JSON.stringify(aiTurnResult({
              publicLog: 'A player choice is needed.',
              interactionRequests: [
                {
                  sourcePlayerId: '托恩',
                  targetPlayerId: '托恩',
                  type: 'confirm',
                  prompt: 'This name-keyed interaction must be ignored.'
                },
                {
                  sourcePlayerId,
                  targetPlayerId,
                  type: 'confirm',
                  prompt: 'Do you accept the offered rope?'
                }
              ]
            }))
          }
        }]
      }
    }));
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Interaction Routing Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const sourceRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '托恩' })
      });
      const source = await sourceRes.json() as { playerId: string; token: string };
      sourcePlayerId = source.playerId;
      const targetRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '托恩' })
      });
      const target = await targetRes.json() as { playerId: string; token: string };
      targetPlayerId = target.playerId;

      await fetch(`${base}/api/player/${source.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我把绳子递给同伴。' })
      });
      await fetch(`${base}/api/player/${target.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我等待对方行动。' })
      });

      const previewRes = await fetch(`${base}/api/admin/ai/turn-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId })
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { previewId: string; flatPrompt: string };

      await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'preview-key', model: 'preview-model' })
      });

      const sendRes = await fetch(`${base}/api/admin/ai/send-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId, previewId: preview.previewId, flatPrompt: preview.flatPrompt })
      });
      expect(sendRes.status).toBe(200);
      const sent = await sendRes.json() as { warnings: string[] };
      expect(sent.warnings).toEqual(expect.arrayContaining([
        'interactionRequests[0].sourcePlayerId 未使用有效 playerId，已忽略该互动请求。',
        'interactionRequests[0].targetPlayerId 未使用有效 playerId，已忽略该互动请求。'
      ]));

      const applyRes = await fetch(`${base}/api/admin/ai/apply-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId, previewId: preview.previewId })
      });
      expect(applyRes.status).toBe(200);
      const applied = await applyRes.json() as { warnings: string[] };
      expect(applied.warnings).toEqual(expect.arrayContaining([
        'interactionRequests[0].sourcePlayerId 未使用有效 playerId，已忽略该互动请求。',
        'interactionRequests[0].targetPlayerId 未使用有效 playerId，已忽略该互动请求。'
      ]));

      const interactions = db.prepare('SELECT source_player_id as sourcePlayerId, target_player_id as targetPlayerId, prompt FROM interaction_requests WHERE room_id = ?')
        .all(room.roomId) as Array<{ sourcePlayerId: string; targetPlayerId: string; prompt: string }>;
      expect(interactions).toEqual([{
        sourcePlayerId,
        targetPlayerId,
        prompt: 'Do you accept the offered rope?'
      }]);
      expect(JSON.stringify(interactions)).not.toContain('name-keyed interaction');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('keeps the current turn waiting while AI interaction requests need player response', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    let sourcePlayerId = '';
    let targetPlayerId = '';
    const stub = await createOpenAiStub(() => {
      const result = aiTurnResult({
        objectiveLog: '需要目标玩家确认是否接受绳子。',
        publicLog: '同伴递出绳子，等待回应。',
        interactionRequests: [{
          sourcePlayerId,
          targetPlayerId,
          type: 'consent',
          prompt: '你是否接受递来的绳子？'
        }]
      });
      return { body: { choices: [{ message: { content: JSON.stringify(result) } }] } };
    });
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Interaction State Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const sourceRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'A' })
      });
      const source = await sourceRes.json() as { playerId: string; token: string };
      sourcePlayerId = source.playerId;
      const targetRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'B' })
      });
      const target = await targetRes.json() as { playerId: string; token: string };
      targetPlayerId = target.playerId;

      await fetch(`${base}/api/player/${source.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我把绳子递给B。' })
      });
      await fetch(`${base}/api/player/${target.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我等待对方行动。' })
      });
      await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'preview-key', model: 'preview-model' })
      });

      const previewRes = await fetch(`${base}/api/admin/ai/turn-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId })
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { previewId: string; flatPrompt: string };
      const sendRes = await fetch(`${base}/api/admin/ai/send-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId, previewId: preview.previewId, flatPrompt: preview.flatPrompt })
      });
      expect(sendRes.status).toBe(200);
      const applyRes = await fetch(`${base}/api/admin/ai/apply-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId, previewId: preview.previewId })
      });
      expect(applyRes.status).toBe(200);

      const roomState = db.prepare('SELECT current_turn as currentTurn, status FROM rooms WHERE id = ?')
        .get(room.roomId) as { currentTurn: number; status: string };
      const turnState = db.prepare('SELECT id, status FROM turns WHERE room_id = ? AND number = 1')
        .get(room.roomId) as { id: string; status: string };
      const nextTurn = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = 2').get(room.roomId);
      expect(roomState).toEqual({ currentTurn: 1, status: 'waiting_for_interaction' });
      expect(turnState.status).toBe('waiting_for_interaction');
      expect(nextTurn).toBeUndefined();

      const lockedActionRes = await fetch(`${base}/api/player/${target.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我先做下一步行动。' })
      });
      expect(lockedActionRes.status).toBe(409);
      const lockedAction = await lockedActionRes.json() as { error: string; roomStatus: string; turnStatus: string };
      expect(lockedAction.error).toBe('ACTIONS_CLOSED');
      expect(lockedAction.roomStatus).toBe('waiting_for_interaction');
      expect(lockedAction.turnStatus).toBe('waiting_for_interaction');

      const interaction = db.prepare('SELECT id, status FROM interaction_requests WHERE room_id = ?')
        .get(room.roomId) as { id: string; status: string };
      expect(interaction.status).toBe('pending_target');
      const responseRes = await fetch(`${base}/api/player/${target.token}/interactions/${interaction.id}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: '我接受绳子。' })
      });
      expect(responseRes.status).toBe(200);

      const readyRoom = db.prepare('SELECT status FROM rooms WHERE id = ?').get(room.roomId) as { status: string };
      const readyTurn = db.prepare('SELECT status FROM turns WHERE id = ?').get(turnState.id) as { status: string };
      expect(readyRoom.status).toBe('ready_to_resolve');
      expect(readyTurn.status).toBe('ready_to_resolve');

      const followupPreviewRes = await fetch(`${base}/api/admin/ai/turn-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId })
      });
      expect(followupPreviewRes.status).toBe(200);
      const followupPreview = await followupPreviewRes.json() as { flatPrompt: string };
      expect(followupPreview.flatPrompt).toContain('status=ready_for_ai');
      expect(followupPreview.flatPrompt).toContain('targetResponse=我接受绳子。');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('shows an empty character placeholder in AI-DM turn preview', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Empty Character Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Draft Hero' })
      });
      const player = await playerRes.json() as { playerId: string };
      const turn = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?').get(room.roomId, 1) as { id: string };
      db.prepare('INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('draft-action', room.roomId, turn.id, player.playerId, 'I look around.', new Date().toISOString(), 'submitted');
      await fetch(`${base}/api/admin/rooms/${room.roomId}`);
      const previewRes = await fetch(`${base}/api/admin/ai/turn-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: room.roomId })
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { flatPrompt: string };
      expect(preview.flatPrompt).toContain('No confirmed character sheets yet');
      expect(preview.flatPrompt).toContain('Draft Characters');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('player submits exploration action with stealth check and dice log is created', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);

    const resultJson = aiTurnResult({
      publicLog: '艾拉尝试潜行穿过走廊。',
      diceRequests: [{
        type: 'skillCheck' as const,
        ability: 'dex' as const,
        skill: 'stealth',
        dc: 12,
        modifier: null,
        reason: '潜行检定'
      }]
    });

    const stub = await createOpenAiStub(() => ({
      body: { choices: [{ message: { content: JSON.stringify(resultJson) } }] }
    }));

    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      // Configure AI provider
      await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'exploration-key', model: 'exploration-model' })
      });

      // Create room and player with a character
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Exploration Test Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '艾拉' })
      });
      const player = await playerRes.json() as { token: string };

      // Give the character stealth proficiency
      const playerRow = db.prepare('SELECT id FROM players WHERE token = ?').get(player.token) as { id: string };
      const charRow = db.prepare('SELECT id, sheet_json FROM characters WHERE player_id = ?').get(playerRow.id) as { id: string; sheet_json: string };
      const sheet = JSON.parse(charRow.sheet_json);
      sheet.abilityScores = { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 8 };
      sheet.skills = ['stealth'];
      sheet.proficiencyBonus = 2;
      db.prepare('UPDATE characters SET sheet_json = ? WHERE id = ?').run(JSON.stringify(sheet), charRow.id);

      // Submit exploration action
      await fetch(`${base}/api/player/${player.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我尝试潜行穿过哥布林巡逻的走廊。', actionType: 'exploration' })
      });

      // Process turn
      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
      expect(processRes.status).toBe(200);

      // Verify dice logs were created
      const diceLogRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/dice-logs`);
      expect(diceLogRes.status).toBe(200);
      const diceLogs = await diceLogRes.json() as { logs: Array<{ diceType: string; reason: string; values: number[]; total: number; success: boolean | null; isPublic: boolean }> };
      expect(diceLogs.logs).toHaveLength(1);
      expect(diceLogs.logs[0].diceType).toBe('skillCheck');
      expect(diceLogs.logs[0].reason).toBe('潜行检定');
      expect(diceLogs.logs[0].values).toHaveLength(1);
      expect(diceLogs.logs[0].isPublic).toBe(true);

      // Verify action has actionType
      const adminRes = await fetch(`${base}/api/admin/rooms/${room.roomId}`);
      const adminState = await adminRes.json() as { actions: Array<{ text: string; actionType: string | null }> };
      expect(adminState.actions.some((a) => a.text === '我尝试潜行穿过哥布林巡逻的走廊。')).toBe(true);

      // Verify public log includes dice summary
      const logs = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at DESC').all(room.roomId, 'public') as Array<{ content: string }>;
      expect(logs.some((l) => l.content.includes('系统骰点'))).toBe(true);
      expect(logs.some((l) => l.content.includes('潜行检定'))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('player submits social action with persuade check against NPC and hidden roll', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);

    // Create rooms, players, characters first to get characterId
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    let stub: Awaited<ReturnType<typeof createOpenAiStub>> | null = null;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Social Test Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '洛林' })
      });
      const player = await playerRes.json() as { token: string };

      // Give the character charisma and persuasion
      const playerRow = db.prepare('SELECT id FROM players WHERE token = ?').get(player.token) as { id: string };
      const charRow = db.prepare('SELECT id, sheet_json FROM characters WHERE player_id = ?').get(playerRow.id) as { id: string; sheet_json: string };
      const sheet = JSON.parse(charRow.sheet_json);
      sheet.abilityScores = { str: 14, dex: 10, con: 14, int: 8, wis: 12, cha: 18 };
      sheet.skills = ['persuasion'];
      sheet.proficiencyBonus = 2;
      db.prepare('UPDATE characters SET sheet_json = ? WHERE id = ?').run(JSON.stringify(sheet), charRow.id);

      // Create a hostile guard NPC
      const npcId = 'npc-guard';
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO npcs (id, room_id, name, hp_max, hp_current, ac, str, dex, con, int, wis, cha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(npcId, room.roomId, '守卫队长', 20, 20, 16, 14, 12, 14, 10, 12, 10, now);

      // Build result JSON with characterId for hidden roll routing
      const resultJson = aiTurnResult({
        publicLog: '洛林试图说服守卫放行。',
        diceRequests: [{
          characterId: charRow.id,
          type: 'skillCheck' as const,
          ability: 'cha' as const,
          skill: 'persuasion',
          dc: 15,
          modifier: null,
          reason: '说服检定（守卫）',
          isHidden: true
        }]
      });

      stub = await createOpenAiStub(() => ({
        body: { choices: [{ message: { content: JSON.stringify(resultJson) } }] }
      }));

      await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: stub!.baseUrl, apiKey: 'social-key', model: 'social-model' })
      });
      await fetch(`${base}/api/player/${player.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我试图说服守卫队长让我们进城。', actionType: 'social', isHiddenRoll: true })
      });

      // Process turn
      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, legacyProcessTurnInit);
      expect(processRes.status).toBe(200);

      // Verify hidden dice log was created
      const diceLogRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/dice-logs`);
      expect(diceLogRes.status).toBe(200);
      const diceLogs = await diceLogRes.json() as { logs: Array<{ diceType: string; reason: string; isPublic: boolean }> };
      expect(diceLogs.logs).toHaveLength(1);
      expect(diceLogs.logs[0].diceType).toBe('skillCheck');
      expect(diceLogs.logs[0].reason).toBe('说服检定（守卫）');
      expect(diceLogs.logs[0].isPublic).toBe(false);

      // Verify private log contains the hidden dice result
      const privateLogs = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at DESC').all(room.roomId, 'private') as Array<{ content: string }>;
      expect(privateLogs).toHaveLength(1);
      expect(privateLogs[0].content).toContain('隐藏骰点');
      expect(privateLogs[0].content).toContain('说服检定（守卫）');

      // Public log should NOT contain the hidden dice
      const publicLogs = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at DESC').all(room.roomId, 'public') as Array<{ content: string }>;
      const turnLog = publicLogs.find((l) => l.content.includes('洛林试图说服'));
      expect(turnLog).toBeTruthy();
      expect(turnLog!.content).not.toContain('隐藏骰点');

      // Verify action stored properly
      const adminRes = await fetch(`${base}/api/admin/rooms/${room.roomId}`);
      const adminState = await adminRes.json() as { actions: Array<{ text: string; actionType: string | null; isHiddenRoll: boolean }> };
      const socialAction = adminState.actions.find((a) => a.text === '我试图说服守卫队长让我们进城。');
      expect(socialAction).toBeTruthy();
      expect(socialAction!.actionType).toBe('social');
      expect(socialAction!.isHiddenRoll).toBe(1); // SQLite returns 0/1 integer

      // Verify NPC exists
      const npcRow = db.prepare('SELECT id, name FROM npcs WHERE id = ?').get(npcId) as { id: string; name: string } | undefined;
      expect(npcRow).toBeTruthy();
      expect(npcRow!.name).toBe('守卫队长');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub?.close();
      db.close();
    }
  });
});


