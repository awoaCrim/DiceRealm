// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceReviewPanel } from './components/ResourceReviewPanel';
import * as api from './api';

const pendingDraft = {
  id: 'draft-1',
  jobId: 'job-1',
  kind: 'rule_entry' as const,
  title: '攻击检定',
  category: 'combat',
  optionType: null,
  summary: '攻击检定摘要。',
  content: '攻击检定内容。',
  keys: ['攻击', '检定'],
  sourceRef: 'PHB p.194',
  sourceType: 'phb_extraction' as const,
  sourceName: 'PHB',
  sourceFileName: 'phb.pdf',
  sourceUrl: '',
  sourceVersion: '',
  sourceHash: '',
  sourceLicense: '',
  ruleset: '5e-2014' as const,
  language: 'zh-CN',
  visibility: 'private' as const,
  isPrivate: true,
  importedBy: 'admin',
  contentHash: 'hash',
  ruleData: { ability: 'str' },
  prerequisites: {},
  raw: { title: '攻击检定' },
  status: 'pending' as const,
  rejectionReason: null,
  createdAt: '2026-05-30T00:00:00.000Z',
  updatedAt: '2026-05-30T00:00:00.000Z'
};

vi.mock('./api', () => ({
  getApprovedCatalogs: vi.fn(async () => ({ ruleEntries: [], characterOptions: [], resourceRules: [] })),
  createResourceImportJob: vi.fn(async () => ({
    job: { id: 'job-1', name: 'PHB', sourceFileName: 'phb.json' },
    drafts: []
  })),
  listResourceImportDrafts: vi.fn(async () => ({ drafts: [pendingDraft] })),
  listResourceImportJobs: vi.fn(async () => ({ jobs: [] })),
  reviewResourceImportDraft: vi.fn(async (_draftId: string, input: { status: 'approved' | 'rejected'; rejectionReason?: string }) => ({
    draft: { ...pendingDraft, status: input.status, rejectionReason: input.rejectionReason ?? null }
  }))
}));

describe('ResourceReviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('显示待审核资源草稿并允许批准', async () => {
    const user = userEvent.setup();
    const setError = vi.fn();

    render(<ResourceReviewPanel setError={setError} />);

    expect(await screen.findByText('资源导入与审核')).toBeInTheDocument();
    expect(await screen.findByText('攻击检定')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '批准' }));

    await waitFor(() => expect(api.reviewResourceImportDraft).toHaveBeenCalledWith('draft-1', { status: 'approved' }));
    expect(setError).toHaveBeenCalledWith('');
  });

  it('批准后刷新已批准目录计数', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getApprovedCatalogs)
      .mockResolvedValueOnce({ ruleEntries: [], characterOptions: [], resourceRules: [] })
      .mockResolvedValueOnce({
        ruleEntries: [{ id: 'rule-1' }],
        characterOptions: [{ id: 'option-1' }],
        resourceRules: [{ id: 'resource-1' }]
      } as Awaited<ReturnType<typeof api.getApprovedCatalogs>>);

    render(<ResourceReviewPanel setError={vi.fn()} />);

    expect(await screen.findByText('已批准规则条目：0')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '批准' }));

    expect(await screen.findByText('已批准规则条目：1')).toBeInTheDocument();
    expect(screen.getByText('已批准角色选项：1')).toBeInTheDocument();
    expect(screen.getByText('已批准资源规则：1')).toBeInTheDocument();
  });

  it('显示待审核资源草稿并允许拒绝', async () => {
    const user = userEvent.setup();

    render(<ResourceReviewPanel setError={vi.fn()} />);

    expect(await screen.findByText('攻击检定')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '拒绝' }));

    await waitFor(() => expect(api.reviewResourceImportDraft).toHaveBeenCalledWith('draft-1', {
      status: 'rejected',
      rejectionReason: '管理员在审核列表中拒绝。'
    }));
  });

  it('上传资源导入 JSON 后导入结构化载荷', async () => {
    const user = userEvent.setup();
    const payload = {
      name: 'PHB 导入',
      sourceFileName: 'phb.pdf',
      drafts: [{ kind: 'rule_entry', title: '检定', summary: '检定摘要。' }]
    };

    render(<ResourceReviewPanel setError={vi.fn()} />);

    const file = new File([JSON.stringify(payload)], 'resource-import.json', { type: 'application/json' });
    await user.upload(await screen.findByLabelText('结构化资源 JSON'), file);

    await waitFor(() => expect(api.createResourceImportJob).toHaveBeenCalledWith(payload));
  });

  it('导入资源 JSON 失败时把错误消息传给 setError', async () => {
    const user = userEvent.setup();
    const setError = vi.fn();
    vi.mocked(api.createResourceImportJob).mockRejectedValueOnce(new Error('导入失败'));
    const payload = {
      name: 'PHB 导入',
      sourceFileName: 'phb.pdf',
      drafts: [{ kind: 'rule_entry', title: '检定', summary: '检定摘要。' }]
    };

    render(<ResourceReviewPanel setError={setError} />);

    const file = new File([JSON.stringify(payload)], 'resource-import.json', { type: 'application/json' });
    await user.upload(await screen.findByLabelText('结构化资源 JSON'), file);

    await waitFor(() => expect(setError).toHaveBeenCalledWith('导入失败'));
  });

  it('上传无效 JSON 时显示解析错误且不调用导入 API', async () => {
    const user = userEvent.setup();
    const setError = vi.fn();

    render(<ResourceReviewPanel setError={setError} />);

    const file = new File(['{ invalid json'], 'bad-resource-import.json', { type: 'application/json' });
    await user.upload(await screen.findByLabelText('结构化资源 JSON'), file);

    await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.stringContaining('资源导入文件不是有效 JSON')));
    expect(api.createResourceImportJob).not.toHaveBeenCalled();
  });
});
