import { useEffect, useState } from 'react';
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
  CharacterBuilderOptions
} from '../types';

const defaultDraft: CharacterBuilderDraft = {
  name: '新英雄',
  concept: '',
  species: '',
  className: '',
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

function toggleItem(arr: string[], item: string): string[] {
  return arr.includes(item) ? arr.filter(i => i !== item) : [...arr, item];
}

function addItem(arr: string[], item: string): string[] {
  const normalized = item.trim();
  if (!normalized || arr.includes(normalized)) return arr;
  return [...arr, normalized];
}

function approvedValue(options: CharacterBuilderOption[], value: string): string {
  return options.some(option => option.name === value) ? value : '';
}

const abilityPresets: Array<{
  name: string;
  scores: CharacterBuilderDraft['abilityScores'];
}> = [
  { name: '均衡', scores: { str: 13, dex: 13, con: 14, int: 12, wis: 12, cha: 10 } },
  { name: '武技', scores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 } },
  { name: '敏捷', scores: { str: 8, dex: 15, con: 14, int: 12, wis: 13, cha: 10 } },
  { name: '施法', scores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 } },
  { name: '社交', scores: { str: 8, dex: 13, con: 12, int: 10, wis: 14, cha: 15 } }
];

function OptionSummary({ option }: { option: CharacterBuilderOption | undefined }) {
  if (!option?.summary && !option?.sourceRef) return null;
  return (
    <p className="muted option-help">
      {option.summary || '暂无摘要。'}{option.sourceRef ? ` 来源：${option.sourceRef}` : ''}
    </p>
  );
}

function SingleOptionField({
  label,
  value,
  options,
  customPlaceholder,
  onChange
}: {
  label: string;
  value: string;
  options: CharacterBuilderOption[];
  customPlaceholder: string;
  onChange: (value: string) => void;
}) {
  const selectedOption = options.find(option => option.name === value);
  const customValue = selectedOption ? '' : value;

  return (
    <div className="builder-field">
      <label>
        {label}
        <select value={approvedValue(options, value)} onChange={e => onChange(e.target.value)}>
          <option value="">从基础/扩展选项选择</option>
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
      <OptionSummary option={selectedOption} />
    </div>
  );
}

function MultiOptionSection({
  title,
  emptyText,
  customLabel,
  options,
  selected,
  onChange
}: {
  title: string;
  emptyText: string;
  customLabel: string;
  options: CharacterBuilderOption[];
  selected: string[];
  onChange: (items: string[]) => void;
}) {
  const [customValue, setCustomValue] = useState('');

  const addCustom = () => {
    const next = addItem(selected, customValue);
    onChange(next);
    if (next !== selected) setCustomValue('');
  };

  return (
    <div className="subcard">
      <div className="section-heading-row">
        <h3>{title}</h3>
        <span className="muted">{selected.length} 已选</span>
      </div>
      {options.length > 0 ? (
        <div className="choice-grid">
          {options.map(o => (
            <label key={o.id} title={o.summary || o.sourceRef || o.name}>
              <input
                type="checkbox"
                checked={selected.includes(o.name)}
                onChange={() => onChange(toggleItem(selected, o.name))}
              />
              <span>{o.name}</span>
            </label>
          ))}
        </div>
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
              {item} x
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface CharacterBuilderProps {
  token: string;
  initialDraft: CharacterBuilderDraft | null;
  onChanged: () => void;
  setError: (error: string) => void;
}

export function CharacterBuilder({ token, initialDraft, onChanged, setError }: CharacterBuilderProps) {
  const [options, setOptions] = useState<CharacterBuilderOptions | null>(null);
  const [draft, setDraft] = useState<CharacterBuilderDraft>(initialDraft ?? defaultDraft);
  const [audit, setAudit] = useState<CharacterBuilderAudit | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    getCharacterBuilderOptions(token)
      .then(res => setOptions(res.options))
      .catch(err => setError(err.message));
  }, [token, setError]);

  const update = (patch: Partial<CharacterBuilderDraft>) => {
    setDraft(prev => ({ ...prev, ...patch }));
  };

  const saveDraft = async () => {
    try {
      await saveCharacterBuilderDraft(token, draft);
      setError('');
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const auditDraftFn = async () => {
    try {
      const res = await auditCharacterBuilderDraft(token, draft);
      setAudit(res.audit);
      if (res.audit.valid) {
        setMessage('审核通过，可以确认角色。');
      } else {
        setMessage('审核未通过，请修正问题。');
      }
      setError('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const confirmDraft = async () => {
    try {
      await confirmCharacterBuilderDraft(token);
      setError('');
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!options) {
    return <div className="card">加载中...</div>;
  }

  const abilityKeys = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
  const totalApprovedOptions = options.species.length + options.classes.length + options.backgrounds.length + options.skills.length + options.equipment.length + options.spells.length + options.languages.length + options.proficiencies.length;

  return (
    <section className="card">
      <h2>角色创建向导</h2>
      <p className="muted">从基础 5e 选项或管理员扩展目录选择，也可以补充自定义内容；确认前会做基础完整性审核。</p>
      <div className="builder-summary">
        <span>可选项 {totalApprovedOptions}</span>
        <span>技能 {draft.skills.length}</span>
        <span>装备 {draft.equipment.length}</span>
        <span>法术 {draft.spells.length}</span>
        <span>语言/熟练 {draft.languages.length + draft.proficiencies.length}</span>
      </div>

      <div className="form-grid">
        <label>
          角色姓名
          <input value={draft.name} onChange={e => update({ name: e.target.value })} />
        </label>

        <SingleOptionField
          label="种族"
          value={draft.species}
          options={options.species}
          customPlaceholder="例如：半精灵、机关造物、自定义族群"
          onChange={species => update({ species })}
        />

        <SingleOptionField
          label="职业"
          value={draft.className}
          options={options.classes}
          customPlaceholder="例如：战士、法师、游侠、自定义职业"
          onChange={className => update({ className })}
        />

        <SingleOptionField
          label="背景"
          value={draft.background}
          options={options.backgrounds}
          customPlaceholder="例如：士兵、学者、罪犯、自定义背景"
          onChange={background => update({ background })}
        />
      </div>

      <label>
        概念
        <textarea value={draft.concept} onChange={e => update({ concept: e.target.value })} />
      </label>

      <div className="subcard">
        <div className="section-heading-row">
          <h3>属性值</h3>
          <span className="muted">可直接套用模板后微调</span>
        </div>
        <div className="button-row">
          {abilityPresets.map(preset => (
            <button key={preset.name} type="button" onClick={() => update({ abilityScores: preset.scores })}>
              {preset.name}
            </button>
          ))}
        </div>
        <div className="ability-grid">
          {abilityKeys.map(ab => (
            <label key={ab}>
              {ab.toUpperCase()}
              <input
                type="number"
                value={draft.abilityScores[ab]}
                onChange={e =>
                  update({
                    abilityScores: { ...draft.abilityScores, [ab]: Number(e.target.value) }
                  })
                }
              />
            </label>
          ))}
        </div>
      </div>

      <MultiOptionSection
        title="技能"
        emptyText="暂无已批准技能选项，可在下方自定义添加。"
        customLabel="自定义技能"
        options={options.skills}
        selected={draft.skills}
        onChange={skills => update({ skills })}
      />

      <MultiOptionSection
        title="装备"
        emptyText="暂无已批准装备选项，可在下方自定义添加。"
        customLabel="自定义装备"
        options={options.equipment}
        selected={draft.equipment}
        onChange={equipment => update({ equipment })}
      />

      <MultiOptionSection
        title="法术 / 能力"
        emptyText="暂无已批准法术选项；非法术职业可以留空，或添加职业能力/戏法备注。"
        customLabel="自定义法术或能力"
        options={options.spells}
        selected={draft.spells}
        onChange={spells => update({ spells })}
      />

      <MultiOptionSection
        title="语言"
        emptyText="暂无已批准语言选项，可按战役设定自定义添加。"
        customLabel="自定义语言"
        options={options.languages}
        selected={draft.languages}
        onChange={languages => update({ languages })}
      />

      <MultiOptionSection
        title="工具 / 武器 / 护甲熟练"
        emptyText="暂无已批准熟练项，可按职业、背景或 DM 许可自定义添加。"
        customLabel="自定义熟练项"
        options={options.proficiencies}
        selected={draft.proficiencies}
        onChange={proficiencies => update({ proficiencies })}
      />

      <div className="form-grid">
        <label>
          性格
          <textarea value={draft.personality} onChange={e => update({ personality: e.target.value })} />
        </label>

        <label>
          理想
          <textarea value={draft.ideal} onChange={e => update({ ideal: e.target.value })} />
        </label>

        <label>
          牵绊
          <textarea value={draft.bond} onChange={e => update({ bond: e.target.value })} />
        </label>

        <label>
          缺点
          <textarea value={draft.flaw} onChange={e => update({ flaw: e.target.value })} />
        </label>
      </div>

      <div className="button-row">
        <button onClick={saveDraft}>保存草稿</button>
        <button onClick={auditDraftFn}>审核角色</button>
        <button onClick={confirmDraft}>确认角色</button>
      </div>

      {message && <p>{message}</p>}

      {audit && audit.issues.length > 0 && (
        <ul>
          {audit.issues.map((issue, idx) => (
            <li key={idx}>{issue.field}: {issue.message}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
