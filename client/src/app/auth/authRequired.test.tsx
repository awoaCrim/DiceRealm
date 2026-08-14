// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '@dnd/contracts';
import { createAppQueryClient } from '../providers/createQueryClient';
import { createAppRouter } from '../router/AppRouter';
import { AppProviders } from '../providers/AppProviders';
import { sessionQueryKey } from '../../entities/user/userQueries';
import { PlatformHttpError } from '../../shared/api/platformHttp';
import { emitAuthRequired, resetAuthRequiredBus } from './authRequiredBus';

const owner: AuthenticatedUser = { userId: 'u-1', login: 'alice' };

vi.mock('../../api/campaigns/campaignApi', () => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  join: vi.fn(),
}));
vi.mock('../../api/auth/authApi', () => ({
  register: vi.fn(),
  login: vi.fn(),
  me: vi.fn(),
  logout: vi.fn(),
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

import * as campaignApi from '../../api/campaigns/campaignApi';
import * as authApi from '../../api/auth/authApi';

beforeEach(() => {
  resetAuthRequiredBus();
  vi.mocked(authApi.me).mockResolvedValue(owner);
  vi.mocked(campaignApi.list).mockResolvedValue([]);
});

/** 完整 AppProviders 渲染：onAuthRequired 接线到总线 → 清缓存 + 跳 /login。 */
function renderApp(initialEntries: string[], seed?: (qc: QueryClient) => void) {
  const qc = createAppQueryClient({ retryDelayMs: 5, onAuthRequired: () => emitAuthRequired() });
  seed?.(qc);
  const router = createAppRouter(qc, { initialEntries });
  render(<AppProviders queryClient={qc} router={router} />);
  return { qc, router };
}

describe('会话过期（AUTH_REQUIRED）全局处理', () => {
  it('已登录期间 protected query 401 → 清 Query Cache 并跳 /login?returnTo=<当前路径>', async () => {
    vi.mocked(campaignApi.list).mockRejectedValue(
      new PlatformHttpError('AUTH_REQUIRED', '会话已过期。', 401),
    );
    vi.mocked(authApi.me).mockResolvedValue(null as unknown as AuthenticatedUser); // 会话已过期：bootstrap /me 也视为 guest
    const { qc, router } = renderApp(['/campaigns'], (qc) => qc.setQueryData(sessionQueryKey, owner));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(decodeURIComponent(router.state.location.search)).toContain('returnTo=/campaigns');
    // 缓存被清空后 session 重新 bootstrap 为 guest（/me 返回 null），而不是保留旧用户。
    await waitFor(() => expect(qc.getQueryData(sessionQueryKey)).toBeNull());
    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    // 不形成重定向循环：停在登录页。
    expect(router.state.location.pathname).toBe('/login');
  });

  it('登录表单 401 只显示表单错误，不触发全局跳转', async () => {
    const onAuthRequired = vi.fn();
    vi.mocked(authApi.login).mockRejectedValue(
      new PlatformHttpError('AUTH_REQUIRED', '用户名或密码错误。', 401),
    );
    const qc = createAppQueryClient({ onAuthRequired });
    qc.setQueryData(sessionQueryKey, null);
    const router = createAppRouter(qc, { initialEntries: ['/login'] });
    render(<AppProviders queryClient={qc} router={router} />);
    const userEv = userEvent.setup();
    await userEv.type(screen.getByLabelText('登录名'), 'alice');
    await userEv.type(screen.getByLabelText('密码'), 'wrong');
    await userEv.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码错误');
    expect(router.state.location.pathname).toBe('/login');
    await waitFor(() => expect(onAuthRequired).not.toHaveBeenCalled());
  });

  it('/me 瞬时网络错误不当作未登录：显示重试状态而不是跳转', async () => {
    vi.mocked(authApi.me).mockRejectedValue(
      new PlatformHttpError('INTERNAL_ERROR', '网络请求失败。', 0),
    );
    const { router } = renderApp(['/campaigns']);
    expect(await screen.findByRole('alert')).toHaveTextContent('登录状态检查失败');
    expect(router.state.location.pathname).toBe('/campaigns');
    // 重试成功后进入
    vi.mocked(authApi.me).mockResolvedValue(owner);
    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('heading', { name: '我的战役' })).toBeInTheDocument();
  });
});

describe('QueryClient onAuthRequired 接线', () => {
  it('protected query 的 AUTH_REQUIRED 触发 onAuthRequired', async () => {
    const onAuthRequired = vi.fn();
    const qc = createAppQueryClient({ onAuthRequired });
    function Probe() {
      const q = useQuery({
        queryKey: ['probe-auth'],
        queryFn: async () => {
          throw new PlatformHttpError('AUTH_REQUIRED', '会话已过期。', 401);
        },
      });
      return <div>{q.isError ? 'error' : 'loading'}</div>;
    }
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument());
    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledTimes(1));
  });

  it('protected mutation 的 AUTH_REQUIRED 触发 onAuthRequired', async () => {
    const onAuthRequired = vi.fn();
    const qc = createAppQueryClient({ onAuthRequired });
    const submit = vi.fn(async () => {
      throw new PlatformHttpError('AUTH_REQUIRED', '会话已过期。', 401);
    });
    function Probe() {
      const m = useMutation({ mutationFn: submit });
      return <button onClick={() => m.mutate()}>提交行动</button>;
    }
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole('button', { name: '提交行动' }));
    await waitFor(() => expect(onAuthRequired).toHaveBeenCalledTimes(1));
  });

  it('auth login mutation（防御性排除）不触发 onAuthRequired', async () => {
    const onAuthRequired = vi.fn();
    const qc = createAppQueryClient({ onAuthRequired });
    const loginFn = vi.fn(async () => {
      throw new PlatformHttpError('AUTH_REQUIRED', '用户名或密码错误。', 401);
    });
    function Probe() {
      const m = useMutation({ mutationKey: ['auth', 'login'], mutationFn: loginFn });
      return <button onClick={() => m.mutate()}>登录</button>;
    }
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(loginFn).toHaveBeenCalled());
    await waitFor(() => expect(onAuthRequired).not.toHaveBeenCalled());
  });
});
