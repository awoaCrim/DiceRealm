// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, Encounter } from '@dnd/contracts';
import { createAppQueryClient } from '../../app/providers/createQueryClient';
import { createAppRouter } from '../../app/router/AppRouter';
import { sessionQueryKey } from '../../entities/user/userQueries';
import { campaignTurnKey } from '../../shared/lib/queryKeys';
import { FeatureErrorBoundary } from '../../shared/ui/FeatureErrorBoundary';

const player: AuthenticatedUser = { userId: 'u-2', login: 'bob' };

vi.mock('../../api/campaigns/campaignApi', () => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  join: vi.fn(),
}));
vi.mock('../../api/turns/turnApi', () => ({
  list: vi.fn(),
  startTurn: vi.fn(),
  getView: vi.fn(),
  submitAction: vi.fn(),
}));
vi.mock('../../api/ai/aiApi', () => ({
  resolveTurn: vi.fn(),
  listRuns: vi.fn(),
  getRunDetail: vi.fn(),
  listEntries: vi.fn(),
}));
vi.mock('../../api/characters/characterApi', () => ({
  getProjection: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  submitForReview: vi.fn(),
  review: vi.fn(),
}));
vi.mock('../../api/combat/combatApi', () => ({
  list: vi.fn(),
  get: vi.fn(),
  start: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock('../../api/auth/authApi', () => ({
  register: vi.fn(),
  login: vi.fn(),
  me: vi.fn(),
  logout: vi.fn(),
}));

import * as campaignApi from '../../api/campaigns/campaignApi';
import * as turnApi from '../../api/turns/turnApi';
import * as aiApi from '../../api/ai/aiApi';
import * as characterApi from '../../api/characters/characterApi';
import * as combatApi from '../../api/combat/combatApi';

/** RealtimeBoundary 使用原生 EventSource；测试注入 stub 并支持手动 emit SSE frame。 */
class StubEventSource {
  static instances: StubEventSource[] = [];
  url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, EventListener>();

  constructor(url: string) {
    this.url = url;
    StubEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  close(): void {}

  emit(type: string, data: string, lastEventId: string): void {
    const listener = this.listeners.get(type);
    if (listener) {
      listener(new MessageEvent(type, { data, lastEventId }));
    }
  }
}

function emitCampaignEvent(payload: unknown, seq: number): void {
  const source = StubEventSource.instances[StubEventSource.instances.length - 1];
  source.emit('campaign', JSON.stringify(payload), String(seq));
}

const campaignView = {
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
    { campaignId: 'c1', userId: 'u-1', role: 'owner' as const, joinedAt: '2026-08-01T00:00:00.000Z' },
    { campaignId: 'c1', userId: 'u-2', role: 'player' as const, joinedAt: '2026-08-02T00:00:00.000Z' },
  ],
};

const turnSummary = {
  id: 't1',
  campaignId: 'c1',
  number: 1,
  status: 'waiting_for_actions' as const,
  lockedAt: null,
  completedAt: null,
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
};

const progressFixture = { requiredPlayerIds: ['u-2'], submittedPlayerIds: [], locked: false };

const myActionFixture = {
  id: 'a1',
  turnId: 't1',
  campaignId: 'c1',
  playerId: 'u-2',
  body: '我的行动正文',
  submittedAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
};

const emptyProjection = {
  myDrafts: [],
  myPending: [],
  myRejected: [],
  myApproved: [],
  reviews: [],
  approvedSummaries: [],
};

beforeEach(() => {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  StubEventSource.instances = [];
  vi.mocked(campaignApi.get).mockResolvedValue(campaignView);
  vi.mocked(turnApi.list).mockResolvedValue([]);
  vi.mocked(aiApi.listEntries).mockResolvedValue([]);
  vi.mocked(characterApi.getProjection).mockResolvedValue(emptyProjection);
  vi.mocked(combatApi.list).mockResolvedValue([]);
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

function seedPlayer(qc: QueryClient) {
  qc.setQueryData(sessionQueryKey, player);
}

async function clickNav(label: string) {
  const userEv = userEvent.setup();
  await userEv.click(screen.getByRole('link', { name: label }));
}

describe('Player 工作区 Shell', () => {
  it('渲染三栏并可导航；index 重定向到 story', async () => {
    const { router } = renderAt(['/campaigns/c1/player/story'], seedPlayer);
    expect(await screen.findByRole('heading', { name: '剧情' })).toBeInTheDocument();
    expect(screen.getByText('烛堡之门')).toBeInTheDocument();
    expect(screen.getByText('我的信息')).toBeInTheDocument();

    await clickNav('行动');
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns/c1/player/action'));
    expect(await screen.findByRole('heading', { name: '行动' })).toBeInTheDocument();

    await clickNav('角色');
    expect(await screen.findByRole('heading', { name: '角色' })).toBeInTheDocument();

    await clickNav('背包');
    expect(await screen.findByRole('heading', { name: '背包' })).toBeInTheDocument();

    await clickNav('战斗');
    expect(await screen.findByRole('heading', { name: '战斗' })).toBeInTheDocument();
  });

  it('player index 重定向到 story', async () => {
    const { router } = renderAt(['/campaigns/c1/player'], seedPlayer);
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns/c1/player/story'));
    expect(await screen.findByRole('heading', { name: '剧情' })).toBeInTheDocument();
  });
});

describe('剧情页', () => {
  it('渲染投影 entries；未知 payload 安全回退', async () => {
    vi.mocked(turnApi.list).mockResolvedValue([
      { turn: { ...turnSummary, status: 'completed' }, progress: { ...progressFixture, locked: true } },
    ]);
    vi.mocked(aiApi.listEntries).mockResolvedValue([
      { id: 'e1', aiRunId: 'r1', turnId: 't1', campaignId: 'c1', entryKind: 'narrative', entryIndex: 0, visibility: 'public', targetPlayerId: null, payload: { text: '你们进入密道。' }, createdAt: '2026-08-03T00:00:00.000Z' },
      { id: 'e2', aiRunId: 'r1', turnId: 't1', campaignId: 'c1', entryKind: 'private_update', entryIndex: 1, visibility: 'player_private', targetPlayerId: 'u-2', payload: { text: '只有你知道的秘密。' }, createdAt: '2026-08-03T00:00:00.000Z' },
      { id: 'e3', aiRunId: 'r1', turnId: 't1', campaignId: 'c1', entryKind: 'dice_result', entryIndex: 2, visibility: 'public', targetPlayerId: null, payload: { formula: '1d20', total: 15, label: '侦查' }, createdAt: '2026-08-03T00:00:00.000Z' },
      { id: 'e4', aiRunId: 'r1', turnId: 't1', campaignId: 'c1', entryKind: 'narrative', entryIndex: 3, visibility: 'public', targetPlayerId: null, payload: { evil: true }, createdAt: '2026-08-03T00:00:00.000Z' },
    ]);
    renderAt(['/campaigns/c1/player/story'], seedPlayer);
    expect(await screen.findByText('你们进入密道。')).toBeInTheDocument();
    expect(screen.getByText('只有你知道的秘密。')).toBeInTheDocument();
    expect(screen.getByText('侦查：1d20 = 15')).toBeInTheDocument();
    expect(screen.getAllByText('（内容暂不可用）').length).toBeGreaterThan(0);
  });

  it('SSE preview 缓冲与 failed 清理', async () => {
    vi.mocked(turnApi.list).mockResolvedValue([
      { turn: { ...turnSummary, status: 'resolving' }, progress: progressFixture },
    ]);
    renderAt(['/campaigns/c1/player/story'], seedPlayer);
    await screen.findByRole('heading', { name: '剧情' });
    await waitFor(() => expect(StubEventSource.instances.length).toBeGreaterThan(0));
    act(() => {
      emitCampaignEvent({ type: 'ai.preview.started', campaignId: 'c1', runId: 'r1' }, 1);
      emitCampaignEvent({ type: 'ai.preview.delta', campaignId: 'c1', runId: 'r1', text: '你发现' }, 2);
      emitCampaignEvent({ type: 'ai.preview.delta', campaignId: 'c1', runId: 'r1', text: '密道。' }, 3);
    });
    expect(await screen.findByText('临时生成中：你发现密道。')).toBeInTheDocument();
    act(() => {
      emitCampaignEvent({ type: 'ai.preview.failed', campaignId: 'c1', runId: 'r1', code: 'AI_OUTPUT_INVALID' }, 4);
    });
    await waitFor(() => expect(screen.queryByText(/临时生成中：/)).not.toBeInTheDocument());
    expect(await screen.findByRole('alert')).toHaveTextContent('AI 生成失败');
  });
});

describe('行动页', () => {
  it('等待期可编辑并提交；SSE refetch 不覆盖脏草稿', async () => {
    vi.mocked(turnApi.list).mockResolvedValue([{ turn: turnSummary, progress: progressFixture }]);
    vi.mocked(turnApi.getView).mockResolvedValue({
      turn: turnSummary,
      myAction: null,
      progress: progressFixture,
    });
    const { qc } = renderAt(['/campaigns/c1/player/action'], seedPlayer);
    const user = userEvent.setup();
    const textarea = await screen.findByLabelText('行动内容');
    expect(textarea).toBeEnabled();
    await user.type(textarea, '我点燃火把。');
    expect(textarea).toHaveValue('我点燃火把。');

    // 服务端刷新出新正文（模拟 SSE 后 refetch）：脏草稿不被覆盖
    vi.mocked(turnApi.getView).mockResolvedValue({
      turn: turnSummary,
      myAction: { ...myActionFixture, body: '服务端新版行动' },
      progress: progressFixture,
    });
    await act(async () => {
      void qc.invalidateQueries({ queryKey: campaignTurnKey('c1', 't1') });
    });
    expect(textarea).toHaveValue('我点燃火把。');

    vi.mocked(turnApi.submitAction).mockResolvedValue({
      turn: turnSummary,
      myAction: { ...myActionFixture, body: '我点燃火把。' },
      progress: progressFixture,
    });
    await user.click(await screen.findByRole('button', { name: '更新行动' }));
    await waitFor(() => expect(turnApi.submitAction).toHaveBeenCalledWith('c1', 't1', '我点燃火把。'));
  });

  it('locked 回合禁用编辑并显示锁定', async () => {
    const lockedTurn = { ...turnSummary, status: 'locked' as const, lockedAt: '2026-08-03T00:00:00.000Z' };
    vi.mocked(turnApi.list).mockResolvedValue([
      { turn: lockedTurn, progress: { ...progressFixture, locked: true } },
    ]);
    vi.mocked(turnApi.getView).mockResolvedValue({
      turn: lockedTurn,
      myAction: myActionFixture,
      progress: { ...progressFixture, locked: true },
    });
    renderAt(['/campaigns/c1/player/action'], seedPlayer);
    expect(await screen.findByText('本回合已锁定。')).toBeInTheDocument();
    expect(screen.getByLabelText('行动内容')).toBeDisabled();
    expect(screen.getByRole('button', { name: '更新行动' })).toBeDisabled();
  });

  it('needs_owner_attention 禁用编辑；无回合显示空状态', async () => {
    const attentionTurn = { ...turnSummary, status: 'needs_owner_attention' as const };
    vi.mocked(turnApi.list).mockResolvedValue([{ turn: attentionTurn, progress: progressFixture }]);
    vi.mocked(turnApi.getView).mockResolvedValue({ turn: attentionTurn, myAction: null, progress: progressFixture });
    renderAt(['/campaigns/c1/player/action'], seedPlayer);
    expect(await screen.findByText('本回合需要主持处理，等待重新结算。')).toBeInTheDocument();
    expect(screen.getByLabelText('行动内容')).toBeDisabled();

    vi.mocked(turnApi.list).mockResolvedValue([]);
    renderAt(['/campaigns/c1/player/action'], seedPlayer);
    expect(await screen.findByText('暂无行动回合。')).toBeInTheDocument();
  });
});

describe('角色页', () => {
  it('创建角色并提交审核', async () => {
    vi.mocked(characterApi.getProjection).mockResolvedValueOnce(emptyProjection);
    const createdDraft = {
      id: 'ch-1',
      campaignId: 'c1',
      playerId: 'u-2',
      name: '洛林',
      status: 'draft' as const,
      sheet: { ac: 17, str: 10, dex: 14, con: 13, int: 12, wis: 11, cha: 9, equipment: [], spells: [], background: '商人', notes: '' },
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    vi.mocked(characterApi.createDraft).mockResolvedValue(createdDraft);
    vi.mocked(characterApi.submitForReview).mockResolvedValue({
      ...createdDraft,
      status: 'pending_review',
      submittedAt: '2026-08-03T00:00:00.000Z',
    });
    renderAt(['/campaigns/c1/player/character'], seedPlayer);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('姓名'), '洛林');
    const acInput = screen.getByLabelText('AC');
    await user.clear(acInput);
    await user.type(acInput, '17');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(characterApi.createDraft).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ name: '洛林', sheet: expect.objectContaining({ ac: 17, str: 10 }) }),
      ),
    );
    // 保存成功后出现提交审核按钮（savedId 来自 createDraft 返回）
    await user.click(await screen.findByRole('button', { name: '提交审核' }));
    await waitFor(() => expect(characterApi.submitForReview).toHaveBeenCalledWith('c1', 'ch-1'));
  });

  it('rejected 角色可编辑并重新提交', async () => {
    const rejected = {
      id: 'ch-1',
      campaignId: 'c1',
      playerId: 'u-2',
      name: '洛林',
      status: 'rejected' as const,
      sheet: { ac: 15, str: 10, dex: 14, con: 13, int: 12, wis: 11, cha: 9, equipment: [], spells: [], background: '商人', notes: '' },
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    vi.mocked(characterApi.getProjection).mockResolvedValue({ ...emptyProjection, myRejected: [rejected] });
    vi.mocked(characterApi.updateDraft).mockResolvedValue({
      ...rejected,
      status: 'draft',
      sheet: { ...rejected.sheet, ac: 16 },
    });
    vi.mocked(characterApi.submitForReview).mockResolvedValue({
      ...rejected,
      status: 'pending_review',
      submittedAt: '2026-08-03T00:00:00.000Z',
    });
    renderAt(['/campaigns/c1/player/character'], seedPlayer);
    const user = userEvent.setup();
    expect(await screen.findByLabelText('姓名')).toHaveValue('洛林');
    const acInput = screen.getByLabelText('AC');
    await user.clear(acInput);
    await user.type(acInput, '16');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(characterApi.updateDraft).toHaveBeenCalledWith(
        'c1',
        'ch-1',
        expect.objectContaining({ sheet: expect.objectContaining({ ac: 16 }) }),
      ),
    );
    await user.click(screen.getByRole('button', { name: '提交审核' }));
    await waitFor(() => expect(characterApi.submitForReview).toHaveBeenCalledWith('c1', 'ch-1'));
  });

  it('pending 只读显示', async () => {
    const pending = {
      id: 'ch-1',
      campaignId: 'c1',
      playerId: 'u-2',
      name: '洛林',
      status: 'pending_review' as const,
      sheet: { ac: 15 },
      submittedAt: '2026-08-03T00:00:00.000Z',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    vi.mocked(characterApi.getProjection).mockResolvedValue({ ...emptyProjection, myPending: [pending] });
    renderAt(['/campaigns/c1/player/character'], seedPlayer);
    expect(await screen.findAllByText('洛林').then((items) => items.length)).toBeGreaterThan(0);
    expect(await screen.findByText('审核中，等待主持确认。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
  });

  it('approved 显示派生 AC 且无编辑器', async () => {
    const approved = {
      id: 'ch-1',
      campaignId: 'c1',
      playerId: 'u-2',
      name: '洛林',
      status: 'approved' as const,
      sheet: { ac: 15 },
      approvedAt: '2026-08-03T00:00:00.000Z',
      derived: { ac: { value: 17, sources: ['base'] } },
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    vi.mocked(characterApi.getProjection).mockResolvedValue({ ...emptyProjection, myApproved: [approved] });
    renderAt(['/campaigns/c1/player/character'], seedPlayer);
    expect(await screen.findByText(/AC（派生）：17/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
  });
});

describe('背包页', () => {
  it('只读显示自己的装备与法术，不含他人角色', async () => {
    const approved = {
      id: 'ch-1',
      campaignId: 'c1',
      playerId: 'u-2',
      name: '洛林',
      status: 'approved' as const,
      sheet: { equipment: ['长剑', '盾牌'], spells: ['魔法飞弹'] },
      approvedAt: '2026-08-03T00:00:00.000Z',
      derived: {},
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    vi.mocked(characterApi.getProjection).mockResolvedValue({
      ...emptyProjection,
      myApproved: [approved],
      approvedSummaries: [{ id: 'ch-other', name: '别人的角色', playerId: 'u-3' }],
    });
    renderAt(['/campaigns/c1/player/inventory'], seedPlayer);
    expect(await screen.findByText('长剑')).toBeInTheDocument();
    expect(screen.getByText('盾牌')).toBeInTheDocument();
    expect(screen.getByText('魔法飞弹')).toBeInTheDocument();
    expect(screen.queryByText('别人的角色')).not.toBeInTheDocument();
  });

  it('错误 shape 的装备/法术安全回退为空', async () => {
    const draft = {
      id: 'ch-1',
      campaignId: 'c1',
      playerId: 'u-2',
      name: '洛林',
      status: 'draft' as const,
      sheet: { equipment: 'not-array', spells: { evil: true } },
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    vi.mocked(characterApi.getProjection).mockResolvedValue({ ...emptyProjection, myDrafts: [draft] });
    renderAt(['/campaigns/c1/player/inventory'], seedPlayer);
    expect(await screen.findByText('暂无装备记录。')).toBeInTheDocument();
    expect(screen.getByText('暂无法术记录。')).toBeInTheDocument();
  });
});

describe('战斗页', () => {
  it('只读投影战斗员，无任何写按钮', async () => {
    const encounter: Encounter = {
      id: 'e1',
      campaignId: 'c1',
      name: '哥布林之战',
      status: 'active',
      activeCombatantId: 'c1',
      round: 2,
      combatants: [
        { id: 'c1', name: '哥布林', characterId: null, initiative: 12, initiativeBonus: 0, hpCurrent: 7, hpMax: 7, ac: 15, conditions: ['中毒'], visibility: 'public', targetPlayerId: null },
      ],
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    vi.mocked(combatApi.list).mockResolvedValue([encounter]);
    renderAt(['/campaigns/c1/player/combat'], seedPlayer);
    expect(await screen.findByText('哥布林之战')).toBeInTheDocument();
    expect(screen.getByText('哥布林')).toBeInTheDocument();
    expect(screen.getByText('进行中 · 第 2 轮')).toBeInTheDocument();
    expect(screen.getByText(/HP 7\/7/)).toBeInTheDocument();
    const main = screen.getByRole('main', { name: 'Player 工作区' });
    expect(within(main).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('隐私与错误隔离', () => {
  it('player DOM 不含其它玩家行动/owner prompt/context/rawDebug', async () => {
    vi.mocked(turnApi.list).mockResolvedValue([{ turn: turnSummary, progress: progressFixture }]);
    vi.mocked(turnApi.getView).mockResolvedValue({
      turn: turnSummary,
      myAction: myActionFixture,
      progress: progressFixture,
    });
    renderAt(['/campaigns/c1/player/action'], seedPlayer);
    const textarea = await screen.findByLabelText('行动内容');
    await waitFor(() => expect(textarea).toHaveValue('我的行动正文'));
    expect(screen.queryByText('其它玩家的行动')).not.toBeInTheDocument();
    expect(screen.queryByText(/rawDebug/)).not.toBeInTheDocument();
    expect(screen.queryByText(/context/)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI 运行/)).not.toBeInTheDocument();
  });

  it('故事面板错误不卸载 header/导航/inspector', async () => {
    vi.mocked(turnApi.list).mockResolvedValue([
      { turn: { ...turnSummary, status: 'completed' }, progress: { ...progressFixture, locked: true } },
    ]);
    vi.mocked(aiApi.listEntries).mockRejectedValue(new Error('entries 服务不可用'));
    renderAt(['/campaigns/c1/player/story'], seedPlayer);
    expect(await screen.findByRole('alert')).toHaveTextContent('剧情内容加载失败');
    expect(screen.getByRole('link', { name: '行动' })).toBeInTheDocument();
    expect(screen.getByText('我的信息')).toBeInTheDocument();
  });

  it('FeatureErrorBoundary：面板崩溃只替换该面板', () => {
    function Boom(): never {
      throw new Error('boom');
    }
    render(
      <>
        <FeatureErrorBoundary fallbackTitle="战斗面板">
          <Boom />
        </FeatureErrorBoundary>
        <p>旁边面板正常</p>
      </>,
    );
    expect(screen.getByText('战斗面板加载失败。')).toBeInTheDocument();
    expect(screen.getByText('旁边面板正常')).toBeInTheDocument();
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });
});
