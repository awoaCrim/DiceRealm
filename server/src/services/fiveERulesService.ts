import type { CharacterSheet, PlayerRuleAvailableAction, PlayerRuleStat, PlayerRulesSummary } from '../domain/types.js';

type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
type WeaponActionInfo = {
  name: string;
  ability: 'str' | 'dex';
  damageDie: string;
  damageType: string;
  ranged?: boolean;
  light?: boolean;
  ammoName?: string;
  range?: string;
};
type SkillDefinition = { key: string; label: string; ability: AbilityKey; aliases: string[] };

const abilityLabels: Record<AbilityKey, string> = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  wis: '感知',
  cha: '魅力'
};

const classSavingThrowProficiencies: Array<{ pattern: RegExp; saves: AbilityKey[] }> = [
  { pattern: /野蛮人|barbarian/i, saves: ['str', 'con'] },
  { pattern: /吟游诗人|bard/i, saves: ['dex', 'cha'] },
  { pattern: /牧师|cleric/i, saves: ['wis', 'cha'] },
  { pattern: /德鲁伊|druid/i, saves: ['int', 'wis'] },
  { pattern: /战士|fighter/i, saves: ['str', 'con'] },
  { pattern: /武僧|monk/i, saves: ['str', 'dex'] },
  { pattern: /圣武士|paladin/i, saves: ['wis', 'cha'] },
  { pattern: /游侠|ranger/i, saves: ['str', 'dex'] },
  { pattern: /游荡者|rogue/i, saves: ['dex', 'int'] },
  { pattern: /术士|sorcerer/i, saves: ['con', 'cha'] },
  { pattern: /邪术师|warlock/i, saves: ['wis', 'cha'] },
  { pattern: /法师|wizard/i, saves: ['int', 'wis'] }
];

const skillDefinitions: SkillDefinition[] = [
  { key: 'acrobatics', label: '体操', ability: 'dex', aliases: ['acrobatics', '体操'] },
  { key: 'animal_handling', label: '驯兽', ability: 'wis', aliases: ['animalhandling', 'animal handling', '驯兽', '驯养动物'] },
  { key: 'arcana', label: '奥秘', ability: 'int', aliases: ['arcana', '奥秘', '奥术'] },
  { key: 'athletics', label: '运动', ability: 'str', aliases: ['athletics', '运动'] },
  { key: 'deception', label: '欺瞒', ability: 'cha', aliases: ['deception', '欺瞒', '欺骗'] },
  { key: 'history', label: '历史', ability: 'int', aliases: ['history', '历史'] },
  { key: 'insight', label: '洞悉', ability: 'wis', aliases: ['insight', '洞悉', '察言观色'] },
  { key: 'intimidation', label: '威吓', ability: 'cha', aliases: ['intimidation', '威吓', '恐吓'] },
  { key: 'investigation', label: '调查', ability: 'int', aliases: ['investigation', '调查', '侦查'] },
  { key: 'medicine', label: '医药', ability: 'wis', aliases: ['medicine', '医药', '医疗'] },
  { key: 'nature', label: '自然', ability: 'int', aliases: ['nature', '自然'] },
  { key: 'perception', label: '察觉', ability: 'wis', aliases: ['perception', '察觉', '观察', '感知'] },
  { key: 'performance', label: '表演', ability: 'cha', aliases: ['performance', '表演'] },
  { key: 'persuasion', label: '游说', ability: 'cha', aliases: ['persuasion', '游说', '说服'] },
  { key: 'religion', label: '宗教', ability: 'int', aliases: ['religion', '宗教'] },
  { key: 'sleight_of_hand', label: '巧手', ability: 'dex', aliases: ['sleightofhand', 'sleight of hand', '巧手', '手上功夫'] },
  { key: 'stealth', label: '隐匿', ability: 'dex', aliases: ['stealth', '隐匿', '潜行'] },
  { key: 'survival', label: '求生', ability: 'wis', aliases: ['survival', '求生', '生存'] }
];

const weaponActionInfo: Record<string, WeaponActionInfo> = {
  长剑: { name: '长剑', ability: 'str', damageDie: '1d8', damageType: '挥砍' },
  longsword: { name: '长剑', ability: 'str', damageDie: '1d8', damageType: '挥砍' },
  巨剑: { name: '巨剑', ability: 'str', damageDie: '2d6', damageType: '挥砍' },
  greatsword: { name: '巨剑', ability: 'str', damageDie: '2d6', damageType: '挥砍' },
  轻弩: { name: '轻弩', ability: 'dex', damageDie: '1d8', damageType: '穿刺', ranged: true, ammoName: '弩矢', range: '80/320' },
  lightcrossbow: { name: '轻弩', ability: 'dex', damageDie: '1d8', damageType: '穿刺', ranged: true, ammoName: '弩矢', range: '80/320' },
  匕首: { name: '匕首', ability: 'dex', damageDie: '1d4', damageType: '穿刺', light: true, range: '20/60' },
  dagger: { name: '匕首', ability: 'dex', damageDie: '1d4', damageType: '穿刺', light: true, range: '20/60' },
  短剑: { name: '短剑', ability: 'dex', damageDie: '1d6', damageType: '穿刺', light: true },
  shortsword: { name: '短剑', ability: 'dex', damageDie: '1d6', damageType: '穿刺', light: true },
  弯刀: { name: '弯刀', ability: 'dex', damageDie: '1d6', damageType: '挥砍', light: true },
  scimitar: { name: '弯刀', ability: 'dex', damageDie: '1d6', damageType: '挥砍', light: true },
  手斧: { name: '手斧', ability: 'str', damageDie: '1d6', damageType: '挥砍', light: true, range: '20/60' },
  handaxe: { name: '手斧', ability: 'str', damageDie: '1d6', damageType: '挥砍', light: true, range: '20/60' },
  轻锤: { name: '轻锤', ability: 'str', damageDie: '1d4', damageType: '钝击', light: true, range: '20/60' },
  lighthammer: { name: '轻锤', ability: 'str', damageDie: '1d4', damageType: '钝击', light: true, range: '20/60' },
  木棍: { name: '木棍', ability: 'str', damageDie: '1d4', damageType: '钝击', light: true },
  club: { name: '木棍', ability: 'str', damageDie: '1d4', damageType: '钝击', light: true },
  短弓: { name: '短弓', ability: 'dex', damageDie: '1d6', damageType: '穿刺', ranged: true, ammoName: '箭矢', range: '80/320' },
  shortbow: { name: '短弓', ability: 'dex', damageDie: '1d6', damageType: '穿刺', ranged: true, ammoName: '箭矢', range: '80/320' },
  长弓: { name: '长弓', ability: 'dex', damageDie: '1d8', damageType: '穿刺', ranged: true, ammoName: '箭矢', range: '150/600' },
  longbow: { name: '长弓', ability: 'dex', damageDie: '1d8', damageType: '穿刺', ranged: true, ammoName: '箭矢', range: '150/600' }
};

function normalizeKnownName(value: string): string {
  return value.replace(/[（）()，,。.\s-]/g, '').toLowerCase();
}

function abilityModifier(score: number | undefined): number {
  return Math.floor(((score ?? 10) - 10) / 2);
}

function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function formatDamage(damageDie: string, modifier: number): string {
  if (modifier === 0) return damageDie;
  return `${damageDie}${modifier > 0 ? `+${modifier}` : modifier}`;
}

function hasAnyAlias(values: string[] | undefined, aliases: string[]): boolean {
  const normalizedValues = (values ?? []).map(normalizeKnownName);
  return aliases.some((alias) => normalizedValues.some((value) => value.includes(normalizeKnownName(alias))));
}

function classText(sheet: CharacterSheet): string {
  return [
    sheet.className,
    sheet.classDetail,
    sheet.privateNotes,
    ...(sheet.proficiencies ?? [])
  ].filter(Boolean).join(' ');
}

function findWeaponActionInfo(item: string): WeaponActionInfo | null {
  const exact = weaponActionInfo[item] ?? weaponActionInfo[normalizeKnownName(item)];
  if (exact) return exact;
  const normalized = normalizeKnownName(item);
  return Object.values(weaponActionInfo).find((weapon) => normalized.includes(normalizeKnownName(weapon.name))) ?? null;
}

function inferSpeed(sheet: CharacterSheet): number {
  const species = normalizeKnownName(`${sheet.species}${sheet.subSpecies ?? ''}`);
  let speed = species.includes('矮人') || species.includes('侏儒') || species.includes('半身人') ? 25 : 30;
  if (species.includes('木精灵')) speed = 35;
  if (/武僧|monk/i.test(classText(sheet)) && (sheet.level ?? 1) >= 2) speed += 10;
  return speed;
}

function isSavingThrowProficient(sheet: CharacterSheet, ability: AbilityKey): boolean {
  const proficiencies = sheet.proficiencies ?? [];
  if (hasAnyAlias(proficiencies, [`${abilityLabels[ability]}豁免`, `${abilityLabels[ability]}豁免熟练`, `${ability} save`, `${ability} saving throw`])) return true;
  const info = classText(sheet);
  return classSavingThrowProficiencies.some((entry) => entry.pattern.test(info) && entry.saves.includes(ability));
}

function buildSavingThrows(sheet: CharacterSheet): PlayerRuleStat[] {
  const proficiencyBonus = sheet.proficiencyBonus ?? 2;
  return (Object.keys(abilityLabels) as AbilityKey[]).map((ability) => {
    const proficient = isSavingThrowProficient(sheet, ability);
    return {
      key: ability,
      label: abilityLabels[ability],
      modifier: formatModifier(abilityModifier(sheet.abilityScores[ability]) + (proficient ? proficiencyBonus : 0)),
      proficient
    };
  });
}

function buildSkills(sheet: CharacterSheet): PlayerRuleStat[] {
  const proficiencyBonus = sheet.proficiencyBonus ?? 2;
  return skillDefinitions.map((skill) => {
    const proficient = hasAnyAlias(sheet.skills, [skill.key, skill.label, ...skill.aliases]);
    return {
      key: skill.key,
      label: skill.label,
      ability: abilityLabels[skill.ability],
      modifier: formatModifier(abilityModifier(sheet.abilityScores[skill.ability]) + (proficient ? proficiencyBonus : 0)),
      proficient
    };
  });
}

function skillModifier(skills: PlayerRuleStat[], key: string): string {
  return skills.find((skill) => skill.key === key)?.modifier ?? '+0';
}

function reactionSpellActions(sheet: CharacterSheet): PlayerRuleAvailableAction[] {
  const reactionSpellNames = [
    { pattern: /护盾术|shield/i, detail: '被命中时可用，直到下回合开始 AC +5。' },
    { pattern: /反制法术|counterspell/i, detail: '看到生物施法时可用，尝试中断法术。' },
    { pattern: /吸收元素|absorb elements/i, detail: '受到酸、冷、火、电或雷鸣伤害时可用。' },
    { pattern: /地狱叱喝|hellish rebuke/i, detail: '受到可见生物伤害时可用。' },
    { pattern: /羽落术|feather fall/i, detail: '自己或附近生物坠落时可用。' }
  ];
  return (sheet.spells ?? []).flatMap((spell) => {
    const match = reactionSpellNames.find((entry) => entry.pattern.test(spell));
    return match ? [{
      id: `reaction-spell-${normalizeKnownName(spell)}`,
      title: spell,
      subtitle: '反应法术',
      timing: '反应' as const,
      tags: ['消耗法术位 / 按法术'],
      detail: match.detail
    }] : [];
  });
}

function buildAvailableActions(sheet: CharacterSheet, skills: PlayerRuleStat[]): PlayerRuleAvailableAction[] {
  const actions: PlayerRuleAvailableAction[] = [];
  const proficiencyBonus = sheet.proficiencyBonus ?? 2;
  const speed = inferSpeed(sheet);
  const weapons = sheet.equipment
    .map((item) => findWeaponActionInfo(item))
    .filter((weapon): weapon is WeaponActionInfo => Boolean(weapon));
  const mainWeapon = weapons[0];

  if (mainWeapon) {
    const abilityMod = abilityModifier(sheet.abilityScores[mainWeapon.ability]);
    actions.push({
      id: 'main-hand-weapon',
      title: '主手武器攻击',
      subtitle: mainWeapon.name,
      timing: '动作',
      tags: [
        `攻击 ${formatModifier(abilityMod + proficiencyBonus)}`,
        `伤害 ${formatDamage(mainWeapon.damageDie, abilityMod)} ${mainWeapon.damageType}`,
        ...(mainWeapon.range ? [`射程 ${mainWeapon.range}`] : []),
        ...(mainWeapon.ammoName ? [`弹药 ${mainWeapon.ammoName}`] : [])
      ]
    });
  } else {
    const abilityMod = Math.max(abilityModifier(sheet.abilityScores.str), abilityModifier(sheet.abilityScores.dex));
    actions.push({
      id: 'unarmed-strike',
      title: '徒手攻击',
      subtitle: '近战武器攻击',
      timing: '动作',
      tags: [`攻击 ${formatModifier(abilityMod + proficiencyBonus)}`, `伤害 ${Math.max(1, 1 + abilityMod)} 钝击`]
    });
  }

  const offhandWeapon = mainWeapon?.light && !mainWeapon.ranged
    ? weapons.slice(1).find((weapon) => weapon.light && !weapon.ranged)
    : null;
  if (offhandWeapon) {
    const abilityMod = abilityModifier(sheet.abilityScores[offhandWeapon.ability]);
    actions.push({
      id: 'off-hand-weapon',
      title: '副手武器攻击',
      subtitle: offhandWeapon.name,
      timing: '附赠动作',
      tags: [`攻击 ${formatModifier(abilityMod + proficiencyBonus)}`, `伤害 ${offhandWeapon.damageDie} ${offhandWeapon.damageType}`],
      detail: '双持轻型近战武器时可用；默认副手伤害不加属性调整值。'
    });
  }

  if (sheet.spells.length > 0) {
    actions.push({
      id: 'cast-spell',
      title: '施放法术',
      subtitle: sheet.spells.join('、'),
      timing: '按法术',
      tags: ['法术 / 戏法 / 能力'],
      detail: '具体施法时间、距离、组件和消耗以法术条目为准。'
    });
  }

  const classInfo = classText(sheet);
  const level = sheet.level ?? 1;
  if (/战士|fighter/i.test(classInfo)) {
    actions.push({ id: 'fighter-second-wind', title: '第二风', subtitle: '恢复 1d10 + 战士等级 HP', timing: '附赠动作', tags: ['短休恢复'] });
    if (level >= 2) actions.push({ id: 'fighter-action-surge', title: '动作如潮', subtitle: '本回合额外获得一次动作', timing: '特殊', tags: ['短休恢复'] });
    if (/战斗大师|战技|battle\s*master/i.test(classInfo)) actions.push({ id: 'fighter-maneuver', title: '战技', subtitle: '随武器攻击或触发条件使用', timing: '特殊', tags: ['战技骰', '按具体战技'] });
  }
  if (/武僧|monk/i.test(classInfo)) {
    actions.push({ id: 'monk-unarmed', title: '徒手打击', subtitle: '近战攻击', timing: '动作', tags: [`攻击 ${formatModifier(abilityModifier(sheet.abilityScores.dex) + proficiencyBonus)}`] });
    actions.push({ id: 'monk-martial-arts', title: '武术附赠攻击', subtitle: '攻击动作后可用', timing: '附赠动作', tags: ['武僧武器 / 徒手'] });
  }
  if (/游荡者|rogue/i.test(classInfo)) {
    actions.push({ id: 'rogue-sneak-attack', title: '偷袭', subtitle: '符合优势或盟友邻近等条件时追加伤害', timing: '特殊', tags: ['每回合一次'] });
    if (level >= 2) actions.push({ id: 'rogue-cunning-action', title: '灵巧动作', subtitle: '疾走、撤离或躲藏', timing: '附赠动作', tags: ['2级起'] });
  }

  actions.push(
    { id: 'dash', title: '疾走', subtitle: `本回合额外移动最多 ${speed} 尺`, timing: '动作', tags: ['移动'] },
    { id: 'disengage', title: '撤离', subtitle: '本回合移动不触发借机攻击', timing: '动作', tags: ['防守'] },
    { id: 'dodge', title: '闪避', subtitle: '攻击者劣势，敏捷豁免优势，直到你下回合开始', timing: '动作', tags: ['防守', '失能时失效'] },
    { id: 'help', title: '协助', subtitle: '帮助盟友进行检定或攻击邻近目标', timing: '动作', tags: ['支援'] },
    { id: 'hide', title: '躲藏', subtitle: '进行敏捷（隐匿）检定', timing: '动作', tags: [`隐匿 ${skillModifier(skills, 'stealth')}`] },
    { id: 'search', title: '搜索', subtitle: '进行感知或调查检定寻找线索/敌人', timing: '动作', tags: [`察觉 ${skillModifier(skills, 'perception')}`, `调查 ${skillModifier(skills, 'investigation')}`] },
    { id: 'ready-action', title: '准备动作', subtitle: '声明触发条件，触发时用反应执行', timing: '动作', tags: ['占用反应', '可能影响专注'] },
    { id: 'use-object', title: '使用物品', subtitle: '使用需要动作的物品或复杂互动', timing: '动作', tags: ['物品'] },
    { id: 'grapple', title: '擒抱', subtitle: '以攻击的一部分进行力量（运动）对抗', timing: '动作', tags: [`运动 ${skillModifier(skills, 'athletics')}`] },
    { id: 'shove', title: '推撞', subtitle: '以攻击的一部分将目标推开或撞倒', timing: '动作', tags: [`运动 ${skillModifier(skills, 'athletics')}`] },
    { id: 'escape-grapple', title: '挣脱擒抱', subtitle: '力量（运动）或敏捷（体操）对抗', timing: '动作', tags: [`运动 ${skillModifier(skills, 'athletics')}`, `体操 ${skillModifier(skills, 'acrobatics')}`] },
    { id: 'improvise', title: '即兴行动', subtitle: '尝试规则未列明的环境互动或战术', timing: '动作', tags: ['由 DM 裁定'] }
  );

  const opportunityWeapon = weapons.find((weapon) => !weapon.ranged) ?? mainWeapon;
  actions.push({
    id: 'opportunity-attack',
    title: '借机攻击',
    subtitle: opportunityWeapon ? `${opportunityWeapon.name} 近战反应` : '敌人离开你的触及时',
    timing: '反应',
    tags: opportunityWeapon ? [`攻击 ${formatModifier(abilityModifier(sheet.abilityScores[opportunityWeapon.ability]) + proficiencyBonus)}`] : ['触发时可用']
  });
  actions.push(...reactionSpellActions(sheet));

  return actions;
}

export function buildFiveERulesSummary(character: { sheet: CharacterSheet; confirmed: boolean } | null): PlayerRulesSummary | undefined {
  if (!character?.confirmed) return undefined;
  const sheet = character.sheet;
  const speed = inferSpeed(sheet);
  const skills = buildSkills(sheet);
  return {
    ruleset: '5e-2014',
    actionEconomy: [
      { title: '动作', value: '1 / 轮', detail: '攻击、施法、疾走、撤离、闪避、协助、躲藏、搜索、准备或使用物品。' },
      { title: '附赠动作', value: '1 / 轮', detail: '只有职业能力、法术或双持等规则给出时才能使用。' },
      { title: '反应', value: '1 / 轮', detail: '常见触发包括借机攻击、准备动作触发和部分反应法术。' },
      { title: '移动', value: `${speed} 尺 / 轮`, detail: '可拆分在行动前后；困难地形、攀爬、游泳、爬行通常额外消耗移动。' },
      { title: '物品互动', value: '1 / 轮', detail: '拔武器、开门、取物等轻量互动；复杂使用通常需要“使用物品”动作。' },
      { title: '专注', value: '最多 1 个', detail: '受到伤害时通常要进行体质豁免来维持专注。' }
    ],
    savingThrows: buildSavingThrows(sheet),
    skills,
    availableActions: buildAvailableActions(sheet, skills),
    assumptions: [
      '速度、装备使用与职业能力基于当前角色卡字段推导；未记录的专长、魔法物品、职业资源和条件不会自动纳入。',
      '本摘要暂不表示本轮资源已消耗，只表示规则上可用的行动与检定。'
    ]
  };
}
