// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '@dnd/contracts';
import { createAppQueryClient } from '../../app/providers/createQueryClient';
import { createAppRouter } from '../../app/router/AppRouter';
import { sessionQueryKey } from '../../entities/user/userQueries';
import { PlatformHttpError } from '../../shared/api/platformHttp';

const user: AuthenticatedUser = { userId: 'u-1', login: 'alice' };

vi.mock('../../api/auth/authApi', () => ({
  register: vi.fn(),
  login: vi.fn(),
  me: vi.fn(),
  logout: vi.fn(),
}));

// /campaigns 页在退出登录测试中挂载，需要 campaign list 的稳定 mock。
vi.mock('../../api/campaigns/campaignApi', () => ({
  list: vi.fn(async () => []),
  get: vi.fn(),
  create: vi.fn(),
  join: vi.fn(),
}));

import * as authApi from '../../api/auth/authApi';

beforeEach(() => {
  vi.mocked(authApi.me).mockReset();
  vi.mocked(authApi.login).mockReset();
  vi.mocked(authApi.register).mockReset();
  vi.mocked(authApi.logout).mockReset();
  vi.mocked(authApi.me).mockResolvedValue(user);
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

async function fillLoginForm(loginValue: string, passwordValue: string) {
  const userEv = userEvent.setup();
  await userEv.type(screen.getByLabelText('登录名'), loginValue);
  await userEv.type(screen.getByLabelText('密码'), passwordValue);
  await userEv.click(screen.getByRole('button', { name: '登录' }));
}

describe('认证页面', () => {
  it('注册成功跳转登录页并预填登录名', async () => {
    vi.mocked(authApi.register).mockResolvedValue(user);
    const { router } = renderAt(['/register'], (qc) => qc.setQueryData(sessionQueryKey, null));
    const userEv = userEvent.setup();
    await userEv.type(screen.getByLabelText('登录名'), 'alice');
    await userEv.type(screen.getByLabelText('密码'), 'secret123');
    await userEv.type(screen.getByLabelText('确认密码'), 'secret123');
    await userEv.click(screen.getByRole('button', { name: '注册' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(authApi.register).toHaveBeenCalledWith({ login: 'alice', password: 'secret123' });
    await waitFor(() => expect(screen.getByLabelText('登录名')).toHaveValue('alice'));
  });

  it('密码不一致时注册被拦截', async () => {
    renderAt(['/register'], (qc) => qc.setQueryData(sessionQueryKey, null));
    const userEv = userEvent.setup();
    await userEv.type(screen.getByLabelText('登录名'), 'alice');
    await userEv.type(screen.getByLabelText('密码'), 'secret123');
    await userEv.type(screen.getByLabelText('确认密码'), 'different');
    await userEv.click(screen.getByRole('button', { name: '注册' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('两次输入的密码不一致');
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it('登录 401 显示错误且不形成重定向循环', async () => {
    vi.mocked(authApi.login).mockRejectedValue(
      new PlatformHttpError('AUTH_REQUIRED', '登录名或密码错误。', 401),
    );
    const { router } = renderAt(['/login'], (qc) => qc.setQueryData(sessionQueryKey, null));
    await fillLoginForm('alice', 'wrong');
    expect(await screen.findByRole('alert')).toHaveTextContent('登录名或密码错误。');
    expect(router.state.location.pathname).toBe('/login');
  });

  it('登录成功后按安全 returnTo 跳转', async () => {
    vi.mocked(authApi.login).mockResolvedValue(undefined);
    const { router } = renderAt(
      ['/login?returnTo=%2Fcampaigns'],
      (qc) => qc.setQueryData(sessionQueryKey, null),
    );
    await fillLoginForm('alice', 'secret123');
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns'));
  });

  it('登录后外部 returnTo 被拒绝，回到 /campaigns', async () => {
    vi.mocked(authApi.login).mockResolvedValue(undefined);
    const { router } = renderAt(
      ['/login?returnTo=%2F%2Fevil.com'],
      (qc) => qc.setQueryData(sessionQueryKey, null),
    );
    await fillLoginForm('alice', 'secret123');
    await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns'));
  });

  it('退出登录清空缓存并回到登录页', async () => {
    vi.mocked(authApi.logout).mockResolvedValue(undefined);
    // 登出后 /me 视为 guest（服务端已删除会话）。
    vi.mocked(authApi.me).mockRejectedValue(
      new PlatformHttpError('AUTH_REQUIRED', '请先登录。', 401),
    );
    const { router } = renderAt(['/campaigns'], (qc) => qc.setQueryData(sessionQueryKey, user));
    expect(await screen.findByRole('heading', { name: '我的战役' })).toBeInTheDocument();
    const userEv = userEvent.setup();
    await userEv.click(screen.getByRole('button', { name: '退出登录' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
  });

  it('session bootstrap：/me 返回 AUTH_REQUIRED 视为 guest', async () => {
    vi.mocked(authApi.me).mockRejectedValue(
      new PlatformHttpError('AUTH_REQUIRED', '请先登录。', 401),
    );
    const { router } = renderAt(['/campaigns']);
    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('session bootstrap：/me 返回用户直接进入受保护页', async () => {
    vi.mocked(authApi.me).mockResolvedValue(user);
    const { router } = renderAt(['/campaigns']);
    expect(await screen.findByRole('heading', { name: '我的战役' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/campaigns');
  });
});
