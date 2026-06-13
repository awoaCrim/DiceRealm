import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { createResourceImportJob, reviewResourceImportDraft } from '../services/resourceReviewService.js';
import {
  auditCharacterBuilderDraft,
  buildCharacterSheetFromDraft,
  listCharacterBuilderOptions,
  normalizeCharacterBuilderDraft,
} from '../services/characterBuilderService.js';

function seedOptions(db: ReturnType<typeof createMemoryDb>) {
  const result = createResourceImportJob(db, {
    name: 'Builder 选项种子',
    drafts: [
      { kind: 'character_option', optionType: 'species', title: '人类', summary: '最常见的人类种族。' },
      { kind: 'character_option', optionType: 'subspecies', title: '变体人类', summary: '更灵活的人类变体。' },
      { kind: 'character_option', optionType: 'class', title: '战士', summary: '擅长武器与护甲的武技专家。' },
      { kind: 'character_option', optionType: 'background', title: '士兵', summary: '曾在军队服役。' },
      { kind: 'character_option', optionType: 'skill', title: 'Athletics', summary: '运动技能。' },
      { kind: 'character_option', optionType: 'equipment', title: '长剑', summary: '一把标准的剑。' },
      { kind: 'character_option', optionType: 'equipment', title: '圣武士圣徽', summary: '只适合圣武士的圣徽。', prerequisites: { classNames: ['圣武士'] } },
      { kind: 'character_option', optionType: 'language', title: '通用语', summary: '常见语言。' },
      { kind: 'character_option', optionType: 'proficiency', title: '盾牌熟练', summary: '盾牌熟练项。' },
      { kind: 'rule_entry', title: '不应出现在角色选项', summary: '这条规则不应该出现在角色选项中。' },
    ]
  });

  for (const draft of result.drafts) {
    if (draft.kind === 'character_option') {
      reviewResourceImportDraft(db, draft.id, { status: 'approved' });
    }
  }
}

describe('characterBuilderService', () => {
  it('lists built-in starter options when no resource import has been approved', () => {
    const db = createMemoryDb();
    migrate(db);

    try {
      const options = listCharacterBuilderOptions(db);

      expect(options.species.map((option) => option.name)).toContain('人类');
      expect(options.subSpecies.map((option) => option.name)).toEqual(expect.arrayContaining(['变体人类', '丘陵矮人', '高等精灵']));
      expect(options.classes.map((option) => option.name)).toEqual(expect.arrayContaining(['战士', '法师', '牧师']));
      expect(options.backgrounds.map((option) => option.name)).toContain('士兵');
      expect(options.skills.map((option) => option.name)).toEqual(expect.arrayContaining(['运动', '察觉', '说服']));
      expect(options.equipment.map((option) => option.name)).toEqual(expect.arrayContaining(['长剑', '盾牌', '冒险者套组']));
      expect(options.spells.map((option) => option.name)).toEqual(expect.arrayContaining(['光亮术', '魔法飞弹', '治疗伤口']));
      expect(options.languages.map((option) => option.name)).toContain('通用语');
      expect(options.proficiencies.map((option) => option.name)).toContain('盾牌熟练');
      expect(options.equipment.find((option) => option.name === '长剑')?.ruleData).toMatchObject({ damage: '1d8', damageType: '挥砍' });
      expect(options.equipment.find((option) => option.name === '盾牌')?.ruleData).toMatchObject({ acBonus: 2 });
      expect(options.spells.find((option) => option.name === '侦测魔法')?.ruleData).toMatchObject({ level: 1, ritual: true });
      expect(options.skills.find((option) => option.name === '运动')?.ruleData).toMatchObject({ ability: '力量' });
      expect(options.classes.find((option) => option.name === '战士')?.ruleData).toMatchObject({ hitDie: 'd10' });
    } finally {
      db.close();
    }
  });

  it('merges approved character options with built-in starter options grouped by option type', () => {
    const db = createMemoryDb();
    migrate(db);

    try {
      seedOptions(db);
      const options = listCharacterBuilderOptions(db);

      expect(options.species.map((option) => option.name)).toContain('人类');
      expect(options.species.filter((option) => option.name === '人类')).toHaveLength(1);
      expect(options.subSpecies.map((option) => option.name)).toContain('变体人类');
      expect(options.subSpecies.filter((option) => option.name === '变体人类')).toHaveLength(1);

      expect(options.classes.map((option) => option.name)).toContain('战士');
      expect(options.classes.filter((option) => option.name === '战士')).toHaveLength(1);

      expect(options.backgrounds.map((option) => option.name)).toContain('士兵');
      expect(options.backgrounds.filter((option) => option.name === '士兵')).toHaveLength(1);

      expect(options.skills.map((option) => option.name)).toEqual(expect.arrayContaining(['Athletics', '运动']));

      expect(options.equipment.map((option) => option.name)).toContain('长剑');
      expect(options.equipment.filter((option) => option.name === '长剑')).toHaveLength(1);

      expect(options.spells.length).toBeGreaterThan(0);
      expect(options.languages.map((option) => option.name)).toContain('通用语');
      expect(options.languages.filter((option) => option.name === '通用语')).toHaveLength(1);
      expect(options.proficiencies.map((option) => option.name)).toContain('盾牌熟练');
      expect(options.proficiencies.filter((option) => option.name === '盾牌熟练')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('audits missing required level-1 builder fields', () => {
    const draft = normalizeCharacterBuilderDraft({ name: '洛林', concept: '前士兵' });
    const audit = auditCharacterBuilderDraft(draft);

    expect(audit.valid).toBe(false);
    const fieldNames = audit.issues.map((issue) => issue.field);
    expect(fieldNames).toEqual(['species', 'className', 'background', 'abilityScores', 'skills', 'equipment']);
    expect(audit.warnings).toEqual([]);
  });

  it('blocks directory choices that conflict with selected upstream options', () => {
    const draft = normalizeCharacterBuilderDraft({
      name: '米拉',
      species: '精灵',
      subSpecies: '变体人类',
      className: '战士',
      background: '士兵',
      abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
      skills: ['运动'],
      equipment: ['长剑'],
      spells: ['魔法飞弹'],
    });

    const audit = auditCharacterBuilderDraft(draft);

    expect(audit.valid).toBe(false);
    expect(audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'subSpecies', message: expect.stringContaining('仅适用于：人类') }),
      expect.objectContaining({ field: 'spells', message: expect.stringContaining('仅适用于职业') }),
    ]));
  });

  it('warns about custom choices without blocking an otherwise valid draft', () => {
    const draft = normalizeCharacterBuilderDraft({
      name: '星图师',
      species: '人类',
      subSpecies: '星裔血统',
      className: '战士',
      background: '士兵',
      abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
      skills: ['运动'],
      equipment: ['黄铜罗盘'],
      spells: ['星光术'],
    });

    const audit = auditCharacterBuilderDraft(draft);

    expect(audit.valid).toBe(true);
    expect(audit.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'subSpecies', message: expect.stringContaining('DM 复核') }),
      expect.objectContaining({ field: 'equipment', message: expect.stringContaining('DM 复核') }),
      expect.objectContaining({ field: 'spells', message: expect.stringContaining('DM 复核') }),
    ]));
  });

  it('applies prerequisites from approved imported options', () => {
    const db = createMemoryDb();
    migrate(db);

    try {
      seedOptions(db);
      const options = listCharacterBuilderOptions(db);
      const draft = normalizeCharacterBuilderDraft({
        name: '洛林',
        species: '人类',
        subSpecies: '变体人类',
        className: '战士',
        background: '士兵',
        abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
        skills: ['运动'],
        equipment: ['圣武士圣徽'],
      });

      const audit = auditCharacterBuilderDraft(draft, options);

      expect(audit.valid).toBe(false);
      expect(audit.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'equipment', message: expect.stringContaining('仅适用于职业：圣武士') }),
      ]));
    } finally {
      db.close();
    }
  });

  it('builds a confirmed level-1 character sheet from a valid draft', () => {
    const draft = normalizeCharacterBuilderDraft({
      name: '洛林',
      species: '人类',
      subSpecies: '变体人类',
      className: '战士',
      classDetail: '防御战斗风格',
      background: '士兵',
      abilityScores: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
      skills: ['Athletics', '察觉'],
      equipment: ['长剑', '盾牌'],
      spells: [],
      languages: ['通用语'],
      proficiencies: ['盾牌熟练'],
      personality: '勇敢',
      ideal: '荣耀',
      bond: '保护队友',
      flaw: '鲁莽',
    });

    const audit = auditCharacterBuilderDraft(draft);
    expect(audit.valid).toBe(true);

    const sheet = buildCharacterSheetFromDraft(draft);

    expect(sheet.name).toBe('洛林');
    expect(sheet.species).toBe('人类');
    expect(sheet.subSpecies).toBe('变体人类');
    expect(sheet.className).toBe('战士');
    expect(sheet.classDetail).toBe('防御战斗风格');
    expect(sheet.level).toBe(1);
    expect(sheet.background).toBe('士兵');
    expect(sheet.hitPoints).toBeDefined();
    expect(sheet.hitPoints.current).toBe(sheet.hitPoints.max);
    expect(sheet.armorClass).toBeDefined();
    expect(sheet.proficiencyBonus).toBe(2);
    expect(sheet.skills).toEqual(['Athletics', '察觉']);
    expect(sheet.equipment).toEqual(['长剑', '盾牌']);
    expect(sheet.spells).toEqual([]);
    expect(sheet.languages).toEqual(['通用语']);
    expect(sheet.proficiencies).toEqual(['盾牌熟练']);
  });
});

