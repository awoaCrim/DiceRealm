import { describe, expect, it } from 'vitest';
import type { CharacterSheet } from '../domain/types.js';
import { buildFiveERulesSummary } from '../services/fiveERulesService.js';

function fighterSheet(): CharacterSheet {
  return {
    name: '洛林',
    species: '人类',
    subSpecies: '标准人类',
    className: '战士',
    classDetail: '防御型战士',
    level: 3,
    abilityScores: { str: 16, dex: 13, con: 15, int: 10, wis: 12, cha: 8 },
    hitPoints: { current: 28, max: 28 },
    armorClass: 18,
    proficiencyBonus: 2,
    skills: ['运动', '察觉'],
    equipment: ['长剑', '盾牌'],
    spells: [],
    languages: [],
    proficiencies: [],
    privateNotes: ''
  };
}

describe('buildFiveERulesSummary', () => {
  it('derives 5e action economy, saves, skills, and combat actions from a character sheet', () => {
    const rules = buildFiveERulesSummary({ sheet: fighterSheet(), confirmed: true });

    expect(rules?.ruleset).toBe('5e-2014');
    expect(rules?.actionEconomy).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '动作', value: '1 / 轮' }),
      expect.objectContaining({ title: '移动', value: '30 尺 / 轮' }),
      expect.objectContaining({ title: '专注', value: '最多 1 个' })
    ]));
    expect(rules?.savingThrows).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'str', label: '力量', modifier: '+5', proficient: true }),
      expect.objectContaining({ key: 'con', label: '体质', modifier: '+4', proficient: true })
    ]));
    expect(rules?.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'athletics', label: '运动', modifier: '+5', proficient: true }),
      expect.objectContaining({ key: 'perception', label: '察觉', modifier: '+3', proficient: true })
    ]));
    expect(rules?.availableActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'main-hand-weapon', title: '主手武器攻击', tags: expect.arrayContaining(['攻击 +5', '伤害 1d8+3 挥砍']) }),
      expect.objectContaining({ id: 'dash', title: '疾走' }),
      expect.objectContaining({ id: 'opportunity-attack', title: '借机攻击', timing: '反应' })
    ]));
  });

  it('does not expose rules for unconfirmed characters', () => {
    expect(buildFiveERulesSummary({ sheet: fighterSheet(), confirmed: false })).toBeUndefined();
    expect(buildFiveERulesSummary(null)).toBeUndefined();
  });
});
