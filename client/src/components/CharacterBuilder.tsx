import { useEffect, useMemo, useState } from 'react';
import {
  auditCharacterBuilderDraft,
  confirmCharacterBuilderDraft,
  getCharacterBuilderOptions,
  saveCharacterBuilderDraft
} from '../api';
import type {
  CharacterBuilderAudit,
  CharacterBuilderDraft,
  CharacterBuilderOption,
  CharacterBuilderOptions,
  JsonValue
} from '../types';

const defaultDraft: CharacterBuilderDraft = {
  name: '新英雄',
  concept: '',
  species: '',
  subSpecies: '',
  className: '',
  classDetail: '',
  background: '',
  abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
  skills: [],
  equipment: [],
  spells: [],
  languages: [],
  proficiencies: [],
  personality: '',
  ideal: '',
  bond: '',
  flaw: '',
  notes: ''
};

const emptyCharacterBuilderOptions: CharacterBuilderOptions = {
  species: [],
  subSpecies: [],
  classes: [],
  backgrounds: [],
  skills: [],
  equipment: [],
  spells: [],
  languages: [],
  proficiencies: []
};

const abilityKeys = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const abilityLabels: Record<(typeof abilityKeys)[number], string> = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  wis: '感知',
  cha: '魅力'
};
const abilityPresets: Array<{ name: string; scores: CharacterBuilderDraft['abilityScores'] }> = [
  { name: '均衡', scores: { str: 13, dex: 13, con: 14, int: 12, wis: 12, cha: 10 } },
  { name: '武技', scores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 } },
  { name: '敏捷', scores: { str: 8, dex: 15, con: 14, int: 12, wis: 13, cha: 10 } },
  { name: '施法', scores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 } },
  { name: '社交', scores: { str: 8, dex: 13, con: 12, int: 10, wis: 14, cha: 15 } }
];

const fallbackRandomOptions = {
  names: ['洛林', '米拉', '艾瑞克', '赛琳', '托恩', '娜雅'],
  species: ['人类', '精灵', '矮人', '半身人'],
  subSpecies: ['标准人类', '变体人类', '高等精灵', '丘陵矮人', '轻足半身人'],
  classes: ['战士', '法师', '牧师', '游荡者', '游侠'],
  backgrounds: ['士兵', '贤者', '民间英雄', '罪犯', '艺人'],
  skills: ['运动', '察觉', '调查', '洞察', '说服', '隐匿'],
  equipment: ['长剑', '盾牌', '短弓', '皮甲', '冒险者套组', '治疗包'],
  spells: ['光亮术', '法师之手', '魔法飞弹', '治疗伤口'],
  languages: ['通用语', '精灵语', '矮人语', '半身人语'],
  proficiencies: ['轻甲熟练', '盾牌熟练', '盗贼工具熟练']
};

const classDetailsByClass: Record<string, string[]> = {
  战士: ['防御战斗风格', '决斗战斗风格', '箭术战斗风格'],
  牧师: ['生命领域', '光明领域', '知识领域'],
  法师: ['塑能学派倾向', '防护学派倾向', '预言学派倾向'],
  游荡者: ['盗贼训练', '刺客训练', '奥术骗术倾向'],
  游侠: ['弓术专长', '双武器专长', '荒野追踪者'],
  圣武士: ['防御战斗风格', '保护战斗风格', '奉献誓言倾向'],
  术士: ['龙族血脉', '狂野魔法血脉'],
  邪术师: ['魔契庇护者：妖精', '魔契庇护者：邪魔', '魔契庇护者：旧日支配者']
};

type BuilderStepId = 'basic' | 'species' | 'class' | 'abilities' | 'skills' | 'equipment' | 'story' | 'review';

const steps: Array<{ id: BuilderStepId; label: string }> = [
  { id: 'basic', label: '基础身份' },
  { id: 'species', label: '种族' },
  { id: 'class', label: '职业' },
  { id: 'abilities', label: '属性值' },
  { id: 'skills', label: '技能 / 熟练' },
  { id: 'equipment', label: '装备' },
  { id: 'story', label: '人格 / 背景' },
  { id: 'review', label: '复核确认' }
];

const auditFieldLabels: Record<string, string> = {
  name: '角色姓名',
  concept: '角色概念',
  species: '种族',
  subSpecies: '子种族 / 血统',
  className: '职业',
  classDetail: '职业细节',
  background: '背景',
  abilityScores: '属性值',
  skills: '技能',
  equipment: '装备',
  spells: '法术 / 能力',
  languages: '语言',
  proficiencies: '工具 / 武器 / 护甲熟练',
  personality: '性格',
  ideal: '理想',
  bond: '牵绊',
  flaw: '缺点',
  notes: '背景摘要'
};

function auditFieldLabel(field: string | undefined): string {
  if (!field) return '字段';
  return auditFieldLabels[field] ?? field;
}

function toggleItem(arr: string[], item: string): string[] {
  return arr.includes(item) ? arr.filter(i => i !== item) : [...arr, item];
}

function addItem(arr: string[], item: string): string[] {
  const normalized = item.trim();
  if (!normalized || arr.includes(normalized)) return arr;
  return [...arr, normalized];
}

function randomFrom<T>(items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

function randomMany(options: CharacterBuilderOption[], fallback: string[], count: number): string[] {
  const source = options.length > 0 ? options.map(option => option.name) : fallback;
  const selected: string[] = [];
  const pool = [...source];
  while (pool.length > 0 && selected.length < count) {
    const index = Math.floor(Math.random() * pool.length);
    const [item] = pool.splice(index, 1);
    if (item && !selected.includes(item)) selected.push(item);
  }
  return selected;
}

function randomCompatibleOptionName(allOptions: CharacterBuilderOption[], compatible: CharacterBuilderOption[], fallback: string[]): string {
  if (allOptions.length > 0) return randomFrom(compatible)?.name ?? '';
  return randomFrom(fallback) ?? '';
}

function randomManyCompatible(allOptions: CharacterBuilderOption[], compatible: CharacterBuilderOption[], fallback: string[], count: number): string[] {
  if (allOptions.length > 0) return randomMany(compatible, [], count);
  return randomMany([], fallback, count);
}

function approvedValue(options: CharacterBuilderOption[], value: string): string {
  return options.some(option => option.name === value) ? value : '';
}

const spellcastingAtLevel1Classes = ['吟游诗人', '牧师', '德鲁伊', '术士', '邪术师', '法师'];

const ruleLabels: Record<string, string> = {
  ability: '关联属性',
  abilityIncreases: '属性提升',
  acBonus: 'AC加值',
  armorTraining: '护甲训练',
  armorType: '护甲类型',
  area: '范围',
  attack: '攻击',
  baseAc: '基础AC',
  bonusDamage: '额外伤害',
  castingTime: '施法时间',
  category: '类别',
  charges: '使用次数',
  components: '法术成分',
  concentration: '专注',
  condition: '状态',
  contents: '内容',
  damage: '伤害',
  damageTrigger: '伤害触发',
  damageType: '伤害类型',
  darkvisionFt: '黑暗视觉',
  dexBonus: '敏捷加值',
  duration: '持续时间',
  effect: '效果',
  feature: '背景特性',
  focusType: '法器类型',
  healing: '治疗',
  hit: '命中',
  hitDie: '生命骰',
  hpPool: '生命值池',
  level: '环阶',
  level1Features: '一级特性',
  maxDexBonus: '敏捷上限',
  maxHpBonusPerLevel: '每级生命值加值',
  primaryAbilities: '关键属性',
  properties: '属性',
  rangeFt: '距离',
  ritual: '仪式',
  save: '豁免',
  savingThrows: '豁免熟练',
  school: '学派',
  size: '体型',
  skillProficiencies: '技能熟练',
  speedFt: '速度',
  stealthDisadvantage: '潜行劣势',
  strengthRequirement: '力量需求',
  targets: '目标数量',
  toolProficiencies: '工具熟练',
  traits: '特性',
  typicalUses: '常见用途',
  uses: '用途',
  valueGp: '价格(gp)',
  versatileDamage: '双手伤害',
  weaponType: '武器类型',
  weightLb: '重量(lb)'
};

function isRuleRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: JsonValue | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return [];
}

function optionPrerequisites(option: CharacterBuilderOption): { [key: string]: JsonValue } {
  return isRuleRecord(option.prerequisites) ? option.prerequisites : {};
}

function prerequisiteMismatch(draft: CharacterBuilderDraft, option: CharacterBuilderOption): string {
  const prerequisites = optionPrerequisites(option);
  const species = stringList(prerequisites.species);
  if (species.length > 0 && (!draft.species || !species.includes(draft.species))) {
    return `仅适用于：${species.join('、')}`;
  }

  const classNames = stringList(prerequisites.classNames);
  if (classNames.length > 0 && (!draft.className || !classNames.includes(draft.className))) {
    return `仅适用于职业：${classNames.join('、')}`;
  }

  const backgrounds = stringList(prerequisites.backgrounds);
  if (backgrounds.length > 0 && (!draft.background || !backgrounds.includes(draft.background))) {
    return `仅适用于背景：${backgrounds.join('、')}`;
  }

  if (prerequisites.requiresSpellcastingAtLevel1 === true && !spellcastingAtLevel1Classes.includes(draft.className)) {
    return '需要一级即可施法的职业';
  }

  return '';
}

function optionMatchesDraft(draft: CharacterBuilderDraft, option: CharacterBuilderOption): boolean {
  return prerequisiteMismatch(draft, option) === '';
}

function isRecommendedForDraft(draft: CharacterBuilderDraft, option: CharacterBuilderOption, extraRecommendedNames: string[] = []): boolean {
  if (extraRecommendedNames.includes(option.name)) {
    return true;
  }
  const prerequisites = optionPrerequisites(option);
  const recommendedClasses = stringList(prerequisites.recommendedForClassNames);
  if (recommendedClasses.length > 0 && draft.className && recommendedClasses.includes(draft.className)) {
    return true;
  }

  return false;
}

function compatibleOptions(options: CharacterBuilderOption[], draft: CharacterBuilderDraft): CharacterBuilderOption[] {
  return options.filter(option => optionMatchesDraft(draft, option));
}

function sanitizeSingleChoice(value: string, allOptions: CharacterBuilderOption[], draft: CharacterBuilderDraft): string {
  if (!value) return value;
  const option = allOptions.find(item => item.name === value);
  if (!option) return value;
  return optionMatchesDraft(draft, option) ? value : '';
}

function sanitizeMultiChoice(values: string[], allOptions: CharacterBuilderOption[], draft: CharacterBuilderDraft): string[] {
  return values.filter(value => {
    const option = allOptions.find(item => item.name === value);
    return !option || optionMatchesDraft(draft, option);
  });
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sanitizeDraftForOptions(draft: CharacterBuilderDraft, options: CharacterBuilderOptions): CharacterBuilderDraft {
  const next = {
    ...draft,
    subSpecies: sanitizeSingleChoice(draft.subSpecies, options.subSpecies, draft),
    skills: sanitizeMultiChoice(draft.skills, options.skills, draft),
    equipment: sanitizeMultiChoice(draft.equipment, options.equipment, draft),
    spells: sanitizeMultiChoice(draft.spells, options.spells, draft),
    languages: sanitizeMultiChoice(draft.languages, options.languages, draft),
    proficiencies: sanitizeMultiChoice(draft.proficiencies, options.proficiencies, draft)
  };

  if (
    next.subSpecies === draft.subSpecies &&
    sameStringArray(next.skills, draft.skills) &&
    sameStringArray(next.equipment, draft.equipment) &&
    sameStringArray(next.spells, draft.spells) &&
    sameStringArray(next.languages, draft.languages) &&
    sameStringArray(next.proficiencies, draft.proficiencies)
  ) {
    return draft;
  }

  return next;
}

function formatRuleValue(value: JsonValue): string {
  if (Array.isArray(value)) return value.map(formatRuleValue).join('、');
  if (isRuleRecord(value)) {
    return Object.entries(value)
      .map(([key, nested]) => `${ruleLabels[key] ?? key}: ${formatRuleValue(nested)}`)
      .join('；');
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value === null || value === '') return '无';
  return String(value);
}

function ruleEntries(value: JsonValue): Array<[string, string]> {
  if (!isRuleRecord(value)) return [];
  return Object.entries(value)
    .filter(([, entryValue]) => entryValue !== null && entryValue !== '')
    .map(([key, entryValue]) => [ruleLabels[key] ?? key, formatRuleValue(entryValue)]);
}

function OptionDetail({ option }: { option: CharacterBuilderOption | undefined }) {
  if (!option) return null;
  const entries = ruleEntries(option.ruleData);
  return (
    <div className="option-detail-panel">
      <div className="section-heading-row">
        <h4>{option.name}</h4>
        {option.sourceRef ? <span className="muted">{option.sourceRef}</span> : null}
      </div>
      {option.summary ? <p className="muted">{option.summary}</p> : null}
      {entries.length > 0 ? (
        <dl className="option-rule-list">
          {entries.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted">暂无结构化数值。</p>
      )}
    </div>
  );
}

function SingleOptionField({
  label,
  value,
  options,
  allOptions = options,
  customPlaceholder,
  onChange
}: {
  label: string;
  value: string;
  options: CharacterBuilderOption[];
  allOptions?: CharacterBuilderOption[];
  customPlaceholder: string;
  onChange: (value: string) => void;
}) {
  const selectedOption = allOptions.find(option => option.name === value);
  const selectedApprovedValue = approvedValue(options, value);
  const customValue = selectedOption ? '' : value;

  return (
    <div className="builder-field">
      <label>
        {label}
        <select value={selectedApprovedValue} onChange={e => onChange(e.target.value)}>
          <option value="">{options.length > 0 ? '从内置 / 已批准选项选择' : '暂无已批准选项，可在下方自定义填写'}</option>
          {options.map(o => (
            <option key={o.id} value={o.name}>{o.name}</option>
          ))}
        </select>
      </label>
      <input
        aria-label={`自定义${label}`}
        value={customValue}
        placeholder={customPlaceholder}
        onChange={e => onChange(e.target.value)}
      />
      {customValue ? <p className="muted option-help">自定义项会保存，但确认时会提示 DM 复核。</p> : null}
      <OptionDetail option={selectedOption} />
    </div>
  );
}

function MultiOptionSection({
  title,
  emptyText,
  customLabel,
  options,
  selected,
  draft,
  extraRecommendedNames = [],
  onChange
}: {
  title: string;
  emptyText: string;
  customLabel: string;
  options: CharacterBuilderOption[];
  selected: string[];
  draft: CharacterBuilderDraft;
  extraRecommendedNames?: string[];
  onChange: (items: string[]) => void;
}) {
  const [customValue, setCustomValue] = useState('');
  const [focusedOptionName, setFocusedOptionName] = useState('');
  const detailOption = options.find(o => o.name === focusedOptionName) ?? options.find(o => selected.includes(o.name));
  const compatible = compatibleOptions(options, draft);
  const recommended = compatible.filter(o => isRecommendedForDraft(draft, o, extraRecommendedNames));
  const reviewOnly = compatible.filter(o => optionPrerequisites(o).reviewOnly === true && !recommended.some(item => item.id === o.id));
  const available = compatible.filter(o => !recommended.some(item => item.id === o.id) && !reviewOnly.some(item => item.id === o.id));
  const selectedCustom = selected.filter(item => !options.some(option => option.name === item));

  const addCustom = () => {
    const next = addItem(selected, customValue);
    onChange(next);
    if (next !== selected) setCustomValue('');
  };

  const renderChoiceGroup = (heading: string, groupOptions: CharacterBuilderOption[]) => {
    if (groupOptions.length === 0) return null;
    return (
      <div className="choice-group">
        <div className="choice-group-title">{heading}</div>
        <div className="choice-grid">
          {groupOptions.map(o => (
            <label key={o.id} title={o.summary || o.sourceRef || o.name} onMouseEnter={() => setFocusedOptionName(o.name)}>
              <input
                type="checkbox"
                checked={selected.includes(o.name)}
                onChange={() => {
                  setFocusedOptionName(o.name);
                  onChange(toggleItem(selected, o.name));
                }}
              />
              <span>{o.name}</span>
            </label>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="subcard builder-option-block">
      <div className="section-heading-row">
        <h3>{title}</h3>
        <span className="muted">{selected.length} 已选</span>
      </div>
      {compatible.length > 0 ? (
        <>
          {renderChoiceGroup('推荐', recommended)}
          {renderChoiceGroup('可选', available)}
          {renderChoiceGroup('需复核', reviewOnly)}
        </>
      ) : (
        <p className="muted">{emptyText}</p>
      )}
      <div className="inline-add-row">
        <label>
          {customLabel}
          <input
            value={customValue}
            placeholder="输入后点击添加"
            onChange={e => setCustomValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCustom();
              }
            }}
          />
        </label>
        <button type="button" onClick={addCustom}>添加</button>
      </div>
      {selected.length > 0 ? (
        <div className="pill-row">
          {selected.map(item => (
            <button
              className="pill choice-pill"
              type="button"
              key={item}
              onClick={() => onChange(selected.filter(existing => existing !== item))}
              title={`移除 ${item}`}
            >
              {item}{selectedCustom.includes(item) ? ' · 需复核' : ''} x
            </button>
          ))}
        </div>
      ) : null}
      {selectedCustom.length > 0 ? <p className="muted option-help">自定义项会保存，但确认时会提示 DM 复核。</p> : null}
      <OptionDetail option={detailOption} />
    </div>
  );
}

function CharacterSummary({ draft }: { draft: CharacterBuilderDraft }) {
  const abilityLine = abilityKeys.map(key => `${abilityLabels[key]} ${draft.abilityScores[key]}`).join(' · ');
  const speciesLine = `${draft.species || '未选种族'}${draft.subSpecies ? `（${draft.subSpecies}）` : ''}`;
  const classLine = `${draft.className || '未选职业'}${draft.classDetail ? `（${draft.classDetail}）` : ''}`;
  return (
    <aside className="builder-live-summary">
      <h3>角色预览</h3>
      <strong>{draft.name || '未命名角色'}</strong>
      <p className="muted">{speciesLine} {classLine} · {draft.background || '未选背景'}</p>
      {draft.concept ? <p>{draft.concept}</p> : null}
      <div className="summary-line">{abilityLine}</div>
      <h4>技能 / 熟练</h4>
      <p>{[...draft.skills, ...draft.languages, ...draft.proficiencies].join(', ') || '暂未选择'}</p>
      <h4>装备 / 法术</h4>
      <p>{[...draft.equipment, ...draft.spells].join(', ') || '暂未选择'}</p>
      {(draft.personality || draft.ideal || draft.bond || draft.flaw) ? (
        <>
          <h4>扮演线索</h4>
          {draft.personality ? <p>性格：{draft.personality}</p> : null}
          {draft.ideal ? <p>理想：{draft.ideal}</p> : null}
          {draft.bond ? <p>牵绊：{draft.bond}</p> : null}
          {draft.flaw ? <p>缺点：{draft.flaw}</p> : null}
        </>
      ) : null}
    </aside>
  );
}

function normalizeInitialDraft(initialDraft: CharacterBuilderDraft | null): CharacterBuilderDraft {
  if (!initialDraft) return defaultDraft;
  return {
    ...defaultDraft,
    ...initialDraft,
    abilityScores: {
      ...defaultDraft.abilityScores,
      ...initialDraft.abilityScores
    },
    subSpecies: initialDraft.subSpecies ?? '',
    classDetail: initialDraft.classDetail ?? ''
  };
}

interface CharacterBuilderProps {
  token: string;
  initialDraft: CharacterBuilderDraft | null;
  onChanged: () => void;
  setError: (error: string) => void;
}

export function CharacterBuilder({ token, initialDraft, onChanged, setError }: CharacterBuilderProps) {
  const [options, setOptions] = useState<CharacterBuilderOptions | null>(null);
  const [draft, setDraft] = useState<CharacterBuilderDraft>(() => normalizeInitialDraft(initialDraft));
  const [audit, setAudit] = useState<CharacterBuilderAudit | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [showMobilePreview, setShowMobilePreview] = useState(false);
  const totalApprovedOptions = useMemo(() => {
    if (!options) return 0;
    return options.species.length + options.subSpecies.length + options.classes.length + options.backgrounds.length + options.skills.length + options.equipment.length + options.spells.length + options.languages.length + options.proficiencies.length;
  }, [options]);

  useEffect(() => {
    getCharacterBuilderOptions(token)
      .then(res => setOptions(res.options))
      .catch(err => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setOptions(emptyCharacterBuilderOptions);
        setError(errorMessage);
        setLocalError(`已进入自定义创建模式：角色选项目录加载失败（${errorMessage}）。`);
        setMessage('可以继续手动填写种族、职业、背景、技能和装备。');
      });
  }, [token, setError]);

  useEffect(() => {
    if (!isOpen || !dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, isOpen]);

  useEffect(() => {
    if (!options) return;
    setDraft(prev => {
      const next = sanitizeDraftForOptions(prev, options);
      if (next === prev) return prev;
      setDirty(true);
      setAudit(null);
      setMessage('已移除与当前种族、职业或背景不兼容的目录选项。');
      return next;
    });
  }, [options, draft.species, draft.className, draft.background]);

  const update = (patch: Partial<CharacterBuilderDraft>) => {
    setDraft(prev => ({ ...prev, ...patch }));
    setDirty(true);
    setAudit(null);
    setMessage('');
    setLocalError('');
  };

  const saveDraft = async () => {
    setSaveBusy(true);
    try {
      await saveCharacterBuilderDraft(token, draft);
      setDirty(false);
      setError('');
      setLocalError('');
      setMessage('草稿已保存。');
      onChanged();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setLocalError(errorMessage);
    } finally {
      setSaveBusy(false);
    }
  };

  const auditDraftFn = async () => {
    setAuditBusy(true);
    setLocalError('');
    try {
      const res = await auditCharacterBuilderDraft(token, draft);
      setAudit(res.audit);
      setMessage(res.audit.valid ? '审核通过，可以确认角色。' : '审核未通过，请修正问题。');
      setError('');
      setLocalError('');
      return res.audit;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setLocalError(errorMessage);
      return null;
    } finally {
      setAuditBusy(false);
    }
  };

  const confirmDraft = async () => {
    setConfirmBusy(true);
    setLocalError('');
    try {
      const res = await auditCharacterBuilderDraft(token, draft);
      setAudit(res.audit);
      if (!res.audit.valid) {
        setMessage('审核未通过，请修正问题。');
        return;
      }
      setMessage('审核通过，正在确认角色...');
      await confirmCharacterBuilderDraft(token, draft);
      setDirty(false);
      setError('');
      setLocalError('');
      setMessage('角色已确认，运行时状态卡已创建。');
      setIsOpen(false);
      onChanged();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setLocalError(errorMessage);
    } finally {
      setConfirmBusy(false);
    }
  };

  const closeModal = () => {
    if (dirty && !window.confirm('角色草稿有未保存修改，确定关闭吗？')) return;
    setIsOpen(false);
    setShowMobilePreview(false);
  };

  const next = () => setStepIndex(index => Math.min(index + 1, steps.length - 1));
  const previous = () => setStepIndex(index => Math.max(index - 1, 0));
  const currentStep = steps[stepIndex];
  const footerStatus = localError
    ? [localError, message].filter(Boolean).join(' ')
    : message || (dirty ? '有未保存修改。' : '草稿已同步。');
  const approvedOptionsText = options
    ? totalApprovedOptions > 0
      ? `已批准选项 ${totalApprovedOptions}`
      : '已批准选项 0 · 可自定义填写'
    : '选项加载中';
  const selectedBackground = options?.backgrounds.find(option => option.name === draft.background);
  const selectedBackgroundRules = selectedBackground && isRuleRecord(selectedBackground.ruleData) ? selectedBackground.ruleData : {};
  const backgroundRecommendedSkills = stringList(selectedBackgroundRules.skillProficiencies);
  const backgroundRecommendedProficiencies = stringList(selectedBackgroundRules.toolProficiencies);
  const speciesOptions = options ? compatibleOptions(options.species, draft) : [];
  const subSpeciesOptions = options ? compatibleOptions(options.subSpecies, draft) : [];
  const classOptions = options ? compatibleOptions(options.classes, draft) : [];
  const backgroundOptions = options ? compatibleOptions(options.backgrounds, draft) : [];
  const skillOptions = options ? compatibleOptions(options.skills, draft) : [];
  const equipmentOptions = options ? compatibleOptions(options.equipment, draft) : [];
  const spellOptions = options ? compatibleOptions(options.spells, draft) : [];
  const languageOptions = options ? compatibleOptions(options.languages, draft) : [];
  const proficiencyOptions = options ? compatibleOptions(options.proficiencies, draft) : [];

  const randomizeCharacter = () => {
    if (!options) return;
    const species = randomCompatibleOptionName(options.species, compatibleOptions(options.species, defaultDraft), fallbackRandomOptions.species);
    const className = randomCompatibleOptionName(options.classes, compatibleOptions(options.classes, { ...defaultDraft, species }), fallbackRandomOptions.classes);
    const background = randomCompatibleOptionName(options.backgrounds, compatibleOptions(options.backgrounds, { ...defaultDraft, species, className }), fallbackRandomOptions.backgrounds);
    const randomDraftBase = { ...defaultDraft, species, className, background };
    const abilityPreset = randomFrom(abilityPresets) ?? abilityPresets[0];
    const classDetail = randomFrom(classDetailsByClass[className] ?? []) ?? '';
    const subSpecies = randomCompatibleOptionName(options.subSpecies, compatibleOptions(options.subSpecies, randomDraftBase), fallbackRandomOptions.subSpecies);
    const concept = `${background || '冒险者'}出身的${className || '冒险者'}，正在寻找下一次证明自己的机会。`;
    setDraft({
      name: randomFrom(fallbackRandomOptions.names) ?? '新英雄',
      concept,
      species,
      subSpecies,
      className,
      classDetail,
      background,
      abilityScores: abilityPreset.scores,
      skills: randomManyCompatible(options.skills, compatibleOptions(options.skills, randomDraftBase), fallbackRandomOptions.skills, 2),
      equipment: randomManyCompatible(options.equipment, compatibleOptions(options.equipment, randomDraftBase), fallbackRandomOptions.equipment, 3),
      spells: spellcastingAtLevel1Classes.includes(className)
        ? randomManyCompatible(options.spells, compatibleOptions(options.spells, randomDraftBase), fallbackRandomOptions.spells, 2)
        : [],
      languages: randomManyCompatible(options.languages, compatibleOptions(options.languages, randomDraftBase), fallbackRandomOptions.languages, 1),
      proficiencies: randomManyCompatible(options.proficiencies, compatibleOptions(options.proficiencies, randomDraftBase), fallbackRandomOptions.proficiencies, 1),
      personality: '谨慎但愿意在关键时刻冒险。',
      ideal: '用自己的选择证明命运可以被改变。',
      bond: '仍牵挂着故乡或旧日同伴。',
      flaw: '面对挑衅时容易过早表态。',
      notes: `${concept} 性格谨慎但不逃避危险。`
    });
    setDirty(true);
    setAudit(null);
    setMessage('已随机生成角色草稿，可继续修改后保存或确认。');
    setStepIndex(0);
    setShowMobilePreview(false);
  };

  const generateBackstorySummary = () => {
    const lines = [
      draft.concept,
      draft.background ? `出身于${draft.background}` : '',
      draft.personality ? `性格：${draft.personality}` : '',
      draft.ideal ? `理想：${draft.ideal}` : '',
      draft.bond ? `牵绊：${draft.bond}` : '',
      draft.flaw ? `缺点：${draft.flaw}` : ''
    ].filter(Boolean);
    update({ notes: lines.join('；') || '请先填写概念、背景和人格线索。' });
  };

  const renderStep = () => {
    if (!options) return <p>加载中...</p>;
    switch (currentStep.id) {
      case 'basic':
        return (
          <div className="builder-step-form">
            <h2>基础身份</h2>
            <div className="form-grid">
              <label>角色姓名<input value={draft.name} onChange={e => update({ name: e.target.value })} /></label>
              <label>角色概念<textarea value={draft.concept} onChange={e => update({ concept: e.target.value })} placeholder="一句话描述角色想成为谁。" /></label>
            </div>
          </div>
        );
      case 'species':
        return (
          <div className="builder-step-form">
            <h2>种族</h2>
            <SingleOptionField label="种族" value={draft.species} options={speciesOptions} allOptions={options.species} customPlaceholder="例如：人类、精灵、矮人、自定义族群" onChange={species => update({ species })} />
            <SingleOptionField label="子种族 / 血统" value={draft.subSpecies} options={subSpeciesOptions} allOptions={options.subSpecies} customPlaceholder="例如：变体人类、丘陵矮人、高等精灵、龙裔血脉" onChange={subSpecies => update({ subSpecies })} />
          </div>
        );
      case 'class':
        return (
          <div className="builder-step-form">
            <h2>职业</h2>
            <SingleOptionField label="职业" value={draft.className} options={classOptions} allOptions={options.classes} customPlaceholder="例如：战士、法师、游侠、自定义职业" onChange={className => update({ className })} />
            <div className="builder-field">
              <label>
                职业细节
                <input
                  value={draft.classDetail}
                  placeholder="例如：防御战斗风格、生命领域、奥术传统、龙族血脉"
                  onChange={e => update({ classDetail: e.target.value })}
                />
              </label>
              <p className="muted option-help">填写一级就需要确定的战斗风格、领域、血脉、庇护者或法术传统等。</p>
            </div>
            <SingleOptionField label="背景" value={draft.background} options={backgroundOptions} allOptions={options.backgrounds} customPlaceholder="例如：士兵、学者、罪犯、自定义背景" onChange={background => update({ background })} />
          </div>
        );
      case 'abilities':
        return (
          <div className="builder-step-form">
            <h2>属性值</h2>
            <div className="button-row">
              {abilityPresets.map(preset => <button key={preset.name} type="button" onClick={() => update({ abilityScores: preset.scores })}>{preset.name}</button>)}
            </div>
            <div className="ability-grid">
              {abilityKeys.map(ab => (
                <label key={ab}>{abilityLabels[ab]}
                  <input type="number" value={draft.abilityScores[ab]} onChange={e => update({ abilityScores: { ...draft.abilityScores, [ab]: Number(e.target.value) } })} />
                </label>
              ))}
            </div>
          </div>
        );
      case 'skills':
        return (
          <div className="builder-step-form">
            <h2>技能 / 熟练</h2>
            <MultiOptionSection title="技能" emptyText="暂无已批准技能选项，可在下方自定义添加。" customLabel="自定义技能" options={skillOptions} selected={draft.skills} draft={draft} extraRecommendedNames={backgroundRecommendedSkills} onChange={skills => update({ skills })} />
            <MultiOptionSection title="语言" emptyText="暂无已批准语言选项，可按战役设定自定义添加。" customLabel="自定义语言" options={languageOptions} selected={draft.languages} draft={draft} onChange={languages => update({ languages })} />
            <MultiOptionSection title="工具 / 武器 / 护甲熟练" emptyText="暂无已批准熟练项，可按职业、背景或 DM 许可自定义添加。" customLabel="自定义熟练项" options={proficiencyOptions} selected={draft.proficiencies} draft={draft} extraRecommendedNames={backgroundRecommendedProficiencies} onChange={proficiencies => update({ proficiencies })} />
          </div>
        );
      case 'equipment':
        return (
          <div className="builder-step-form">
            <h2>装备</h2>
            <MultiOptionSection title="装备" emptyText="暂无与当前选择兼容的已批准装备；可在下方自定义添加并交由 DM 复核。" customLabel="自定义装备" options={equipmentOptions} selected={draft.equipment} draft={draft} onChange={equipment => update({ equipment })} />
            <MultiOptionSection title="法术 / 能力" emptyText="当前职业没有一级可用的已批准法术；可添加职业能力/戏法备注并交由 DM 复核。" customLabel="自定义法术或能力" options={spellOptions} selected={draft.spells} draft={draft} onChange={spells => update({ spells })} />
          </div>
        );
      case 'story':
        return (
          <div className="builder-step-form">
            <h2>人格 / 背景</h2>
            <div className="form-grid">
              <label>性格<textarea value={draft.personality} onChange={e => update({ personality: e.target.value })} /></label>
              <label>理想<textarea value={draft.ideal} onChange={e => update({ ideal: e.target.value })} /></label>
              <label>牵绊<textarea value={draft.bond} onChange={e => update({ bond: e.target.value })} /></label>
              <label>缺点<textarea value={draft.flaw} onChange={e => update({ flaw: e.target.value })} /></label>
              <label>背景摘要<textarea value={draft.notes} onChange={e => update({ notes: e.target.value })} /></label>
            </div>
            <button type="button" onClick={generateBackstorySummary}>整理背景摘要</button>
            <p className="muted">AI 或辅助文本只能整理你已输入的背景，不会替你选择种族、职业、属性或最终选项。</p>
          </div>
        );
      case 'review':
        return (
          <div className="builder-step-form">
            <h2>复核确认</h2>
            <p className="muted">确认后会生成正式角色构建表，并启用运行时状态卡。角色状态来自角色卡和资源状态，不来自世界书文本。</p>
            <p className="muted">请在右侧角色预览中核对姓名、种族、职业、属性、技能、装备和扮演线索。移动端可切换到“预览”查看完整摘要。</p>
            <div className="subcard review-action-card">
              <h3>确认前操作</h3>
              <p className="muted">可以先保存草稿，或审核通过后直接确认角色。</p>
              <div className="button-row">
                <button type="button" onClick={saveDraft} disabled={saveBusy || confirmBusy}>{saveBusy ? '保存中...' : '保存草稿'}</button>
                <button type="button" onClick={auditDraftFn} disabled={auditBusy || confirmBusy}>{auditBusy ? '审核中...' : '审核角色'}</button>
                <button type="button" onClick={confirmDraft} disabled={saveBusy || auditBusy || confirmBusy}>{confirmBusy ? '确认中...' : '确认角色'}</button>
              </div>
            </div>
            {localError ? <p className="form-error" role="alert">{localError}</p> : null}
            {audit ? (
              <div className="subcard" role="status">
                <h3>{audit.valid ? '审核通过' : '需要修正'}</h3>
                <p>{audit.valid ? '当前草稿可以确认角色。' : '请修正以下问题后再确认角色。'}</p>
                {audit.issues.length > 0 ? (
                  <ul>
                    {audit.issues.map((issue, idx) => <li key={idx}>{auditFieldLabel(issue.field)}：{issue.message}</li>)}
                  </ul>
                ) : null}
                {(audit.warnings ?? []).length > 0 ? (
                  <>
                    <h4>DM 复核提示</h4>
                    <ul>
                      {(audit.warnings ?? []).map((warning, idx) => <li key={idx}>{auditFieldLabel(warning.field)}：{warning.message}</li>)}
                    </ul>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        );
    }
  };

  return (
    <section className="card character-builder-entry">
      <div>
        <h2>角色卡</h2>
        <p className="muted">尚未确认角色。使用分步向导创建角色，草稿可随时保存。</p>
        <div className="builder-summary">
          <span>{approvedOptionsText}</span>
          <span>技能 {draft.skills.length}</span>
          <span>装备 {draft.equipment.length}</span>
          <span>法术 {draft.spells.length}</span>
        </div>
        {options && totalApprovedOptions === 0 ? (
          <p className="muted">当前没有已批准目录，不影响创建角色；每一步都可以手动输入自定义内容。</p>
        ) : null}
        <div className="button-row">
          <button type="button" onClick={() => setIsOpen(true)}>创建角色</button>
          <button type="button" onClick={() => { setIsOpen(true); randomizeCharacter(); }} disabled={!options}>随机角色</button>
        </div>
      </div>

      {isOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="character-builder-modal" role="dialog" aria-modal="true" aria-labelledby="character-builder-title">
            <header className="builder-modal-header">
              <div>
                <h1 id="character-builder-title">角色创建向导</h1>
                <p className="muted">优先读取内置和已批准角色选项；没有目录时也可以自定义填写。保存草稿不会确认角色。</p>
              </div>
              <div className="button-row">
                <button type="button" onClick={randomizeCharacter} disabled={!options}>随机生成</button>
                <button type="button" onClick={closeModal}>关闭</button>
              </div>
            </header>
            <div className="builder-mobile-tabs">
              <button type="button" className={!showMobilePreview ? 'active' : ''} onClick={() => setShowMobilePreview(false)}>编辑</button>
              <button type="button" className={showMobilePreview ? 'active' : ''} onClick={() => setShowMobilePreview(true)}>预览</button>
            </div>
            <div className="builder-modal-body">
              <nav className="builder-step-nav" aria-label="角色创建步骤">
                {steps.map((step, index) => (
                  <button
                    key={step.id}
                    type="button"
                    className={index === stepIndex ? 'active' : ''}
                    onClick={() => { setStepIndex(index); setShowMobilePreview(false); }}
                  >
                    <span>{index + 1}</span>{step.label}
                  </button>
                ))}
              </nav>
              <section className={`builder-main-pane${showMobilePreview ? ' mobile-hidden' : ''}`}>
                {renderStep()}
              </section>
              <section className={`builder-summary-pane${showMobilePreview ? ' mobile-visible' : ''}`}>
                <CharacterSummary draft={draft} />
              </section>
            </div>
            <footer className="builder-modal-footer">
              <span className={localError ? 'form-error' : 'muted'}>{footerStatus}</span>
              <div className="button-row">
                <button type="button" onClick={randomizeCharacter} disabled={!options}>重新随机草稿</button>
                {stepIndex < steps.length - 1 ? <button type="button" onClick={saveDraft} disabled={saveBusy || confirmBusy}>{saveBusy ? '保存中...' : '保存草稿'}</button> : null}
                <button type="button" onClick={previous} disabled={stepIndex === 0}>上一步</button>
                {stepIndex < steps.length - 1 ? (
                  <button type="button" onClick={next}>下一步</button>
                ) : null}
              </div>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
