import { abilityCheck, abilityModifier } from './diceService.js';

export interface SkillCheckResult {
  success: boolean;
  criticalSuccess: boolean;
  criticalFail: boolean;
  roll: number;
  total: number;
  dc: number;
  description: string;
}

export function skillCheck(score: number, dc: number, proficiency = 0, advantage?: 'advantage'|'disadvantage'|null): SkillCheckResult {
  const result = abilityCheck(score, dc, proficiency, advantage);
  return {
    success: result.success,
    criticalSuccess: result.natural20,
    criticalFail: result.natural1,
    roll: result.roll,
    total: result.total,
    dc,
    description: result.success
      ? (result.natural20 ? '大成功！' : '检定成功。')
      : (result.natural1 ? '大失败！' : `检定失败（DC ${dc}）。`)
  };
}

export function stealthCheck(dexScore: number, proficiency = 0, advantage?: 'advantage'|'disadvantage'|null): SkillCheckResult {
  return skillCheck(dexScore, 12, proficiency, advantage);
}

export function perceptionCheck(wisScore: number, proficiency = 0): SkillCheckResult {
  return skillCheck(wisScore, 12, proficiency);
}

export function investigationCheck(intScore: number, proficiency = 0, dc = 13): SkillCheckResult {
  return skillCheck(intScore, dc, proficiency);
}

export function lockpick(dexScore: number, proficiency = 0, dc = 15): SkillCheckResult {
  return skillCheck(dexScore, dc, proficiency);
}

export function disarmTrap(dexScore: number, proficiency = 0, dc = 15): SkillCheckResult {
  return skillCheck(dexScore, dc, proficiency);
}

export function trackTarget(wisScore: number, proficiency = 0, dc = 13): SkillCheckResult {
  return skillCheck(wisScore, dc, proficiency);
}

export function solvePuzzle(intScore: number, dc = 12): SkillCheckResult {
  return skillCheck(intScore, dc, 0);
}
