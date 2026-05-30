import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  rollDice,
  rollD20,
  abilityCheck,
  attackRoll,
  damageRoll,
  abilityModifier
} from '../services/diceService.js';

describe('rollDice', () => {
  it('returns array of specified count and total in valid range', () => {
    // With Math.random=0.5, rollSingle(6) = floor(0.5*6)+1 = 4
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const result = rollDice('d6', 3);
    expect(result.values).toHaveLength(3);
    expect(result.values).toEqual([4, 4, 4]);
    expect(result.total).toBe(12);
    expect(result.total).toBeGreaterThanOrEqual(3);
    expect(result.total).toBeLessThanOrEqual(18);
    vi.restoreAllMocks();
  });

  it('defaults to 1 die when count not provided', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = rollDice('d8');
    expect(result.values).toHaveLength(1);
    expect(result.values[0]).toBeGreaterThanOrEqual(1);
    expect(result.values[0]).toBeLessThanOrEqual(8);
    vi.restoreAllMocks();
  });
});

describe('rollD20', () => {
  it('returns a single value with no advantage', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // roll = 11
    const result = rollD20();
    expect(result.value).toBe(11);
    expect(result.natural).toBe(11);
    expect(result.advantage).toBeNull();
    vi.restoreAllMocks();
  });

  it('with advantage returns max of two rolls', () => {
    // First call to Math.random: 0.1 → roll=3, second call: 0.9 → roll=19
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.9);
    const result = rollD20('advantage');
    expect(result.value).toBe(19);
    expect(result.advantage).toBe('advantage');
    // Math.max was used: value is the max of the two
    vi.restoreAllMocks();
  });

  it('with disadvantage returns min of two rolls', () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)  // roll=3
      .mockReturnValueOnce(0.9); // roll=19
    const result = rollD20('disadvantage');
    expect(result.value).toBe(3);
    expect(result.advantage).toBe('disadvantage');
    // Math.min was used: value is the min of the two
    vi.restoreAllMocks();
  });
});

describe('abilityModifier', () => {
  it('returns 0 for score 10', () => {
    expect(abilityModifier(10)).toBe(0);
  });

  it('returns 2 for score 14', () => {
    expect(abilityModifier(14)).toBe(2);
  });

  it('returns -1 for score 8', () => {
    expect(abilityModifier(8)).toBe(-1);
  });

  it('returns -5 for score 1', () => {
    expect(abilityModifier(1)).toBe(-5);
  });
});

describe('abilityCheck', () => {
  it('computes total = roll + mod + proficiency for score 14 with proficiency 2', () => {
    // Math.random returns 0.5 → roll=11
    // mod = floor((14-10)/2) = 2
    // total = 11 + 2 + 2 = 15
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const result = abilityCheck(14, 15, 2);
    expect(result.roll).toBe(11);
    expect(result.modifier).toBe(2);
    expect(result.proficiency).toBe(2);
    expect(result.total).toBe(15);
    expect(result.success).toBe(true); // 15 >= 15
    expect(result.natural20).toBe(false);
    expect(result.natural1).toBe(false);
    vi.restoreAllMocks();
  });

  it('natural20 is critical success regardless of DC', () => {
    // Math.random returns (19/20) = 0.95 → roll=20 (natural20)
    vi.spyOn(Math, 'random').mockReturnValue(19 / 20);
    const result = abilityCheck(10, 99, 0); // impossible DC
    expect(result.natural).toBe(20);
    expect(result.natural20).toBe(true);
    expect(result.success).toBe(true); // natural20 always succeeds
    vi.restoreAllMocks();
  });

  it('natural1 fails regardless of modifiers', () => {
    // Math.random returns 0 → roll=1
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = abilityCheck(30, 5, 10); // huge mods, trivial DC
    expect(result.natural).toBe(1);
    expect(result.natural1).toBe(true);
    expect(result.success).toBe(false); // natural1 always fails
    vi.restoreAllMocks();
  });
});

describe('attackRoll', () => {
  it('hit when total >= AC', () => {
    // Math.random returns 0.5 → roll=11
    // total = 11 + 3 + 2 = 16
    // AC = 16 → hit
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const result = attackRoll(3, 2, 16);
    expect(result.roll).toBe(11);
    expect(result.total).toBe(16);
    expect(result.hit).toBe(true);
    expect(result.criticalHit).toBe(false);
    expect(result.criticalMiss).toBe(false);
    vi.restoreAllMocks();
  });

  it('miss when total < AC', () => {
    // Math.random returns 0 → roll=1
    // total = 1 + 3 + 2 = 6
    // AC = 16 → miss (but not critical miss since natural != 1 when mocking)
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // roll=3
    const result = attackRoll(3, 2, 16);
    expect(result.total).toBeLessThan(16);
    expect(result.hit).toBe(false);
    vi.restoreAllMocks();
  });

  it('natural20 is criticalHit and always hits', () => {
    vi.spyOn(Math, 'random').mockReturnValue(19 / 20); // roll=20
    const result = attackRoll(0, 0, 99);
    expect(result.natural).toBe(20);
    expect(result.criticalHit).toBe(true);
    expect(result.hit).toBe(true);
    vi.restoreAllMocks();
  });

  it('natural1 is criticalMiss and never hits', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // roll=1
    const result = attackRoll(10, 10, 1); // total would be 21, AC=1
    expect(result.natural).toBe(1);
    expect(result.criticalMiss).toBe(true);
    expect(result.hit).toBe(false);
    vi.restoreAllMocks();
  });
});

describe('damageRoll', () => {
  it('computes values and total with modifier', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // d8 gives 5
    const result = damageRoll('d8', 2, 3);
    expect(result.values).toHaveLength(2);
    expect(result.values).toEqual([5, 5]);
    expect(result.total).toBe(13); // 5+5+3
    expect(result.modifier).toBe(3);
    vi.restoreAllMocks();
  });

  it('defaults modifier to 0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // d6 gives 1
    const result = damageRoll('d6', 1);
    expect(result.values).toEqual([1]);
    expect(result.total).toBe(1); // 1+0
    expect(result.modifier).toBe(0);
    vi.restoreAllMocks();
  });
});
