import { createHash } from 'node:crypto';
import { rollPlanSchema, type AdvantageState, type RollPlan } from '@dnd/contracts';
import { AppError } from '../../platform/http/AppError.js';

export interface DiceRollResult {
  rawDice: number[];
  selectedDice: number[];
  total: number;
}

export type RollPlanInput = Omit<RollPlan, 'planHash' | 'lockedAt'> & {
  lockedAt?: string;
};

/**
 * The only random source used by formal server rolls. Tests inject a
 * deterministic function; Provider output never reaches this class.
 */
export class DiceService {
  constructor(private readonly random: () => number = Math.random) {}

  rollExpression(expression: string, advantageState: AdvantageState = 'normal'): DiceRollResult {
    const parsed = parseDiceExpression(expression);
    if (advantageState !== 'normal' && expression !== '1d20') {
      throw new AppError('VALIDATION_ERROR', '优势/劣势只适用于单次 d20。');
    }
    const count = advantageState === 'normal' ? parsed.count : 2;
    const rawDice = Array.from({ length: count }, () => this.rollDie(parsed.sides));
    const selectedDice = advantageState === 'advantage'
      ? [Math.max(...rawDice)]
      : advantageState === 'disadvantage'
        ? [Math.min(...rawDice)]
        : rawDice;
    return {
      rawDice,
      selectedDice,
      total: selectedDice.reduce((sum, value) => sum + value, 0),
    };
  }

  rollD20(advantageState: AdvantageState = 'normal'): DiceRollResult {
    return this.rollExpression('1d20', advantageState);
  }

  /**
   * Create and hash a plan before any random source is read. The hash covers
   * the server-owned rules and target inputs, but not the lock timestamp or
   * the hash field itself.
   */
  lockPlan(input: RollPlanInput, lockedAt = new Date().toISOString()): RollPlan {
    const { lockedAt: _ignored, ...hashInput } = input;
    const planHash = hashRollPlan(hashInput);
    return rollPlanSchema.parse({ ...input, planHash, lockedAt });
  }

  private rollDie(sides: number): number {
    const random = this.random();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw new AppError('INTERNAL_ERROR', '服务端随机源无效。');
    }
    return Math.floor(random * sides) + 1;
  }
}

export function parseDiceExpression(expression: string): { count: number; sides: number } {
  const match = /^(?<count>[1-9]|1[0-9]|20)d(?<sides>4|6|8|10|12|20|100)$/.exec(expression);
  if (!match?.groups) {
    throw new AppError('VALIDATION_ERROR', '骰子表达式不在服务端允许范围内。');
  }
  return { count: Number(match.groups.count), sides: Number(match.groups.sides) };
}

export function hashRollPlan(plan: Omit<RollPlan, 'planHash' | 'lockedAt'>): string {
  const canonical = stableJson(plan);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
