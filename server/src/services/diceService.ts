export interface DiceResult {
  values: number[];
  total: number;
}

export interface D20Result {
  value: number;
  natural: number;
  advantage: 'advantage' | 'disadvantage' | null;
}

export interface AbilityCheckResult {
  roll: number;
  natural: number;
  total: number;
  modifier: number;
  proficiency: number;
  success: boolean;
  natural20: boolean;
  natural1: boolean;
  advantage: 'advantage' | 'disadvantage' | null;
}

export interface AttackRollResult {
  roll: number;
  natural: number;
  total: number;
  modifier: number;
  proficiency: number;
  ac: number;
  hit: boolean;
  criticalHit: boolean;
  criticalMiss: boolean;
}

export interface DamageRollResult {
  values: number[];
  total: number;
  modifier: number;
}

export type RandomSource = () => number;

export interface RollOptions {
  rng?: RandomSource;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createSeededRng(seed: string): RandomSource {
  let state = hashSeed(seed) || 0x9e3779b9;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function rollSingle(die: number, rng: RandomSource = Math.random): number {
  return Math.floor(rng() * die) + 1;
}

export function rollDice(die: string, count = 1, options: RollOptions = {}): DiceResult {
  const max: Record<string, number> = {
    d4: 4,
    d6: 6,
    d8: 8,
    d10: 10,
    d12: 12,
    d20: 20,
    d100: 100
  };
  const sides = max[die] ?? 6;
  const vals = Array.from({ length: count }, () => rollSingle(sides, options.rng));
  return {
    values: vals,
    total: vals.reduce((a, b) => a + b, 0)
  };
}

export function rollD20(
  advantage?: 'advantage' | 'disadvantage' | null,
  options: RollOptions = {}
): D20Result {
  const r1 = rollSingle(20, options.rng);
  if (!advantage) {
    return { value: r1, natural: r1, advantage: null };
  }
  const r2 = rollSingle(20, options.rng);
  return advantage === 'advantage'
    ? { value: Math.max(r1, r2), natural: r1, advantage: 'advantage' }
    : { value: Math.min(r1, r2), natural: r1, advantage: 'disadvantage' };
}

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function abilityCheck(
  score: number,
  dc: number,
  proficiency = 0,
  advantage?: 'advantage' | 'disadvantage' | null,
  options: RollOptions = {}
): AbilityCheckResult {
  const { value: roll, natural, advantage: adv } = rollD20(advantage, options);
  const mod = abilityModifier(score);
  const total = roll + mod + proficiency;
  const natural20 = natural === 20;
  const natural1 = natural === 1;
  return {
    roll,
    natural,
    total,
    modifier: mod,
    proficiency,
    success: natural20 || (!natural1 && total >= dc),
    natural20,
    natural1,
    advantage: adv
  };
}

export function attackRoll(
  modifier: number,
  proficiency: number,
  ac: number,
  advantage?: 'advantage' | 'disadvantage' | null,
  options: RollOptions = {}
): AttackRollResult {
  const { value: roll, natural } = rollD20(advantage, options);
  const total = roll + modifier + proficiency;
  const natural20 = natural === 20;
  const natural1 = natural === 1;
  return {
    roll,
    natural,
    total,
    modifier,
    proficiency,
    ac,
    hit: natural20 || (!natural1 && total >= ac),
    criticalHit: natural20,
    criticalMiss: natural1
  };
}

export function damageRoll(
  die: string,
  count: number,
  modifier = 0,
  options: RollOptions = {}
): DamageRollResult {
  const { values } = rollDice(die, count, options);
  return {
    values,
    total: values.reduce((a, b) => a + b, 0) + modifier,
    modifier
  };
}
