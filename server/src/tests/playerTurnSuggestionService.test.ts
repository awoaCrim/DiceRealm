import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { AppDatabase } from '../db/connection.js';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import type { CharacterSheet } from '../domain/types.js';
import { updateGlobalAiProviderConfig } from '../services/globalConfigService.js';
import {
  generateCurrentPlayerTurnSuggestions,
  loadCachedCurrentPlayerTurnSuggestions,
  parsePlayerTurnSuggestionResponse
} from '../services/playerTurnSuggestionService.js';
import { getTurnReadiness } from '../services/turnReadinessService.js';

type OpenAiStubResponse = { status?: number; body?: unknown; rawBody?: string };

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
      res.setHeader('content-type', 'application/json');
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
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function sheet(name: string): CharacterSheet {
  return {
    name,
    species: '人类',
    className: '游侠',
    level: 1,
    abilityScores: { str: 10, dex: 16, con: 12, int: 11, wis: 14, cha: 9 },
    hitPoints: { current: 11, max: 11 },
    armorClass: 15,
    proficiencyBonus: 2,
    skills: ['perception', 'stealth'],
    equipment: ['短弓', '匕首'],
    spells: [],
    privateNotes: `${name} 的私人目标是找到失踪的导师。`,
    background: '边境斥候',
    concept: `${name} 习惯先观察再行动。`,
    personality: '安静、敏锐',
    ideal: '保护无辜者',
    bond: '导师留下的旧徽记',
    flaw: '不轻易信任陌生人'
  };
}

function seedRoom(db: AppDatabase): void {
  const now = '2026-06-10T00:00:00.000Z';
  db.prepare(`
    INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, expected_player_count, ai_config_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('room-1', '雾门旅店', '', '此房间实时使用当前全局配置。', 1, 'waiting_for_actions', 2, '{}', now);
  db.prepare('INSERT INTO turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('turn-1', 'room-1', 1, 'open', now, null);
  db.prepare(`
    INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('public-1', 'room-1', 'turn-1', 'public', null, '公开场景', '旅店门外的雾中传来金属拖地声。', now);
}

function seedPlayer(db: AppDatabase, input: { id: string; name: string; token: string }): void {
  const createdAt = input.id === 'p1' ? '2026-06-10T00:01:00.000Z' : '2026-06-10T00:02:00.000Z';
  db.prepare('INSERT INTO players (id, room_id, name, token, is_connected, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.id, 'room-1', input.name, input.token, 0, createdAt);
  db.prepare('INSERT INTO characters (id, player_id, sheet_json, draft_source, confirmed, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`char-${input.id}`, input.id, JSON.stringify(sheet(input.name)), 'manual', 1, createdAt);
}

function seedStandardGame(db: AppDatabase): void {
  seedRoom(db);
  seedPlayer(db, { id: 'p1', name: '阿瑞', token: 'token-p1' });
  seedPlayer(db, { id: 'p2', name: '波', token: 'token-p2' });
}

function validSuggestionsJson(actionTypes = ['in_character_action', 'observe', 'nonsense', 'combat-action']): string {
  return JSON.stringify({
    options: actionTypes.map((actionType, index) => ({
      title: `建议 ${index + 1}`,
      actionText: `我执行第 ${index + 1} 个可选行动。`,
      actionType,
      hint: `这是第 ${index + 1} 个提示。`
    }))
  });
}

describe('playerTurnSuggestionService', () => {
  it('generates exactly four suggestions and reuses the cached result', async () => {
    const db = createMemoryDb();
    migrate(db);
    const stub = await createOpenAiStub(() => ({
      body: { choices: [{ message: { content: validSuggestionsJson() } }] }
    }));

    try {
      seedStandardGame(db);
      updateGlobalAiProviderConfig(db, {
        provider: 'openai-compatible',
        baseUrl: stub.baseUrl,
        apiKey: 'test-key',
        model: 'suggestion-model'
      });

      const first = await generateCurrentPlayerTurnSuggestions(db, { roomId: 'room-1', playerId: 'p1' });
      const second = await generateCurrentPlayerTurnSuggestions(db, { roomId: 'room-1', playerId: 'p1' });

      expect(first.status).toBe('ready');
      expect(first.options).toHaveLength(4);
      expect(first.options[2].actionType).toBe('in_character_action');
      expect(first.options[3].actionType).toBe('combat_action');
      expect(second).toEqual(first);
      expect(stub.requests).toHaveLength(1);

      const count = db.prepare('SELECT COUNT(*) as count FROM turn_suggestions WHERE room_id = ? AND turn_id = ? AND player_id = ?')
        .get('room-1', 'turn-1', 'p1') as { count: number };
      expect(count.count).toBe(1);
    } finally {
      await stub.close();
      db.close();
    }
  });

  it('returns failed for mock provider without writing a ready cache', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedStandardGame(db);

      const result = await generateCurrentPlayerTurnSuggestions(db, { roomId: 'room-1', playerId: 'p1' });

      expect(result.status).toBe('failed');
      expect(result.options).toEqual([]);
      expect(result.error).toContain('real AI provider');
      const row = db.prepare('SELECT status, suggestions_json as suggestionsJson FROM turn_suggestions WHERE room_id = ? AND turn_id = ? AND player_id = ?')
        .get('room-1', 'turn-1', 'p1') as { status: string; suggestionsJson: string };
      expect(row.status).toBe('failed');
      expect(() => parsePlayerTurnSuggestionResponse(row.suggestionsJson)).toThrow('exactly 4');
    } finally {
      db.close();
    }
  });

  it('rejects suggestion generation until the player character is confirmed', async () => {
    const db = createMemoryDb();
    migrate(db);
    const stub = await createOpenAiStub(() => ({
      body: { choices: [{ message: { content: validSuggestionsJson() } }] }
    }));

    try {
      seedStandardGame(db);
      db.prepare('UPDATE characters SET confirmed = 0 WHERE player_id = ?').run('p1');
      updateGlobalAiProviderConfig(db, {
        provider: 'openai-compatible',
        baseUrl: stub.baseUrl,
        apiKey: 'test-key',
        model: 'suggestion-model'
      });

      await expect(generateCurrentPlayerTurnSuggestions(db, { roomId: 'room-1', playerId: 'p1' }))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(stub.requests).toHaveLength(0);
    } finally {
      await stub.close();
      db.close();
    }
  });

  it('writes a failed cache for bad JSON and retries on the next generation request', async () => {
    const db = createMemoryDb();
    migrate(db);
    let callCount = 0;
    const stub = await createOpenAiStub(() => {
      callCount++;
      return {
        body: {
          choices: [{
            message: {
              content: callCount === 1
                ? validSuggestionsJson(['observe', 'wait', 'player_question'])
                : validSuggestionsJson()
            }
          }]
        }
      };
    });

    try {
      seedStandardGame(db);
      updateGlobalAiProviderConfig(db, {
        provider: 'openai-compatible',
        baseUrl: stub.baseUrl,
        apiKey: 'test-key',
        model: 'bad-json-model'
      });

      const first = await generateCurrentPlayerTurnSuggestions(db, { roomId: 'room-1', playerId: 'p1' });
      const second = await generateCurrentPlayerTurnSuggestions(db, { roomId: 'room-1', playerId: 'p1' });

      expect(first.status).toBe('failed');
      expect(first.error).toContain('exactly 4');
      expect(second.status).toBe('ready');
      expect(second.options).toHaveLength(4);
      expect(stub.requests).toHaveLength(2);
    } finally {
      await stub.close();
      db.close();
    }
  });

  it('builds prompts from public logs and only the current player private logs', async () => {
    const db = createMemoryDb();
    migrate(db);
    const stub = await createOpenAiStub((body) => {
      const prompt = JSON.stringify(body);
      expect(prompt).toContain('旅店门外的雾中传来金属拖地声');
      expect(prompt).toContain('阿瑞听见只有自己能懂的银铃暗号');
      expect(prompt).not.toContain('波知道地下室暗门口令');
      return { body: { choices: [{ message: { content: validSuggestionsJson() } }] } };
    });

    try {
      seedStandardGame(db);
      db.prepare(`
        INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('private-p1', 'room-1', 'turn-1', 'private', 'p1', '阿瑞私密', '阿瑞听见只有自己能懂的银铃暗号。', '2026-06-10T00:03:00.000Z');
      db.prepare(`
        INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('private-p2', 'room-1', 'turn-1', 'private', 'p2', '波私密', '波知道地下室暗门口令。', '2026-06-10T00:04:00.000Z');
      updateGlobalAiProviderConfig(db, {
        provider: 'openai-compatible',
        baseUrl: stub.baseUrl,
        apiKey: 'test-key',
        model: 'privacy-model'
      });

      const result = await generateCurrentPlayerTurnSuggestions(db, { roomId: 'room-1', playerId: 'p1' });

      expect(result.status).toBe('ready');
      expect(stub.requests).toHaveLength(1);
    } finally {
      await stub.close();
      db.close();
    }
  });

  it('player route reports missing cache without waiting for AI and bad JSON does not block action submission', async () => {
    const db = createMemoryDb();
    migrate(db);
    const stub = await createOpenAiStub(() => ({
      body: { choices: [{ message: { content: 'not json' } }] }
    }));
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      seedStandardGame(db);
      updateGlobalAiProviderConfig(db, {
        provider: 'openai-compatible',
        baseUrl: stub.baseUrl,
        apiKey: 'test-key',
        model: 'route-model'
      });

      const initialStateRes = await fetch(`${base}/api/player/token-p1/state`);
      expect(initialStateRes.status).toBe(200);
      const initialState = await initialStateRes.json() as { turnSuggestions: unknown[]; turnSuggestionStatus: string };
      expect(initialState.turnSuggestionStatus).toBe('missing');
      expect(initialState.turnSuggestions).toEqual([]);
      expect(stub.requests).toHaveLength(0);

      const suggestionRes = await fetch(`${base}/api/player/token-p1/turn-suggestions`, { method: 'POST' });
      expect(suggestionRes.status).toBe(200);
      const suggestionPayload = await suggestionRes.json() as { suggestions: unknown[]; status: string; error: string | null };
      expect(suggestionPayload.status).toBe('failed');
      expect(suggestionPayload.suggestions).toEqual([]);
      expect(suggestionPayload.error).toContain('strict JSON');

      const actionRes = await fetch(`${base}/api/player/token-p1/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我先保持警戒，观察雾中的声音。', actionType: 'observe' })
      });
      expect(actionRes.status).toBe(200);

      const cached = loadCachedCurrentPlayerTurnSuggestions(db, { roomId: 'room-1', playerId: 'p1' });
      expect(cached.status).toBe('failed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      db.close();
    }
  });

  it('player route rejects actions from unconfirmed characters once the room roster is full', async () => {
    const db = createMemoryDb();
    migrate(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      seedStandardGame(db);
      db.prepare('UPDATE characters SET confirmed = 0 WHERE player_id = ?').run('p1');

      const actionRes = await fetch(`${base}/api/player/token-p1/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我先保持警戒，观察雾中的声音。', actionType: 'observe' })
      });
      expect(actionRes.status).toBe(409);
      const payload = await actionRes.json() as { error: string; message: string };
      expect(payload).toMatchObject({
        error: 'CHARACTER_NOT_CONFIRMED',
        message: '确认角色后才能提交本回合行动。'
      });

      const count = db.prepare('SELECT COUNT(*) as count FROM actions WHERE player_id = ?').get('p1') as { count: number };
      expect(count.count).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('does not count stale actions from unconfirmed characters when checking full-room readiness', () => {
    const db = createMemoryDb();
    migrate(db);

    try {
      seedStandardGame(db);
      db.prepare('UPDATE characters SET confirmed = 0 WHERE player_id = ?').run('p1');
      db.prepare(`
        INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status, action_type, visibility, is_hidden_roll)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('action-p1', 'room-1', 'turn-1', 'p1', '我在角色确认前提交过旧行动。', '2026-06-10T00:05:00.000Z', 'submitted', 'observe', 'public', 0);
      db.prepare(`
        INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status, action_type, visibility, is_hidden_roll)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('action-p2', 'room-1', 'turn-1', 'p2', '我保持警戒。', '2026-06-10T00:06:00.000Z', 'submitted', 'observe', 'public', 0);

      const readiness = getTurnReadiness(db, { id: 'room-1', currentTurn: 1, status: 'waiting_for_actions' });

      expect(readiness.submittedActorIds).toEqual(['p2']);
      expect(readiness.missingActorIds).toEqual(['p1']);
      expect(readiness.ready).toBe(false);
    } finally {
      db.close();
    }
  });
});
