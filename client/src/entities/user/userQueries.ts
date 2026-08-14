import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { AuthenticatedUser } from '@dnd/contracts';
import { PlatformHttpError, shouldNotRetry } from '../../shared/api/platformHttp';
import * as authApi from '../../api/auth/authApi';

export const sessionQueryKey = ['session'] as const;

export type SessionQueryResult = UseQueryResult<AuthenticatedUser | null>;

/**
 * 会话查询：/me 返回 AUTH_REQUIRED 时视为 guest（data = null），不是页面 error。
 * 瞬时网络错误（status 0）最多重试 2 次再进入 error，避免把网络抖动当未登录弹回 /login。
 */
export function useSessionQuery(): SessionQueryResult {
  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: async () => {
      try {
        return await authApi.me();
      } catch (error) {
        if (error instanceof PlatformHttpError && error.code === 'AUTH_REQUIRED') {
          return null;
        }
        throw error;
      }
    },
    staleTime: 30_000,
    retry: (failureCount, error) => (shouldNotRetry(error) ? false : failureCount < 2),
  });
}

/** 登录成功后刷新会话；登出后清空整个 Query Cache。 */
export function useSessionActions() {
  const queryClient = useQueryClient();
  return {
    refreshSession: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
    clearSession: () => {
      queryClient.clear();
    },
  };
}
