import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { nanoid } from 'nanoid';

function seedCharacter(db: ReturnType<typeof createMemoryDb>) {
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
  ).run(playerId, roomId, 'Test Player', 'token-test', 1, now);

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
  };

  db.prepare(
    `INSERT INTO characters (id, player_id, sheet_json, draft_source, confirmed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(characterId, playerId, JSON.stringify(sheet), 'manual', 1, now);

  return { roomId, playerId, characterId, sheet };
}

describe('characterResourceService', () => {
  it('getCharacterResources returns default resource model', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { characterId } = seedCharacter(db);

      // Dynamic import to avoid top-level failure when module doesn't exist
      const { getCharacterResources } = await import('../services/characterResourceService.js');

      const resources = getCharacterResources(db, characterId);

      expect(resources).toEqual({
        hitPoints: { current: 12, max: 12, temp: 0 },
        hitDice: { total: 1, remaining: 1, die: 'd10' },
        spellSlots: { level1: { total: 0, used: 0 } },
        ammo: [],
        consumables: [],
        currency: { gp: 0, sp: 0, cp: 0 },
        conditions: [],
      });
    } finally {
      db.close();
    }
  });

  it('applyResourcePatch validates and writes', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { characterId, roomId } = seedCharacter(db);
      const { getCharacterResources, applyResourcePatch } = await import('../services/characterResourceService.js');

      // Valid patch: reduce HP from 12 to 8
      const patch1 = {
        characterId,
        path: 'hitPoints.current',
        before: 12,
        after: 8,
        reason: '受到攻击',
        ruleRefs: ['combat-damage'],
      };
      const result1 = applyResourcePatch(db, roomId, patch1, 'dm', 'admin-dm');
      expect(result1.hitPoints.current).toBe(8);

      const resources1 = getCharacterResources(db, characterId);
      expect(resources1.hitPoints.current).toBe(8);

      // Invalid path
      expect(() =>
        applyResourcePatch(db, roomId, {
          characterId,
          path: 'invalid.field',
          before: 0,
          after: 1,
          reason: '测试',
          ruleRefs: [],
        }, 'dm', 'admin-dm')
      ).toThrow(/Invalid resource path/);

      // Before mismatch
      expect(() =>
        applyResourcePatch(db, roomId, {
          characterId,
          path: 'hitPoints.current',
          before: 12, // current is 8
          after: 5,
          reason: '测试',
          ruleRefs: [],
        }, 'dm', 'admin-dm')
      ).toThrow(/Before value mismatch/);
    } finally {
      db.close();
    }
  });

  it('shortRest recovers hitDice→HP and longRest fullHP+halfHitDice', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { characterId, roomId } = seedCharacter(db);
      const { getCharacterResources, applyResourcePatch, shortRest, longRest } =
        await import('../services/characterResourceService.js');

      // Set HP current to 5, dice remaining to 0
      applyResourcePatch(db, roomId, {
        characterId,
        path: 'hitPoints.current',
        before: 12,
        after: 5,
        reason: 'setup',
        ruleRefs: [],
      }, 'dm', 'admin-dm');

      applyResourcePatch(db, roomId, {
        characterId,
        path: 'hitDice.remaining',
        before: 1,
        after: 0,
        reason: 'setup',
        ruleRefs: [],
      }, 'dm', 'admin-dm');

      let resources = getCharacterResources(db, characterId);
      expect(resources.hitPoints.current).toBe(5);
      expect(resources.hitDice.remaining).toBe(0);

      // Short rest: consumes remaining hitDice (0) but actually we need to test with dice available
      // Re-set: remaining=1, current=5
      applyResourcePatch(db, roomId, {
        characterId,
        path: 'hitDice.remaining',
        before: 0,
        after: 1,
        reason: 're-setup',
        ruleRefs: [],
      }, 'dm', 'admin-dm');

      // shortRest should consume 1 hitDice and recover HP
      shortRest(db, characterId);
      resources = getCharacterResources(db, characterId);
      // remaining should go 1->0, HP should increase
      expect(resources.hitDice.remaining).toBe(0);
      expect(resources.hitPoints.current).toBeGreaterThan(5);
      expect(resources.hitPoints.current).toBeLessThanOrEqual(resources.hitPoints.max);

      // Long rest: HP -> max, hitDice -> 1, spellSlots restored
      longRest(db, characterId);
      resources = getCharacterResources(db, characterId);
      expect(resources.hitPoints.current).toBe(resources.hitPoints.max);
      expect(resources.hitDice.remaining).toBe(1);
    } finally {
      db.close();
    }
  });
});
