/** AUTH_REQUIRED 全局事件总线：QueryClient 错误 → AppProviders 订阅 → 清缓存并跳 /login。 */

export type AuthRequiredListener = () => void;

const listeners = new Set<AuthRequiredListener>();

/** 已登录期间任意 protected query/mutation 返回 AUTH_REQUIRED 时由 QueryClient 通知。 */
export function emitAuthRequired(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/** 订阅全局会话过期事件；返回取消订阅函数。 */
export function onAuthRequired(listener: AuthRequiredListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试专用：清空全部订阅，防止跨测试泄漏。 */
export function resetAuthRequiredBus(): void {
  listeners.clear();
}
