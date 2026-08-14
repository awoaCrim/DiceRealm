// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '@dnd/contracts';
import { createAppQueryClient } from '../../app/providers/createQueryClient';
import { createAppRouter } from '../../app/router/AppRouter';
import { campaignDetailKey } from '../../entities/campaign/campaignQueries';
import { sessionQueryKey } from '../../entities/user/userQueries';
import { PlatformHttpError } from '../../shared/api/platformHttp';

const user: AuthenticatedUser = { userId: 'u-1', login: 'alice' };

vi.mock('../../api/campaigns/campaignApi', () => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  join: vi.fn(),
}));

import * as campaignApi from '../../api/campaigns/campaignApi';

/** RealtimeBoundary 使用原生 EventSource；jsdom 无 EventSource，测试注入 stub。 */
class StubEventSource {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(_type: string, _listener: EventListener): void {}
  close(): void {}
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
}

const ownerCampaign = {
  id: 'c1',
  name: '烛堡之门',
  status: 'setup' as const,
  ruleset: 'dnd5e',
  updatedAt: '2026-08-01T00:00:00.000Z',
  role: 'owner' as const,
};
const playerCampaign = {
  id: 'c2',
  name: '矿井危机',
  status: 'active' as const,
  ruleset: 'dnd5e',
  updatedAt: '2026-08-02T00:00:00.000Z',
  role: 'player' as const,
};

function ownerView(role: 'owner' | 'player' = 'owner') {
  return {
    campaign: {
      id: 'c1',
      ownerId: 'u-1',
      name: '烛堡之门',
      status: 'setup' as const,
      ruleset: 'dnd5e',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    members: [
      { campaignId: 'c1', userId: 'u-1', role, joinedAt: '2026-08-01T00:00:00.000Z' },
    ],
  };
}

beforeEach(() => {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  vi.mocked(campaignApi.list).mockReset();
  vi.mocked(campaignApi.get).mockReset();
  vi.mocked(campaignApi.create).mockReset();
  vi.mocked(campaignApi.join).mockReset();
  vi.mocked(campaignApi.list).mockResolvedValue([]);
});

function renderAt(initialEntries: string[], seed?: (qc: QueryClient) => void) {
  const qc = createAppQueryClient();
  seed?.(qc);
  const router = createAppRouter(qc, { initialEntries });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { qc, router };
}

function seedSession(qc: QueryClient) {
  qc.setQueryData(sessionQueryKey, user);
}

describe('战役列表', () => {
  it('显示 owner/player 战役卡片并进入对应工作区', async () => {
    vi.mocked(campaignApi.list).mockResolvedValue([ownerCampaign, playerCampaign]);
    vi.mocked(campaignApi.get).mockResolvedValue(ownerView('owner'));
    const { router } = renderAt(['/campaigns'], seedSession);
    expect(await screen.findByRole('heading', { name: '我的战役' })).toBeInTheDocument();
    expect(await screen.findByText('烛堡之门')).toBeInTheDocument();
    expect(screen.getByText('矿井危机')).toBeInTheDocument();

    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole('link', { name: '进入 Owner 工作区' }));
    // owner 落地页重定向到 /owner/turn（回合与 AI 运行）。
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns/c1/owner/turn'));
  });

  it('空列表显示空状态并引导创建', async () => {
    renderAt(['/campaigns'], seedSession);
    expect(await screen.findByText('暂无战役。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '创建战役' })).toHaveAttribute('href', '/campaigns/new');
  });

  it('列表加载失败显示错误并可重试', async () => {
    vi.mocked(campaignApi.list).mockRejectedValueOnce(
      new PlatformHttpError('NOT_FOUND', '接口不存在。', 404),
    );
    renderAt(['/campaigns'], seedSession);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('战役列表加载失败');
    vi.mocked(campaignApi.list).mockResolvedValueOnce([ownerCampaign]);
    const userEv = userEvent.setup();
    await userEv.click(within(alert).getByRole('button', { name: '重试' }));
    expect(await screen.findByText('烛堡之门')).toBeInTheDocument();
  });
});

describe('创建战役向导', () => {
  it('只提交 name+ruleset，成功停在邀请码步骤，显式确认后进入 owner/turn', async () => {
    vi.mocked(campaignApi.create).mockResolvedValue({
      campaign: {
        id: 'c1',
        ownerId: 'u-1',
        name: '烛堡之门',
        status: 'setup' as const,
        ruleset: 'dnd5e',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      inviteCode: 'invite-abc-123',
    });
    vi.mocked(campaignApi.get).mockResolvedValue(ownerView('owner'));
    const { router } = renderAt(['/campaigns/new'], seedSession);
    const userEv = userEvent.setup();
    await userEv.type(screen.getByLabelText('战役名称'), '烛堡之门');
    await userEv.click(screen.getByRole('button', { name: '创建战役' }));

    expect(await screen.findByText('保存邀请码')).toBeInTheDocument();
    expect(campaignApi.create).toHaveBeenCalledWith({ name: '烛堡之门', ruleset: 'dnd5e' });
    expect(screen.getByText('invite-abc-123')).toBeInTheDocument();
    const link = screen.getByLabelText('邀请链接') as HTMLInputElement;
    expect(link.value).toContain('/campaigns/join/c1?code=invite-abc-123');
    expect(screen.getByText('关闭后无法再次查看邀请码。')).toBeInTheDocument();

    await userEv.click(screen.getByRole('button', { name: '我已保存，进入工作区' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns/c1/owner/turn'));
  });

  it('邀请步骤展示可选中的邀请链接与复制按钮', async () => {
    vi.mocked(campaignApi.create).mockResolvedValue({
      campaign: {
        id: 'c1',
        ownerId: 'u-1',
        name: '烛堡之门',
        status: 'setup' as const,
        ruleset: 'dnd5e',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      inviteCode: 'invite-abc-123',
    });
    renderAt(['/campaigns/new'], seedSession);
    const userEv = userEvent.setup();
    await userEv.type(screen.getByLabelText('战役名称'), '烛堡之门');
    await userEv.click(screen.getByRole('button', { name: '创建战役' }));
    const link = (await screen.findByLabelText('邀请链接')) as HTMLInputElement;
    expect(link.value).toContain('/campaigns/join/c1?code=invite-abc-123');
    expect(screen.getByRole('button', { name: '复制邀请链接' })).toBeInTheDocument();
    expect(screen.getByText('关闭后无法再次查看邀请码。')).toBeInTheDocument();
  });
});

describe('加入战役', () => {
  it('邀请链接预填 code，确认后调用 path-param join 并进入 player/story', async () => {
    vi.mocked(campaignApi.join).mockResolvedValue({
      campaignId: 'c1',
      userId: 'u-2',
      role: 'player',
      joinedAt: '2026-08-03T00:00:00.000Z',
    });
    vi.mocked(campaignApi.get).mockResolvedValue(ownerView('player'));
    const { router } = renderAt(
      ['/campaigns/join/c1?code=invite-abc-123'],
      seedSession,
    );
    expect(await screen.findByLabelText('邀请码')).toHaveValue('invite-abc-123');
    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole('button', { name: '加入战役' }));
    await waitFor(() => expect(campaignApi.join).toHaveBeenCalledWith('c1', 'invite-abc-123'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns/c1/player/story'));
  });

  it('无效邀请码显示脱敏错误且停留在加入页', async () => {
    vi.mocked(campaignApi.join).mockRejectedValue(
      new PlatformHttpError('CAMPAIGN_NOT_FOUND', '战役不存在或邀请码无效。', 404),
    );
    const { router } = renderAt(
      ['/campaigns/join/c1?code=bad-code'],
      seedSession,
    );
    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole('button', { name: '加入战役' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('战役不存在或邀请码无效');
    expect(router.state.location.pathname).toBe('/campaigns/join/c1');
  });

  it('手动入口允许填写 campaignId + code', async () => {
    vi.mocked(campaignApi.join).mockResolvedValue({
      campaignId: 'c9',
      userId: 'u-1',
      role: 'player',
      joinedAt: '2026-08-03T00:00:00.000Z',
    });
    vi.mocked(campaignApi.get).mockResolvedValue({
      campaign: {
        id: 'c9',
        ownerId: 'u-9',
        name: '手动战役',
        status: 'setup' as const,
        ruleset: 'dnd5e',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      members: [{ campaignId: 'c9', userId: 'u-1', role: 'player', joinedAt: '2026-08-03T00:00:00.000Z' }],
    });
    const { router } = renderAt(['/campaigns/join/xyz'], seedSession);
    const userEv = userEvent.setup();
    await userEv.clear(screen.getByLabelText('战役 ID'));
    await userEv.type(screen.getByLabelText('战役 ID'), 'c9');
    await userEv.clear(screen.getByLabelText('邀请码'));
    await userEv.type(screen.getByLabelText('邀请码'), 'manual-code');
    await userEv.click(screen.getByRole('button', { name: '加入战役' }));
    await waitFor(() => expect(campaignApi.join).toHaveBeenCalledWith('c9', 'manual-code'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns/c9/player/story'));
  });
});

describe('战役角色守卫', () => {
  it('player 访问 owner 页被重定向到 player 工作区', async () => {
    vi.mocked(campaignApi.get).mockResolvedValue(ownerView('player'));
    const { router } = renderAt(['/campaigns/c1/owner'], seedSession);
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns/c1/player'));
  });

  it('owner 访问 player 页被重定向到 owner 工作区', async () => {
    vi.mocked(campaignApi.get).mockResolvedValue(ownerView('owner'));
    const { router } = renderAt(['/campaigns/c1/player'], seedSession);
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns/c1/owner'));
  });

  it('非成员访问战役页回到 /campaigns', async () => {
    vi.mocked(campaignApi.get).mockRejectedValue(
      new PlatformHttpError('CAMPAIGN_NOT_FOUND', '战役不存在。', 404),
    );
    const { router } = renderAt(['/campaigns/c1/owner'], seedSession);
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns'));
  });

  it('成员按角色渲染对应工作区', async () => {
    vi.mocked(campaignApi.get).mockResolvedValue(ownerView('owner'));
    const { router } = renderAt(['/campaigns/c1/owner'], seedSession);
    // owner 落地页重定向到 /owner/turn，并渲染真实 Owner 工作区。
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns/c1/owner/turn'));
    expect(await screen.findByRole('heading', { name: '回合与 AI 运行' })).toBeInTheDocument();
  });

  it('使用缓存中的战役详情而不是重复请求', async () => {
    vi.mocked(campaignApi.get).mockResolvedValue(ownerView('player'));
    renderAt(['/campaigns/c1/owner'], (qc) => {
      seedSession(qc);
      qc.setQueryData(campaignDetailKey('c1'), ownerView('player'));
    });
    // player 角色访问 owner 页 → 重定向到 player/story，并渲染真实 Player 工作区。
    await waitFor(() => expect(screen.queryByText('DND AI-DM · Player')).not.toBeNull());
    expect(campaignApi.get).not.toHaveBeenCalled();
  });
});
