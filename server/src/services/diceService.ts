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

function rollSingle(die: number): number {
  return Math.floor(Math.random() * die) + 1;
}

export function rollDice(die: string, count = 1): DiceResult {
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
  const vals = Array.from({ length: count }, () => rollSingle(sides));
  return {
    values: vals,
    total: vals.reduce((a, b) => a + b, 0)
  };
}

export function rollD20(
  advantage?: 'advantage' | 'disadvantage' | null
): D20Result {
  const r1 = rollSingle(20);
  if (!advantage) {
    return { value: r1, natural: r1, advantage: null };
  }
  const r2 = rollSingle(20);
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
  advantage?: 'advantage' | 'disadvantage' | null
): AbilityCheckResult {
  const { value: roll, natural, advantage: adv } = rollD20(advantage);
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
  advantage?: 'advantage' | 'disadvantage' | null
): AttackRollResult {
  const { value: roll, natural } = rollD20(advantage);
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
  modifier = 0
): DamageRollResult {
  const { values } = rollDice(die, count);
  return {
    values,
    total: values.reduce((a, b) => a + b, 0) + modifier,
    modifier
  };
}
