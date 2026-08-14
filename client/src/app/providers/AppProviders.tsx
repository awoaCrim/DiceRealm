import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type DataRouter } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { onAuthRequired } from '../auth/authRequiredBus';

export interface AppProvidersProps {
  queryClient: import('@tanstack/react-query').QueryClient;
  router: DataRouter;
  children?: ReactNode;
}

/** 全局唯一 Provider 层：Query Cache 之上挂 Router。无全局 Auth/Realtime context。 */
export function AppProviders({ queryClient, router }: AppProvidersProps) {
  useEffect(() => {
    // 已登录期间任何 protected API 返回 AUTH_REQUIRED：清 Query Cache（旧实时 session 随
    // campaign workspace unmount 停止）并跳 /login?returnTo=<当前安全路径>。
    // 登录/注册表单 401 由页面 catch 显示，不经过此总线，因此不会形成重定向循环。
    return onAuthRequired(() => {
      queryClient.clear();
      const location = router.state.location;
      const raw = `${location.pathname}${location.search}`;
      const returnTo = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/campaigns';
      void router.navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
    });
  }, [queryClient, router]);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
