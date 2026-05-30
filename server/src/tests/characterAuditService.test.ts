import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { nanoid } from 'nanoid';

function seedCharacterWithRoom(db: ReturnType<typeof createMemoryDb>) {
  const roomId = nanoid();
  const playerId = nanoid();
  const characterId = nanoid();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(roomId, 'Test Room', '', '', 0, 'setup', now);

  db.prepare(
    `INSERT INTO players (id, room_id, name, token, is_connected, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(playerId, roomId, 'Test Player', 'token-' + nanoid(), 1, now);

  const sheet = {
    name: '洛林',
    species: 'Human',
    className: '战士',
    level: 1,
    abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
    hitPoints: { current: 12, max: 12 },
    armorClass: 16,
    proficiencyBonus: 2,
    skills: ['Athletics'],
    equipment: ['长剑'],
    spells: [],
    privateNotes: '',
    resources: {
      hitPoints: { current: 12, max: 12, temp: 0 },
      hitDice: { total: 1, remaining: 1, die: 'd10' },
      spellSlots: { level1: { total: 0, used: 0 } },
      ammo: [],
      consumables: [],
      currency: { gp: 0, sp: 0, cp: 0 },
      conditions: [],
    },
  };

  db.prepare(
    `INSERT INTO characters (id, player_id, sheet_json, draft_source, confirmed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(characterId, playerId, JSON.stringify(sheet), 'manual', 1, now);

  return { roomId, playerId, characterId, sheet };
}

describe('characterAuditService', () => {
  it('recordResourceChange captures audit data', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, characterId } = seedCharacterWithRoom(db);
      const { applyResourcePatch } = await import('../services/characterResourceService.js');
      const { listCharacterResourceChanges } = await import('../services/characterAuditService.js');

      applyResourcePatch(db, roomId, {
        characterId,
        path: 'hitPoints.current',
        before: 12,
        after: 8,
        reason: '受到攻击',
        ruleRefs: ['combat-damage'],
      }, 'player', 'player-1');

      const changes = listCharacterResourceChanges(db, roomId, {});
      expect(changes).toHaveLength(1);

      const c = changes[0];
      expect(c.roomId).toBe(roomId);
      expect(c.characterId).toBe(characterId);
      expect(c.actorType).toBe('player');
      expect(c.actorId).toBe('player-1');
      expect(c.changeType).toBe('resource_patch');
      expect(c.path).toBe('hitPoints.current');
      expect(JSON.parse(c.beforeJson)).toBe(12);
      expect(JSON.parse(c.afterJson)).toBe(8);
      expect(c.reason).toBe('受到攻击');
      expect(JSON.parse(c.ruleRefsJson)).toEqual(['combat-damage']);
      expect(c.revertedAt).toBeNull();
      expect(c.revertedBy).toBeNull();
    } finally {
      db.close();
    }
  });

  it('listCharacterResourceChanges with filters', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, characterId } = seedCharacterWithRoom(db);
      const { applyResourcePatch } = await import('../services/characterResourceService.js');
      const { listCharacterResourceChanges } = await import('../services/characterAuditService.js');

      // Patch 1: HP
      applyResourcePatch(db, roomId, {
        characterId,
        path: 'hitPoints.current',
        before: 12,
        after: 8,
        reason: '受伤',
        ruleRefs: ['combat-damage'],
      }, 'dm', 'admin-dm');

      // Small delay to ensure different created_at timestamps
      await new Promise((r) => setTimeout(r, 5));

      // Patch 2: currency
      applyResourcePatch(db, roomId, {
        characterId,
        path: 'currency.gp',
        before: 0,
        after: 100,
        reason: '获得金币',
        ruleRefs: ['loot'],
      }, 'dm', 'admin-dm');

      const changes = listCharacterResourceChanges(db, roomId, {});
      expect(changes).toHaveLength(2);
      // DESC order: most recent first
      expect(changes[0].path).toBe('currency.gp');
      expect(changes[1].path).toBe('hitPoints.current');

      // Filter by characterId
      const filtered = listCharacterResourceChanges(db, roomId, { characterId });
      expect(filtered).toHaveLength(2);

      // Filter by different characterId returns empty
      const empty = listCharacterResourceChanges(db, roomId, { characterId: 'nonexistent' });
      expect(empty).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('rollbackResourceChange restores before and marks revertedAt', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, characterId } = seedCharacterWithRoom(db);
      const { applyResourcePatch, getCharacterResources } =
        await import('../services/characterResourceService.js');
      const { listCharacterResourceChanges, rollbackResourceChange } =
        await import('../services/characterAuditService.js');

      // Apply HP patch 12 → 8
      applyResourcePatch(db, roomId, {
        characterId,
        path: 'hitPoints.current',
        before: 12,
        after: 8,
        reason: '受到攻击',
        ruleRefs: ['combat-damage'],
      }, 'dm', 'admin-dm');

      let resources = getCharacterResources(db, characterId);
      expect(resources.hitPoints.current).toBe(8);

      // Get the change id
      const changes = listCharacterResourceChanges(db, roomId, {});
      expect(changes).toHaveLength(1);
      const changeId = changes[0].id;

      // Rollback
      rollbackResourceChange(db, changeId, 'admin-1');

      // HP should be restored to 12
      resources = getCharacterResources(db, characterId);
      expect(resources.hitPoints.current).toBe(12);

      // Audit row should be marked
      const afterRollback = listCharacterResourceChanges(db, roomId, {});
      expect(afterRollback).toHaveLength(1);
      const reverted = afterRollback[0];
      expect(reverted.revertedAt).not.toBeNull();
      expect(reverted.revertedBy).toBe('admin-1');

      // Rolling back again should throw
      expect(() => rollbackResourceChange(db, changeId, 'admin-1'))
        .toThrow(/already reverted/);
    } finally {
      db.close();
    }
  });
});
