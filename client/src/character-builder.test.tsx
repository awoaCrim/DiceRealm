// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CharacterBuilder } from './components/CharacterBuilder';
import * as api from './api';
import type { CharacterBuilderDraft, CharacterBuilderOptions } from './types';

const mockOptions: CharacterBuilderOptions = {
  species: [{ id: 's-1', optionType: 'species', name: '人类', summary: '人类', ruleData: { speedFt: 30, traits: ['多才多艺'] }, prerequisites: {}, sourceRef: '' }],
  subSpecies: [{ id: 'ss-1', optionType: 'subspecies', name: '变体人类', summary: '变体人类', ruleData: { traits: ['任选专长'] }, prerequisites: {}, sourceRef: '' }],
  classes: [{ id: 'c-1', optionType: 'class', name: '战士', summary: '战士', ruleData: { hitDie: 'd10', level1Features: ['战斗风格'] }, prerequisites: {}, sourceRef: '' }],
  backgrounds: [{ id: 'b-1', optionType: 'background', name: '士兵', summary: '士兵', ruleData: { skillProficiencies: ['运动', '威吓'] }, prerequisites: {}, sourceRef: '' }],
  skills: [{ id: 'sk-1', optionType: 'skill', name: 'Athletics', summary: 'Athletics', ruleData: { ability: '力量' }, prerequisites: {}, sourceRef: '' }],
  equipment: [{ id: 'e-1', optionType: 'equipment', name: '长剑', summary: '长剑', ruleData: { damage: '1d8', damageType: '挥砍' }, prerequisites: {}, sourceRef: '' }],
  spells: [{ id: 'sp-1', optionType: 'spell', name: '光亮术', summary: '照明戏法', ruleData: { level: 0, duration: '1小时' }, prerequisites: {}, sourceRef: '' }],
  languages: [{ id: 'l-1', optionType: 'language', name: '通用语', summary: '常见语言', ruleData: {}, prerequisites: {}, sourceRef: '' }],
  proficiencies: [{ id: 'p-1', optionType: 'proficiency', name: '盾牌熟练', summary: '可使用盾牌', ruleData: {}, prerequisites: {}, sourceRef: '' }]
};

const emptyOptions: CharacterBuilderOptions = {
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

const validDraft: CharacterBuilderDraft = {
  name: '洛林',
  concept: '',
  species: '人类',
  subSpecies: '变体人类',
  className: '战士',
  classDetail: '',
  background: '士兵',
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

vi.mock('./api', () => ({
  getCharacterBuilderOptions: vi.fn(async () => ({ options: mockOptions })),
  auditCharacterBuilderDraft: vi.fn(async (_token: string, draft: unknown) => ({
    draft,
    audit: { valid: true, issues: [], warnings: [] }
  })),
  saveCharacterBuilderDraft: vi.fn(async () => ({
    character: { id: 'char-1', confirmed: false }
  })),
  confirmCharacterBuilderDraft: vi.fn(async () => ({
    character: { id: 'char-1', confirmed: true, sheet: { name: '洛林' } }
  }))
}));

describe('CharacterBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads approved resource options and saves a builder draft', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const setError = vi.fn();

    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={onChanged} setError={setError} />);

    await user.click(await screen.findByRole('button', { name: '创建角色' }));
    expect(await screen.findByRole('dialog', { name: '角色创建向导' })).toBeInTheDocument();

    await user.clear(screen.getByLabelText('角色姓名'));
    await user.type(screen.getByLabelText('角色姓名'), '洛林');
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.selectOptions(screen.getByLabelText('种族'), '人类');
    expect(screen.getByText('速度')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('子种族 / 血统'), '变体人类');
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.selectOptions(screen.getByLabelText('职业'), '战士');
    expect(screen.getByText('生命骰')).toBeInTheDocument();
    await user.type(screen.getByLabelText('职业细节'), '防御战斗风格');
    await user.selectOptions(screen.getByLabelText('背景'), '士兵');
    await user.click(screen.getByRole('button', { name: /技能 \/ 熟练/ }));
    await user.click(screen.getByLabelText('Athletics'));
    await user.click(screen.getByLabelText('通用语'));
    await user.click(screen.getByLabelText('盾牌熟练'));
    await user.click(screen.getByRole('button', { name: /装备/ }));
    await user.click(screen.getByLabelText('长剑'));
    expect(screen.getByText('伤害')).toBeInTheDocument();
    expect(screen.getByText('1d8')).toBeInTheDocument();
    await user.click(screen.getByLabelText('光亮术'));
    expect(screen.getByText('环阶')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() => expect(api.saveCharacterBuilderDraft).toHaveBeenCalled());
    expect(api.saveCharacterBuilderDraft).toHaveBeenCalledWith('token-1', expect.objectContaining({
      subSpecies: '变体人类',
      classDetail: '防御战斗风格',
      spells: ['光亮术'],
      languages: ['通用语'],
      proficiencies: ['盾牌熟练']
    }));
    expect(setError).toHaveBeenCalledWith('');
    expect(onChanged).toHaveBeenCalled();
  });

  it('allows custom choices when approved catalogs are empty', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCharacterBuilderOptions).mockResolvedValueOnce({ options: emptyOptions });
    const onChanged = vi.fn();

    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={onChanged} setError={vi.fn()} />);

    expect(await screen.findByText('已批准选项 0 · 可自定义填写')).toBeInTheDocument();
    expect(screen.getByText('当前没有已批准目录，不影响创建角色；每一步都可以手动输入自定义内容。')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '创建角色' }));
    expect(await screen.findByRole('dialog', { name: '角色创建向导' })).toBeInTheDocument();
    expect(screen.getByText('优先读取内置和已批准角色选项；没有目录时也可以自定义填写。保存草稿不会确认角色。')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('角色姓名'));
    await user.type(screen.getByLabelText('角色姓名'), '米拉');
    await user.click(screen.getByRole('button', { name: /种族/ }));
    await user.type(screen.getByLabelText('自定义种族'), '自定义族群');
    await user.type(screen.getByLabelText('自定义子种族 / 血统'), '星裔血统');
    await user.click(screen.getByRole('button', { name: /职业/ }));
    await user.type(screen.getByLabelText('自定义职业'), '星图师');
    await user.type(screen.getByLabelText('职业细节'), '星盘传统');
    await user.type(screen.getByLabelText('自定义背景'), '失落学徒');
    await user.click(screen.getByRole('button', { name: /技能 \/ 熟练/ }));
    await user.type(screen.getByLabelText('自定义技能'), '调查');
    await user.click(screen.getAllByRole('button', { name: '添加' })[0]);
    await user.type(screen.getByLabelText('自定义语言'), '星界语');
    await user.click(screen.getAllByRole('button', { name: '添加' })[1]);
    await user.click(screen.getByRole('button', { name: /装备/ }));
    await user.type(screen.getByLabelText('自定义装备'), '黄铜罗盘');
    await user.click(screen.getAllByRole('button', { name: '添加' })[0]);
    await user.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() => expect(api.saveCharacterBuilderDraft).toHaveBeenCalledWith('token-1', expect.objectContaining({
      name: '米拉',
      species: '自定义族群',
      subSpecies: '星裔血统',
      className: '星图师',
      classDetail: '星盘传统',
      background: '失落学徒',
      skills: ['调查'],
      equipment: ['黄铜罗盘'],
      languages: ['星界语']
    })));
  });

  it('falls back to custom creation mode when option catalogs fail to load', async () => {
    const user = userEvent.setup();
    const setError = vi.fn();
    vi.mocked(api.getCharacterBuilderOptions).mockRejectedValueOnce(new Error('目录服务不可用'));

    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={vi.fn()} setError={setError} />);

    expect(await screen.findByText('已批准选项 0 · 可自定义填写')).toBeInTheDocument();
    expect(setError).toHaveBeenCalledWith('目录服务不可用');
    await user.click(screen.getByRole('button', { name: '创建角色' }));

    expect(await screen.findByRole('dialog', { name: '角色创建向导' })).toBeInTheDocument();
    expect(screen.getByText(/已进入自定义创建模式：角色选项目录加载失败/)).toBeInTheDocument();
    expect(screen.getByText(/可以继续手动填写种族、职业、背景、技能和装备/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /种族/ }));
    expect(screen.getAllByText('暂无已批准选项，可在下方自定义填写').length).toBeGreaterThan(0);
  });

  it('fills an editable random draft from available options', async () => {
    const user = userEvent.setup();
    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={vi.fn()} setError={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '随机角色' }));

    expect(await screen.findByRole('dialog', { name: '角色创建向导' })).toBeInTheDocument();
    expect(screen.getByText('已随机生成角色草稿，可继续修改后保存或确认。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() => expect(api.saveCharacterBuilderDraft).toHaveBeenCalledWith('token-1', expect.objectContaining({
      species: '人类',
      subSpecies: '变体人类',
      className: '战士',
      background: '士兵',
      skills: ['Athletics'],
      equipment: ['长剑'],
      languages: ['通用语'],
      proficiencies: ['盾牌熟练']
    })));
  });

  it('audits and confirms a valid draft', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();

    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={onChanged} setError={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '创建角色' }));
    expect(await screen.findByRole('dialog', { name: '角色创建向导' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /复核确认/ }));
    await user.click(screen.getByRole('button', { name: '审核角色' }));

    expect(await screen.findByText('审核通过，可以确认角色。')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('审核通过');
    expect(screen.getByRole('status')).toHaveTextContent('当前草稿可以确认角色。');

    await user.click(screen.getByRole('button', { name: '确认角色' }));

    await waitFor(() => expect(api.confirmCharacterBuilderDraft).toHaveBeenCalledWith('token-1', expect.any(Object)));
    expect(api.saveCharacterBuilderDraft).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows audit errors inside the modal', async () => {
    const user = userEvent.setup();
    vi.mocked(api.auditCharacterBuilderDraft).mockRejectedValueOnce(new Error('审核服务暂不可用'));

    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={vi.fn()} setError={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '创建角色' }));
    await user.click(screen.getByRole('button', { name: /复核确认/ }));
    await user.click(screen.getByRole('button', { name: '审核角色' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('审核服务暂不可用');
    expect(screen.getByRole('button', { name: '审核角色' })).toBeEnabled();
  });

  it('renders audit issue field labels in Chinese', async () => {
    const user = userEvent.setup();
    vi.mocked(api.auditCharacterBuilderDraft).mockResolvedValueOnce({
      draft: validDraft,
      audit: {
        valid: false,
        issues: [
          { field: 'abilityScores', message: '属性总值不符合当前规则。' },
          { field: 'className', message: '请选择职业。' }
        ],
        warnings: []
      }
    });

    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={vi.fn()} setError={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '创建角色' }));
    await user.click(screen.getByRole('button', { name: /复核确认/ }));
    await user.click(screen.getByRole('button', { name: '审核角色' }));

    expect(await screen.findByRole('status')).toHaveTextContent('属性值：属性总值不符合当前规则。');
    expect(screen.getByRole('status')).toHaveTextContent('职业：请选择职业。');
    expect(screen.queryByText(/abilityScores/)).not.toBeInTheDocument();
    expect(screen.queryByText(/className/)).not.toBeInTheDocument();
  });

  it('shows confirm errors inside the modal', async () => {
    const user = userEvent.setup();
    vi.mocked(api.confirmCharacterBuilderDraft).mockRejectedValueOnce(new Error('确认角色失败'));

    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={vi.fn()} setError={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '创建角色' }));
    await user.click(screen.getByRole('button', { name: /复核确认/ }));
    await user.click(screen.getByRole('button', { name: '确认角色' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('确认角色失败');
    expect(screen.getByRole('button', { name: '确认角色' })).toBeEnabled();
  });

  it('warns before closing when the modal has unsaved changes', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);

    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={vi.fn()} setError={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '创建角色' }));
    await user.type(screen.getByLabelText('角色姓名'), '未保存');
    await user.click(screen.getByRole('button', { name: '关闭' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '角色创建向导' })).toBeInTheDocument();
  });

  it('filters sub-species after the selected species changes', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCharacterBuilderOptions).mockResolvedValueOnce({
      options: {
        ...mockOptions,
        species: [
          { id: 's-human', optionType: 'species', name: '人类', summary: '人类', ruleData: {}, prerequisites: {}, sourceRef: '' },
          { id: 's-elf', optionType: 'species', name: '精灵', summary: '精灵', ruleData: {}, prerequisites: {}, sourceRef: '' }
        ],
        subSpecies: [
          { id: 'ss-human', optionType: 'subspecies', name: '变体人类', summary: '人类变体', ruleData: {}, prerequisites: { species: ['人类'] }, sourceRef: '' },
          { id: 'ss-elf', optionType: 'subspecies', name: '高等精灵', summary: '精灵分支', ruleData: {}, prerequisites: { species: ['精灵'] }, sourceRef: '' }
        ]
      }
    });

    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={vi.fn()} setError={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '创建角色' }));
    await user.click(screen.getByRole('button', { name: /种族/ }));
    await user.selectOptions(screen.getByLabelText('种族'), '精灵');

    const subSpeciesSelect = screen.getByLabelText('子种族 / 血统');
    expect(subSpeciesSelect).toHaveTextContent('高等精灵');
    expect(subSpeciesSelect).not.toHaveTextContent('变体人类');
  });

  it('clears incompatible approved spells when class changes', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCharacterBuilderOptions).mockResolvedValueOnce({
      options: {
        ...mockOptions,
        classes: [
          { id: 'c-fighter', optionType: 'class', name: '战士', summary: '战士', ruleData: {}, prerequisites: {}, sourceRef: '' },
          { id: 'c-wizard', optionType: 'class', name: '法师', summary: '法师', ruleData: {}, prerequisites: {}, sourceRef: '' }
        ],
        spells: [
          { id: 'sp-mm', optionType: 'spell', name: '魔法飞弹', summary: '法术', ruleData: { level: 1 }, prerequisites: { classNames: ['法师'], requiresSpellcastingAtLevel1: true }, sourceRef: '' }
        ]
      }
    });

    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={vi.fn()} setError={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '创建角色' }));
    await user.click(screen.getByRole('button', { name: /职业/ }));
    await user.selectOptions(screen.getByLabelText('职业'), '法师');
    await user.click(screen.getByRole('button', { name: /装备/ }));
    await user.click(screen.getByLabelText('魔法飞弹'));
    await user.click(screen.getByRole('button', { name: /职业/ }));
    await user.selectOptions(screen.getByLabelText('职业'), '战士');
    await user.click(screen.getByRole('button', { name: /装备/ }));

    await waitFor(() => expect(screen.queryByLabelText('魔法飞弹')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(api.saveCharacterBuilderDraft).toHaveBeenCalledWith('token-1', expect.objectContaining({
      className: '战士',
      spells: []
    })));
  });

  it('renders custom-choice warnings from audit results', async () => {
    const user = userEvent.setup();
    vi.mocked(api.auditCharacterBuilderDraft).mockResolvedValueOnce({
      draft: validDraft,
      audit: {
        valid: true,
        issues: [],
        warnings: [
          { field: 'equipment', message: '黄铜罗盘 是自定义项，请由 DM 复核。' }
        ]
      }
    });

    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={vi.fn()} setError={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '创建角色' }));
    await user.click(screen.getByRole('button', { name: /复核确认/ }));
    await user.click(screen.getByRole('button', { name: '审核角色' }));

    expect(await screen.findByRole('status')).toHaveTextContent('DM 复核提示');
    expect(screen.getByRole('status')).toHaveTextContent('装备：黄铜罗盘 是自定义项，请由 DM 复核。');
  });

  it('does not randomize spells from an incompatible catalog', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getCharacterBuilderOptions).mockResolvedValueOnce({
      options: {
        ...mockOptions,
        classes: [{ id: 'c-fighter', optionType: 'class', name: '战士', summary: '战士', ruleData: {}, prerequisites: {}, sourceRef: '' }],
        spells: [
          { id: 'sp-mm', optionType: 'spell', name: '魔法飞弹', summary: '法术', ruleData: { level: 1 }, prerequisites: { classNames: ['法师'], requiresSpellcastingAtLevel1: true }, sourceRef: '' }
        ]
      }
    });

    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={vi.fn()} setError={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '随机角色' }));
    await user.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() => expect(api.saveCharacterBuilderDraft).toHaveBeenCalledWith('token-1', expect.objectContaining({
      className: '战士',
      spells: []
    })));
  });
});
