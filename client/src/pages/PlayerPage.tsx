import { useEffect, useRef, useState } from 'react';
import { generatePlayerTurnSuggestions, getPlayerState, respondToInteraction, submitAction, subscribeRoom } from '../api';
import { CharacterBuilder } from '../components/CharacterBuilder';
import { CharacterCard } from '../components/CharacterCard';
import { LogList } from '../components/LogList';
import { TurnPanel } from '../components/TurnPanel';
import { formatIsoDateTime, npcAttitudeLabel, questStatusLabel, roomStatusLabel } from '../displayLabels';
import type { PlayerRuleAvailableAction, PlayerRuleStat, PlayerRulesSummary, PlayerTurnSuggestion, PlayerVisibleState } from '../types';

type PlayerActionType = 'in_character_action' | 'player_question' | 'meta_question' | 'observe' | 'wait' | 'skip' | 'ready' | 'follow' | 'combat_action' | 'narrative' | 'exploration' | 'social' | 'combat' | 'ooc';
type ExplorationAction = 'stealth' | 'perception' | 'investigation' | 'lockpick' | 'disarmTrap' | 'track' | 'solvePuzzle';
type SocialAction = 'persuade' | 'deceive' | 'intimidate' | 'haggle' | 'negotiate';
type PlayerTab = 'story' | 'character' | 'backpack' | 'status';
type LogTab = 'public' | 'private';
type ActionTiming = '动作' | '附赠动作' | '反应' | '按法术' | '特殊';
type AvailableAction = PlayerRuleAvailableAction;
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
type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
type ActionEconomyItem = { title: string; value: string; detail: string };
type SkillDefinition = { key: string; label: string; ability: AbilityKey; aliases: string[] };

const explorationActions: { value: ExplorationAction; label: string; dcInfo: string }[] = [
  { value: 'stealth', label: '潜行', dcInfo: 'DC 12 (敏捷)' },
  { value: 'perception', label: '察觉', dcInfo: 'DC 12 (感知)' },
  { value: 'investigation', label: '调查', dcInfo: 'DC 13 (智力)' },
  { value: 'lockpick', label: '开锁', dcInfo: 'DC 15 (敏捷)' },
  { value: 'disarmTrap', label: '解除陷阱', dcInfo: 'DC 15 (敏捷)' },
  { value: 'track', label: '追踪', dcInfo: 'DC 13 (感知)' },
  { value: 'solvePuzzle', label: '解谜', dcInfo: 'DC 12 (智力)' },
];

const socialActions: { value: SocialAction; label: string; dcInfo: string }[] = [
  { value: 'persuade', label: '说服', dcInfo: 'DC 15 (魅力)' },
  { value: 'deceive', label: '欺骗', dcInfo: 'DC 15 (魅力)' },
  { value: 'intimidate', label: '威吓', dcInfo: 'DC 17 (魅力，偏难)' },
  { value: 'haggle', label: '交易', dcInfo: 'DC 15 (魅力)' },
  { value: 'negotiate', label: '谈判', dcInfo: '3次检定 (魅力)' },
];

const playerTabs: Array<{ id: PlayerTab; label: string }> = [
  { id: 'story', label: '剧情' },
  { id: 'character', label: '人物卡' },
  { id: 'backpack', label: '背包' },
  { id: 'status', label: '状态' }
];

const itemInfo: Record<string, { type: string; detail: string }> = {
  长剑: { type: '武器', detail: '近战武器，1d8 挥砍伤害；双手使用时为 1d10。' },
  盾牌: { type: '防具', detail: '装备后护甲等级 +2。' },
  轻弩: { type: '武器', detail: '远程武器，1d8 穿刺伤害，射程 80/320，需要弩矢。' },
  巨剑: { type: '武器', detail: '双手近战武器，2d6 挥砍伤害。' },
  奥术法器: { type: '施法工具', detail: '施法者可用作法术焦点；具体可用性以职业和 DM 判定为准。' },
  弩矢: { type: '弹药', detail: '用于弩类武器的弹药，通常命中后消耗。' },
  治疗包: { type: '工具', detail: '可用于稳定 0 HP 生物，通常有有限使用次数。' }
};

const abilityLabels: Record<AbilityKey, string> = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  wis: '感知',
  cha: '魅力'
};

const classSavingThrowProficiencies: Array<{ pattern: RegExp; saves: AbilityKey[] }> = [
  { pattern: /野蛮人|barbarian/, saves: ['str', 'con'] },
  { pattern: /吟游诗人|bard/, saves: ['dex', 'cha'] },
  { pattern: /牧师|cleric/, saves: ['wis', 'cha'] },
  { pattern: /德鲁伊|druid/, saves: ['int', 'wis'] },
  { pattern: /战士|fighter/, saves: ['str', 'con'] },
  { pattern: /武僧|monk/, saves: ['str', 'dex'] },
  { pattern: /圣武士|paladin/, saves: ['wis', 'cha'] },
  { pattern: /游侠|ranger/, saves: ['str', 'dex'] },
  { pattern: /游荡者|rogue/, saves: ['dex', 'int'] },
  { pattern: /术士|sorcerer/, saves: ['con', 'cha'] },
  { pattern: /邪术师|warlock/, saves: ['wis', 'cha'] },
  { pattern: /法师|wizard/, saves: ['int', 'wis'] }
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
  巨剑: { name: '巨剑', ability: 'str', damageDie: '2d6', damageType: '挥砍' },
  轻弩: { name: '轻弩', ability: 'dex', damageDie: '1d8', damageType: '穿刺', ranged: true, ammoName: '弩矢', range: '80/320' },
  匕首: { name: '匕首', ability: 'dex', damageDie: '1d4', damageType: '穿刺', light: true, range: '20/60' },
  短剑: { name: '短剑', ability: 'dex', damageDie: '1d6', damageType: '穿刺', light: true },
  弯刀: { name: '弯刀', ability: 'dex', damageDie: '1d6', damageType: '挥砍', light: true },
  手斧: { name: '手斧', ability: 'str', damageDie: '1d6', damageType: '挥砍', light: true, range: '20/60' },
  轻锤: { name: '轻锤', ability: 'str', damageDie: '1d4', damageType: '钝击', light: true, range: '20/60' },
  木棍: { name: '木棍', ability: 'str', damageDie: '1d4', damageType: '钝击', light: true },
  短弓: { name: '短弓', ability: 'dex', damageDie: '1d6', damageType: '穿刺', ranged: true, ammoName: '箭矢', range: '80/320' },
  长弓: { name: '长弓', ability: 'dex', damageDie: '1d8', damageType: '穿刺', ranged: true, ammoName: '箭矢', range: '150/600' }
};

function inferActionType(text: string, selected: PlayerActionType): PlayerActionType {
  if (selected !== 'in_character_action') return selected;
  const trimmed = text.trim();
  if (/^(我是谁|我现在是谁|我的角色是谁)[？?]?$/.test(trimmed)) return 'player_question';
  if (/[？?]$/.test(trimmed)) return 'player_question';
  if (/^(观察|查看|环顾|侦查|搜索)/.test(trimmed)) return 'observe';
  if (/^(等待|静观|观望|不行动)/.test(trimmed)) return 'wait';
  return selected;
}

function inferActionVisibility(actionType: PlayerActionType): 'public' | 'private' {
  return actionType === 'player_question' || actionType === 'meta_question' ? 'private' : 'public';
}

function defaultActionText(actionType: PlayerActionType): string {
  switch (actionType) {
    case 'wait': return '等待并观察局势。';
    case 'skip': return '跳过本回合。';
    case 'ready': return '准备行动，等待合适时机。';
    case 'follow': return '跟随队伍行动。';
    default: return '';
  }
}

function draftActionType(actionType: PlayerTurnSuggestion['actionType']): PlayerActionType {
  return actionType === 'combat' ? 'combat_action' : actionType;
}

function inferTextSubAction(actionType: PlayerTurnSuggestion['actionType'] | PlayerActionType | undefined, text: string): string {
  if (actionType === 'exploration') {
    if (/(调查|调查技能|现场|复核|粉末|质地|气味|岩壁比对)/.test(text)) return 'investigation';
    if (/(脚印|足迹|踪迹|拖痕|追踪|尾随|痕迹)/.test(text)) return 'track';
    if (/(搜索|搜查|线索)/.test(text)) return 'investigation';
    if (/(观察|察觉|警戒|留意|环顾|侦查|监视)/.test(text)) return 'perception';
    if (/(潜行|隐匿|悄悄|避开视线)/.test(text)) return 'stealth';
    if (/(开锁|锁孔|撬锁)/.test(text)) return 'lockpick';
    if (/(陷阱|机关|解除)/.test(text)) return 'disarmTrap';
    if (/(谜题|谜团|符文|机关谜)/.test(text)) return 'solvePuzzle';
    return explorationActions.find((item) => text.includes(item.label))?.value ?? '';
  }
  if (actionType === 'social') {
    return socialActions.find((item) => text.includes(item.label))?.value ?? '';
  }
  return '';
}

function inferSuggestionSubAction(suggestion: PlayerTurnSuggestion): string {
  return inferTextSubAction(suggestion.actionType, `${suggestion.title} ${suggestion.actionText} ${suggestion.hint}`);
}

function describeItem(name: string): { type: string; detail: string } {
  return itemInfo[name] ?? { type: '物品', detail: '角色持有的可见物品；具体规则效果由当前规则与场景决定。' };
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

function normalizeKnownName(value: string): string {
  return value.replace(/[（）()，,。.\s]/g, '').toLowerCase();
}

function hasAnyAlias(values: string[] | undefined, aliases: string[]): boolean {
  const normalizedValues = (values ?? []).map(normalizeKnownName);
  return aliases.some((alias) => normalizedValues.some((value) => value.includes(normalizeKnownName(alias))));
}

function findWeaponActionInfo(item: string): WeaponActionInfo | null {
  const exact = weaponActionInfo[item];
  if (exact) return exact;
  const normalized = normalizeKnownName(item);
  return Object.values(weaponActionInfo).find((weapon) => normalized.includes(normalizeKnownName(weapon.name))) ?? null;
}

function resourceAmmoText(state: PlayerVisibleState, weapon: WeaponActionInfo): string | null {
  if (!weapon.ammoName) return null;
  const ammo = state.resources?.ammo.find((entry) => normalizeKnownName(entry.name).includes(normalizeKnownName(weapon.ammoName!)));
  return ammo ? `${weapon.ammoName} ${ammo.current}/${ammo.max}` : `${weapon.ammoName} 未记录`;
}

function classText(state: PlayerVisibleState): string {
  const sheet = state.character?.sheet;
  if (!sheet) return '';
  return [
    sheet.className,
    sheet.classDetail,
    sheet.privateNotes,
    ...(sheet.proficiencies ?? [])
  ].filter(Boolean).join(' ');
}

function inferSpeed(state: PlayerVisibleState): number {
  const sheet = state.character?.sheet;
  if (!sheet) return 30;
  const species = normalizeKnownName(`${sheet.species}${sheet.subSpecies ?? ''}`);
  let speed = species.includes('矮人') || species.includes('侏儒') || species.includes('半身人') ? 25 : 30;
  if (species.includes('木精灵')) speed = 35;
  if (/武僧|monk/i.test(classText(state)) && (sheet.level ?? 1) >= 2) speed += 10;
  return speed;
}

function buildActionEconomy(state: PlayerVisibleState): ActionEconomyItem[] {
  return [
    { title: '动作', value: '1 / 轮', detail: '攻击、施法、疾走、撤离、闪避、协助、躲藏、搜索、准备或使用物品。' },
    { title: '附赠动作', value: '1 / 轮', detail: '只有职业能力、法术或双持等规则给出时才能使用。' },
    { title: '反应', value: '1 / 轮', detail: '常见触发包括借机攻击、准备动作触发和部分反应法术。' },
    { title: '移动', value: `${inferSpeed(state)} 尺 / 轮`, detail: '可拆分在行动前后；困难地形、攀爬、游泳、爬行通常额外消耗移动。' },
    { title: '物品互动', value: '1 / 轮', detail: '拔武器、开门、取物等轻量互动；复杂使用通常需要“使用物品”动作。' },
    { title: '专注', value: '最多 1 个', detail: '受到伤害时通常要进行体质豁免来维持专注。' }
  ];
}

function isSavingThrowProficient(state: PlayerVisibleState, ability: AbilityKey): boolean {
  const sheet = state.character?.sheet;
  if (!sheet) return false;
  const proficiencies = sheet.proficiencies ?? [];
  if (hasAnyAlias(proficiencies, [`${abilityLabels[ability]}豁免`, `${abilityLabels[ability]}豁免熟练`, `${ability} save`, `${ability} saving throw`])) return true;
  const classInfo = classText(state).toLowerCase();
  return classSavingThrowProficiencies.some((entry) => entry.pattern.test(classInfo) && entry.saves.includes(ability));
}

function buildSavingThrows(state: PlayerVisibleState): PlayerRuleStat[] {
  const sheet = state.character?.sheet;
  if (!sheet) return [];
  const proficiencyBonus = sheet.proficiencyBonus ?? 2;
  return (Object.keys(abilityLabels) as AbilityKey[]).map((ability) => {
    const proficient = isSavingThrowProficient(state, ability);
    return {
      key: ability,
      label: abilityLabels[ability],
      modifier: formatModifier(abilityModifier(sheet.abilityScores[ability]) + (proficient ? proficiencyBonus : 0)),
      proficient
    };
  });
}

function isSkillProficient(state: PlayerVisibleState, skill: SkillDefinition): boolean {
  return hasAnyAlias(state.character?.sheet.skills, [skill.key, skill.label, ...skill.aliases]);
}

function buildSkillChecks(state: PlayerVisibleState): PlayerRuleStat[] {
  const sheet = state.character?.sheet;
  if (!sheet) return [];
  const proficiencyBonus = sheet.proficiencyBonus ?? 2;
  return skillDefinitions.map((skill) => {
    const proficient = isSkillProficient(state, skill);
    return {
      key: skill.key,
      label: skill.label,
      ability: abilityLabels[skill.ability],
      modifier: formatModifier(abilityModifier(sheet.abilityScores[skill.ability]) + (proficient ? proficiencyBonus : 0)),
      proficient
    };
  });
}

function reactionSpellActions(state: PlayerVisibleState): AvailableAction[] {
  const reactionSpellNames = [
    { pattern: /护盾术|shield/i, detail: '被命中时可用，直到下回合开始 AC +5。' },
    { pattern: /反制法术|counterspell/i, detail: '看到生物施法时可用，尝试中断法术。' },
    { pattern: /吸收元素|absorb elements/i, detail: '受到酸、冷、火、电或雷鸣伤害时可用。' },
    { pattern: /地狱叱喝|hellish rebuke/i, detail: '受到可见生物伤害时可用。' },
    { pattern: /羽落术|feather fall/i, detail: '自己或附近生物坠落时可用。' }
  ];
  return (state.character?.sheet.spells ?? []).flatMap((spell) => {
    const match = reactionSpellNames.find((entry) => entry.pattern.test(spell));
    return match ? [{
      id: `reaction-spell-${normalizeKnownName(spell)}`,
      title: spell,
      subtitle: '反应法术',
      timing: '反应' as ActionTiming,
      tags: ['消耗法术位 / 按法术'],
      detail: match.detail
    }] : [];
  });
}

function buildAvailableActions(state: PlayerVisibleState): AvailableAction[] {
  const sheet = state.character?.sheet;
  if (!sheet || !state.character?.confirmed) return [];

  const actions: AvailableAction[] = [];
  const proficiencyBonus = sheet.proficiencyBonus ?? 2;
  const weapons = sheet.equipment
    .map((item) => findWeaponActionInfo(item))
    .filter((weapon): weapon is WeaponActionInfo => Boolean(weapon));
  const mainWeapon = weapons[0];

  if (mainWeapon) {
    const abilityMod = abilityModifier(sheet.abilityScores[mainWeapon.ability]);
    const ammoText = resourceAmmoText(state, mainWeapon);
    actions.push({
      id: 'main-hand-weapon',
      title: '主手武器攻击',
      subtitle: mainWeapon.name,
      timing: '动作',
      tags: [
        `攻击 ${formatModifier(abilityMod + proficiencyBonus)}`,
        `伤害 ${formatDamage(mainWeapon.damageDie, abilityMod)} ${mainWeapon.damageType}`,
        ...(mainWeapon.range ? [`射程 ${mainWeapon.range}`] : []),
        ...(ammoText ? [ammoText] : [])
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
      tags: [
        `攻击 ${formatModifier(abilityMod + proficiencyBonus)}`,
        `伤害 ${offhandWeapon.damageDie} ${offhandWeapon.damageType}`
      ],
      detail: '双持轻型近战武器时可用；默认副手伤害不加属性调整值。'
    });
  }

  if (sheet.spells.length > 0) {
    const slotSummary = Object.entries(state.resources?.spellSlots ?? {})
      .filter(([, slots]) => slots.total > 0)
      .map(([level, slots]) => `${level}: ${Math.max(0, slots.total - slots.used)}/${slots.total}`);
    actions.push({
      id: 'cast-spell',
      title: '施放法术',
      subtitle: sheet.spells.join('、'),
      timing: '按法术',
      tags: slotSummary.length ? [`可用法术位 ${slotSummary.join('，')}`] : ['法术 / 戏法 / 能力'],
      detail: '具体施法时间、距离和消耗以法术条目为准。'
    });
  }

  const classInfo = classText(state).toLowerCase();
  const level = sheet.level ?? 1;
  if (/战士|fighter/.test(classInfo)) {
    actions.push({
      id: 'fighter-second-wind',
      title: '第二风',
      subtitle: '恢复 1d10 + 战士等级 HP',
      timing: '附赠动作',
      tags: ['短休恢复']
    });
    if (level >= 2) {
      actions.push({
        id: 'fighter-action-surge',
        title: '动作如潮',
        subtitle: '本回合额外获得一次动作',
        timing: '特殊',
        tags: ['短休恢复']
      });
    }
    if (/战斗大师|战技|battle\s*master/.test(classInfo)) {
      actions.push({
        id: 'fighter-maneuver',
        title: '战技',
        subtitle: '随武器攻击或触发条件使用',
        timing: '特殊',
        tags: ['战技骰', '按具体战技']
      });
    }
  }
  if (/武僧|monk/.test(classInfo)) {
    actions.push({
      id: 'monk-unarmed',
      title: '徒手打击',
      subtitle: '近战攻击',
      timing: '动作',
      tags: [`攻击 ${formatModifier(abilityModifier(sheet.abilityScores.dex) + proficiencyBonus)}`]
    });
    actions.push({
      id: 'monk-martial-arts',
      title: '武术附赠攻击',
      subtitle: '攻击动作后可用',
      timing: '附赠动作',
      tags: ['武僧武器 / 徒手']
    });
  }
  if (/游荡者|rogue/.test(classInfo)) {
    actions.push({
      id: 'rogue-sneak-attack',
      title: '偷袭',
      subtitle: '符合优势或盟友邻近等条件时追加伤害',
      timing: '特殊',
      tags: ['每回合一次']
    });
    if (level >= 2) {
      actions.push({
        id: 'rogue-cunning-action',
        title: '灵巧动作',
        subtitle: '疾走、撤离或躲藏',
        timing: '附赠动作',
        tags: ['2级起']
      });
    }
  }

  actions.push(
    { id: 'dash', title: '疾走', subtitle: `本回合额外移动最多 ${inferSpeed(state)} 尺`, timing: '动作', tags: ['移动'] },
    { id: 'disengage', title: '撤离', subtitle: '本回合移动不触发借机攻击', timing: '动作', tags: ['防守'] },
    { id: 'dodge', title: '闪避', subtitle: '攻击者劣势，敏捷豁免优势，直到你下回合开始', timing: '动作', tags: ['防守', '失能时失效'] },
    { id: 'help', title: '协助', subtitle: '帮助盟友进行检定或攻击邻近目标', timing: '动作', tags: ['支援'] },
    { id: 'hide', title: '躲藏', subtitle: '进行敏捷（隐匿）检定', timing: '动作', tags: [`隐匿 ${buildSkillChecks(state).find((skill) => skill.key === 'stealth')?.modifier ?? '+0'}`] },
    { id: 'search', title: '搜索', subtitle: '进行感知或调查检定寻找线索/敌人', timing: '动作', tags: [`察觉 ${buildSkillChecks(state).find((skill) => skill.key === 'perception')?.modifier ?? '+0'}`, `调查 ${buildSkillChecks(state).find((skill) => skill.key === 'investigation')?.modifier ?? '+0'}`] },
    { id: 'ready-action', title: '准备动作', subtitle: '声明触发条件，触发时用反应执行', timing: '动作', tags: ['占用反应', '可能影响专注'] },
    { id: 'use-object', title: '使用物品', subtitle: '使用需要动作的物品或复杂互动', timing: '动作', tags: ['物品'] },
    { id: 'grapple', title: '擒抱', subtitle: '以攻击的一部分进行力量（运动）对抗', timing: '动作', tags: [`运动 ${buildSkillChecks(state).find((skill) => skill.key === 'athletics')?.modifier ?? '+0'}`] },
    { id: 'shove', title: '推撞', subtitle: '以攻击的一部分将目标推开或撞倒', timing: '动作', tags: [`运动 ${buildSkillChecks(state).find((skill) => skill.key === 'athletics')?.modifier ?? '+0'}`] },
    { id: 'escape-grapple', title: '挣脱擒抱', subtitle: '力量（运动）或敏捷（体操）对抗', timing: '动作', tags: [`运动 ${buildSkillChecks(state).find((skill) => skill.key === 'athletics')?.modifier ?? '+0'}`, `体操 ${buildSkillChecks(state).find((skill) => skill.key === 'acrobatics')?.modifier ?? '+0'}`] },
    { id: 'improvise', title: '即兴行动', subtitle: '尝试规则未列明的环境互动或战术', timing: '动作', tags: ['由 DM 裁定'] }
  );

  const opportunityWeapon = weapons.find((weapon) => !weapon.ranged) ?? mainWeapon;
  actions.push({
    id: 'opportunity-attack',
    title: '借机攻击',
    subtitle: opportunityWeapon ? `${opportunityWeapon.name} 近战反应` : '敌人离开你的触及时',
    timing: '反应',
    tags: opportunityWeapon
      ? [`攻击 ${formatModifier(abilityModifier(sheet.abilityScores[opportunityWeapon.ability]) + proficiencyBonus)}`]
      : ['触发时可用']
  });
  actions.push(...reactionSpellActions(state));

  return actions;
}

function combatHealthText(label: string): string {
  switch (label) {
    case 'healthy': return '状态良好';
    case 'injured': return '受伤';
    case 'bloodied': return '重伤';
    case 'defeated': return '倒下';
    default: return '未知';
  }
}

function actionTypeLabel(type: string | undefined): string {
  switch (type) {
    case 'player_question': return '玩家问题';
    case 'meta_question': return '场外问题';
    case 'observe': return '观察';
    case 'wait': return '等待';
    case 'skip': return '跳过';
    case 'ready': return '准备';
    case 'follow': return '跟随';
    case 'combat_action':
    case 'combat': return '临场行动';
    case 'exploration': return '探索行动';
    case 'social': return '社交行动';
    case 'ooc': return '场外说明';
    default: return '角色行动';
  }
}

function actionVisibilityLabel(visibility: string | undefined): string {
  switch (visibility) {
    case 'private': return '私人';
    case 'dm_only': return '仅主持人';
    default: return '公开';
  }
}

function actionStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'complete': return '已结算';
    case 'processing': return '处理中';
    default: return '已提交';
  }
}

export function PlayerPage({ token }: { token: string }) {
  const [state, setState] = useState<PlayerVisibleState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [isSubmittingAction, setIsSubmittingAction] = useState(false);
  const [isGeneratingTurnSuggestions, setIsGeneratingTurnSuggestions] = useState(false);
  const [actionType, setActionType] = useState<PlayerActionType>('in_character_action');
  const [subAction, setSubAction] = useState('');
  const [isHiddenRoll, setIsHiddenRoll] = useState(false);
  const [activeTab, setActiveTab] = useState<PlayerTab>('story');
  const [activeLogTab, setActiveLogTab] = useState<LogTab>('public');
  const [interactionResponses, setInteractionResponses] = useState<Record<string, string>>({});
  const [interactionNotice, setInteractionNotice] = useState('');
  const [selectedSuggestionId, setSelectedSuggestionId] = useState('');
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const requestedSuggestionTurnsRef = useRef<Set<string>>(new Set());

  async function refresh() {
    try {
      setState(await getPlayerState(token));
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    let unsubscribe = () => {};
    void getPlayerState(token).then((next) => {
      setState(next);
      setLoadError('');
      if (next.character && !next.character.confirmed) setActiveTab('character');
      unsubscribe = subscribeRoom(next.room.id, () => void refresh());
    }).catch((err) => {
      setLoadError(err instanceof Error ? err.message : String(err));
    });
    return () => unsubscribe();
  }, [token]);

  useEffect(() => {
    if (activeTab !== 'story') return;
    const node = logScrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [activeTab, activeLogTab, state?.publicLogs.length, state?.privateLogs.length]);

  useEffect(() => {
    if (!state) return;
    if (!state.character?.confirmed || state.room.status !== 'waiting_for_actions' || state.currentAction || state.turnSuggestionStatus !== 'missing') return;
    const requestKey = `${state.room.id}:${state.room.currentTurn}:${state.player.id}`;
    if (requestedSuggestionTurnsRef.current.has(requestKey)) return;
    requestedSuggestionTurnsRef.current.add(requestKey);
    let isActive = true;
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (!isActive || settled) return;
      isActive = false;
      setIsGeneratingTurnSuggestions(false);
      setState((current) => {
        if (!current || current.room.id !== state.room.id || current.room.currentTurn !== state.room.currentTurn) return current;
        return {
          ...current,
          turnSuggestions: [],
          turnSuggestionStatus: 'failed',
          turnSuggestionError: '建议生成超过 45 秒未完成，可重新生成或直接输入行动。'
        };
      });
    }, 45_000);
    setIsGeneratingTurnSuggestions(true);
    void generatePlayerTurnSuggestions(token)
      .then((result) => {
        if (!isActive) return;
        settled = true;
        setState((current) => {
          if (!current || current.room.id !== state.room.id || current.room.currentTurn !== state.room.currentTurn) return current;
          return {
            ...current,
            turnSuggestions: result.suggestions,
            turnSuggestionStatus: result.status,
            turnSuggestionError: result.error ?? null
          };
        });
      })
      .catch((err) => {
        if (!isActive) return;
        settled = true;
        setState((current) => {
          if (!current || current.room.id !== state.room.id || current.room.currentTurn !== state.room.currentTurn) return current;
          return {
            ...current,
            turnSuggestions: [],
            turnSuggestionStatus: 'failed',
            turnSuggestionError: err instanceof Error ? err.message : String(err)
          };
        });
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
        if (isActive) setIsGeneratingTurnSuggestions(false);
      });
    return () => {
      isActive = false;
      window.clearTimeout(timeoutId);
    };
  }, [state?.room.id, state?.room.currentTurn, state?.room.status, state?.character?.confirmed, state?.currentAction?.id, state?.turnSuggestionStatus, state?.player.id, token]);

  useEffect(() => {
    setSelectedSuggestionId('');
  }, [state?.room.id, state?.room.currentTurn]);

  useEffect(() => {
    if (!state) return;
    setSelectedSuggestionId('');
    setActionNotice('');
    if (state.currentAction) {
      const syncedActionType = draftActionType(state.currentAction.actionType ?? 'in_character_action');
      setAction(state.currentAction.text);
      setActionType(syncedActionType);
      setSubAction(inferTextSubAction(syncedActionType, state.currentAction.text));
      return;
    }
    setAction('');
    setActionType('in_character_action');
    setSubAction('');
  }, [
    state?.room.id,
    state?.room.currentTurn,
    state?.currentAction?.id,
    state?.currentAction?.text,
    state?.currentAction?.actionType
  ]);

  async function retryTurnSuggestions() {
    if (!state || !state.character?.confirmed || isGeneratingTurnSuggestions) return;
    const roomId = state.room.id;
    const currentTurn = state.room.currentTurn;
    const requestKey = `${roomId}:${currentTurn}:${state.player.id}`;
    requestedSuggestionTurnsRef.current.add(requestKey);
    setError('');
    setState((current) => {
      if (!current || current.room.id !== roomId || current.room.currentTurn !== currentTurn) return current;
      return { ...current, turnSuggestions: [], turnSuggestionStatus: 'missing', turnSuggestionError: null };
    });
    setIsGeneratingTurnSuggestions(true);
    try {
      const result = await generatePlayerTurnSuggestions(token);
      setState((current) => {
        if (!current || current.room.id !== roomId || current.room.currentTurn !== currentTurn) return current;
        return {
          ...current,
          turnSuggestions: result.suggestions,
          turnSuggestionStatus: result.status,
          turnSuggestionError: result.error ?? null
        };
      });
    } catch (err) {
      setState((current) => {
        if (!current || current.room.id !== roomId || current.room.currentTurn !== currentTurn) return current;
        return {
          ...current,
          turnSuggestions: [],
          turnSuggestionStatus: 'failed',
          turnSuggestionError: err instanceof Error ? err.message : String(err)
        };
      });
    } finally {
      setIsGeneratingTurnSuggestions(false);
    }
  }

  async function submit() {
    setError('');
    setActionNotice('');
    const selectedDefaultText = defaultActionText(actionType);
    if (!(action.trim() || selectedDefaultText) || isSubmittingAction) return;
    setIsSubmittingAction(true);
    try {
      const inferredType = inferActionType(action, actionType);
      const submittedText = action.trim() || defaultActionText(inferredType);
      await submitAction(token, submittedText, inferredType, isHiddenRoll, inferActionVisibility(inferredType));
      setAction(submittedText);
      await refresh();
      setActionNotice('行动已提交，等待 DM 处理。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmittingAction(false);
    }
  }

  function applyTurnSuggestion(suggestion: PlayerTurnSuggestion) {
    setSelectedSuggestionId(suggestion.id);
    setAction(suggestion.actionText);
    setActionType(draftActionType(suggestion.actionType));
    setSubAction(inferSuggestionSubAction(suggestion));
    setActionNotice(`已套用建议：${suggestion.title}。确认内容后点击提交行动。`);
    setError('');
  }

  function getSubActionDcInfo(): string | null {
    if (actionType === 'exploration') {
      const found = explorationActions.find((a) => a.value === subAction);
      return found?.dcInfo ?? null;
    }
    if (actionType === 'social') {
      const found = socialActions.find((a) => a.value === subAction);
      return found?.dcInfo ?? null;
    }
    return null;
  }

  async function respond(interactionId: string, response: string) {
    const trimmed = response.trim();
    if (!trimmed) return;
    setError('');
    setInteractionNotice('');
    try {
      await respondToInteraction(token, interactionId, trimmed);
      setInteractionResponses((current) => {
        const next = { ...current };
        delete next[interactionId];
        return next;
      });
      await refresh();
      setInteractionNotice('回应已提交，等待主持人继续结算。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!state) {
    return (
      <main className="shell">
        {loadError ? (
          <section className="card">
            <h1>无法加载玩家页面</h1>
            <p role="alert" className="form-error">{loadError}</p>
            <button type="button" onClick={() => window.location.reload()}>重新加载</button>
          </section>
        ) : <p>加载中...</p>}
      </main>
    );
  }
  const hasConfirmedCharacter = Boolean(state.character?.confirmed);
  const canSubmitAction = hasConfirmedCharacter && state.room.status === 'waiting_for_actions';
  const fallbackActionText = defaultActionText(actionType);
  const canSubmitCurrentAction = Boolean(action.trim() || fallbackActionText);
  const actionDisabledReason = !hasConfirmedCharacter
    ? '确认角色后才能提交本回合行动。'
    : canSubmitAction
    ? ''
    : state.room.status === 'waiting_for_interaction'
      ? (state.pendingInteractions.length > 0
        ? '请先回应下方互动请求，本回合暂不能提交新行动。'
        : '正在等待其他玩家回应互动请求，本回合暂不能提交新行动。')
      : state.room.status === 'ready_to_resolve'
        ? '所有必要行动已完成，等待主持人结算，本回合暂不能修改行动。'
        : '当前回合未开放行动提交。';
  const availableActions = state.rules?.availableActions ?? buildAvailableActions(state);
  const actionEconomy = state.rules?.actionEconomy ?? buildActionEconomy(state);
  const savingThrows = state.rules?.savingThrows ?? buildSavingThrows(state);
  const skillChecks = state.rules?.skills ?? buildSkillChecks(state);
  const characterRules: PlayerRulesSummary | undefined = state.rules ?? (state.character?.confirmed ? {
    ruleset: '5e-2014',
    actionEconomy,
    savingThrows,
    skills: skillChecks,
    availableActions,
    assumptions: []
  } : undefined);
  const hasBackpackContent = Boolean(state.character?.sheet.equipment.length)
    || Boolean(state.character?.sheet.spells.length)
    || Boolean(state.resources?.ammo.length)
    || Boolean(state.resources?.consumables.length)
    || Boolean(state.resources && (
      state.resources.currency.gp > 0
      || state.resources.currency.sp > 0
      || state.resources.currency.cp > 0
    ));
  const statusSpellSlotSummary = state.resources
    ? Object.entries(state.resources.spellSlots)
      .filter(([, slots]) => slots.total > 0 || slots.used > 0)
      .map(([level, slots]) => `${level.replace(/^level/, '')} 环 ${slots.total - slots.used}/${slots.total}`)
      .join('、')
    : '';
  const statusAmmoSummary = state.resources?.ammo.map((item) => `${item.name} ${item.current}/${item.max}`).join('、') ?? '';
  const turnSuggestionStatus = state.turnSuggestionStatus;
  const turnSuggestions = state.turnSuggestions ?? [];
  const showTurnSuggestions = canSubmitAction && !state.currentAction && activeLogTab === 'public';
  const isWaitingForTurnSuggestions = showTurnSuggestions && turnSuggestionStatus === 'missing' && (isGeneratingTurnSuggestions || turnSuggestions.length === 0);
  const hasTurnSuggestionPanel = showTurnSuggestions && (
    isWaitingForTurnSuggestions
    || turnSuggestionStatus === 'failed'
    || (turnSuggestionStatus === 'ready' && turnSuggestions.length > 0)
  );
  const playerHpText = state.character?.confirmed
    ? `${state.resources?.hitPoints.current ?? state.character.sheet.hitPoints.current}/${state.resources?.hitPoints.max ?? state.character.sheet.hitPoints.max}`
    : '未确认';
  const playerAcText = state.character?.confirmed ? String(state.character.sheet.armorClass) : '--';
  const actionStateText = state.currentAction
    ? '已提交'
    : canSubmitAction
      ? '等待你行动'
      : state.room.status === 'ready_to_resolve'
        ? '等待主持人结算'
        : state.room.status === 'waiting_for_interaction'
          ? '等待互动回应'
          : '暂未开放';
  const pendingInteractionText = state.pendingInteractions.length > 0 ? `${state.pendingInteractions.length} 个待回应` : '无';
  const suggestionCountText = turnSuggestionStatus === 'ready'
    ? `${turnSuggestions.length} 个建议`
    : turnSuggestionStatus === 'failed'
      ? '生成失败'
      : canSubmitAction && !state.currentAction
        ? '生成中'
        : '未显示';

  return (
    <main className="shell player-shell">
      <div className="page-header player-page-header">
        <div>
          <h1>{state.room.name}</h1>
          <p className="muted">玩家视图 · {state.player.name}</p>
        </div>
      </div>

      <div className="player-workbench-shell">
        <aside className="player-rail">
          <nav className="player-tab-nav" aria-label="玩家功能区">
            {playerTabs.map((tab) => (
              <button
                aria-current={activeTab === tab.id ? 'page' : undefined}
                className={activeTab === tab.id ? 'active' : ''}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <section className="player-quick-status" aria-label="玩家当前状态">
            <div>
              <span className="muted">回合</span>
              <strong>第 {state.room.currentTurn} 回合</strong>
            </div>
            <div>
              <span className="muted">行动</span>
              <strong>{actionStateText}</strong>
            </div>
            <div>
              <span className="muted">互动</span>
              <strong>{pendingInteractionText}</strong>
            </div>
            <div>
              <span className="muted">HP / AC</span>
              <strong>{playerHpText} · AC {playerAcText}</strong>
            </div>
          </section>
        </aside>

        <div className="player-workbench-main">
          <section className="player-command-strip" aria-label="本轮概览">
            <div>
              <span className="eyebrow">当前状态</span>
              <h2>{actionStateText}</h2>
              <p className="muted">{roomStatusLabel(state.room.status)} · 建议行动：{suggestionCountText}</p>
            </div>
            <div className="status-chip-grid">
              <span className={`status-chip${state.currentAction ? ' ok' : canSubmitAction ? ' warning' : ''}`}>行动：{actionStateText}</span>
              <span className={`status-chip${state.pendingInteractions.length > 0 ? ' warning' : ' ok'}`}>互动：{pendingInteractionText}</span>
              <span className="status-chip">HP：{playerHpText}</span>
              <span className="status-chip">AC：{playerAcText}</span>
            </div>
          </section>

      {activeTab === 'story' ? (
        <div className="player-story-layout">
          <section className="content-stack">
            <section className="card player-log-panel">
              <div className="inline-tab-row" role="tablist" aria-label="日志类型">
                <button className={activeLogTab === 'public' ? 'active' : ''} onClick={() => setActiveLogTab('public')} type="button">公开剧情</button>
                <button className={activeLogTab === 'private' ? 'active' : ''} onClick={() => setActiveLogTab('private')} type="button">私人剧情</button>
              </div>
              <div className="player-log-scroll" ref={logScrollRef}>
                <LogList title={activeLogTab === 'public' ? '公开剧情' : '私人剧情'} logs={activeLogTab === 'public' ? state.publicLogs : state.privateLogs} />
              </div>
            </section>
            {(state.campaignSummary || (state.quests && state.quests.length > 0) || (state.npcs && state.npcs.length > 0)) ? (
              <section className="card">
                <h2>冒险日志</h2>
                {state.campaignSummary ? (
                  <div className="subcard">
                    <strong>最近进展</strong>
                    <p className="muted">回合 {state.campaignSummary.turnStart}-{state.campaignSummary.turnEnd}</p>
                    <p>{state.campaignSummary.summary}</p>
                  </div>
                ) : null}
                {state.quests && state.quests.length > 0 ? (
                  <div>
                    <strong>任务</strong>
                    {state.quests.filter((q) => q.status === 'active' || q.status === 'in_progress').map((q) => (
                      <div className="subcard" key={q.id}>
                        <strong>{q.title}</strong> <span className="muted">[{questStatusLabel(q.status)}]</span>
                        <p>{q.description}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
                {state.npcs && state.npcs.length > 0 ? (
                  <div>
                    <strong>已知 NPC</strong>
                    {state.npcs.map((n) => (
                      <div className="subcard" key={n.id}>
                        <strong>{n.name}</strong> <span className="muted">({n.role}，{npcAttitudeLabel(n.attitude)})</span>
                        {n.location ? <p className="muted">{n.location}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
          </section>
          <aside className="side-stack">
            <TurnPanel currentTurn={state.room.currentTurn} status={state.room.status} submittedPlayers={state.submittedPlayers} waitingPlayers={state.waitingPlayers} />
            <section className="card action-card">
              <h2>你的行动</h2>
              <label>行动类型
                <select
                  value={actionType}
                  disabled={!canSubmitAction || isSubmittingAction}
                  onChange={(event) => { setActionType(event.target.value as PlayerActionType); setSubAction(''); }}
                >
                  <option value="in_character_action">角色行动</option>
                  <option value="exploration">探索行动</option>
                  <option value="social">社交行动</option>
                  <option value="observe">观察</option>
                  <option value="wait">等待</option>
                  <option value="skip">跳过本回合</option>
                  <option value="ready">准备</option>
                  <option value="follow">跟随</option>
                  <option value="combat_action">临场行动</option>
                  <option value="player_question">玩家问题</option>
                  <option value="meta_question">场外问题</option>
                </select>
              </label>
              {(actionType === 'exploration' || actionType === 'social') ? (
                <label>具体行动
                  <select value={subAction} disabled={!canSubmitAction || isSubmittingAction} onChange={(event) => setSubAction(event.target.value)}>
                    <option value="">(选择具体行动)</option>
                    {actionType === 'exploration'
                      ? explorationActions.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)
                      : socialActions.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)
                    }
                  </select>
                </label>
              ) : null}
              {subAction ? <p className="muted">预计 DC: {getSubActionDcInfo()}</p> : null}
              {state.currentAction ? (
                <div className="subcard">
                  <h3>本回合已提交</h3>
                  <p>{state.currentAction.text}</p>
                  <p className="muted">
                    {actionTypeLabel(state.currentAction.actionType)} · {actionVisibilityLabel(state.currentAction.visibility)} · {actionStatusLabel(state.currentAction.status)}
                    {state.currentAction.submittedAt ? ` · 提交时间 ${formatIsoDateTime(state.currentAction.submittedAt)}` : ''}
                  </p>
                  <p className="muted">
                    {canSubmitAction ? '可在下方修改文本后再次提交，以替换本回合行动。' : '当前回合已锁定，不能再修改本次行动。'}
                  </p>
                </div>
              ) : null}
              <label className="check-row">
                <input type="checkbox" checked={isHiddenRoll} disabled={!canSubmitAction || isSubmittingAction} onChange={(event) => setIsHiddenRoll(event.target.checked)} />
                隐藏骰点（仅玩家本人可见）
              </label>
              {hasTurnSuggestionPanel ? (
                <div className="turn-suggestions" aria-live={turnSuggestionStatus === 'missing' ? 'polite' : undefined}>
                  <div className="section-header">
                    <div>
                      <h3>本轮四个选项</h3>
                      <p className="muted">可以直接套用建议，也可以把它当灵感后自由改写。</p>
                    </div>
                  </div>
                  {isWaitingForTurnSuggestions ? <p className="muted">正在生成本轮建议...</p> : null}
                  {turnSuggestionStatus === 'failed' ? (
                    <div className="stack">
                      <p className="muted">本轮建议生成失败，可自由输入行动。</p>
                      {state.turnSuggestionError ? <p className="form-error">{state.turnSuggestionError}</p> : null}
                      <button type="button" onClick={retryTurnSuggestions} disabled={isGeneratingTurnSuggestions}>
                        {isGeneratingTurnSuggestions ? '生成中...' : '重新生成建议'}
                      </button>
                    </div>
                  ) : null}
                  {turnSuggestionStatus === 'ready' && turnSuggestions.length > 0 ? (
                    <div className="turn-suggestions-grid" aria-label="本轮 AI 行动建议">
                      {turnSuggestions.map((suggestion) => {
                        const selected = selectedSuggestionId === suggestion.id;
                        return (
                        <button
                          className={`turn-suggestion-card${selected ? ' selected' : ''}`}
                          key={suggestion.id}
                          onClick={() => applyTurnSuggestion(suggestion)}
                          aria-pressed={selected}
                          type="button"
                        >
                          <span className="turn-suggestion-title">{suggestion.title}</span>
                          <span className="turn-suggestion-meta">{actionTypeLabel(suggestion.actionType)}</span>
                          <span className="turn-suggestion-action">{suggestion.actionText}</span>
                          {suggestion.hint ? <span className="turn-suggestion-hint">{suggestion.hint}</span> : null}
                          {selected ? <span className="turn-suggestion-applied">已套用</span> : null}
                        </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <textarea
                value={action}
                disabled={!canSubmitAction || isSubmittingAction}
                onChange={(event) => {
                  setAction(event.target.value);
                  setSelectedSuggestionId('');
                  setActionNotice('');
                }}
                placeholder={fallbackActionText ? `${fallbackActionText} 可补充细节。` : '描述你的角色本回合想尝试做什么。'}
              />
              <button disabled={!canSubmitAction || !canSubmitCurrentAction || isSubmittingAction} onClick={submit}>
                {isSubmittingAction ? '提交中...' : '提交行动'}
              </button>
              {!canSubmitAction ? <p className="muted">{actionDisabledReason}</p> : null}
              {actionNotice ? <p className="form-success">{actionNotice}</p> : null}
              {error ? <p className="form-error">{error}</p> : null}
            </section>
            {interactionNotice ? <p className="form-success">{interactionNotice}</p> : null}
            {state.pendingInteractions.map((interaction) => (
              <section className="card" key={interaction.id}>
                <h2>需要回应</h2>
                <p>{interaction.prompt}</p>
                <div className="button-row">
                  <button onClick={() => respond(interaction.id, '我同意或配合。')}>同意 / 配合</button>
                  <button onClick={() => respond(interaction.id, '我反抗或拒绝。')}>反抗 / 拒绝</button>
                </div>
                <label>自定义回应
                  <textarea
                    value={interactionResponses[interaction.id] ?? ''}
                    onChange={(event) => setInteractionResponses((current) => ({ ...current, [interaction.id]: event.target.value }))}
                    placeholder="写下你的具体回应、条件或反问。"
                  />
                </label>
                <button
                  disabled={!interactionResponses[interaction.id]?.trim()}
                  onClick={() => respond(interaction.id, interactionResponses[interaction.id] ?? '')}
                >
                  提交回应
                </button>
              </section>
            ))}
          </aside>
        </div>
      ) : null}

      {activeTab === 'character' ? (
        <section className="player-tab-panel">
          {state.character?.confirmed ? (
            <CharacterCard
              character={state.character}
              resources={state.resources}
              rules={characterRules}
            />
          ) : (
            <CharacterBuilder
              token={token}
              initialDraft={state.character?.sheet.builderDraft ?? null}
              onChanged={refresh}
              setError={setError}
            />
          )}
        </section>
      ) : null}

      {activeTab === 'backpack' ? (
        <section className="card player-tab-panel">
          <h2>背包</h2>
          <p className="muted">{state.character?.sheet.name ?? state.player.name} 的可见装备、法术、消耗品和货币。</p>
          {state.character ? (
            <>
              <div className="subcard">
                <h3>装备</h3>
                {state.character.sheet.equipment.length > 0 ? (
                  <div className="inventory-grid">
                    {state.character.sheet.equipment.map((item) => {
                      const info = describeItem(item);
                      return (
                        <article className="inventory-item-card" key={item}>
                          <strong>{item}</strong>
                          <span>{info.type}</span>
                          <p>{info.detail}</p>
                        </article>
                      );
                    })}
                  </div>
                ) : <p className="muted">暂无装备。</p>}
              </div>
              <div className="subcard">
                <h3>法术</h3>
                {state.character.sheet.spells.length > 0 ? (
                  <div className="inventory-grid">
                    {state.character.sheet.spells.map((spell) => (
                      <article className="inventory-item-card" key={spell}>
                        <strong>{spell}</strong>
                        <span>法术</span>
                        <p>具体施法时间、距离和消耗以法术条目为准。</p>
                      </article>
                    ))}
                  </div>
                ) : <p className="muted">暂无法术。</p>}
              </div>
              <div className="subcard">
                <h3>弹药 / 消耗品</h3>
                {(state.resources?.ammo.length || state.resources?.consumables.length) ? (
                  <div className="inventory-grid">
                    {state.resources?.ammo.map((ammo) => {
                      const info = describeItem(ammo.name);
                      return (
                        <article className="inventory-item-card" key={ammo.name}>
                          <strong>{ammo.name}</strong>
                          <span>{info.type}</span>
                          <p>{ammo.name}: {ammo.current} / {ammo.max}</p>
                          <p>{info.detail}</p>
                        </article>
                      );
                    })}
                    {state.resources?.consumables.map((item) => {
                      const info = describeItem(item.name);
                      return (
                        <article className="inventory-item-card" key={item.name}>
                          <strong>{item.name}</strong>
                          <span>{info.type}</span>
                          <p>{item.name}: {item.quantity}</p>
                          <p>{info.detail}</p>
                        </article>
                      );
                    })}
                  </div>
                ) : null}
                {!state.resources?.ammo.length && !state.resources?.consumables.length ? <p className="muted">暂无弹药或消耗品。</p> : null}
              </div>
              <div className="subcard">
                <h3>货币</h3>
                {state.resources ? <p>{state.resources.currency.gp} gp · {state.resources.currency.sp} sp · {state.resources.currency.cp} cp</p> : <p className="muted">暂无货币记录。</p>}
              </div>
            </>
          ) : <p className="muted">确认角色后会显示背包。</p>}
          {!hasBackpackContent ? <p className="muted">当前没有可见物品。</p> : null}
        </section>
      ) : null}

      {activeTab === 'status' ? (
        <div className="player-status-layout">
          <div className="status-column">
            <section className="card">
              <h2>当前状态</h2>
              <div className="stat-grid">
                <div className="stat-tile">
                  <span className="muted">回合</span>
                  <strong>第 {state.room.currentTurn} 回合</strong>
                </div>
                <div className="stat-tile">
                  <span className="muted">房间状态</span>
                  <strong>{roomStatusLabel(state.room.status)}</strong>
                </div>
                <div className="stat-tile">
                  <span className="muted">行动提交</span>
                  <strong>{state.currentAction ? '已提交' : '未提交'}</strong>
                </div>
                <div className="stat-tile">
                  <span className="muted">等待中</span>
                  <strong>{state.waitingPlayers.length ? state.waitingPlayers.join('、') : '无人'}</strong>
                </div>
              </div>
              {state.currentAction ? (
                <div className="subcard">
                  <h3>本回合行动</h3>
                  <p>{state.currentAction.text}</p>
                  <p className="muted">{actionTypeLabel(state.currentAction.actionType)} · {actionVisibilityLabel(state.currentAction.visibility)} · {actionStatusLabel(state.currentAction.status)}</p>
                </div>
              ) : <p className="muted">你还没有提交本回合行动。</p>}
              {state.pendingInteractions.length > 0 ? (
                <p className="muted">有 {state.pendingInteractions.length} 个互动请求等待回应。</p>
              ) : null}
            </section>

            <section className="card">
              <h2>角色资源概览</h2>
              {state.character?.confirmed ? (
                <>
                  <div className="stat-grid">
                    <div className="stat-tile">
                      <span className="muted">HP</span>
                      <strong>{state.resources?.hitPoints.current ?? state.character.sheet.hitPoints.current}/{state.resources?.hitPoints.max ?? state.character.sheet.hitPoints.max}</strong>
                    </div>
                    <div className="stat-tile">
                      <span className="muted">AC</span>
                      <strong>{state.character.sheet.armorClass}</strong>
                    </div>
                    <div className="stat-tile">
                      <span className="muted">条件</span>
                      <strong>{state.resources?.conditions.length ? state.resources.conditions.join('、') : '无'}</strong>
                    </div>
                  </div>
                  {statusSpellSlotSummary ? <p>法术位：{statusSpellSlotSummary}</p> : null}
                  {statusAmmoSummary ? <p>弹药：{statusAmmoSummary}</p> : null}
                </>
              ) : <p className="muted">确认角色后会显示资源概览。</p>}
            </section>

            <section className="card">
              <h2>最近骰点</h2>
              {state.recentDiceLogs && state.recentDiceLogs.length > 0 ? (
                <>
                  {state.recentDiceLogs.map((log) => (
                    <div className="subcard" key={log.id}>
                      <p>{log.reason}：{log.die} [{log.values.join(', ')}] + {log.modifier} = {log.total}{log.success !== undefined ? (log.success ? ' (成功)' : ' (失败)') : ''}</p>
                      <p className="muted">{log.playerName} · {formatIsoDateTime(log.createdAt)}</p>
                    </div>
                  ))}
                </>
              ) : <p className="muted">暂无骰点记录。</p>}
            </section>

            <section className="card">
              <h2>最近资源变动</h2>
              {state.recentChanges && state.recentChanges.length > 0 ? (
                <>
                  {state.recentChanges.slice(0, 5).map((change) => (
                    <div className="subcard" key={change.id}>
                      <strong>{change.path}</strong>
                      <p>{String(change.before)} → {String(change.after)}</p>
                      <p className="muted">{change.reason}</p>
                    </div>
                  ))}
                </>
              ) : <p className="muted">暂无资源变动。</p>}
            </section>
          </div>
          <div className="status-column">
            <section className="card">
              <h2>临场态势</h2>
              {state.combatState ? (
                <>
                <p className="muted">第 {state.combatState.round} 轮态势 · 当前焦点：{state.combatState.participants[state.combatState.currentTurnIndex]?.name ?? '--'}</p>
                {state.combatState.participants
                  .map((p, i) => (
                    <div className="subcard" key={p.id} style={i === state.combatState!.currentTurnIndex ? { border: '2px solid #ffd700' } : undefined}>
                      <strong>{p.name}{p.isNpc ? ' (NPC)' : ''}</strong>
                      <p>顺序参考: {p.initiative ?? '--'}{p.ac !== null ? ` · 防护参考: AC ${p.ac}` : ''}</p>
                      {p.hp !== null && p.maxHp !== null ? (
                        <>
                          <div className="hp-bar-bg">
                            <div className="hp-bar-fill" style={{
                              width: `${Math.min(100, Math.round(p.hp / p.maxHp * 100))}%`,
                              background: p.hp > p.maxHp / 2 ? '#79bd74' : p.hp > 0 ? '#dfa34b' : '#de6f62'
                            }} />
                          </div>
                          <p className="muted">体力参考: {p.hp}/{p.maxHp}</p>
                        </>
                      ) : (
                        <p className="muted">状态：{combatHealthText(p.healthLabel)}</p>
                      )}
                    </div>
                  ))}
                </>
              ) : <p className="muted">当前没有锁定的临场态势；剧情会按场景描述和本回合行动推进。</p>}
            </section>

            <section className="card">
              <h2>本轮规则摘要</h2>
              {state.ruleSummaries.length ? (
                <>
                  {state.ruleSummaries.map((summary) => (
                    <div className="subcard" key={summary.entryId}>
                      <strong>{summary.title}</strong>
                      <p>{summary.summary}</p>
                      <p className="muted">{summary.reason}</p>
                    </div>
                  ))}
                </>
              ) : <p className="muted">本轮暂无规则摘要。</p>}
            </section>
          </div>
        </div>
      ) : null}
        </div>
      </div>
    </main>
  );
}
