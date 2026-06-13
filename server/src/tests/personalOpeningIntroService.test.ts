import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import type { CharacterSheet } from '../domain/types.js';
import { updateGlobalAiProviderConfig } from '../services/globalConfigService.js';
import { PersonalOpeningIntroError, preparePersonalOpeningIntrosForConfirmation } from '../services/personalOpeningIntroService.js';

function sheet(name: string): CharacterSheet {
  return {
    name,
    species: '人类',
    className: '战士',
    level: 1,
    abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
    hitPoints: { current: 12, max: 12 },
    armorClass: 16,
    proficiencyBonus: 2,
    skills: ['运动'],
    equipment: ['长剑'],
    spells: [],
    privateNotes: `${name} 的私密备注`,
    background: '士兵',
    concept: `${name} 正在寻找旧战友`,
    personality: '谨慎但可靠',
    ideal: '守护同伴',
    bond: '欠一位旅店老板人情',
    flaw: '不愿承认恐惧'
  };
}

function seedRoom(db: ReturnType<typeof createMemoryDb>, expectedPlayerCount: number | null): void {
  const now = '2026-06-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, expected_player_count, ai_config_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('room-1', '烛堡之门', '', '此房间实时使用当前全局配置。', 1, 'waiting_for_actions', expectedPlayerCount, '{}', now);
  db.prepare('INSERT INTO turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('turn-1', 'room-1', 1, 'open', now, null);
  db.prepare(`
    INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('opening-1', 'room-1', 'turn-1', 'public', null, '公开开场', '队伍抵达烛堡门前，雨正落在石阶上。', now);
}

function seedPlayer(db: ReturnType<typeof createMemoryDb>, input: { id: string; name: string; confirmed: boolean }): void {
  const createdAt = input.id === 'p1' ? '2026-06-01T00:01:00.000Z' : '2026-06-01T00:02:00.000Z';
  db.prepare('INSERT INTO players (id, room_id, name, token, is_connected, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.id, 'room-1', input.name, `token-${input.id}`, 0, createdAt);
  db.prepare('INSERT INTO characters (id, player_id, sheet_json, draft_source, confirmed, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`char-${input.id}`, input.id, JSON.stringify(sheet(input.name)), 'manual', input.confirmed ? 1 : 0, createdAt);
}

type OpenAiStubResponse = { status?: number; body?: unknown; rawBody?: string };

async function createOpenAiStub(handler: (body: any) => OpenAiStubResponse | Promise<OpenAiStubResponse>) {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
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

describe('personalOpeningIntroService', () => {
  it('does not generate intros before the room reaches expected confirmed players', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedRoom(db, 2);
      seedPlayer(db, { id: 'p1', name: '阿瑞', confirmed: false });

      const intros = await preparePersonalOpeningIntrosForConfirmation(db, {
        roomId: 'room-1',
        playerId: 'p1',
        builtSheet: sheet('阿瑞')
      });

      expect(intros).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('blocks final confirmation when the AI provider is mock', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedRoom(db, 2);
      seedPlayer(db, { id: 'p1', name: '阿瑞', confirmed: true });
      seedPlayer(db, { id: 'p2', name: '波', confirmed: false });

      await expect(preparePersonalOpeningIntrosForConfirmation(db, {
        roomId: 'room-1',
        playerId: 'p2',
        builtSheet: sheet('波')
      })).rejects.toBeInstanceOf(PersonalOpeningIntroError);
    } finally {
      db.close();
    }
  });

  it('prepares private opening intros for all confirmed players missing one', async () => {
    const db = createMemoryDb();
    migrate(db);
    const stub = await createOpenAiStub(() => ({
      body: {
        choices: [{
          message: {
            content: JSON.stringify({
              introsByPlayerId: {
                p1: '你阿瑞出身于北境边地，曾在寒风里巡逻多年，因旧友失踪追查到烛堡。途中他在驿站帮助波脱离一场误会，两人因此同行。雨夜里，他们跟随同一封求援信来到烛堡门前，准备向守门人说明来意。',
                p2: '波，你，波，离开家乡后靠抄写古卷谋生，一枚旧徽记把他引向烛堡。他在路上遇见阿瑞，并从对方谨慎的护送中看见可靠同伴的影子。如今雨声敲打石阶，他把湿透的信收入怀中。'
              }
            })
          }
        }]
      }
    }));

    try {
      seedRoom(db, 2);
      seedPlayer(db, { id: 'p1', name: '阿瑞', confirmed: true });
      seedPlayer(db, { id: 'p2', name: '波', confirmed: false });
      updateGlobalAiProviderConfig(db, {
        provider: 'openai-compatible',
        baseUrl: stub.baseUrl,
        apiKey: 'test-key',
        model: 'test-model'
      });

      const intros = await preparePersonalOpeningIntrosForConfirmation(db, {
        roomId: 'room-1',
        playerId: 'p2',
        builtSheet: sheet('波')
      });

      expect(intros.map((intro) => intro.playerId).sort()).toEqual(['p1', 'p2']);
      expect(intros.every((intro) => intro.title === '个人开场')).toBe(true);
      expect(intros.find((intro) => intro.playerId === 'p1')?.content).toMatch(/^阿瑞出身于北境边地/);
      expect(intros.find((intro) => intro.playerId === 'p2')?.content).toMatch(/^波，离开家乡/);
      expect(stub.requests).toHaveLength(1);
      expect(JSON.stringify(stub.requests[0])).toContain('队伍抵达烛堡门前');
      expect(JSON.stringify(stub.requests[0])).toContain('使用第二人称写给该玩家本人');
      expect(JSON.stringify(stub.requests[0])).toContain('默认用“你……”描述个人经历');
    } finally {
      await stub.close();
      db.close();
    }
  });
});
