import type { AppDatabase } from '../db/connection.js';
import type { CombatState, Combatant, DiceLog } from '../domain/types.js';
import { abilityModifier, rollD20, attackRoll, damageRoll } from './diceService.js';
import { applyResourcePatch } from './characterResourceService.js';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// input types
// ---------------------------------------------------------------------------

export interface CombatantSpec {
  characterId?: string;
  npcId?: string;
  name: string;
  hp: number;
  ac: number;
  isPlayer: boolean;
}

export interface ProcessAttackParams {
  roomId: string;
  combatId: string;
  attackerIndex: number;
  targetIndex: number;
}

export interface DeathSaveParams {
  roomId: string;
  combatId: string;
  combatantIndex: number;
}

export interface ProcessAttackResult {
  state: CombatState;
  attackResult: ReturnType<typeof attackRoll>;
  damageResult: ReturnType<typeof damageRoll> | null;
}

export interface DeathSaveResult {
  state: CombatState;
  roll: number;
  natural: number;
  success: boolean;
  stable: boolean;
  dead: boolean;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function nowISO(): string {
  return new Date().toISOString();
}

function loadCombatState(db: AppDatabase, combatId: string): CombatState {
  const row = db
    .prepare('SELECT state_json FROM combat_state WHERE id = ?')
    .get(combatId) as { state_json: string } | undefined;
  if (!row) {
    throw new Error(`Combat not found: ${combatId}`);
  }
  return JSON.parse(row.state_json) as CombatState;
}

function saveCombatState(db: AppDatabase, state: CombatState): void {
  db.prepare('UPDATE combat_state SET state_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(state),
    nowISO(),
    state.id
  );
}

function insertDiceLog(
  db: AppDatabase,
  log: Omit<DiceLog, 'id' | 'timestamp'>
): string {
  const id = nanoid();
  const timestamp = nowISO();
  db.prepare(
    `INSERT INTO dice_logs (id, room_id, turn_id, combat_id, character_id, dice_type, values_json, modifier, total, dc, success, is_public, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    log.roomId,
    log.turnId ?? null,
    log.combatId ?? null,
    log.characterId ?? null,
    log.diceType,
    JSON.stringify(log.values),
    log.modifier,
    log.total,
    log.dc ?? null,
    log.success === null ? null : (log.success ? 1 : 0),
    log.isPublic ? 1 : 0,
    log.reason,
    timestamp
  );
  return id;
}

function readDexForCombatant(
  db: AppDatabase,
  c: Combatant
): number {
  if (c.characterId) {
    const row = db
      .prepare('SELECT sheet_json FROM characters WHERE id = ?')
      .get(c.characterId) as { sheet_json: string } | undefined;
    if (row) {
      const sheet = JSON.parse(row.sheet_json) as Record<string, unknown>;
      const scores = sheet.abilityScores as Record<string, number> | undefined;
      return scores?.dex ?? 10;
    }
  }
  if (c.npcId) {
    const row = db
      .prepare('SELECT dex FROM npcs WHERE id = ?')
      .get(c.npcId) as { dex: number } | undefined;
    if (row) {
      return row.dex;
    }
  }
  return 10;
}

function readAbilityAndProfForCombatant(
  db: AppDatabase,
  c: Combatant
): { str: number; dex: number; proficiency: number } {
  let str = 10;
  let dex = 10;
  let proficiency = 2;

  if (c.characterId) {
    const row = db
      .prepare('SELECT sheet_json FROM characters WHERE id = ?')
      .get(c.characterId) as { sheet_json: string } | undefined;
    if (row) {
      const sheet = JSON.parse(row.sheet_json) as Record<string, unknown>;
      const scores = sheet.abilityScores as Record<string, number> | undefined;
      str = scores?.str ?? 10;
      dex = scores?.dex ?? 10;
      proficiency = (sheet.proficiencyBonus as number) ?? 2;
    }
  } else if (c.npcId) {
    const row = db
      .prepare('SELECT str, dex FROM npcs WHERE id = ?')
      .get(c.npcId) as { str: number; dex: number } | undefined;
    if (row) {
      str = row.str;
      dex = row.dex;
    }
    proficiency = 2;
  }

  return { str, dex, proficiency };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export function createCombat(
  db: AppDatabase,
  roomId: string,
  combatantSpecs: CombatantSpec[]
): CombatState {
  const combatants: Combatant[] = combatantSpecs.map((spec) => ({
    id: nanoid(),
    characterId: spec.characterId ?? null,
    npcId: spec.npcId ?? null,
    name: spec.name,
    initiative: null,
    hp: { current: spec.hp, max: spec.hp },
    ac: spec.ac,
    isPlayer: spec.isPlayer,
    conditions: [],
  }));

  const state: CombatState = {
    id: nanoid(),
    roomId,
    round: 1,
    currentTurn: 0,
    combatants,
    status: 'active',
    startedAt: nowISO(),
  };

  db.prepare(
    `INSERT INTO combat_state (id, room_id, state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(state.id, roomId, JSON.stringify(state), state.startedAt, state.startedAt);

  return state;
}

export function rollInitiative(db: AppDatabase, combatId: string): CombatState {
  const state = loadCombatState(db, combatId);

  for (const c of state.combatants) {
    const dex = readDexForCombatant(db, c);
    const dexMod = abilityModifier(dex);
    const roll = rollD20();
    c.initiative = roll.value + dexMod;
  }

  // Sort descending by initiative
  state.combatants.sort((a, b) => (b.initiative ?? 0) - (a.initiative ?? 0));
  state.currentTurn = 0;

  saveCombatState(db, state);
  return state;
}

export function nextTurn(db: AppDatabase, combatId: string): CombatState {
  const state = loadCombatState(db, combatId);

  state.currentTurn = (state.currentTurn + 1) % state.combatants.length;
  if (state.currentTurn === 0) {
    state.round++;
  }

  saveCombatState(db, state);
  return state;
}

export function processAttack(
  db: AppDatabase,
  params: ProcessAttackParams
): ProcessAttackResult {
  const state = loadCombatState(db, params.combatId);

  const attacker = state.combatants[params.attackerIndex];
  const target = state.combatants[params.targetIndex];

  if (!attacker || !target) {
    throw new Error('Invalid attacker or target index');
  }

  const { str, proficiency } = readAbilityAndProfForCombatant(db, attacker);
  const attackMod = abilityModifier(str); // default to str-based melee attack

  // 1) Attack roll
  const attResult = attackRoll(attackMod, proficiency, target.ac);

  // Log attack roll
  insertDiceLog(db, {
    roomId: params.roomId,
    turnId: null,
    combatId: params.combatId,
    characterId: attacker.characterId,
    diceType: 'd20',
    values: [attResult.natural],
    modifier: attackMod + proficiency,
    total: attResult.total,
    dc: target.ac,
    success: attResult.hit,
    isPublic: true,
    reason: `Attack by ${attacker.name} vs ${target.name}`,
  });

  let damageResult: ReturnType<typeof damageRoll> | null = null;

  // 2) Damage roll (if hit)
  if (attResult.hit) {
    const dmgResult = damageRoll('d8', 1, attackMod);
    damageResult = dmgResult;

    const oldHp = target.hp.current;
    const newHp = Math.max(0, oldHp - dmgResult.total);

    // Update HP in combat state
    target.hp.current = newHp;

    // For PC targets: also update through resource service
    if (target.characterId) {
      applyResourcePatch(
        db,
        params.roomId,
        {
          characterId: target.characterId,
          path: 'hitPoints.current',
          before: oldHp,
          after: newHp,
          reason: `Attacked by ${attacker.name}`,
          ruleRefs: ['combat-damage'],
        },
        'combat',
        params.combatId
      );
    }

    // Log damage roll
    insertDiceLog(db, {
      roomId: params.roomId,
      turnId: null,
      combatId: params.combatId,
      characterId: attacker.characterId,
      diceType: 'd8',
      values: dmgResult.values,
      modifier: dmgResult.modifier,
      total: dmgResult.total,
      dc: null,
      success: null,
      isPublic: true,
      reason: `Damage by ${attacker.name} vs ${target.name}`,
    });
  }

  saveCombatState(db, state);

  return { state, attackResult: attResult, damageResult };
}

export function deathSave(
  db: AppDatabase,
  params: DeathSaveParams
): DeathSaveResult {
  const state = loadCombatState(db, params.combatId);
  const combatant = state.combatants[params.combatantIndex];

  if (!combatant) {
    throw new Error('Invalid combatant index');
  }

  // Roll d20
  const { value: roll, natural } = rollD20();
  const success = roll >= 10;

  // Track passes/fails on the combatant object (stored in JSON)
  const c = combatant as Combatant & {
    deathSavePasses?: number;
    deathSaveFails?: number;
    stable?: boolean;
    dead?: boolean;
  };

  // Initialize counters
  c.deathSavePasses = c.deathSavePasses ?? 0;
  c.deathSaveFails = c.deathSaveFails ?? 0;

  if (success) {
    c.deathSavePasses++;
  } else {
    c.deathSaveFails++;
  }

  const stable = (c.deathSavePasses ?? 0) >= 3;
  const dead = (c.deathSaveFails ?? 0) >= 3;

  if (stable) {
    c.stable = true;
  }
  if (dead) {
    c.dead = true;
  }

  // Log death save
  insertDiceLog(db, {
    roomId: params.roomId,
    turnId: null,
    combatId: params.combatId,
    characterId: combatant.characterId,
    diceType: 'd20',
    values: [natural],
    modifier: 0,
    total: roll,
    dc: 10,
    success,
    isPublic: true,
    reason: `Death save for ${combatant.name}`,
  });

  saveCombatState(db, state);

  return { state, roll, natural, success, stable, dead };
}
