import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { ensureAutoCompanionNpcs, requiredCompanionNpcCount } from '../services/autoCompanionNpcService.js';

function seedRoom(db: ReturnType<typeof createMemoryDb>, roomId = 'room-1'): void {
  db.prepare(`
    INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, expected_player_count, ai_config_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(roomId, '测试房间', '', '', 1, 'waiting_for_actions', null, '{}', '2026-06-07T00:00:00.000Z');
}

describe('autoCompanionNpcService', () => {
  it('calculates missing companion NPCs against a four-person party', () => {
    expect(requiredCompanionNpcCount(1)).toBe(3);
    expect(requiredCompanionNpcCount(2)).toBe(2);
    expect(requiredCompanionNpcCount(3)).toBe(1);
    expect(requiredCompanionNpcCount(4)).toBe(0);
    expect(requiredCompanionNpcCount(5)).toBe(0);
  });

  it('creates friendly companion NPCs when expected players are fewer than four', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedRoom(db);

      const created = ensureAutoCompanionNpcs(db, 'room-1', 2);
      const npcs = db.prepare('SELECT name, role, attitude, notes, location FROM campaign_npcs WHERE room_id = ? ORDER BY name ASC')
        .all('room-1') as Array<{ name: string; role: string; attitude: string; notes: string; location: string }>;

      expect(created).toBe(2);
      expect(npcs).toHaveLength(2);
      expect(npcs.map((npc) => npc.name).sort()).toEqual(['布兰', '希拉']);
      expect(npcs.every((npc) => npc.attitude === 'friendly')).toBe(true);
      expect(npcs.every((npc) => npc.role.includes('补位同伴'))).toBe(true);
      expect(npcs.every((npc) => npc.notes.includes('[AUTO_COMPANION_NPC]'))).toBe(true);
      expect(npcs.every((npc) => npc.location === '随队行动')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('does not create companions for four or more expected players', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedRoom(db);

      const created = ensureAutoCompanionNpcs(db, 'room-1', 4);
      const count = db.prepare('SELECT COUNT(*) as count FROM campaign_npcs WHERE room_id = ?')
        .get('room-1') as { count: number };

      expect(created).toBe(0);
      expect(count.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('is idempotent for the same room and expected player count', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedRoom(db);

      expect(ensureAutoCompanionNpcs(db, 'room-1', 1)).toBe(3);
      expect(ensureAutoCompanionNpcs(db, 'room-1', 1)).toBe(0);
      const count = db.prepare('SELECT COUNT(*) as count FROM campaign_npcs WHERE room_id = ?')
        .get('room-1') as { count: number };

      expect(count.count).toBe(3);
    } finally {
      db.close();
    }
  });
});
