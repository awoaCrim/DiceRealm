import type { AppDatabase } from '../db/connection.js';
import type {
  CharacterBuilderAudit,
  CharacterBuilderAuditIssue,
  CharacterBuilderDraft,
  CharacterBuilderOption,
  CharacterBuilderOptions,
  CharacterSheet,
} from '../domain/types.js';

function parseJsonValue(json: string, context: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function builtinOption(optionType: CharacterBuilderOption['optionType'], name: string, summary: string): CharacterBuilderOption {
  return {
    id: `builtin-${optionType}-${name}`,
    optionType,
    name,
    summary,
    ruleData: {},
    prerequisites: {},
    sourceRef: '5e 基础建卡选项',
  };
}

const builtinCharacterBuilderOptions: CharacterBuilderOption[] = [
  ...['人类', '矮人', '精灵', '半身人', '龙裔', '侏儒', '半精灵', '半兽人', '提夫林']
    .map((name) => builtinOption('species', name, '常见 5e 玩家角色物种。')),
  ...['野蛮人', '吟游诗人', '牧师', '德鲁伊', '战士', '武僧', '圣武士', '游侠', '游荡者', '术士', '邪术师', '法师']
    .map((name) => builtinOption('class', name, '常见 5e 一级职业选项。')),
  ...['侍僧', '罪犯', '民间英雄', '贵族', '贤者', '士兵', '水手', '隐士', '艺人', '公会工匠', '流浪儿', '化外之民']
    .map((name) => builtinOption('background', name, '常见 5e 角色背景。')),
  ...['运动', '体操', '巧手', '隐匿', '奥秘', '历史', '调查', '自然', '宗教', '驯兽', '洞察', '医药', '察觉', '求生', '欺瞒', '威吓', '表演', '说服']
    .map((name) => builtinOption('skill', name, '常见 5e 技能熟练项。')),
  ...['匕首', '长剑', '巨剑', '短弓', '长弓', '轻弩', '法杖', '盾牌', '皮甲', '链甲', '鳞甲', '冒险者套组', '探索者套组', '学者套组', '圣徽', '奥术法器', '盗贼工具', '治疗包']
    .map((name) => builtinOption('equipment', name, '常见 5e 初始装备候选。')),
  ...['光亮术', '法师之手', '火焰箭', '冷冻射线', '魔法飞弹', '护盾术', '治疗伤口', '祝福术', '妖火', '猎人印记', '魅惑人类', '侦测魔法', '睡眠术', '雷鸣波', '治愈真言']
    .map((name) => builtinOption('spell', name, '常见 5e 低环法术或戏法候选。')),
  ...['通用语', '矮人语', '精灵语', '巨人语', '侏儒语', '地精语', '半身人语', '兽人语', '龙语', '炼狱语', '天界语', '深渊语', '地下通用语']
    .map((name) => builtinOption('language', name, '常见 5e 语言候选。')),
  ...['简易武器熟练', '军用武器熟练', '轻甲熟练', '中甲熟练', '重甲熟练', '盾牌熟练', '盗贼工具熟练', '草药工具熟练', '乐器熟练', '工匠工具熟练', '游戏用具熟练']
    .map((name) => builtinOption('proficiency', name, '常见工具、武器或护甲熟练候选。')),
];

function mergeOptionsWithBuiltins(importedOptions: CharacterBuilderOption[]): CharacterBuilderOption[] {
  const byTypeAndName = new Map<string, CharacterBuilderOption>();
  for (const option of builtinCharacterBuilderOptions) {
    byTypeAndName.set(`${option.optionType}:${option.name}`, option);
  }
  for (const option of importedOptions) {
    byTypeAndName.set(`${option.optionType}:${option.name}`, option);
  }
  return [...byTypeAndName.values()].sort((a, b) => {
    const typeCompare = a.optionType.localeCompare(b.optionType, 'zh-CN');
    return typeCompare || a.name.localeCompare(b.name, 'zh-CN');
  });
}

export function listCharacterBuilderOptions(db: AppDatabase): CharacterBuilderOptions {
  const rows = db.prepare(`
    SELECT id, option_type as optionType, name, summary,
      rule_data_json as ruleDataJson, prerequisites_json as prerequisitesJson,
      source_ref as sourceRef
    FROM character_options
    ORDER BY option_type ASC, name ASC
  `).all() as Array<{
    id: string;
    optionType: string;
    name: string;
    summary: string;
    ruleDataJson: string;
    prerequisitesJson: string;
    sourceRef: string;
  }>;

  const importedOptions: CharacterBuilderOption[] = rows.map((row) => ({
    id: row.id,
    optionType: row.optionType as CharacterBuilderOption['optionType'],
    name: row.name,
    summary: row.summary,
    ruleData: parseJsonValue(row.ruleDataJson, `ruleData for ${row.id}`),
    prerequisites: parseJsonValue(row.prerequisitesJson, `prerequisites for ${row.id}`),
    sourceRef: row.sourceRef,
  }));
  const options = mergeOptionsWithBuiltins(importedOptions);

  return {
    species: options.filter((o) => o.optionType === 'species'),
    classes: options.filter((o) => o.optionType === 'class'),
    backgrounds: options.filter((o) => o.optionType === 'background'),
    skills: options.filter((o) => o.optionType === 'skill'),
    equipment: options.filter((o) => o.optionType === 'equipment'),
    spells: options.filter((o) => o.optionType === 'spell'),
    languages: options.filter((o) => o.optionType === 'language'),
    proficiencies: options.filter((o) => o.optionType === 'proficiency'),
  };
}

function normalizeScores(input: unknown): Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', number> {
  const defaults: Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', number> = {
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
  };

  if (typeof input !== 'object' || input === null) return { ...defaults };

  const raw = input as Record<string, unknown>;
  const keys = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
  const result = { ...defaults };

  for (const key of keys) {
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) {
      result[key] = raw[key] as number;
    }
  }

  return result;
}

export function normalizeCharacterBuilderDraft(input: unknown): CharacterBuilderDraft {
  const defaults: CharacterBuilderDraft = {
    name: '',
    concept: '',
    species: '',
    className: '',
    background: '',
    abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    skills: [],
    equipment: [],
    spells: [],
    languages: [],
    proficiencies: [],
    personality: '',
    ideal: '',
    bond: '',
    flaw: '',
    notes: '',
  };

  if (typeof input !== 'object' || input === null) return defaults;

  const raw = input as Record<string, unknown>;

  return {
    name: typeof raw.name === 'string' ? raw.name.trim() : defaults.name,
    concept: typeof raw.concept === 'string' ? raw.concept.trim() : defaults.concept,
    species: typeof raw.species === 'string' ? raw.species.trim() : defaults.species,
    className: typeof raw.className === 'string' ? raw.className.trim() : defaults.className,
    background: typeof raw.background === 'string' ? raw.background.trim() : defaults.background,
    abilityScores: normalizeScores(raw.abilityScores),
    skills: Array.isArray(raw.skills)
      ? raw.skills.filter((s): s is string => typeof s === 'string').map((s) => s.trim())
      : [],
    equipment: Array.isArray(raw.equipment)
      ? raw.equipment.filter((e): e is string => typeof e === 'string').map((e) => e.trim())
      : [],
    spells: Array.isArray(raw.spells)
      ? raw.spells.filter((s): s is string => typeof s === 'string').map((s) => s.trim())
      : [],
    languages: Array.isArray(raw.languages)
      ? raw.languages.filter((s): s is string => typeof s === 'string').map((s) => s.trim())
      : [],
    proficiencies: Array.isArray(raw.proficiencies)
      ? raw.proficiencies.filter((s): s is string => typeof s === 'string').map((s) => s.trim())
      : [],
    personality: typeof raw.personality === 'string' ? raw.personality.trim() : defaults.personality,
    ideal: typeof raw.ideal === 'string' ? raw.ideal.trim() : defaults.ideal,
    bond: typeof raw.bond === 'string' ? raw.bond.trim() : defaults.bond,
    flaw: typeof raw.flaw === 'string' ? raw.flaw.trim() : defaults.flaw,
    notes: typeof raw.notes === 'string' ? raw.notes.trim() : defaults.notes,
  };
}

export function auditCharacterBuilderDraft(draft: CharacterBuilderDraft): CharacterBuilderAudit {
  const issues: CharacterBuilderAuditIssue[] = [];

  if (!draft.species) {
    issues.push({ field: 'species', message: '请选择物种' });
  }

  if (!draft.className) {
    issues.push({ field: 'className', message: '请选择职业' });
  }

  if (!draft.background) {
    issues.push({ field: 'background', message: '请选择背景' });
  }

  const abilityKeys = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
  let allDefault = true;
  for (const key of abilityKeys) {
    const val = draft.abilityScores[key];
    if (!Number.isFinite(val) || val < 1 || val > 30 || !Number.isInteger(val)) {
      issues.push({ field: 'abilityScores', message: `属性值 ${key} 必须在 1-30 之间` });
    }
    if (val !== 10) {
      allDefault = false;
    }
  }
  if (allDefault) {
    issues.push({ field: 'abilityScores', message: '请设置属性值' });
  }

  if (draft.skills.length === 0) {
    issues.push({ field: 'skills', message: '请选择至少一项技能' });
  }

  if (draft.equipment.length === 0) {
    issues.push({ field: 'equipment', message: '请选择至少一件装备' });
  }

  return { valid: issues.length === 0, issues };
}

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function buildCharacterSheetFromDraft(draft: CharacterBuilderDraft): CharacterSheet {
  const conMod = abilityModifier(draft.abilityScores.con);
  const dexMod = abilityModifier(draft.abilityScores.dex);
  const isFighter = draft.className === '战士';
  const baseHp = isFighter ? 10 : 8;
  const maxHp = baseHp + conMod;

  return {
    name: draft.name,
    species: draft.species,
    className: draft.className,
    level: 1,
    abilityScores: draft.abilityScores,
    hitPoints: { current: maxHp, max: maxHp },
    armorClass: 10 + dexMod,
    proficiencyBonus: 2,
    skills: draft.skills,
    equipment: draft.equipment,
    spells: draft.spells,
    languages: draft.languages,
    proficiencies: draft.proficiencies,
    privateNotes: draft.notes,
    background: draft.background,
    concept: draft.concept,
    personality: draft.personality,
    ideal: draft.ideal,
    bond: draft.bond,
    flaw: draft.flaw,
    builderDraft: draft,
  };
}
