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

interface BuiltinOptionDetail {
  summary: string;
  ruleData?: Record<string, unknown>;
  prerequisites?: Record<string, unknown>;
}

const spellcastingAtLevel1Classes = ['吟游诗人', '牧师', '德鲁伊', '术士', '邪术师', '法师'];
const divineSpellcastingClasses = ['牧师'];
const arcaneSpellcastingClasses = ['吟游诗人', '术士', '邪术师', '法师'];

const subSpeciesParents: Record<string, string[]> = {
  标准人类: ['人类'],
  变体人类: ['人类'],
  丘陵矮人: ['矮人'],
  山地矮人: ['矮人'],
  高等精灵: ['精灵'],
  木精灵: ['精灵'],
  黑暗精灵: ['精灵'],
  轻足半身人: ['半身人'],
  强心半身人: ['半身人'],
  森林侏儒: ['侏儒'],
  岩侏儒: ['侏儒'],
  龙裔血脉: ['龙裔'],
  提夫林血统: ['提夫林'],
};

const spellClassRecommendations: Record<string, string[]> = {
  光亮术: ['吟游诗人', '牧师', '法师', '术士'],
  法师之手: ['吟游诗人', '术士', '邪术师', '法师'],
  火焰箭: ['术士', '邪术师', '法师'],
  冷冻射线: ['术士', '法师'],
  魔法飞弹: ['术士', '法师'],
  护盾术: ['术士', '法师'],
  治疗伤口: ['吟游诗人', '牧师', '德鲁伊'],
  祝福术: ['牧师'],
  妖火: ['吟游诗人', '德鲁伊'],
  猎人印记: ['游侠'],
  魅惑人类: ['吟游诗人', '德鲁伊', '术士', '邪术师', '法师'],
  侦测魔法: ['吟游诗人', '牧师', '德鲁伊', '术士', '邪术师', '法师'],
  睡眠术: ['吟游诗人', '术士', '法师'],
  雷鸣波: ['吟游诗人', '德鲁伊', '术士', '法师'],
  治愈真言: ['吟游诗人', '牧师', '德鲁伊'],
};

const equipmentClassRecommendations: Record<string, string[]> = {
  匕首: ['吟游诗人', '术士', '邪术师', '法师', '游荡者'],
  长剑: ['战士', '圣武士', '游侠'],
  巨剑: ['战士', '圣武士'],
  短弓: ['游侠', '游荡者'],
  长弓: ['战士', '游侠'],
  轻弩: ['吟游诗人', '术士', '邪术师', '法师', '游荡者'],
  法杖: ['牧师', '德鲁伊', '术士', '邪术师', '法师'],
  盾牌: ['战士', '牧师', '圣武士', '德鲁伊', '游侠'],
  皮甲: ['吟游诗人', '德鲁伊', '游侠', '游荡者', '邪术师'],
  链甲: ['战士', '牧师', '圣武士'],
  鳞甲: ['牧师', '德鲁伊', '战士', '圣武士', '游侠'],
  冒险者套组: ['野蛮人', '战士', '圣武士', '游荡者'],
  探索者套组: ['德鲁伊', '游侠', '武僧'],
  学者套组: ['法师', '术士', '吟游诗人'],
  圣徽: divineSpellcastingClasses,
  奥术法器: arcaneSpellcastingClasses,
  盗贼工具: ['游荡者'],
  治疗包: ['牧师', '圣武士', '德鲁伊'],
};

const proficiencyClassRecommendations: Record<string, string[]> = {
  军用武器熟练: ['野蛮人', '战士', '圣武士', '游侠'],
  中甲熟练: ['野蛮人', '牧师', '德鲁伊', '战士', '圣武士', '游侠'],
  重甲熟练: ['战士', '牧师', '圣武士'],
  盾牌熟练: ['战士', '牧师', '德鲁伊', '圣武士', '游侠'],
  盗贼工具熟练: ['游荡者'],
  草药工具熟练: ['德鲁伊', '隐士'],
  乐器熟练: ['吟游诗人', '艺人'],
  工匠工具熟练: ['矮人', '公会工匠'],
  游戏用具熟练: ['士兵', '贵族', '罪犯'],
};

function withPrerequisites(detail: BuiltinOptionDetail, prerequisites: Record<string, unknown>): BuiltinOptionDetail {
  return {
    ...detail,
    prerequisites: {
      ...(detail.prerequisites ?? {}),
      ...prerequisites,
    },
  };
}

function builtinOption(
  optionType: CharacterBuilderOption['optionType'],
  name: string,
  summary: string,
  ruleData: Record<string, unknown> = {},
  prerequisites: Record<string, unknown> = {},
): CharacterBuilderOption {
  return {
    id: `builtin-${optionType}-${name}`,
    optionType,
    name,
    summary,
    ruleData,
    prerequisites,
    sourceRef: '5e 基础建卡选项',
  };
}

function optionFromDetail(
  optionType: CharacterBuilderOption['optionType'],
  name: string,
  detail: BuiltinOptionDetail,
): CharacterBuilderOption {
  return builtinOption(optionType, name, detail.summary, detail.ruleData ?? {}, detail.prerequisites ?? {});
}

const speciesDetails: Record<string, BuiltinOptionDetail> = {
  人类: { summary: '适应力强的常见玩家物种。', ruleData: { size: '中型', speedFt: 30, traits: ['多才多艺', '额外语言'] } },
  矮人: { summary: '坚韧、抗毒、擅长地下生活的物种。', ruleData: { size: '中型', speedFt: 25, traits: ['黑暗视觉60尺', '矮人体魄', '工具熟练'] } },
  精灵: { summary: '敏捷、长寿，拥有敏锐感官和出神能力。', ruleData: { size: '中型', speedFt: 30, traits: ['黑暗视觉60尺', '敏锐感官', '精类血统', '出神'] } },
  半身人: { summary: '小型、幸运、灵巧的玩家物种。', ruleData: { size: '小型', speedFt: 25, traits: ['幸运', '勇敢', '半身人灵巧'] } },
  龙裔: { summary: '带有龙族血脉，拥有吐息武器和伤害抗性。', ruleData: { size: '中型', speedFt: 30, traits: ['龙族祖先', '吐息武器', '伤害抗性'] } },
  侏儒: { summary: '小型、聪慧，对魔法有天然韧性。', ruleData: { size: '小型', speedFt: 25, traits: ['黑暗视觉60尺', '侏儒狡黠'] } },
  半精灵: { summary: '兼具人类适应力与精灵血统的社交型物种。', ruleData: { size: '中型', speedFt: 30, traits: ['黑暗视觉60尺', '精类血统', '技能多面手'] } },
  半兽人: { summary: '强韧、凶猛，适合近战角色。', ruleData: { size: '中型', speedFt: 30, traits: ['黑暗视觉60尺', '凶蛮攻击', '坚韧不屈'] } },
  提夫林: { summary: '带有炼狱血统，拥有火焰抗性与天生法术。', ruleData: { size: '中型', speedFt: 30, traits: ['黑暗视觉60尺', '炼狱抗性', '炼狱传承'] } },
};

const subSpeciesDetails: Record<string, BuiltinOptionDetail> = {
  标准人类: { summary: '所有属性小幅提升的人类基础版本。', ruleData: { traits: ['全属性提升'], abilityIncreases: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 } } },
  变体人类: { summary: '用专长和技能换取更明确构筑方向的人类变体。', ruleData: { traits: ['任选专长', '任选技能'], abilityIncreaseChoices: { count: 2, bonus: 1 } } },
  丘陵矮人: { summary: '额外坚韧，适合前排或耐久型角色。', ruleData: { traits: ['矮人韧性'], maxHpBonusPerLevel: 1 } },
  山地矮人: { summary: '更擅长力量和护甲的矮人分支。', ruleData: { traits: ['矮人护甲训练'], armorTraining: ['轻甲', '中甲'] } },
  高等精灵: { summary: '擅长奥术学习的精灵分支。', ruleData: { traits: ['精灵武器训练', '戏法', '额外语言'] } },
  木精灵: { summary: '速度更快，适合野外潜行和观察。', ruleData: { speedFt: 35, traits: ['精灵武器训练', '捷足', '荒野面具'] } },
  黑暗精灵: { summary: '拥有更远黑暗视觉与卓尔魔法，但受阳光敏感影响。', ruleData: { darkvisionFt: 120, traits: ['卓尔魔法', '卓尔武器训练', '阳光敏感'] } },
  轻足半身人: { summary: '更容易借体型优势隐藏。', ruleData: { traits: ['天生善匿'] } },
  强心半身人: { summary: '对毒素更有抗性。', ruleData: { traits: ['强心体魄'] } },
  森林侏儒: { summary: '与小动物交流，拥有简单幻术天赋。', ruleData: { traits: ['天生幻术师', '小兽交流'] } },
  岩侏儒: { summary: '擅长工匠和机械小装置。', ruleData: { traits: ['工匠知识', '发条匠'] } },
  龙裔血脉: { summary: '选择一种龙族祖先决定吐息伤害和抗性。', ruleData: { traits: ['龙族祖先选择', '吐息武器', '对应伤害抗性'] } },
  提夫林血统: { summary: '炼狱血统提供火焰抗性和天生法术。', ruleData: { traits: ['火焰抗性', '奇术', '炼狱传承法术'] } },
};

const classDetails: Record<string, BuiltinOptionDetail> = {
  野蛮人: { summary: '依靠狂暴和高生命值承受并输出近战伤害。', ruleData: { hitDie: 'd12', primaryAbilities: ['力量', '体质'], savingThrows: ['力量', '体质'], level1Features: ['狂暴', '无甲防御'] } },
  吟游诗人: { summary: '以魅力施法，擅长支援、技能和社交。', ruleData: { hitDie: 'd8', primaryAbilities: ['魅力'], savingThrows: ['敏捷', '魅力'], level1Features: ['施法', '吟游激励'] } },
  牧师: { summary: '神术施法者，能治疗、防护并引导神域力量。', ruleData: { hitDie: 'd8', primaryAbilities: ['感知'], savingThrows: ['感知', '魅力'], level1Features: ['施法', '神圣领域'] } },
  德鲁伊: { summary: '自然施法者，擅长控制、治疗和野外生存。', ruleData: { hitDie: 'd8', primaryAbilities: ['感知'], savingThrows: ['智力', '感知'], level1Features: ['德鲁伊语', '施法'] } },
  战士: { summary: '武器与护甲专家，一级即拥有战斗风格和恢复能力。', ruleData: { hitDie: 'd10', primaryAbilities: ['力量', '敏捷', '体质'], savingThrows: ['力量', '体质'], level1Features: ['战斗风格', '回气'] } },
  武僧: { summary: '依靠敏捷、感知和武术进行高速近战。', ruleData: { hitDie: 'd8', primaryAbilities: ['敏捷', '感知'], savingThrows: ['力量', '敏捷'], level1Features: ['无甲防御', '武术'] } },
  圣武士: { summary: '重甲近战与神圣力量结合的誓言战士。', ruleData: { hitDie: 'd10', primaryAbilities: ['力量', '魅力'], savingThrows: ['感知', '魅力'], level1Features: ['神圣感知', '圣疗'] } },
  游侠: { summary: '野外追踪者，兼具武器、探索和自然魔法成长方向。', ruleData: { hitDie: 'd10', primaryAbilities: ['敏捷', '感知'], savingThrows: ['力量', '敏捷'], level1Features: ['宿敌', '自然探索者'] } },
  游荡者: { summary: '高技能、潜行和精准打击专家。', ruleData: { hitDie: 'd8', primaryAbilities: ['敏捷'], savingThrows: ['敏捷', '智力'], level1Features: ['专精', '偷袭', '盗贼黑话'] } },
  术士: { summary: '天生奥术施法者，依靠魅力和血脉力量。', ruleData: { hitDie: 'd6', primaryAbilities: ['魅力'], savingThrows: ['体质', '魅力'], level1Features: ['施法', '术法起源'] } },
  邪术师: { summary: '与异界庇护者缔约，法术位少但恢复快。', ruleData: { hitDie: 'd8', primaryAbilities: ['魅力'], savingThrows: ['感知', '魅力'], level1Features: ['异界庇护者', '契约魔法'] } },
  法师: { summary: '依靠智力准备并施放大量奥术法术。', ruleData: { hitDie: 'd6', primaryAbilities: ['智力'], savingThrows: ['智力', '感知'], level1Features: ['施法', '奥术回响'] } },
};

const backgroundDetails: Record<string, BuiltinOptionDetail> = {
  侍僧: { summary: '宗教机构成员，熟悉仪式和神殿关系。', ruleData: { skillProficiencies: ['洞察', '宗教'], feature: '信仰庇护' } },
  罪犯: { summary: '熟悉黑市、人脉和地下规则。', ruleData: { skillProficiencies: ['欺瞒', '隐匿'], toolProficiencies: ['盗贼工具', '游戏用具'], feature: '罪犯联系人' } },
  民间英雄: { summary: '来自普通人群体，曾挺身而出。', ruleData: { skillProficiencies: ['驯兽', '求生'], toolProficiencies: ['工匠工具', '载具'], feature: '乡民款待' } },
  贵族: { summary: '拥有贵族身份、礼仪和社会关系。', ruleData: { skillProficiencies: ['历史', '说服'], toolProficiencies: ['游戏用具'], feature: '特权地位' } },
  贤者: { summary: '学术研究者，擅长知识检索。', ruleData: { skillProficiencies: ['奥秘', '历史'], feature: '研究者' } },
  士兵: { summary: '曾在军队服役，懂纪律、战场和军阶。', ruleData: { skillProficiencies: ['运动', '威吓'], toolProficiencies: ['游戏用具', '载具'], feature: '军阶' } },
  水手: { summary: '熟悉船只、航海和港口生活。', ruleData: { skillProficiencies: ['运动', '察觉'], toolProficiencies: ['航海工具', '载具'], feature: '船票' } },
  隐士: { summary: '长期隐居，拥有某种发现或启示。', ruleData: { skillProficiencies: ['医药', '宗教'], toolProficiencies: ['草药工具'], feature: '发现' } },
  艺人: { summary: '表演者，擅长取悦观众和进入演出场所。', ruleData: { skillProficiencies: ['体操', '表演'], toolProficiencies: ['易容工具', '乐器'], feature: '受欢迎的表演者' } },
  公会工匠: { summary: '隶属公会，拥有工艺、人脉和商贸身份。', ruleData: { skillProficiencies: ['洞察', '说服'], toolProficiencies: ['工匠工具'], feature: '公会会员' } },
  流浪儿: { summary: '在城市底层长大，擅长隐匿和街巷导航。', ruleData: { skillProficiencies: ['巧手', '隐匿'], toolProficiencies: ['易容工具', '盗贼工具'], feature: '城市秘密' } },
  化外之民: { summary: '来自荒野或边境，擅长生存和旅行。', ruleData: { skillProficiencies: ['运动', '求生'], toolProficiencies: ['乐器'], feature: '漂泊者' } },
};

const skillDetails: Record<string, BuiltinOptionDetail> = {
  运动: { summary: '攀爬、跳跃、游泳、冲撞等力量活动。', ruleData: { ability: '力量', typicalUses: ['攀爬', '跳跃', '游泳', '擒抱或挣脱'] } },
  体操: { summary: '平衡、翻滚、逃脱束缚等敏捷动作。', ruleData: { ability: '敏捷', typicalUses: ['保持平衡', '翻滚', '躲过坠落危险'] } },
  巧手: { summary: '偷取、藏物、细致手部动作。', ruleData: { ability: '敏捷', typicalUses: ['扒窃', '藏匿小物件', '手部戏法'] } },
  隐匿: { summary: '潜行、躲藏、避免被发现。', ruleData: { ability: '敏捷', typicalUses: ['潜行', '躲藏', '伏击前隐藏'] } },
  奥秘: { summary: '辨识魔法、位面、符文和奥术传统。', ruleData: { ability: '智力', typicalUses: ['辨识法术效果', '研究魔法符文', '回忆位面知识'] } },
  历史: { summary: '王国、战争、人物和古代事件知识。', ruleData: { ability: '智力', typicalUses: ['回忆历史事件', '辨认古代标志'] } },
  调查: { summary: '分析线索、搜索机关、推理结论。', ruleData: { ability: '智力', typicalUses: ['搜查房间', '分析线索', '发现机关规律'] } },
  自然: { summary: '动植物、天气、地形和自然知识。', ruleData: { ability: '智力', typicalUses: ['辨识野兽', '判断天气', '识别植物'] } },
  宗教: { summary: '神祇、仪式、圣徽和不死生物知识。', ruleData: { ability: '智力', typicalUses: ['辨识宗教仪式', '回忆神祇传说'] } },
  驯兽: { summary: '安抚、驾驭或判断动物意图。', ruleData: { ability: '感知', typicalUses: ['安抚坐骑', '控制动物', '判断野兽状态'] } },
  洞察: { summary: '判断意图、谎言、情绪和动机。', ruleData: { ability: '感知', typicalUses: ['判断是否说谎', '读懂情绪', '识破动机'] } },
  医药: { summary: '稳定濒死生物、诊断病症。', ruleData: { ability: '感知', typicalUses: ['稳定伤者', '诊断疾病或毒素'] } },
  察觉: { summary: '看、听、闻到隐藏威胁或线索。', ruleData: { ability: '感知', typicalUses: ['发现埋伏', '听见动静', '注意细节'] } },
  求生: { summary: '追踪、觅食、导航和野外求生。', ruleData: { ability: '感知', typicalUses: ['追踪足迹', '寻找食水', '野外导航'] } },
  欺瞒: { summary: '撒谎、伪装意图、误导他人。', ruleData: { ability: '魅力', typicalUses: ['说谎', '虚张声势', '伪造意图'] } },
  威吓: { summary: '通过威胁、气势或暴力暗示迫使让步。', ruleData: { ability: '魅力', typicalUses: ['逼问', '震慑', '威胁谈判'] } },
  表演: { summary: '音乐、戏剧、舞蹈和公开演出。', ruleData: { ability: '魅力', typicalUses: ['演奏', '演戏', '吸引观众'] } },
  说服: { summary: '用理性、礼貌或诚意影响他人。', ruleData: { ability: '魅力', typicalUses: ['谈判', '请求帮助', '缓和冲突'] } },
};

const equipmentDetails: Record<string, BuiltinOptionDetail> = {
  匕首: { summary: '轻型灵巧近战武器，可投掷。', ruleData: { category: '武器', weaponType: '简易近战', damage: '1d4', damageType: '穿刺', properties: ['轻型', '灵巧', '投掷20/60尺'], weightLb: 1, valueGp: 2 } },
  长剑: { summary: '常见军用近战武器，可单手或双手使用。', ruleData: { category: '武器', weaponType: '军用近战', damage: '1d8', versatileDamage: '1d10', damageType: '挥砍', properties: ['多用'], weightLb: 3, valueGp: 15 } },
  巨剑: { summary: '重型双手剑，造成稳定高额挥砍伤害。', ruleData: { category: '武器', weaponType: '军用近战', damage: '2d6', damageType: '挥砍', properties: ['重型', '双手'], weightLb: 6, valueGp: 50 } },
  短弓: { summary: '简易远程武器，适合轻装角色。', ruleData: { category: '武器', weaponType: '简易远程', damage: '1d6', damageType: '穿刺', rangeFt: '80/320', properties: ['弹药', '双手'], weightLb: 2, valueGp: 25 } },
  长弓: { summary: '远距离军用弓，射程和伤害优秀。', ruleData: { category: '武器', weaponType: '军用远程', damage: '1d8', damageType: '穿刺', rangeFt: '150/600', properties: ['弹药', '重型', '双手'], weightLb: 2, valueGp: 50 } },
  轻弩: { summary: '简易远程弩，伤害较高但装填较慢。', ruleData: { category: '武器', weaponType: '简易远程', damage: '1d8', damageType: '穿刺', rangeFt: '80/320', properties: ['弹药', '装填', '双手'], weightLb: 5, valueGp: 25 } },
  法杖: { summary: '可作奥术法器，也可作为木棍武器。', ruleData: { category: '武器/法器', weaponType: '简易近战', damage: '1d6', versatileDamage: '1d8', damageType: '钝击', properties: ['多用', '可作奥术法器'], weightLb: 4, valueGp: 5 } },
  盾牌: { summary: '持用时 AC +2，需要盾牌熟练避免惩罚。', ruleData: { category: '护甲', armorType: '盾牌', acBonus: 2, weightLb: 6, valueGp: 10 } },
  皮甲: { summary: '轻甲，基础 AC 11 + 敏捷调整值。', ruleData: { category: '护甲', armorType: '轻甲', baseAc: 11, dexBonus: '完整敏捷调整值', stealthDisadvantage: false, weightLb: 10, valueGp: 10 } },
  链甲: { summary: '重甲，基础 AC 16，不加敏捷，潜行劣势。', ruleData: { category: '护甲', armorType: '重甲', baseAc: 16, dexBonus: '不适用', strengthRequirement: 13, stealthDisadvantage: true, weightLb: 55, valueGp: 75 } },
  鳞甲: { summary: '中甲，基础 AC 14 + 敏捷调整值最高 +2。', ruleData: { category: '护甲', armorType: '中甲', baseAc: 14, maxDexBonus: 2, stealthDisadvantage: true, weightLb: 45, valueGp: 50 } },
  冒险者套组: { summary: '常用地下城探索装备包。', ruleData: { category: '装备包', valueGp: 12, contents: ['背包', '撬棍', '锤子', '岩钉10枚', '火把10支', '口粮10天', '水袋', '麻绳50尺'] } },
  探索者套组: { summary: '野外旅行与探索装备包。', ruleData: { category: '装备包', valueGp: 10, contents: ['背包', '铺盖卷', '餐具', '火绒盒', '火把10支', '口粮10天', '水袋', '麻绳50尺'] } },
  学者套组: { summary: '研究和记录用装备包。', ruleData: { category: '装备包', valueGp: 40, contents: ['背包', '学识书籍', '墨水', '墨水笔', '羊皮纸10张', '小刀'] } },
  圣徽: { summary: '神术施法焦点。', ruleData: { category: '施法焦点', focusType: '神术', valueGp: 5, uses: ['作为牧师或圣武士法术材料成分焦点'] } },
  奥术法器: { summary: '奥术施法焦点。', ruleData: { category: '施法焦点', focusType: '奥术', valueGp: 10, uses: ['作为法师、术士或邪术师法术材料成分焦点'] } },
  盗贼工具: { summary: '开锁和拆除小型机关的工具组。', ruleData: { category: '工具', valueGp: 25, uses: ['开锁', '解除陷阱', '处理机械机关'], requiresProficiencyForBonus: true } },
  治疗包: { summary: '含 10 次用途，可稳定濒死生物。', ruleData: { category: '消耗品', charges: 10, effect: '花费一次用途稳定0HP生物，无需医药检定', valueGp: 5, weightLb: 3 } },
};

const spellDetails: Record<string, BuiltinOptionDetail> = {
  光亮术: { summary: '让一个物体发出明亮光照。', ruleData: { level: 0, school: '塑能', castingTime: '1动作', rangeFt: '接触', duration: '1小时', components: ['V', 'M'], effect: '目标物体发出20尺明亮光和额外20尺微光。' } },
  法师之手: { summary: '召唤一只可远程操纵物体的幽灵手。', ruleData: { level: 0, school: '咒法', castingTime: '1动作', rangeFt: 30, duration: '1分钟', components: ['V', 'S'], effect: '创造一只幽灵手，可操作物体但不能攻击。' } },
  火焰箭: { summary: '远程法术攻击，命中造成火焰伤害。', ruleData: { level: 0, school: '塑能', castingTime: '1动作', rangeFt: 120, attack: '远程法术攻击', damage: '1d10', damageType: '火焰', components: ['V', 'S'] } },
  冷冻射线: { summary: '远程法术攻击，造成寒冷伤害并减速。', ruleData: { level: 0, school: '塑能', castingTime: '1动作', rangeFt: 60, attack: '远程法术攻击', damage: '1d8', damageType: '寒冷', effect: '目标速度到施法者下回合开始前减少10尺。', components: ['V', 'S'] } },
  魔法飞弹: { summary: '自动命中的力场飞弹。', ruleData: { level: 1, school: '塑能', castingTime: '1动作', rangeFt: 120, duration: '立即', damage: '3 x (1d4+1)', damageType: '力场', hit: '自动命中', components: ['V', 'S'] } },
  护盾术: { summary: '反应施法，短暂提高 AC 并抵挡魔法飞弹。', ruleData: { level: 1, school: '防护', castingTime: '1反应', trigger: '被攻击命中或成为魔法飞弹目标', rangeFt: '自身', duration: '直到下回合开始', acBonus: 5, effect: '对触发攻击也生效，并免疫魔法飞弹。', components: ['V', 'S'] } },
  治疗伤口: { summary: '接触治疗一个生物。', ruleData: { level: 1, school: '塑能', castingTime: '1动作', rangeFt: '接触', healing: '1d8 + 施法关键属性调整值', components: ['V', 'S'] } },
  祝福术: { summary: '增强最多三个生物的攻击检定和豁免。', ruleData: { level: 1, school: '惑控', castingTime: '1动作', rangeFt: 30, duration: '专注，最多1分钟', concentration: true, targets: 3, effect: '目标进行攻击检定或豁免时额外加1d4。', components: ['V', 'S', 'M'] } },
  妖火: { summary: '让区域内目标显形，攻击者更容易命中。', ruleData: { level: 1, school: '塑能', castingTime: '1动作', rangeFt: 60, area: '20尺立方', save: '敏捷', duration: '专注，最多1分钟', concentration: true, effect: '豁免失败者被光包围，针对其攻击具有优势，且不能受隐形获益。', components: ['V'] } },
  猎人印记: { summary: '标记目标，武器命中时追加伤害。', ruleData: { level: 1, school: '预言', castingTime: '1附赠动作', rangeFt: 90, duration: '专注，最多1小时', concentration: true, bonusDamage: '1d6', damageTrigger: '武器攻击命中被标记目标', components: ['V'] } },
  魅惑人类: { summary: '尝试让一个类人生物把你视为友善熟人。', ruleData: { level: 1, school: '惑控', castingTime: '1动作', rangeFt: 30, save: '感知', duration: '1小时', condition: '魅惑', limitation: '目标在法术结束后知道曾被魅惑。', components: ['V', 'S'] } },
  侦测魔法: { summary: '感知附近魔法存在和魔法学派。', ruleData: { level: 1, school: '预言', castingTime: '1动作', rangeFt: '自身30尺范围', duration: '专注，最多10分钟', concentration: true, ritual: true, effect: '感知30尺内魔法；可用动作看见可见物体或生物上的微弱灵光并辨识学派。', components: ['V', 'S'] } },
  睡眠术: { summary: '按生命值总量使范围内生物陷入睡眠。', ruleData: { level: 1, school: '惑控', castingTime: '1动作', rangeFt: 90, area: '20尺半径', duration: '1分钟', hpPool: '5d8', condition: '失能/昏迷式睡眠', components: ['V', 'S', 'M'] } },
  雷鸣波: { summary: '近身范围冲击波，造成雷鸣伤害并推开目标。', ruleData: { level: 1, school: '塑能', castingTime: '1动作', rangeFt: '自身15尺立方', save: '体质', damage: '2d8', damageType: '雷鸣', effect: '豁免失败被推开10尺；成功伤害减半且不被推开。', components: ['V', 'S'] } },
  治愈真言: { summary: '远程附赠动作治疗。', ruleData: { level: 1, school: '塑能', castingTime: '1附赠动作', rangeFt: 60, healing: '1d4 + 施法关键属性调整值', components: ['V'] } },
};

const languageDetails: Record<string, BuiltinOptionDetail> = Object.fromEntries(
  ['通用语', '矮人语', '精灵语', '巨人语', '侏儒语', '地精语', '半身人语', '兽人语', '龙语', '炼狱语', '天界语', '深渊语', '地下通用语']
    .map((name) => [name, { summary: `常见 5e 语言：${name}。`, ruleData: { category: '语言' } }])
);

const proficiencyDetails: Record<string, BuiltinOptionDetail> = {
  简易武器熟练: { summary: '可将熟练加值加入简易武器攻击检定。', ruleData: { category: '武器熟练', appliesTo: '简易武器攻击检定' } },
  军用武器熟练: { summary: '可将熟练加值加入军用武器攻击检定。', ruleData: { category: '武器熟练', appliesTo: '军用武器攻击检定' } },
  轻甲熟练: { summary: '穿轻甲时可正常施法并避免护甲熟练惩罚。', ruleData: { category: '护甲熟练', appliesTo: '轻甲' } },
  中甲熟练: { summary: '穿中甲时可正常施法并避免护甲熟练惩罚。', ruleData: { category: '护甲熟练', appliesTo: '中甲' } },
  重甲熟练: { summary: '穿重甲时可正常施法并避免护甲熟练惩罚。', ruleData: { category: '护甲熟练', appliesTo: '重甲' } },
  盾牌熟练: { summary: '持用盾牌时可正常获得 AC 加值并避免熟练惩罚。', ruleData: { category: '护甲熟练', appliesTo: '盾牌', acBonus: 2 } },
  盗贼工具熟练: { summary: '使用盗贼工具开锁或解除机关时加入熟练加值。', ruleData: { category: '工具熟练', appliesTo: '盗贼工具' } },
  草药工具熟练: { summary: '制作或辨识草药、药剂相关检定可加入熟练加值。', ruleData: { category: '工具熟练', appliesTo: '草药工具' } },
  乐器熟练: { summary: '使用所选乐器表演或相关检定可加入熟练加值。', ruleData: { category: '工具熟练', appliesTo: '乐器' } },
  工匠工具熟练: { summary: '使用所选工匠工具制作、修理或鉴定物品时加入熟练加值。', ruleData: { category: '工具熟练', appliesTo: '工匠工具' } },
  游戏用具熟练: { summary: '进行所选游戏用具相关检定时加入熟练加值。', ruleData: { category: '工具熟练', appliesTo: '游戏用具' } },
};

const builtinCharacterBuilderOptions: CharacterBuilderOption[] = [
  ...['人类', '矮人', '精灵', '半身人', '龙裔', '侏儒', '半精灵', '半兽人', '提夫林']
    .map((name) => optionFromDetail('species', name, speciesDetails[name])),
  ...[
    '标准人类',
    '变体人类',
    '丘陵矮人',
    '山地矮人',
    '高等精灵',
    '木精灵',
    '黑暗精灵',
    '轻足半身人',
    '强心半身人',
    '森林侏儒',
    '岩侏儒',
    '龙裔血脉',
    '提夫林血统'
  ].map((name) => optionFromDetail('subspecies', name, withPrerequisites(subSpeciesDetails[name], { species: subSpeciesParents[name] ?? [] }))),
  ...['野蛮人', '吟游诗人', '牧师', '德鲁伊', '战士', '武僧', '圣武士', '游侠', '游荡者', '术士', '邪术师', '法师']
    .map((name) => optionFromDetail('class', name, classDetails[name])),
  ...['侍僧', '罪犯', '民间英雄', '贵族', '贤者', '士兵', '水手', '隐士', '艺人', '公会工匠', '流浪儿', '化外之民']
    .map((name) => optionFromDetail('background', name, backgroundDetails[name])),
  ...['运动', '体操', '巧手', '隐匿', '奥秘', '历史', '调查', '自然', '宗教', '驯兽', '洞察', '医药', '察觉', '求生', '欺瞒', '威吓', '表演', '说服']
    .map((name) => optionFromDetail('skill', name, skillDetails[name])),
  ...['匕首', '长剑', '巨剑', '短弓', '长弓', '轻弩', '法杖', '盾牌', '皮甲', '链甲', '鳞甲', '冒险者套组', '探索者套组', '学者套组', '圣徽', '奥术法器', '盗贼工具', '治疗包']
    .map((name) => optionFromDetail('equipment', name, withPrerequisites(equipmentDetails[name], { recommendedForClassNames: equipmentClassRecommendations[name] ?? [] }))),
  ...['光亮术', '法师之手', '火焰箭', '冷冻射线', '魔法飞弹', '护盾术', '治疗伤口', '祝福术', '妖火', '猎人印记', '魅惑人类', '侦测魔法', '睡眠术', '雷鸣波', '治愈真言']
    .map((name) => optionFromDetail('spell', name, withPrerequisites(spellDetails[name], {
      requiresSpellcastingAtLevel1: true,
      classNames: spellClassRecommendations[name] ?? spellcastingAtLevel1Classes,
    }))),
  ...['通用语', '矮人语', '精灵语', '巨人语', '侏儒语', '地精语', '半身人语', '兽人语', '龙语', '炼狱语', '天界语', '深渊语', '地下通用语']
    .map((name) => optionFromDetail('language', name, languageDetails[name])),
  ...['简易武器熟练', '军用武器熟练', '轻甲熟练', '中甲熟练', '重甲熟练', '盾牌熟练', '盗贼工具熟练', '草药工具熟练', '乐器熟练', '工匠工具熟练', '游戏用具熟练']
    .map((name) => optionFromDetail('proficiency', name, withPrerequisites(proficiencyDetails[name], { recommendedForClassNames: proficiencyClassRecommendations[name] ?? [] }))),
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

function groupOptions(options: CharacterBuilderOption[]): CharacterBuilderOptions {
  return {
    species: options.filter((o) => o.optionType === 'species'),
    subSpecies: options.filter((o) => o.optionType === 'subspecies'),
    classes: options.filter((o) => o.optionType === 'class'),
    backgrounds: options.filter((o) => o.optionType === 'background'),
    skills: options.filter((o) => o.optionType === 'skill'),
    equipment: options.filter((o) => o.optionType === 'equipment'),
    spells: options.filter((o) => o.optionType === 'spell'),
    languages: options.filter((o) => o.optionType === 'language'),
    proficiencies: options.filter((o) => o.optionType === 'proficiency'),
  };
}

function defaultCharacterBuilderOptions(): CharacterBuilderOptions {
  return groupOptions(mergeOptionsWithBuiltins([]));
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

  return groupOptions(options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return [];
}

function optionPrerequisites(option: CharacterBuilderOption): Record<string, unknown> {
  return isRecord(option.prerequisites) ? option.prerequisites : {};
}

function hasPrerequisiteMismatch(draft: CharacterBuilderDraft, option: CharacterBuilderOption): string | null {
  const prerequisites = optionPrerequisites(option);
  const species = stringList(prerequisites.species);
  if (species.length > 0 && (!draft.species || !species.includes(draft.species))) {
    return `${option.name} 仅适用于：${species.join('、')}`;
  }

  const classNames = stringList(prerequisites.classNames);
  if (classNames.length > 0 && (!draft.className || !classNames.includes(draft.className))) {
    return `${option.name} 仅适用于职业：${classNames.join('、')}`;
  }

  const backgrounds = stringList(prerequisites.backgrounds);
  if (backgrounds.length > 0 && (!draft.background || !backgrounds.includes(draft.background))) {
    return `${option.name} 仅适用于背景：${backgrounds.join('、')}`;
  }

  if (prerequisites.requiresSpellcastingAtLevel1 === true && !spellcastingAtLevel1Classes.includes(draft.className)) {
    return `${option.name} 需要一级即可施法的职业`;
  }

  return null;
}

function findOption(options: CharacterBuilderOption[], name: string): CharacterBuilderOption | undefined {
  return options.find((option) => option.name === name);
}

function auditSingleChoice(
  draft: CharacterBuilderDraft,
  issues: CharacterBuilderAuditIssue[],
  warnings: CharacterBuilderAuditIssue[],
  options: CharacterBuilderOption[],
  field: string,
  value: string,
): void {
  if (!value) return;
  const option = findOption(options, value);
  if (!option) {
    warnings.push({ field, message: `${value} 是自定义项，请由 DM 复核。` });
    return;
  }

  const mismatch = hasPrerequisiteMismatch(draft, option);
  if (mismatch) {
    issues.push({ field, message: mismatch });
  }

  if (optionPrerequisites(option).reviewOnly === true) {
    warnings.push({ field, message: `${value} 标记为需复核，请由 DM 确认。` });
  }
}

function auditMultiChoice(
  draft: CharacterBuilderDraft,
  issues: CharacterBuilderAuditIssue[],
  warnings: CharacterBuilderAuditIssue[],
  options: CharacterBuilderOption[],
  field: string,
  values: string[],
): void {
  for (const value of values) {
    auditSingleChoice(draft, issues, warnings, options, field, value);
  }
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
    subSpecies: '',
    className: '',
    classDetail: '',
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
    subSpecies: typeof raw.subSpecies === 'string' ? raw.subSpecies.trim() : defaults.subSpecies,
    className: typeof raw.className === 'string' ? raw.className.trim() : defaults.className,
    classDetail: typeof raw.classDetail === 'string' ? raw.classDetail.trim() : defaults.classDetail,
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

export function auditCharacterBuilderDraft(draft: CharacterBuilderDraft, options: CharacterBuilderOptions = defaultCharacterBuilderOptions()): CharacterBuilderAudit {
  const issues: CharacterBuilderAuditIssue[] = [];
  const warnings: CharacterBuilderAuditIssue[] = [];
  const abilityLabels: Record<keyof CharacterBuilderDraft['abilityScores'], string> = {
    str: '力量',
    dex: '敏捷',
    con: '体质',
    int: '智力',
    wis: '感知',
    cha: '魅力',
  };

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
      issues.push({ field: 'abilityScores', message: `${abilityLabels[key]}属性值必须在 1-30 之间` });
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

  auditSingleChoice(draft, issues, warnings, options.species, 'species', draft.species);
  auditSingleChoice(draft, issues, warnings, options.subSpecies, 'subSpecies', draft.subSpecies);
  auditSingleChoice(draft, issues, warnings, options.classes, 'className', draft.className);
  auditSingleChoice(draft, issues, warnings, options.backgrounds, 'background', draft.background);
  auditMultiChoice(draft, issues, warnings, options.skills, 'skills', draft.skills);
  auditMultiChoice(draft, issues, warnings, options.equipment, 'equipment', draft.equipment);
  auditMultiChoice(draft, issues, warnings, options.spells, 'spells', draft.spells);
  auditMultiChoice(draft, issues, warnings, options.languages, 'languages', draft.languages);
  auditMultiChoice(draft, issues, warnings, options.proficiencies, 'proficiencies', draft.proficiencies);

  return { valid: issues.length === 0, issues, warnings };
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
    subSpecies: draft.subSpecies,
    className: draft.className,
    classDetail: draft.classDetail,
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
