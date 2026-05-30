import type { CharacterResources, ResourcePatch } from '../domain/types.js';
import type { AppDatabase } from '../db/connection.js';
import { recordResourceChange } from './characterAuditService.js';

// --- helpers ---

type RollFn = (sides: number) => number;

function defaultRoll(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

function getHitDieForClass(className: string): { sides: number; die: string } {
  const d12 = ['Barbarian', '野蛮人'];
  const d10 = ['Fighter', 'Paladin', 'Ranger', '战士', '圣骑士', '游侠'];
  const d8 = ['Cleric', 'Druid', 'Monk', 'Rogue', 'Warlock', '牧师', '德鲁伊', '武僧', '游荡者', '术士'];
  // d6: Bard, Sorcerer, Wizard, 吟游诗人, 术士, 法师 (Warlock is d8, correct)

  if (d12.some((c) => className.includes(c))) return { sides: 12, die: 'd12' };
  if (d10.some((c) => className.includes(c))) return { sides: 10, die: 'd10' };
  if (d8.some((c) => className.includes(c))) return { sides: 8, die: 'd8' };
  return { sides: 6, die: 'd6' };
}

function loadSheetJson(db: AppDatabase, characterId: string): Record<string, unknown> {
  const row = db
    .prepare('SELECT sheet_json FROM characters WHERE id = ?')
    .get(characterId) as { sheet_json: string } | undefined;
  if (!row) {
    throw new Error(`Character not found: ${characterId}`);
  }
  return JSON.parse(row.sheet_json) as Record<string, unknown>;
}

function saveSheetJson(db: AppDatabase, characterId: string, sheet: Record<string, unknown>): void {
  db.prepare('UPDATE characters SET sheet_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(sheet),
    new Date().toISOString(),
    characterId
  );
}

function getDefaultResources(sheet: Record<string, unknown>): CharacterResources {
  const className = (sheet.className as string) || 'Fighter';
  const level = (sheet.level as number) || 1;
  const hpMax = ((sheet.hitPoints as Record<string, number>)?.max) || 12;
  const hpCurrent = ((sheet.hitPoints as Record<string, number>)?.current) || hpMax;
  const hitDie = getHitDieForClass(className);

  return {
    hitPoints: { current: hpCurrent, max: hpMax, temp: 0 },
    hitDice: { total: level, remaining: level, die: hitDie.die },
    spellSlots: { level1: { total: 0, used: 0 } },
    ammo: [],
    consumables: [],
    currency: { gp: 0, sp: 0, cp: 0 },
    conditions: [],
  };
}

function getAtPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      if (isNaN(idx)) return undefined;
      current = (current as Array<unknown>)[idx];
    } else {
      return undefined;
    }
  }
  return current;
}

function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    const nextIsIndex = /^\d+$/.test(nextPart);

    if (current[part] === undefined || current[part] === null) {
      current[part] = nextIsIndex ? [] : {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

// Whitelist regex patterns for valid resource paths
const VALID_PATH_PATTERNS = [
  /^hitPoints\.(current|max|temp)$/,
  /^hitDice\.(remaining|total)$/,
  /^spellSlots\.[a-zA-Z0-9_]+\.(total|used)$/,
  /^ammo\.\d+\.(name|current|max)$/,
  /^consumables\.\d+\.(name|quantity)$/,
  /^currency\.(gp|sp|cp)$/,
  /^conditions$/,
];

function isValidPath(path: string): boolean {
  return VALID_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function validateRange(path: string, value: number): void {
  if (path === 'hitPoints.current') {
    if (typeof value !== 'number' || value < 0) {
      throw new Error(`hitPoints.current must be >= 0, got ${value}`);
    }
  }
  if (path === 'hitPoints.max') {
    if (typeof value !== 'number' || value < 1) {
      throw new Error(`hitPoints.max must be >= 1, got ${value}`);
    }
  }
  if (path === 'hitPoints.temp') {
    if (typeof value !== 'number' || value < 0) {
      throw new Error(`hitPoints.temp must be >= 0, got ${value}`);
    }
  }
  if (path === 'hitDice.remaining') {
    if (typeof value !== 'number' || value < 0) {
      throw new Error(`hitDice.remaining must be >= 0, got ${value}`);
    }
  }
  if (path === 'hitDice.total') {
    if (typeof value !== 'number' || value < 1) {
      throw new Error(`hitDice.total must be >= 1, got ${value}`);
    }
  }
}

// --- public API ---

export function getCharacterResources(db: AppDatabase, characterId: string): CharacterResources {
  const sheet = loadSheetJson(db, characterId);

  if (sheet.resources) {
    return sheet.resources as CharacterResources;
  }

  // Initialize default resources and persist
  const resources = getDefaultResources(sheet);
  sheet.resources = resources;
  saveSheetJson(db, characterId, sheet);

  return resources;
}

export function applyResourcePatch(
  db: AppDatabase,
  roomId: string,
  patch: ResourcePatch,
  actorType: string,
  actorId: string
): CharacterResources {
  // Validate path is whitelisted
  if (!isValidPath(patch.path)) {
    throw new Error(`Invalid resource path: ${patch.path}`);
  }

  const sheet = loadSheetJson(db, patch.characterId);
  const resources = (sheet.resources as CharacterResources) || getDefaultResources(sheet);

  // Validate before matches current value
  const currentValue = getAtPath(resources as unknown as Record<string, unknown>, patch.path);
  if (currentValue !== patch.before) {
    throw new Error(
      `Before value mismatch for ${patch.path}: expected ${patch.before}, got ${JSON.stringify(currentValue)}`
    );
  }

  // Validate range for numeric paths
  if (typeof patch.after === 'number') {
    validateRange(patch.path, patch.after);
  }

  // Ensure hitPoints.current <= hitPoints.max
  if (patch.path === 'hitPoints.current' && typeof patch.after === 'number') {
    if (patch.after > resources.hitPoints.max) {
      throw new Error(`hitPoints.current (${patch.after}) cannot exceed max (${resources.hitPoints.max})`);
    }
  }
  if (patch.path === 'hitPoints.max' && typeof patch.after === 'number') {
    if (patch.after < resources.hitPoints.current) {
      // Adjust current down to new max
      resources.hitPoints.current = patch.after;
    }
  }
  if (patch.path === 'hitDice.remaining' && typeof patch.after === 'number') {
    if (patch.after > resources.hitDice.total) {
      throw new Error(`hitDice.remaining (${patch.after}) cannot exceed total (${resources.hitDice.total})`);
    }
  }

  // Apply the change
  setAtPath(resources as unknown as Record<string, unknown>, patch.path, patch.after);

  // Persist
  sheet.resources = resources;
  saveSheetJson(db, patch.characterId, sheet);

  // Log the change via audit service
  recordResourceChange(db, {
    roomId,
    characterId: patch.characterId,
    actorType,
    actorId,
    changeType: 'resource_patch',
    path: patch.path,
    before: patch.before,
    after: patch.after,
    reason: patch.reason || '',
    ruleRefs: patch.ruleRefs || [],
  });

  return resources;
}

export function shortRest(
  db: AppDatabase,
  characterId: string,
  opts?: {
    roomId?: string;
    actorType?: string;
    actorId?: string;
    hitDiceSpent?: number;
    rollFn?: RollFn;
  }
): CharacterResources {
  const rollFn = opts?.rollFn ?? defaultRoll;
  const sheet = loadSheetJson(db, characterId);
  const resources = (sheet.resources as CharacterResources) || getDefaultResources(sheet);

  const remaining = resources.hitDice.remaining;
  if (remaining <= 0) {
    // Nothing to do, still return resources
    return resources;
  }

  const hitDieInfo = getHitDieForClass(sheet.className as string || 'Fighter');
  const conMod = Math.floor((((sheet.abilityScores as Record<string, number>)?.con || 10) - 10) / 2);

  const diceToUse = opts?.hitDiceSpent != null
    ? Math.min(remaining, opts.hitDiceSpent)
    : Math.min(remaining, resources.hitDice.total);

  let totalHealed = 0;
  for (let i = 0; i < diceToUse; i++) {
    const roll = rollFn(hitDieInfo.sides);
    totalHealed += Math.max(1, roll + conMod); // minimum 1 HP per die
  }

  const hpBefore = resources.hitPoints.current;
  const hdRemainingBefore = resources.hitDice.remaining;
  const newHp = Math.min(hpBefore + totalHealed, resources.hitPoints.max);
  resources.hitPoints.current = newHp;
  resources.hitDice.remaining = remaining - diceToUse;

  sheet.resources = resources;
  saveSheetJson(db, characterId, sheet);

  // Record changes if room context provided
  if (opts?.roomId) {
    recordResourceChange(db, {
      roomId: opts.roomId,
      characterId,
      actorType: opts.actorType ?? 'system',
      actorId: opts.actorId ?? '',
      changeType: 'short_rest',
      path: 'hitPoints.current',
      before: hpBefore,
      after: newHp,
      reason: `Short rest: spent ${diceToUse} hit dice, healed ${newHp - hpBefore} HP`,
      ruleRefs: [],
    });
    recordResourceChange(db, {
      roomId: opts.roomId,
      characterId,
      actorType: opts.actorType ?? 'system',
      actorId: opts.actorId ?? '',
      changeType: 'short_rest',
      path: 'hitDice.remaining',
      before: hdRemainingBefore,
      after: resources.hitDice.remaining,
      reason: `Short rest: spent ${diceToUse} hit dice`,
      ruleRefs: [],
    });
  }

  return resources;
}

export function longRest(
  db: AppDatabase,
  characterId: string,
  opts?: {
    roomId?: string;
    actorType?: string;
    actorId?: string;
  }
): CharacterResources {
  const sheet = loadSheetJson(db, characterId);
  const resources = (sheet.resources as CharacterResources) || getDefaultResources(sheet);

  const hpBefore = resources.hitPoints.current;
  const hdRemainingBefore = resources.hitDice.remaining;

  // Fully restore HP
  resources.hitPoints.current = resources.hitPoints.max;

  // Restore half of total hit dice (minimum 1)
  const halfHd = Math.max(1, Math.floor(resources.hitDice.total / 2));
  resources.hitDice.remaining = Math.min(resources.hitDice.remaining + halfHd, resources.hitDice.total);

  // Restore all spell slots
  for (const level of Object.keys(resources.spellSlots)) {
    const slot = resources.spellSlots[level];
    if (slot) {
      slot.used = 0;
    }
  }

  sheet.resources = resources;
  saveSheetJson(db, characterId, sheet);

  // Record changes if room context provided
  if (opts?.roomId) {
    recordResourceChange(db, {
      roomId: opts.roomId,
      characterId,
      actorType: opts.actorType ?? 'system',
      actorId: opts.actorId ?? '',
      changeType: 'long_rest',
      path: 'hitPoints.current',
      before: hpBefore,
      after: resources.hitPoints.current,
      reason: 'Long rest: fully restored HP',
      ruleRefs: [],
    });
    recordResourceChange(db, {
      roomId: opts.roomId,
      characterId,
      actorType: opts.actorType ?? 'system',
      actorId: opts.actorId ?? '',
      changeType: 'long_rest',
      path: 'hitDice.remaining',
      before: hdRemainingBefore,
      after: resources.hitDice.remaining,
      reason: `Long rest: recovered ${resources.hitDice.remaining - hdRemainingBefore} hit dice`,
      ruleRefs: [],
    });
  }

  return resources;
}
