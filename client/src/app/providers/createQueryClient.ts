import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { PlatformHttpError, shouldNotRetry } from '../../shared/api/platformHttp';

export interface CreateAppQueryClientOptions {
  /** 测试可注入更快的重试间隔；不传则使用 TanStack Query 默认指数退避。 */
  retryDelayMs?: number;
  /**
   * 已登录期间任意 protected query/mutation 返回 AUTH_REQUIRED(401) 时回调。
   * App 接线为全局 authRequiredBus → AppProviders 清 Query Cache 并跳 /login?returnTo=…。
   * 不覆盖：session bootstrap /me 的 AUTH_REQUIRED（queryFn 内转为 guest null）；
   * auth login/register 表单 401（走平台错误 envelope，非 React Query mutation）。
   */
  onAuthRequired?: () => void;
}

/** 平台 AUTH_REQUIRED 错误判断：仅当平台错误 envelope 明确返回该码。 */
function isAuthRequiredError(error: unknown): boolean {
  return error instanceof PlatformHttpError && error.code === 'AUTH_REQUIRED';
}

/** 防御性排除：未来若登录/注册改为 React Query mutation，表单 401 也不触发全局跳转。 */
const AUTH_FORM_MUTATION_KEYS = new Set(['login', 'register']);

/** 应用默认 QueryClient：普通 query 最多 2 次重试；认证/权限/404/校验错误不重试；focus 时刷新。 */
export function createAppQueryClient(options: CreateAppQueryClientOptions = {}): QueryClient {
  const { retryDelayMs, onAuthRequired } = options;
  const notifyAuthRequired = () => {
    onAuthRequired?.();
  };
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (shouldNotRetry(error)) {
            return false;
          }
          return failureCount < 2;
        },
        retryDelay: retryDelayMs,
        refetchOnWindowFocus: true,
      },
      mutations: {
        retry: false,
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        if (isAuthRequiredError(error)) {
          notifyAuthRequired();
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const key = mutation.options.mutationKey;
        if (
          Array.isArray(key) &&
          key[0] === 'auth' &&
          typeof key[1] === 'string' &&
          AUTH_FORM_MUTATION_KEYS.has(key[1])
        ) {
          return; // 登录/注册表单 401 只显示表单错误，不触发全局跳转。
        }
        if (isAuthRequiredError(error)) {
          notifyAuthRequired();
        }
      },
    }),
  });
}
