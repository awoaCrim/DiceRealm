import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { abilityModifier } from '../services/diceService.js';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// seed helper
// ---------------------------------------------------------------------------
function seedCombatants(db: ReturnType<typeof createMemoryDb>) {
  const roomId = nanoid();
  const player1Id = nanoid();
  const player2Id = nanoid();
  const charWarriorId = nanoid();
  const charMageId = nanoid();
  const now = new Date().toISOString();

  // room
  db.prepare(
    `INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(roomId, 'Combat Test Room', '', '', 0, 'setup', now);

  // players
  db.prepare(
    `INSERT INTO players (id, room_id, name, token, is_connected, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(player1Id, roomId, 'Player 1', 'token-p1', 1, now);
  db.prepare(
    `INSERT INTO players (id, room_id, name, token, is_connected, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(player2Id, roomId, 'Player 2', 'token-p2', 1, now);

  // character sheets
  const warriorSheet = {
    name: '战士',
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

  const mageSheet = {
    name: '法师',
    species: 'Human',
    className: '法师',
    level: 1,
    abilityScores: { str: 8, dex: 14, con: 12, int: 16, wis: 10, cha: 10 },
    hitPoints: { current: 8, max: 8 },
    armorClass: 12,
    proficiencyBonus: 2,
    skills: ['Arcana'],
    equipment: ['法杖'],
    spells: ['魔法飞弹'],
    privateNotes: '',
  };

  db.prepare(
    `INSERT INTO characters (id, player_id, sheet_json, draft_source, confirmed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(charWarriorId, player1Id, JSON.stringify(warriorSheet), 'manual', 1, now);

  db.prepare(
    `INSERT INTO characters (id, player_id, sheet_json, draft_source, confirmed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(charMageId, player2Id, JSON.stringify(mageSheet), 'manual', 1, now);

  // NPC goblin
  const goblinId = nanoid();
  db.prepare(
    `INSERT INTO npcs (id, room_id, name, hp_max, hp_current, ac, str, dex, con, int, wis, cha, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(goblinId, roomId, 'Goblin', 7, 7, 15, 8, 14, 10, 8, 8, 8, now);

  return {
    roomId,
    charIds: [charWarriorId, charMageId] as [string, string],
    npcIds: [goblinId] as [string],
  };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
describe('combatService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createCombat initializes state', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, charIds, npcIds } = seedCombatants(db);
      const { createCombat } = await import('../services/combatService.js');

      const combatants = [
        { characterId: charIds[0], name: '战士', hp: 12, ac: 16, isPlayer: true },
        { characterId: charIds[1], name: '法师', hp: 8, ac: 12, isPlayer: true },
        { npcId: npcIds[0], name: 'Goblin', hp: 7, ac: 15, isPlayer: false },
      ];

      const state = createCombat(db, roomId, combatants);

      expect(state.status).toBe('active');
      expect(state.round).toBe(1);
      expect(state.combatants).toHaveLength(3);
      expect(state.combatants[0].initiative).toBeNull();
      expect(state.combatants[1].initiative).toBeNull();
      expect(state.combatants[2].initiative).toBeNull();

      // Verify persisted
      const row = db
        .prepare('SELECT state_json FROM combat_state WHERE id = ?')
        .get(state.id) as { state_json: string } | undefined;
      expect(row).toBeTruthy();
      const parsed = JSON.parse(row!.state_json);
      expect(parsed.status).toBe('active');
    } finally {
      db.close();
    }
  });

  it('rollInitiative sorts by initiative total', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, charIds, npcIds } = seedCombatants(db);
      const { createCombat, rollInitiative } = await import('../services/combatService.js');

      const combatants = [
        { characterId: charIds[0], name: '战士', hp: 12, ac: 16, isPlayer: true },
        { characterId: charIds[1], name: '法师', hp: 8, ac: 12, isPlayer: true },
        { npcId: npcIds[0], name: 'Goblin', hp: 7, ac: 15, isPlayer: false },
      ];

      const state = createCombat(db, roomId, combatants);

      // Mock dice rolls:
      // 战士 dex 13 -> mod +1, roll=11 -> initiative 12
      // 法师 dex 14 -> mod +2, roll=15 -> initiative 17
      // Goblin dex 14 -> mod +2, roll=7 -> initiative 9
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.5)   // 战士: roll=11
        .mockReturnValueOnce(0.7)   // 法师: roll=15
        .mockReturnValueOnce(0.3);  // Goblin: roll=7

      const result = rollInitiative(db, state.id);

      // Should be sorted desc by initiative
      expect(result.combatants).toHaveLength(3);
      expect(result.combatants[0].name).toBe('法师');
      expect(result.combatants[0].initiative).toBe(17);
      expect(result.combatants[1].name).toBe('战士');
      expect(result.combatants[1].initiative).toBe(12);
      expect(result.combatants[2].name).toBe('Goblin');
      expect(result.combatants[2].initiative).toBe(9);
      expect(result.currentTurn).toBe(0);
    } finally {
      db.close();
    }
  });

  it('nextTurn cycles through combatants', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, charIds, npcIds } = seedCombatants(db);
      const { createCombat, nextTurn } = await import('../services/combatService.js');

      const combatants = [
        { characterId: charIds[0], name: '战士', hp: 12, ac: 16, isPlayer: true },
        { characterId: charIds[1], name: '法师', hp: 8, ac: 12, isPlayer: true },
        { npcId: npcIds[0], name: 'Goblin', hp: 7, ac: 15, isPlayer: false },
      ];

      let state = createCombat(db, roomId, combatants);
      // Manually set initiative so order is deterministic
      state.combatants[0].initiative = 20; // 战士
      state.combatants[1].initiative = 15; // 法师
      state.combatants[2].initiative = 10; // Goblin

      // Persist the manually set initiative
      db.prepare('UPDATE combat_state SET state_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(state), new Date().toISOString(), state.id
      );

      expect(state.currentTurn).toBe(0);

      state = nextTurn(db, state.id);
      expect(state.currentTurn).toBe(1);

      state = nextTurn(db, state.id);
      expect(state.currentTurn).toBe(2);

      state = nextTurn(db, state.id);
      expect(state.currentTurn).toBe(0);
      expect(state.round).toBe(2); // wrapped around, new round
    } finally {
      db.close();
    }
  });

  it('processAttack hits NPC and reduces HP', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, charIds, npcIds } = seedCombatants(db);
      const { createCombat, processAttack } = await import('../services/combatService.js');

      const combatants = [
        { characterId: charIds[0], name: '战士', hp: 12, ac: 16, isPlayer: true },
        { npcId: npcIds[0], name: 'Goblin', hp: 7, ac: 15, isPlayer: false },
      ];

      const state = createCombat(db, roomId, combatants);

      // Mock: attack roll 11 (random=0.5), total = 11+2(str)+2(prof)=15 >= AC 15 → hit
      // Mock: damage roll 5 on d8 (random=0.5), total = 5+2(str)=7
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.5)  // attack d20: roll=11
        .mockReturnValueOnce(0.5); // damage d8: roll=5

      const result = processAttack(db, {
        roomId,
        combatId: state.id,
        attackerIndex: 0,
        targetIndex: 1,
      });

      // Hit confirmed
      expect(result.attackResult.hit).toBe(true);
      expect(result.attackResult.total).toBe(15); // 11 + 2 + 2

      // Damage applied to goblin HP
      expect(result.damageResult).toBeTruthy();
      expect(result.damageResult!.total).toBe(7); // 5 + 2

      // Goblin HP updated in state
      const goblin = result.state.combatants[1];
      expect(goblin.hp.current).toBe(0);
      expect(goblin.hp.max).toBe(7);
      expect(goblin.name).toBe('Goblin');

      // Dice log recorded
      const logs = db.prepare('SELECT * FROM dice_logs WHERE combat_id = ? ORDER BY created_at').all(result.state.id) as Array<Record<string, unknown>>;
      expect(logs.length).toBeGreaterThanOrEqual(2); // attack roll + damage roll
      const attackLog = logs[0];
      expect(attackLog.dice_type).toBe('d20');
      expect(attackLog.reason).toContain('Attack');
    } finally {
      db.close();
    }
  });

  it('processAttack miss does not change HP', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, charIds, npcIds } = seedCombatants(db);
      const { createCombat, processAttack } = await import('../services/combatService.js');

      const combatants = [
        { characterId: charIds[0], name: '战士', hp: 12, ac: 16, isPlayer: true },
        { npcId: npcIds[0], name: 'Goblin', hp: 7, ac: 15, isPlayer: false },
      ];

      const state = createCombat(db, roomId, combatants);

      // Mock: attack roll 1 (random=0), total = 1+2+2=5 < 15 → miss
      vi.spyOn(Math, 'random').mockReturnValue(0);

      const result = processAttack(db, {
        roomId,
        combatId: state.id,
        attackerIndex: 0,
        targetIndex: 1,
      });

      expect(result.attackResult.hit).toBe(false);
      expect(result.damageResult).toBeNull();

      // Goblin HP unchanged
      const goblin = result.state.combatants[1];
      expect(goblin.hp.current).toBe(7);
    } finally {
      db.close();
    }
  });

  it('deathSave tracks pass/fail correctly', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, charIds, npcIds } = seedCombatants(db);
      const { createCombat, deathSave } = await import('../services/combatService.js');

      const combatants = [
        { characterId: charIds[0], name: '战士', hp: 0, ac: 16, isPlayer: true },
      ];

      let state = createCombat(db, roomId, combatants);

      // Death save 1: roll 15 → pass
      vi.spyOn(Math, 'random').mockReturnValue(0.7); // roll=15
      let result = deathSave(db, { roomId, combatId: state.id, combatantIndex: 0 });
      expect(result.success).toBe(true);
      state = result.state;
      // After 1 pass
      const c1 = state.combatants[0] as unknown as Record<string, unknown>;
      expect(c1.deathSavePasses).toBe(1);
      expect(c1.deathSaveFails).toBe(0);
      vi.restoreAllMocks();

      // Death save 2: roll 5 → fail
      vi.spyOn(Math, 'random').mockReturnValue(0.2); // roll=5
      result = deathSave(db, { roomId, combatId: state.id, combatantIndex: 0 });
      expect(result.success).toBe(false);
      state = result.state;
      const c2 = state.combatants[0] as unknown as Record<string, unknown>;
      expect(c2.deathSavePasses).toBe(1);
      expect(c2.deathSaveFails).toBe(1);
      vi.restoreAllMocks();

      // Death save 3: roll 12 → pass (2 passes)
      vi.spyOn(Math, 'random').mockReturnValue(0.55); // roll=12
      result = deathSave(db, { roomId, combatId: state.id, combatantIndex: 0 });
      expect(result.success).toBe(true);
      state = result.state;
      const c3 = state.combatants[0] as unknown as Record<string, unknown>;
      expect(c3.deathSavePasses).toBe(2);
      expect(c3.deathSaveFails).toBe(1);
      vi.restoreAllMocks();

      // Death save 4: roll 18 → pass (3 passes → stable!)
      vi.spyOn(Math, 'random').mockReturnValue(0.85); // roll=18
      result = deathSave(db, { roomId, combatId: state.id, combatantIndex: 0 });
      expect(result.success).toBe(true);
      expect(result.stable).toBe(true);
      state = result.state;
      const c4 = state.combatants[0] as unknown as Record<string, unknown>;
      expect(c4.deathSavePasses).toBe(3);
      expect(c4.stable).toBe(true);
    } finally {
      db.close();
    }
  });

  it('deathSave 3 fails results in death', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, charIds } = seedCombatants(db);
      const { createCombat, deathSave } = await import('../services/combatService.js');

      const combatants = [
        { characterId: charIds[0], name: '战士', hp: 0, ac: 16, isPlayer: true },
      ];

      let state = createCombat(db, roomId, combatants);

      // 3 consecutive fails
      for (let i = 0; i < 3; i++) {
        vi.spyOn(Math, 'random').mockReturnValue(0.2); // roll=5 → fail
        const result = deathSave(db, { roomId, combatId: state.id, combatantIndex: 0 });
        expect(result.success).toBe(false);
        state = result.state;
        vi.restoreAllMocks();
      }

      const c = state.combatants[0] as unknown as Record<string, unknown>;
      expect(c.deathSaveFails).toBe(3);
      expect(c.dead).toBe(true);
    } finally {
      db.close();
    }
  });
});
