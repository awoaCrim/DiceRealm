import { abilityCheck } from './diceService.js';

export type NpcAttitude = 'hostile' | 'unfriendly' | 'neutral' | 'friendly' | 'allied';

export function attitudeModifier(attitude: NpcAttitude): number {
  const mods: Record<NpcAttitude, number> = { hostile: 5, unfriendly: 2, neutral: 0, friendly: -2, allied: -5 };
  return mods[attitude];
}

export function socialCheck(skill: string, chaScore: number, attitude: NpcAttitude, dc: number, proficiency = 0): { success: boolean; total: number; dc: number; adjustedDc: number; resultText: string } {
  const adjustedDc = dc + attitudeModifier(attitude);
  const result = abilityCheck(chaScore, adjustedDc, proficiency);
  const attitudeText = attitude === 'friendly' || attitude === 'allied' ? '对方态度友善，DC降低。' : attitude === 'hostile' || attitude === 'unfriendly' ? '对方态度不佳，DC提高。' : '';
  return {
    success: result.success,
    total: result.total,
    dc: adjustedDc,
    adjustedDc,
    resultText: result.success ? `说服成功。${attitudeText}` : `说服失败。${attitudeText}`
  };
}

export function persuade(chaScore: number, attitude: NpcAttitude, dc = 15, proficiency = 0) {
  return socialCheck('persuasion', chaScore, attitude, dc, proficiency);
}

export function deceive(chaScore: number, attitude: NpcAttitude, dc = 15, proficiency = 0) {
  return socialCheck('deception', chaScore, attitude, dc, proficiency);
}

export function intimidate(chaScore: number, attitude: NpcAttitude, dc = 15, proficiency = 0) {
  return socialCheck('intimidation', chaScore, attitude, dc + 2, proficiency); // harder
}

export function haggle(chaScore: number, attitude: NpcAttitude, basePrice: number, proficiency = 0) {
  const result = socialCheck('persuasion', chaScore, attitude, 15, proficiency);
  const discount = result.success ? Math.floor(basePrice * 0.2) : 0;
  return { ...result, basePrice, finalPrice: basePrice - discount, discount };
}

export function negotiate(chaScore: number, attitude: NpcAttitude, proficiency = 0) {
  // complex: need 2 of 3 checks
  const check1 = abilityCheck(chaScore, 12 + attitudeModifier(attitude), proficiency);
  const check2 = abilityCheck(chaScore, 14 + attitudeModifier(attitude), proficiency);
  const check3 = abilityCheck(chaScore, 16 + attitudeModifier(attitude), proficiency);
  const passes = [check1, check2, check3].filter(c => c.success).length;
  return { success: passes >= 2, passes, totalChecks: 3, resultText: passes >= 2 ? '谈判成功。' : `谈判破裂（通过 ${passes}/3 次检定）。` };
}
