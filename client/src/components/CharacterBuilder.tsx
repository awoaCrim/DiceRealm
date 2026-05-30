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

const abilityKeys = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const abilityPresets: Array<{ name: string; scores: CharacterBuilderDraft['abilityScores'] }> = [
  { name: '均衡', scores: { str: 13, dex: 13, con: 14, int: 12, wis: 12, cha: 10 } },
  { name: '武技', scores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 } },
  { name: '敏捷', scores: { str: 8, dex: 15, con: 14, int: 12, wis: 13, cha: 10 } },
  { name: '施法', scores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 } },
  { name: '社交', scores: { str: 8, dex: 13, con: 12, int: 10, wis: 14, cha: 15 } }
];

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
          <option value="">从内置 / 已批准选项选择</option>
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
    <div className="subcard builder-option-block">
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

function CharacterSummary({ draft }: { draft: CharacterBuilderDraft }) {
  const abilityLine = abilityKeys.map(key => `${key.toUpperCase()} ${draft.abilityScores[key]}`).join(' · ');
  return (
    <aside className="builder-live-summary">
      <h3>角色预览</h3>
      <strong>{draft.name || '未命名角色'}</strong>
      <p className="muted">{draft.species || '未选种族'} {draft.className || '未选职业'} · {draft.background || '未选背景'}</p>
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
  const [isOpen, setIsOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [showMobilePreview, setShowMobilePreview] = useState(false);
  const totalApprovedOptions = useMemo(() => {
    if (!options) return 0;
    return options.species.length + options.classes.length + options.backgrounds.length + options.skills.length + options.equipment.length + options.spells.length + options.languages.length + options.proficiencies.length;
  }, [options]);

  useEffect(() => {
    getCharacterBuilderOptions(token)
      .then(res => setOptions(res.options))
      .catch(err => setError(err.message));
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

  const update = (patch: Partial<CharacterBuilderDraft>) => {
    setDraft(prev => ({ ...prev, ...patch }));
    setDirty(true);
    setAudit(null);
    setMessage('');
  };

  const saveDraft = async () => {
    try {
      await saveCharacterBuilderDraft(token, draft);
      setDirty(false);
      setError('');
      setMessage('草稿已保存。');
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const auditDraftFn = async () => {
    try {
      const res = await auditCharacterBuilderDraft(token, draft);
      setAudit(res.audit);
      setMessage(res.audit.valid ? '审核通过，可以确认角色。' : '审核未通过，请修正问题。');
      setError('');
      return res.audit;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const confirmDraft = async () => {
    try {
      await saveCharacterBuilderDraft(token, draft);
      const res = await auditCharacterBuilderDraft(token, draft);
      setAudit(res.audit);
      if (!res.audit.valid) {
        setMessage('审核未通过，请修正问题。');
        return;
      }
      await confirmCharacterBuilderDraft(token);
      setDirty(false);
      setError('');
      setMessage('角色已确认，运行时状态卡已创建。');
      setIsOpen(false);
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
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
            <SingleOptionField label="种族" value={draft.species} options={options.species} customPlaceholder="例如：人类、精灵、矮人、自定义族群" onChange={species => update({ species })} />
          </div>
        );
      case 'class':
        return (
          <div className="builder-step-form">
            <h2>职业</h2>
            <SingleOptionField label="职业" value={draft.className} options={options.classes} customPlaceholder="例如：战士、法师、游侠、自定义职业" onChange={className => update({ className })} />
            <SingleOptionField label="背景" value={draft.background} options={options.backgrounds} customPlaceholder="例如：士兵、学者、罪犯、自定义背景" onChange={background => update({ background })} />
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
                <label key={ab}>{ab.toUpperCase()}
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
            <MultiOptionSection title="技能" emptyText="暂无已批准技能选项，可在下方自定义添加。" customLabel="自定义技能" options={options.skills} selected={draft.skills} onChange={skills => update({ skills })} />
            <MultiOptionSection title="语言" emptyText="暂无已批准语言选项，可按战役设定自定义添加。" customLabel="自定义语言" options={options.languages} selected={draft.languages} onChange={languages => update({ languages })} />
            <MultiOptionSection title="工具 / 武器 / 护甲熟练" emptyText="暂无已批准熟练项，可按职业、背景或 DM 许可自定义添加。" customLabel="自定义熟练项" options={options.proficiencies} selected={draft.proficiencies} onChange={proficiencies => update({ proficiencies })} />
          </div>
        );
      case 'equipment':
        return (
          <div className="builder-step-form">
            <h2>装备</h2>
            <MultiOptionSection title="装备" emptyText="暂无已批准装备选项，可在下方自定义添加。" customLabel="自定义装备" options={options.equipment} selected={draft.equipment} onChange={equipment => update({ equipment })} />
            <MultiOptionSection title="法术 / 能力" emptyText="暂无已批准法术选项；非法术职业可以留空，或添加职业能力/戏法备注。" customLabel="自定义法术或能力" options={options.spells} selected={draft.spells} onChange={spells => update({ spells })} />
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
            <CharacterSummary draft={draft} />
            <div className="button-row">
              <button type="button" onClick={auditDraftFn}>审核角色</button>
            </div>
            {audit && audit.issues.length > 0 ? (
              <ul>
                {audit.issues.map((issue, idx) => <li key={idx}>{issue.field}: {issue.message}</li>)}
              </ul>
            ) : null}
          </div>
        );
    }
  };

  return (
    <section className="card character-builder-entry">
      <h2>角色卡</h2>
      <p className="muted">尚未确认角色。使用分步向导创建角色，草稿可随时保存。</p>
      <div className="builder-summary">
        <span>可选项 {totalApprovedOptions}</span>
        <span>技能 {draft.skills.length}</span>
        <span>装备 {draft.equipment.length}</span>
        <span>法术 {draft.spells.length}</span>
      </div>
      <button type="button" onClick={() => setIsOpen(true)}>创建角色</button>

      {isOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="character-builder-modal" role="dialog" aria-modal="true" aria-labelledby="character-builder-title">
            <header className="builder-modal-header">
              <div>
                <h1 id="character-builder-title">角色创建向导</h1>
                <p className="muted">优先读取内置和已批准角色选项；保存草稿不会确认角色。</p>
              </div>
              <button type="button" onClick={closeModal}>关闭</button>
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
              <span className="muted">{message || (dirty ? '有未保存修改。' : '草稿已同步。')}</span>
              <div className="button-row">
                <button type="button" onClick={saveDraft}>保存草稿</button>
                <button type="button" onClick={previous} disabled={stepIndex === 0}>上一步</button>
                {stepIndex < steps.length - 1 ? (
                  <button type="button" onClick={next}>下一步</button>
                ) : (
                  <button type="button" onClick={confirmDraft}>确认角色</button>
                )}
              </div>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
