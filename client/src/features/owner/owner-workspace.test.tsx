// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRunDetail, AuthenticatedUser, CharacterRejected, Encounter } from '@dnd/contracts';
import { createAppQueryClient } from '../../app/providers/createQueryClient';
import { createAppRouter } from '../../app/router/AppRouter';
import { campaignDetailKey } from '../../entities/campaign/campaignQueries';
import { sessionQueryKey } from '../../entities/user/userQueries';
import { campaignTurnsKey } from '../../shared/lib/queryKeys';
import { PlatformHttpError } from '../../shared/api/platformHttp';

const user: AuthenticatedUser = { userId: 'u-1', login: 'alice' };

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
  getProviderStatus: vi.fn(),
  saveProviderConfig: vi.fn(),
  testProviderConfig: vi.fn(),
  listCampaignRuns: vi.fn(),
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
vi.mock('../../api/world/worldApi', () => ({
  getProjection: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../../api/combat/combatApi', () => ({
  list: vi.fn(),
  get: vi.fn(),
  start: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock('../../api/archives/archiveApi', () => ({
  list: vi.fn(),
  createManual: vi.fn(),
  restore: vi.fn(),
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
import * as worldApi from '../../api/world/worldApi';
import * as combatApi from '../../api/combat/combatApi';
import * as archiveApi from '../../api/archives/archiveApi';

/** RealtimeBoundary 使用原生 EventSource；测试注入 stub 避免依赖浏览器实现。 */
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

const ownerView = {
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

/** 类型化 fixture：避免把 {} 传给强类型 mock。 */
const runDetailFixture: AiRunDetail = {
  id: 'r1',
  campaignId: 'c1',
  campaignSequence: 1,
  turnId: 't1',
  attempt: 1,
  idempotencyKey: 'key-1',
  provider: 'scripted',
  model: 'demo',
  status: 'succeeded',
  errorCode: null,
  startedAt: '2026-08-03T00:00:00.000Z',
  completedAt: '2026-08-03T00:00:00.000Z',
  superseded: false,
  context: {},
  result: {},
  rawDebug: {},
  narrationAttempts: [],
};

const emptyEncounter: Encounter = {
  id: 'e0',
  campaignId: 'c1',
  name: '空战斗',
  status: 'preparation',
  activeCombatantId: null,
  round: 0,
  combatants: [],
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
};

const rejectedCharacter: CharacterRejected = {
  id: 'ch1',
  campaignId: 'c1',
  playerId: 'u-2',
  name: '洛林',
  status: 'rejected',
  sheet: { ac: 17, background: '商人' },
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
};

beforeEach(() => {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  vi.mocked(campaignApi.get).mockResolvedValue(ownerView);
  vi.mocked(campaignApi.list).mockResolvedValue([]);
  vi.mocked(turnApi.list).mockResolvedValue([]);
  vi.mocked(turnApi.startTurn).mockResolvedValue(turnSummary);
  vi.mocked(turnApi.getView).mockResolvedValue({
    turn: turnSummary,
    actions: [],
    progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: [], locked: false },
  });
  vi.mocked(aiApi.listRuns).mockResolvedValue([]);
  vi.mocked(aiApi.getProviderStatus).mockResolvedValue({
    provider: 'unavailable',
    baseUrl: '',
    model: 'unavailable',
    configured: false,
    apiKeyConfigured: false,
    source: 'unavailable',
  });
  vi.mocked(aiApi.saveProviderConfig).mockResolvedValue({
    provider: 'openai-compatible', baseUrl: 'https://api.example.test/v1', model: 'gpt-test',
    configured: true, apiKeyConfigured: true, source: 'campaign',
  });
  vi.mocked(aiApi.testProviderConfig).mockResolvedValue({ ok: true });
  vi.mocked(aiApi.listCampaignRuns).mockResolvedValue([]);
  vi.mocked(aiApi.getRunDetail).mockResolvedValue(runDetailFixture);
  vi.mocked(aiApi.listEntries).mockResolvedValue([]);
  vi.mocked(characterApi.getProjection).mockResolvedValue({
    myDrafts: [],
    myPending: [],
    myRejected: [],
    myApproved: [],
    reviews: [],
    approvedSummaries: [],
  });
  vi.mocked(worldApi.getProjection).mockResolvedValue({ facts: [] });
  vi.mocked(combatApi.list).mockResolvedValue([]);
  vi.mocked(combatApi.get).mockResolvedValue(emptyEncounter);
  vi.mocked(archiveApi.list).mockResolvedValue([]);
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

async function clickNav(label: string) {
  const userEv = userEvent.setup();
  await userEv.click(screen.getByRole('link', { name: label }));
}

describe('Owner 工作区 Shell', () => {
  it('渲染三栏：导航、战役名、成员信息；导航可切换页面', async () => {
    const { router } = renderAt(['/campaigns/c1/owner/turn'], seedSession);
    expect(await screen.findByRole('heading', { name: '回合与 AI 运行' })).toBeInTheDocument();
    expect(screen.getByText('烛堡之门')).toBeInTheDocument();
    expect(screen.getByText('成员')).toBeInTheDocument();
    expect(screen.getByText('2 人')).toBeInTheDocument();

    await clickNav('角色审核');
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns/c1/owner/characters'));
    expect(screen.getByRole('heading', { name: '角色审核' })).toBeInTheDocument();

    await clickNav('世界');
    expect(await screen.findByRole('heading', { name: '世界状态' })).toBeInTheDocument();

    await clickNav('战斗');
    expect(await screen.findByRole('heading', { name: '战斗状态' })).toBeInTheDocument();

    await clickNav('存档');
    expect(await screen.findByRole('heading', { name: '存档' })).toBeInTheDocument();

    await clickNav('AI 接口');
    expect(await screen.findByRole('heading', { name: 'AI 接口' })).toBeInTheDocument();

    await clickNav('AI 日志');
    expect(await screen.findByRole('heading', { name: 'AI 日志' })).toBeInTheDocument();
  });
});

describe('DM 剧情', () => {
  it('直接显示当前回合剧情，并可展开上一回合历史', async () => {
    const firstTurn = { ...turnSummary, status: 'completed' as const, completedAt: '2026-08-03T00:10:00.000Z' };
    const secondTurn = {
      ...turnSummary,
      id: 't2',
      number: 2,
      status: 'completed' as const,
      completedAt: '2026-08-03T00:20:00.000Z',
      updatedAt: '2026-08-03T00:20:00.000Z',
    };
    vi.mocked(turnApi.list).mockResolvedValue([
      { turn: firstTurn, progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: ['u-2'], locked: true } },
      { turn: secondTurn, progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: ['u-2'], locked: true } },
    ]);
    vi.mocked(aiApi.listEntries).mockImplementation(async (_campaignId, turnId) => turnId === 't1'
      ? [{
          id: 'owner-history-entry', aiRunId: 'r1', turnId: 't1', campaignId: 'c1', entryKind: 'narrative',
          entryIndex: 0, visibility: 'public', targetPlayerId: null, payload: { text: 'DM 可以回看上一回合。' },
          createdAt: '2026-08-03T00:10:00.000Z',
        }]
      : [
          {
            id: 'owner-current-entry', aiRunId: 'r2', turnId: 't2', campaignId: 'c1', entryKind: 'private_update',
            entryIndex: 0, visibility: 'player_private', targetPlayerId: 'u-2', payload: { text: 'DM 可以看到私密结果。' },
            createdAt: '2026-08-03T00:20:00.000Z',
          },
          {
            id: 'owner-current-narrative', aiRunId: 'r2', turnId: 't2', campaignId: 'c1', entryKind: 'narrative',
            entryIndex: 1, visibility: 'public', targetPlayerId: null, payload: { text: '队伍抵达石桥。' },
            createdAt: '2026-08-03T00:20:01.000Z',
          },
          {
            id: 'owner-current-dice', aiRunId: 'r2', turnId: 't2', campaignId: 'c1', entryKind: 'dice_result',
            entryIndex: 2, visibility: 'public', targetPlayerId: null, payload: { formula: '1d20', total: 18, label: '察觉' },
            createdAt: '2026-08-03T00:20:02.000Z',
          },
        ]);

    renderAt(['/campaigns/c1/owner/turn'], seedSession);
    expect(await screen.findByText('DM 可以看到私密结果。')).toBeInTheDocument();
    expect(screen.getByText('队伍抵达石桥。')).toBeInTheDocument();
    expect(screen.getByText('察觉：1d20 = 18')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /第 1 回合/ }));
    expect(await screen.findByText('DM 可以回看上一回合。')).toBeInTheDocument();
  });
});

describe('回合与 AI 运行', () => {
  it('按回合号选择当前回合，而不是依赖服务端列表返回顺序', async () => {
    const turn2 = { ...turnSummary, id: 't2', number: 2 };
    vi.mocked(turnApi.list).mockResolvedValue([
      { turn: turn2, progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: [], locked: false } },
      { turn: turnSummary, progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: [], locked: false } },
    ]);
    renderAt(['/campaigns/c1/owner/turn'], seedSession);
    expect(await screen.findByRole('heading', { name: '第 2 回合 · 等待行动' })).toBeInTheDocument();
  });
  it('AI 接口可测试并保存写入式密钥，AI 日志详情仍按需请求', async () => {
    vi.mocked(aiApi.getProviderStatus).mockResolvedValue({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      model: 'gpt-test',
      configured: true,
      apiKeyConfigured: true,
      source: 'campaign',
    });
    vi.mocked(aiApi.testProviderConfig).mockResolvedValue({ ok: true });
    vi.mocked(aiApi.saveProviderConfig).mockResolvedValue({
      provider: 'openai-compatible',
      baseUrl: 'https://new.example.test/v1',
      model: 'gpt-new',
      configured: true,
      apiKeyConfigured: true,
      source: 'campaign',
    });
    vi.mocked(aiApi.listCampaignRuns).mockResolvedValue([
      {
        id: 'run-1', campaignId: 'c1', campaignSequence: 4, turnId: 'turn-4', attempt: 1,
        idempotencyKey: 'secret-key', provider: 'openai-compatible', model: 'gpt-test', status: 'succeeded',
        errorCode: null, startedAt: '2026-08-03T00:00:00.000Z', completedAt: '2026-08-03T00:01:00.000Z', superseded: false,
      },
    ]);
    vi.mocked(aiApi.getRunDetail).mockResolvedValue(runDetailFixture);
    renderAt(['/campaigns/c1/owner/ai-provider'], seedSession);
    expect(await screen.findByText('已配置，可用于 AI 结算')).toBeInTheDocument();
    expect(screen.getByLabelText('API 地址')).toHaveValue('https://api.example.test/v1');
    expect(screen.getByLabelText('模型')).toHaveValue('gpt-test');
    expect(screen.getByText('API Key 已配置')).toBeInTheDocument();
    expect(screen.queryByText('secret-key')).not.toBeInTheDocument();

    const userEv = userEvent.setup();
    await userEv.clear(screen.getByLabelText('API 地址'));
    await userEv.type(screen.getByLabelText('API 地址'), 'https://new.example.test/v1');
    await userEv.clear(screen.getByLabelText('模型'));
    await userEv.type(screen.getByLabelText('模型'), 'gpt-new');
    await userEv.type(screen.getByLabelText('API Key'), 'sk-new-secret');
    await userEv.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(aiApi.testProviderConfig).toHaveBeenCalledWith('c1', {
      provider: 'openai-compatible', baseUrl: 'https://new.example.test/v1', model: 'gpt-new', apiKey: 'sk-new-secret',
    }));
    expect(await screen.findByText('连接测试成功。')).toBeInTheDocument();

    await userEv.click(screen.getByRole('button', { name: '保存并立即启用' }));
    await waitFor(() => expect(aiApi.saveProviderConfig).toHaveBeenCalledWith('c1', {
      provider: 'openai-compatible', baseUrl: 'https://new.example.test/v1', model: 'gpt-new', apiKey: 'sk-new-secret',
    }));
    expect(await screen.findByText('配置已加密保存并立即生效。')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toHaveValue('');

    await userEv.click(screen.getByRole('link', { name: 'AI 日志' }));
    expect(await screen.findByRole('heading', { name: 'AI 日志' })).toBeInTheDocument();
    expect(await screen.findByText('openai-compatible')).toBeInTheDocument();
    expect(aiApi.getRunDetail).not.toHaveBeenCalled();
    await userEv.click(screen.getByRole('button', { name: '查看详情' }));
    await waitFor(() => expect(aiApi.getRunDetail).toHaveBeenCalledWith('c1', 'run-1'));
  });

  it('无回合时显示空状态并可开始回合', async () => {
    vi.mocked(turnApi.list)
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          turn: turnSummary,
          progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: [], locked: false },
        },
      ]);
    const { router } = renderAt(['/campaigns/c1/owner/turn'], seedSession);
    expect(await screen.findByText('暂无回合。')).toBeInTheDocument();
    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole('button', { name: '开始回合' }));
    await waitFor(() => expect(turnApi.startTurn).toHaveBeenCalledWith('c1'));
    // 开始成功后重新拉取列表显示最新回合
    expect(await screen.findByRole('heading', { name: '第 1 回合 · 等待行动' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/campaigns/c1/owner/turn');
  });

  it('显示提交进度与 owner 可见行动正文', async () => {
    vi.mocked(turnApi.list).mockResolvedValue([
      {
        turn: turnSummary,
        progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: ['u-2'], locked: false },
      },
    ]);
    vi.mocked(turnApi.getView).mockResolvedValue({
      turn: turnSummary,
      actions: [{ id: 'a1', turnId: 't1', campaignId: 'c1', playerId: 'u-2', body: '我向前搜索密道。', submittedAt: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-03T00:00:00.000Z' }],
      progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: ['u-2'], locked: false },
    });
    renderAt(['/campaigns/c1/owner/turn'], seedSession);
    expect(await screen.findByText('已提交 1 / 1')).toBeInTheDocument();
    expect(await screen.findByText('我向前搜索密道。')).toBeInTheDocument();
  });

  it('locked 回合可发起结算；AI 失败后重试生成新 idempotency key', async () => {
    const lockedTurn = { ...turnSummary, status: 'locked' as const };
    vi.mocked(turnApi.list).mockResolvedValue([
      {
        turn: lockedTurn,
        progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: ['u-2'], locked: true },
      },
    ]);
    vi.mocked(aiApi.resolveTurn)
      .mockRejectedValueOnce(new PlatformHttpError('AI_PROVIDER_FAILED', 'AI 生成失败。', 502))
      .mockResolvedValueOnce({
        id: 'r1',
        campaignId: 'c1',
        campaignSequence: 1,
        turnId: 't1',
        attempt: 1,
        idempotencyKey: 'key-1',
        provider: 'scripted',
        model: 'demo',
        status: 'succeeded',
        errorCode: null,
        startedAt: '2026-08-03T00:00:00.000Z',
        completedAt: '2026-08-03T00:00:00.000Z',
        superseded: false,
      });
    renderAt(['/campaigns/c1/owner/turn'], seedSession);
    const userEv = userEvent.setup();
    const resolveButton = await screen.findByRole('button', { name: '发起 AI 结算' });
    await userEv.click(resolveButton);
    expect(await screen.findByRole('alert')).toHaveTextContent('AI 生成失败');
    await userEv.click(screen.getByRole('button', { name: '发起 AI 结算' }));
    await waitFor(() => expect(aiApi.resolveTurn).toHaveBeenCalledTimes(2));
    const [firstKey, secondKey] = (aiApi.resolveTurn as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);
    expect(firstKey).not.toBe(secondKey);
  });

  it('结算成功后跨回合使用新 idempotency key 且按新 turn 提交', async () => {
    vi.mocked(aiApi.resolveTurn).mockClear(); // 同文件前序测试已调用过该 mock，先清历史。
    const lockedTurn = { ...turnSummary, status: 'locked' as const };
    const lockedTurn2 = { ...turnSummary, id: 't2', number: 2, status: 'locked' as const };
    const succeededRun = (turnId: string) => ({
      id: `r-${turnId}`,
      campaignId: 'c1',
      campaignSequence: 1,
      turnId,
      attempt: 1,
      idempotencyKey: `key-${turnId}`,
      provider: 'scripted',
      model: 'demo',
      status: 'succeeded' as const,
      errorCode: null,
      startedAt: '2026-08-03T00:00:00.000Z',
      completedAt: '2026-08-03T00:00:00.000Z',
      superseded: false,
    });
    vi.mocked(turnApi.list)
      .mockResolvedValueOnce([
        {
          turn: lockedTurn,
          progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: ['u-2'], locked: true },
        },
      ])
      .mockResolvedValue([
        {
          turn: lockedTurn2,
          progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: ['u-2'], locked: true },
        },
      ]);
    vi.mocked(aiApi.resolveTurn).mockResolvedValue(succeededRun('t1'));
    const { qc } = renderAt(['/campaigns/c1/owner/turn'], seedSession);
    const userEv = userEvent.setup();
    await userEv.click(await screen.findByRole('button', { name: '发起 AI 结算' }));
    await waitFor(() => expect(aiApi.resolveTurn).toHaveBeenCalledTimes(1));
    const firstCall = vi.mocked(aiApi.resolveTurn).mock.calls[0];
    expect(firstCall[1]).toBe('t1');
    const firstKey = firstCall[2];
    // 模拟 turn.resolved 后列表刷新到第 2 回合
    await act(async () => {
      void qc.invalidateQueries({ queryKey: campaignTurnsKey('c1') });
    });
    expect(await screen.findByRole('heading', { name: '第 2 回合 · 已锁定' })).toBeInTheDocument();
    vi.mocked(aiApi.resolveTurn).mockResolvedValue(succeededRun('t2'));
    await userEv.click(screen.getByRole('button', { name: '发起 AI 结算' }));
    await waitFor(() => expect(aiApi.resolveTurn).toHaveBeenCalledTimes(2));
    const secondCall = vi.mocked(aiApi.resolveTurn).mock.calls[1];
    expect(secondCall[1]).toBe('t2');
    expect(secondCall[2]).not.toBe(firstKey);
  });

  it('网络级失败（无 HTTP 响应）重试复用同一 idempotency key', async () => {
    const lockedTurn = { ...turnSummary, status: 'locked' as const };
    vi.mocked(aiApi.resolveTurn).mockClear();
    vi.mocked(turnApi.list).mockResolvedValue([
      {
        turn: lockedTurn,
        progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: ['u-2'], locked: true },
      },
    ]);
    vi.mocked(aiApi.resolveTurn)
      .mockRejectedValueOnce(new PlatformHttpError('INTERNAL_ERROR', '网络请求失败。', 0))
      .mockResolvedValueOnce({
        id: 'r1',
        campaignId: 'c1',
        campaignSequence: 1,
        turnId: 't1',
        attempt: 1,
        idempotencyKey: 'key-1',
        provider: 'scripted',
        model: 'demo',
        status: 'succeeded',
        errorCode: null,
        startedAt: '2026-08-03T00:00:00.000Z',
        completedAt: '2026-08-03T00:00:00.000Z',
        superseded: false,
      });
    renderAt(['/campaigns/c1/owner/turn'], seedSession);
    const userEv = userEvent.setup();
    await userEv.click(await screen.findByRole('button', { name: '发起 AI 结算' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络请求失败');
    await userEv.click(screen.getByRole('button', { name: '发起 AI 结算' }));
    await waitFor(() => expect(aiApi.resolveTurn).toHaveBeenCalledTimes(2));
    const [firstKey, secondKey] = vi.mocked(aiApi.resolveTurn).mock.calls.map((call) => call[2]);
    expect(firstKey).toBe(secondKey); // 尚无 HTTP 响应的网络级重复提交复用同一 key
  });

  it('AI run 详情未展开时不请求，展开后才调用 getRunDetail', async () => {
    vi.mocked(aiApi.getRunDetail).mockClear(); // 同文件前序测试可能已调用过该 mock，先清历史。
    vi.mocked(turnApi.list).mockResolvedValue([
      {
        turn: { ...turnSummary, status: 'locked' as const },
        progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: ['u-2'], locked: true },
      },
    ]);
    vi.mocked(aiApi.listRuns).mockResolvedValue([
      {
        id: 'r1',
        campaignId: 'c1',
        campaignSequence: 1,
        turnId: 't1',
        attempt: 1,
        idempotencyKey: 'key-1',
        provider: 'scripted',
        model: 'demo',
        status: 'succeeded',
        errorCode: null,
        startedAt: '2026-08-03T00:00:00.000Z',
        completedAt: '2026-08-03T00:00:00.000Z',
        superseded: false,
      },
    ]);
    renderAt(['/campaigns/c1/owner/turn'], seedSession);
    expect(await screen.findByText('AI 运行')).toBeInTheDocument();
    await waitFor(() => expect(aiApi.listRuns).toHaveBeenCalled());
    // 未展开：不得发起 owner-only detail 请求。
    expect(aiApi.getRunDetail).not.toHaveBeenCalled();
    const userEv = userEvent.setup();
    await userEv.click(screen.getByText('展开详情'));
    await waitFor(() => expect(aiApi.getRunDetail).toHaveBeenCalledWith('c1', 'r1'));
  });

  it('AI run 面板失败不影响回合主面板', async () => {
    vi.mocked(turnApi.list).mockResolvedValue([
      {
        turn: turnSummary,
        progress: { requiredPlayerIds: ['u-2'], submittedPlayerIds: [], locked: false },
      },
    ]);
    vi.mocked(aiApi.listRuns).mockRejectedValue(new Error('runs 服务不可用'));
    renderAt(['/campaigns/c1/owner/turn'], seedSession);
    expect(await screen.findByRole('heading', { name: '第 1 回合 · 等待行动' })).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('AI 运行列表加载失败');
  });
});

describe('角色审核', () => {
  it('待审角色可通过/退回', async () => {
    vi.mocked(characterApi.getProjection).mockResolvedValue({
      myDrafts: [],
      myPending: [],
      myRejected: [],
      myApproved: [],
      reviews: [
        { id: 'ch1', campaignId: 'c1', playerId: 'u-2', name: '洛林', status: 'pending_review', sheet: { ac: 17, background: '商人' }, submittedAt: '2026-08-03T00:00:00.000Z', createdAt: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-03T00:00:00.000Z' },
      ],
      approvedSummaries: [],
    });
    vi.mocked(characterApi.review).mockResolvedValue(rejectedCharacter);
    renderAt(['/campaigns/c1/owner/characters'], seedSession);
    expect(await screen.findByText('洛林')).toBeInTheDocument();
    expect(screen.getByText(/AC：17/)).toBeInTheDocument();
    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole('button', { name: '通过' }));
    await waitFor(() =>
      expect(characterApi.review).toHaveBeenCalledWith('c1', 'ch1', 'approve'),
    );
  });
});

describe('世界', () => {
  it('默认只展示 AI-DM 维护的世界状态，不把创建/编辑/删除当作 Owner 主流程', async () => {
    vi.mocked(worldApi.getProjection).mockResolvedValue({
      facts: [
        {
          id: 'fact-1', campaignId: 'c1', title: '烛堡地窖', kind: 'location',
          content: '旧石墙后藏着一条封闭密道。', visibility: 'owner_only', knownBy: [],
          createdAt: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-03T00:00:00.000Z',
        },
      ],
    });
    renderAt(['/campaigns/c1/owner/world'], seedSession);

    expect(await screen.findByText('烛堡地窖')).toBeInTheDocument();
    expect(screen.getByText('由 AI-DM 根据剧情与玩家行动自动维护。')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '新建事实' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '创建事实' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    expect(worldApi.create).not.toHaveBeenCalled();
    expect(worldApi.update).not.toHaveBeenCalled();
    expect(worldApi.remove).not.toHaveBeenCalled();
  });
});

describe('战斗', () => {
  it('默认只展示 AI-DM 自动发起的遭遇，不要求 Owner 创建或执行规则命令', async () => {
    const encounter: Encounter = {
      id: 'e1', campaignId: 'c1', name: '哥布林之战', status: 'active', activeCombatantId: 'c1', round: 2,
      createdAt: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-03T00:00:00.000Z',
      combatants: [
        { id: 'c1', name: '哥布林', characterId: null, initiative: 12, initiativeBonus: 0, hpCurrent: 7, hpMax: 7, ac: 15, conditions: [], visibility: 'public', targetPlayerId: null },
        { id: 'c2', name: '骑士', characterId: null, initiative: 15, initiativeBonus: 2, hpCurrent: 20, hpMax: 20, ac: 18, conditions: [], visibility: 'public', targetPlayerId: null },
      ],
    };
    vi.mocked(combatApi.list).mockResolvedValue([encounter]);
    renderAt(['/campaigns/c1/owner/combat'], seedSession);

    expect(await screen.findByRole('heading', { name: '哥布林之战' })).toBeInTheDocument();
    expect(screen.getByText('由 AI-DM 根据叙事和规则自动发起并推进。')).toBeInTheDocument();
    expect(screen.getByText('哥布林')).toBeInTheDocument();
    expect(screen.getByText('骑士')).toBeInTheDocument();
    expect(screen.queryByLabelText('战斗名称')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始战斗' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '造成伤害' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发起攻击' })).not.toBeInTheDocument();
    expect(combatApi.start).not.toHaveBeenCalled();
    expect(combatApi.executeCommand).not.toHaveBeenCalled();
  });
});

describe.skip('旧 Owner 手工世界/战斗控制面（已从普通工作区移除）', () => {
  it('player_private 无目标时阻止提交；有目标后调用 create', async () => {
    renderAt(['/campaigns/c1/owner/world'], seedSession);
    const userEv = userEvent.setup();
    await userEv.type(await screen.findByLabelText('标题'), '密道传闻');
    await userEv.type(screen.getByLabelText('内容'), '酒馆里流传着地下密道的传说。');
    await userEv.selectOptions(screen.getByLabelText('可见性'), 'player_private');
    await userEv.click(screen.getByRole('button', { name: '创建事实' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('player_private 必须指定至少一个目标玩家');
    expect(worldApi.create).not.toHaveBeenCalled();

    await userEv.type(screen.getByLabelText('目标玩家 ID（逗号分隔）'), 'u-2');
    await userEv.click(screen.getByRole('button', { name: '创建事实' }));
    await waitFor(() =>
      expect(worldApi.create).toHaveBeenCalledWith('c1', {
        title: '密道传闻',
        kind: 'location',
        content: '酒馆里流传着地下密道的传说。',
        visibility: 'player_private',
        knownBy: ['u-2'],
      }),
    );
  });
});

describe('战斗', () => {
  it.skip('开始战斗校验并提交至少一个战斗员', async () => {
    renderAt(['/campaigns/c1/owner/combat'], seedSession);
    const userEv = userEvent.setup();
    await userEv.type(await screen.findByLabelText('战斗名称'), '哥布林突袭');
    await userEv.click(screen.getByRole('button', { name: '开始战斗' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('战斗员名称不能为空');
    expect(combatApi.start).not.toHaveBeenCalled();

    await userEv.type(screen.getAllByLabelText('名称')[0], '哥布林');
    await userEv.type(screen.getByLabelText('HP'), '7');
    await userEv.type(screen.getByLabelText('AC'), '15');
    await userEv.click(screen.getByRole('button', { name: '开始战斗' }));
    await waitFor(() =>
      expect(combatApi.start).toHaveBeenCalledWith('c1', {
        name: '哥布林突袭',
        combatants: [
          {
            name: '哥布林',
            characterId: null,
            initiativeBonus: 0,
            hpCurrent: 7,
            hpMax: 7,
            ac: 15,
            conditions: [],
            visibility: 'public',
            targetPlayerId: null,
          },
        ],
      }),
    );
  });

  it.skip('active encounter 可执行 apply_damage 白名单指令；completed 只读', async () => {
    const encounter: Encounter = {
      id: 'e1',
      campaignId: 'c1',
      name: '哥布林之战',
      status: 'active',
      activeCombatantId: 'c1',
      round: 2,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
      combatants: [
        { id: 'c1', name: '哥布林', characterId: null, initiative: 12, initiativeBonus: 0, hpCurrent: 7, hpMax: 7, ac: 15, conditions: [], visibility: 'public', targetPlayerId: null },
        { id: 'c2', name: '骑士', characterId: null, initiative: 15, initiativeBonus: 2, hpCurrent: 20, hpMax: 20, ac: 18, conditions: [], visibility: 'public', targetPlayerId: null },
      ],
    };
    vi.mocked(combatApi.list).mockResolvedValue([encounter]);
    vi.mocked(combatApi.get).mockResolvedValue(encounter);
    vi.mocked(combatApi.executeCommand).mockResolvedValue(encounter);
    renderAt(['/campaigns/c1/owner/combat'], seedSession);
    const userEv = userEvent.setup();
    await userEv.click(await screen.findByRole('button', { name: /哥布林之战/ }));
    expect(await screen.findByText(/进行中 · 第 2 轮/)).toBeInTheDocument();
    await userEv.selectOptions(screen.getByLabelText('攻击者'), 'c1');
    await userEv.selectOptions(screen.getByLabelText('目标'), 'c2');
    await userEv.type(screen.getByLabelText('伤害'), '5');
    await userEv.click(screen.getByRole('button', { name: '造成伤害' }));
    await waitFor(() =>
      expect(combatApi.executeCommand).toHaveBeenCalledWith('c1', 'e1', {
        kind: 'apply_damage',
        payload: { actorCombatantId: 'c1', targetCombatantId: 'c2', amount: 5 },
      }),
    );
  });
});

describe.skip('旧战斗指令表单（已从普通工作区移除）', () => {
  const activeEncounter: Encounter = {
    id: 'e1',
    campaignId: 'c1',
    name: '哥布林之战',
    status: 'active',
    activeCombatantId: 'c1',
    round: 2,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    combatants: [
      { id: 'c1', name: '哥布林', characterId: null, initiative: 12, initiativeBonus: 0, hpCurrent: 7, hpMax: 7, ac: 15, conditions: [], visibility: 'public', targetPlayerId: null },
      { id: 'c2', name: '骑士', characterId: null, initiative: 15, initiativeBonus: 2, hpCurrent: 20, hpMax: 20, ac: 18, conditions: [], visibility: 'public', targetPlayerId: null },
    ],
  };

  function renderActiveEncounter() {
    vi.mocked(combatApi.list).mockResolvedValue([activeEncounter]);
    vi.mocked(combatApi.get).mockResolvedValue(activeEncounter);
    vi.mocked(combatApi.executeCommand).mockResolvedValue(activeEncounter);
    renderAt(['/campaigns/c1/owner/combat'], seedSession);
    return userEvent.setup();
  }

  it('apply_attack 按 contract 生成严格 payload', async () => {
    const userEv = renderActiveEncounter();
    await userEv.click(await screen.findByRole('button', { name: /哥布林之战/ }));
    await userEv.selectOptions(screen.getByLabelText('攻击方'), 'c1');
    await userEv.selectOptions(screen.getByLabelText('被攻击目标'), 'c2');
    await userEv.type(screen.getByLabelText('攻击加值'), '3');
    await userEv.selectOptions(screen.getByLabelText('伤害骰面'), 'd8');
    await userEv.type(screen.getByLabelText('伤害骰数'), '2');
    await userEv.type(screen.getByLabelText('伤害加值'), '1');
    await userEv.click(screen.getByRole('button', { name: '发起攻击' }));
    await waitFor(() =>
      expect(combatApi.executeCommand).toHaveBeenCalledWith('c1', 'e1', {
        kind: 'apply_attack',
        payload: { actorCombatantId: 'c1', targetCombatantId: 'c2', attackBonus: 3, damageDie: 'd8', damageDice: 2, damageBonus: 1 },
      }),
    );
  });

  it('apply_saving_throw 按 contract 生成严格 payload', async () => {
    const userEv = renderActiveEncounter();
    await userEv.click(await screen.findByRole('button', { name: /哥布林之战/ }));
    await userEv.selectOptions(screen.getByLabelText('豁免来源'), 'c1');
    await userEv.selectOptions(screen.getByLabelText('豁免目标'), 'c2');
    await userEv.type(screen.getByLabelText('豁免加值'), '2');
    await userEv.type(screen.getByLabelText('豁免 DC'), '14');
    await userEv.type(screen.getByLabelText('失败伤害'), '6');
    await userEv.click(screen.getByRole('button', { name: '发起豁免' }));
    await waitFor(() =>
      expect(combatApi.executeCommand).toHaveBeenCalledWith('c1', 'e1', {
        kind: 'apply_saving_throw',
        payload: { actorCombatantId: 'c1', targetCombatantId: 'c2', saveBonus: 2, dc: 14, damageOnFailure: 6 },
      }),
    );
  });

  it('apply_healing 按 contract 生成严格 payload', async () => {
    const userEv = renderActiveEncounter();
    await userEv.click(await screen.findByRole('button', { name: /哥布林之战/ }));
    await userEv.selectOptions(screen.getByLabelText('治疗来源'), 'c2');
    await userEv.selectOptions(screen.getByLabelText('治疗目标'), 'c1');
    await userEv.type(screen.getByLabelText('治疗量'), '8');
    await userEv.click(screen.getByRole('button', { name: '治疗' }));
    await waitFor(() =>
      expect(combatApi.executeCommand).toHaveBeenCalledWith('c1', 'e1', {
        kind: 'apply_healing',
        payload: { actorCombatantId: 'c2', targetCombatantId: 'c1', amount: 8 },
      }),
    );
  });

  it('add_condition 按 contract 生成严格 payload', async () => {
    const userEv = renderActiveEncounter();
    await userEv.click(await screen.findByRole('button', { name: /哥布林之战/ }));
    await userEv.selectOptions(screen.getByLabelText('状态施加方'), 'c1');
    await userEv.selectOptions(screen.getByLabelText('状态目标'), 'c2');
    await userEv.type(screen.getByLabelText('状态名称'), '中毒');
    await userEv.click(screen.getByRole('button', { name: '添加状态' }));
    await waitFor(() =>
      expect(combatApi.executeCommand).toHaveBeenCalledWith('c1', 'e1', {
        kind: 'add_condition',
        payload: { actorCombatantId: 'c1', targetCombatantId: 'c2', condition: '中毒' },
      }),
    );
  });

  it('remove_condition 按 contract 生成严格 payload', async () => {
    const userEv = renderActiveEncounter();
    await userEv.click(await screen.findByRole('button', { name: /哥布林之战/ }));
    await userEv.selectOptions(screen.getByLabelText('状态移除方'), 'c1');
    await userEv.selectOptions(screen.getByLabelText('状态移除目标'), 'c2');
    await userEv.type(screen.getByLabelText('移除状态名称'), '中毒');
    await userEv.click(screen.getByRole('button', { name: '移除状态' }));
    await waitFor(() =>
      expect(combatApi.executeCommand).toHaveBeenCalledWith('c1', 'e1', {
        kind: 'remove_condition',
        payload: { actorCombatantId: 'c1', targetCombatantId: 'c2', condition: '中毒' },
      }),
    );
  });
});

describe('存档', () => {
  it('手动创建调用 createManual；恢复前确认后调用 restore', async () => {
    vi.mocked(archiveApi.list).mockResolvedValue([
      { id: 'a1', campaignId: 'c1', kind: 'manual', turnId: null, label: '开局前', version: 1, superseded: false, createdByUserId: 'u-1', createdAt: '2026-08-03T00:00:00.000Z' },
    ]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { qc } = renderAt(['/campaigns/c1/owner/archives'], seedSession);
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const userEv = userEvent.setup();
    await userEv.type(await screen.findByLabelText('存档说明'), '开局前存档');
    await userEv.click(screen.getByRole('button', { name: '创建存档' }));
    await waitFor(() => expect(archiveApi.createManual).toHaveBeenCalledWith('c1', '开局前存档'));

    expect(await screen.findByText('开局前')).toBeInTheDocument();
    await userEv.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    await waitFor(() => expect(archiveApi.restore).toHaveBeenCalledWith('c1', 'a1'));
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: campaignTurnsKey('c1') });
    });
  });
});
