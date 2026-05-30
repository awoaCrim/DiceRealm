// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CharacterBuilder } from './components/CharacterBuilder';
import * as api from './api';
import type { CharacterBuilderOptions } from './types';

const mockOptions: CharacterBuilderOptions = {
  species: [{ id: 's-1', optionType: 'species', name: '人类', summary: '人类', ruleData: {}, prerequisites: {}, sourceRef: '' }],
  classes: [{ id: 'c-1', optionType: 'class', name: '战士', summary: '战士', ruleData: {}, prerequisites: {}, sourceRef: '' }],
  backgrounds: [{ id: 'b-1', optionType: 'background', name: '士兵', summary: '士兵', ruleData: {}, prerequisites: {}, sourceRef: '' }],
  skills: [{ id: 'sk-1', optionType: 'skill', name: 'Athletics', summary: 'Athletics', ruleData: {}, prerequisites: {}, sourceRef: '' }],
  equipment: [{ id: 'e-1', optionType: 'equipment', name: '长剑', summary: '长剑', ruleData: {}, prerequisites: {}, sourceRef: '' }],
  spells: [{ id: 'sp-1', optionType: 'spell', name: '光亮术', summary: '照明戏法', ruleData: {}, prerequisites: {}, sourceRef: '' }],
  languages: [{ id: 'l-1', optionType: 'language', name: '通用语', summary: '常见语言', ruleData: {}, prerequisites: {}, sourceRef: '' }],
  proficiencies: [{ id: 'p-1', optionType: 'proficiency', name: '盾牌熟练', summary: '可使用盾牌', ruleData: {}, prerequisites: {}, sourceRef: '' }]
};

const emptyOptions: CharacterBuilderOptions = {
  species: [],
  classes: [],
  backgrounds: [],
  skills: [],
  equipment: [],
  spells: [],
  languages: [],
  proficiencies: []
};

vi.mock('./api', () => ({
  getCharacterBuilderOptions: vi.fn(async () => ({ options: mockOptions })),
  auditCharacterBuilderDraft: vi.fn(async (_token: string, draft: unknown) => ({
    draft,
    audit: { valid: true, issues: [] }
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
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.selectOptions(screen.getByLabelText('职业'), '战士');
    await user.selectOptions(screen.getByLabelText('背景'), '士兵');
    await user.click(screen.getByRole('button', { name: /技能 \/ 熟练/ }));
    await user.click(screen.getByLabelText('Athletics'));
    await user.click(screen.getByLabelText('通用语'));
    await user.click(screen.getByLabelText('盾牌熟练'));
    await user.click(screen.getByRole('button', { name: /装备/ }));
    await user.click(screen.getByLabelText('长剑'));
    await user.click(screen.getByLabelText('光亮术'));
    await user.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() => expect(api.saveCharacterBuilderDraft).toHaveBeenCalled());
    expect(api.saveCharacterBuilderDraft).toHaveBeenCalledWith('token-1', expect.objectContaining({
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

    await user.click(await screen.findByRole('button', { name: '创建角色' }));
    expect(await screen.findByRole('dialog', { name: '角色创建向导' })).toBeInTheDocument();

    await user.clear(screen.getByLabelText('角色姓名'));
    await user.type(screen.getByLabelText('角色姓名'), '米拉');
    await user.click(screen.getByRole('button', { name: /种族/ }));
    await user.type(screen.getByLabelText('自定义种族'), '自定义族群');
    await user.click(screen.getByRole('button', { name: /职业/ }));
    await user.type(screen.getByLabelText('自定义职业'), '星图师');
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
      className: '星图师',
      background: '失落学徒',
      skills: ['调查'],
      equipment: ['黄铜罗盘'],
      languages: ['星界语']
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

    await user.click(screen.getByRole('button', { name: '确认角色' }));

    await waitFor(() => expect(api.confirmCharacterBuilderDraft).toHaveBeenCalledWith('token-1'));
    expect(api.saveCharacterBuilderDraft).toHaveBeenCalledWith('token-1', expect.any(Object));
    expect(onChanged).toHaveBeenCalled();
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
});
