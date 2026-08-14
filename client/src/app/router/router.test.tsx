// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '@dnd/contracts';
import { sessionQueryKey } from '../../entities/user/userQueries';
import { createAppQueryClient } from '../providers/createQueryClient';
import { createAppRouter } from './AppRouter';
import { PlatformHttpError } from '../../shared/api/platformHttp';

const owner: AuthenticatedUser = { userId: 'u-owner', login: 'owner' };

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

describe('AppRouter 路由守卫', () => {
  it('guest 访问 / 重定向到 /login', async () => {
    renderAt(['/'], (qc) => qc.setQueryData(sessionQueryKey, null));
    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
  });

  it('已登录访问 / 重定向到 /campaigns', async () => {
    renderAt(['/'], (qc) => qc.setQueryData(sessionQueryKey, owner));
    expect(await screen.findByRole('heading', { name: '我的战役' })).toBeInTheDocument();
  });

  it('guest 访问 protected 重定向到 /login 且携带安全 returnTo', async () => {
    const { router } = renderAt(['/campaigns'], (qc) => qc.setQueryData(sessionQueryKey, null));
    expect(await screen.findByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(decodeURIComponent(router.state.location.search)).toContain('returnTo=/campaigns');
  });

  it('已登录访问 /login 重定向到 /campaigns', async () => {
    renderAt(['/login'], (qc) => qc.setQueryData(sessionQueryKey, owner));
    expect(await screen.findByRole('heading', { name: '我的战役' })).toBeInTheDocument();
  });

  it('unknown 路由显示应用内 404 而不是 legacy 首页', async () => {
    renderAt(['/definitely-not-a-route'], (qc) => qc.setQueryData(sessionQueryKey, owner));
    expect(await screen.findByRole('heading', { name: '页面不存在' })).toBeInTheDocument();
    expect(screen.queryByText('创建本地多人跑团房间')).not.toBeInTheDocument();
  });

  it('legacy /admin/:roomId 与 /player/:token 显示统一 NotFound 页面而非迁移提示', async () => {
    for (const path of ['/admin/room-1', '/player/token-1']) {
      const { router } = renderAt([path], (qc) => qc.setQueryData(sessionQueryKey, owner));
      // 循环内多次 render 会累积 DOM；用 getAllByRole 断言至少存在一个目标 heading。
      await waitFor(() => {
        expect(screen.getAllByRole('heading', { name: '页面不存在' }).length, path).toBeGreaterThan(0);
      });
      expect(screen.queryByText('旧入口迁移提示'), path).not.toBeInTheDocument();
      expect(screen.queryByText('创建本地多人跑团房间'), path).not.toBeInTheDocument();
      // 不 redirect 到 /login 或 /campaigns：原地 404。
      expect(router.state.location.pathname, path).toBe(path);
    }
  });

  it('legacy URLs 对 guest session 同样显示 NotFound 且不跳转登录', async () => {
    const { router } = renderAt(['/admin/room-1'], (qc) => qc.setQueryData(sessionQueryKey, null));
    expect(await screen.findByRole('heading', { name: '页面不存在' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/room-1');
    expect(router.state.location.pathname).not.toBe('/login');
  });
});

describe('QueryClient 默认 retry 策略', () => {
  it('认证/权限/校验类 PlatformHttpError 不自动重试', async () => {
    const calls = vi.fn();
    const qc = createAppQueryClient();
    const queryFn = vi.fn(async () => {
      calls();
      throw new PlatformHttpError('AUTH_REQUIRED', '未登录。', 401);
    });
    function Probe() {
      const q = useQuery({ queryKey: ['probe-no-retry'], queryFn });
      return <div>{q.isError ? 'error' : 'loading'}</div>;
    }
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument());
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('普通 query 最多重试 2 次（共 3 次尝试）', async () => {
    const qc = createAppQueryClient({ retryDelayMs: 5 });
    const queryFn = vi.fn(async () => {
      throw new Error('boom');
    });
    function Probe() {
      const q = useQuery({ queryKey: ['probe-retry'], queryFn });
      return <div>{q.isError ? 'error' : 'loading'}</div>;
    }
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument());
    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  it('404 类错误不重试', async () => {
    const qc = createAppQueryClient();
    const queryFn = vi.fn(async () => {
      throw new PlatformHttpError('CAMPAIGN_NOT_FOUND', '战役不存在。', 404);
    });
    function Probe() {
      const q = useQuery({ queryKey: ['probe-404'], queryFn });
      return <div>{q.isError ? 'error' : 'loading'}</div>;
    }
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('error')).toBeInTheDocument());
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});
