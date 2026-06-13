import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';

describe('auto companion NPC routes', () => {
  it('creates companion NPCs when a new room expects fewer than four players', async () => {
    const db = createMemoryDb();
    migrate(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '双人房', expectedPlayerCount: 2 })
      });
      expect(roomRes.status).toBe(200);
      const room = await roomRes.json() as { roomId: string };
      const npcs = db.prepare('SELECT name, role, attitude FROM campaign_npcs WHERE room_id = ? ORDER BY name ASC')
        .all(room.roomId) as Array<{ name: string; role: string; attitude: string }>;

      expect(npcs).toHaveLength(2);
      expect(npcs.map((npc) => npc.name)).toEqual(['布兰', '希拉']);
      expect(npcs.every((npc) => npc.role.includes('补位同伴'))).toBe(true);
      expect(npcs.every((npc) => npc.attitude === 'friendly')).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it('creates companion NPCs when an old room receives its expected player count', async () => {
    const db = createMemoryDb();
    migrate(db);
    const now = '2026-06-07T00:00:00.000Z';
    db.prepare(`
      INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, expected_player_count, ai_config_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-room', '旧房间', '', '', 1, 'waiting_for_actions', null, '{}', now);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const res = await fetch(`${base}/api/admin/rooms/legacy-room/expected-player-count`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedPlayerCount: 3 })
      });
      expect(res.status).toBe(200);
      const count = db.prepare('SELECT COUNT(*) as count FROM campaign_npcs WHERE room_id = ?')
        .get('legacy-room') as { count: number };

      expect(count.count).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});
