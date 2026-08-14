import type { ReactNode } from 'react';

/** 单区块异步状态类型：feature 组合 locked/waiting/ai-generating 等更高阶状态。 */
export type AsyncStateStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'retrying';

export interface AsyncStateProps {
  status: AsyncStateStatus;
  /** 区块名，用于可访问文案，如「角色列表」。 */
  label: string;
  errorMessage?: string;
  onRetry?: () => void;
  children?: ReactNode;
}

/** 只负责单个区块的 loading/empty/error/retrying 表现；ready 时渲染 children。 */
export function AsyncState({ status, label, errorMessage, onRetry, children }: AsyncStateProps) {
  if (status === 'loading' || status === 'idle') {
    return <div role="status">正在加载{label}…</div>;
  }
  if (status === 'retrying') {
    return <div role="status">加载{label}失败，正在重试…</div>;
  }
  if (status === 'error') {
    return (
      <div role="alert">
        <p>{label}加载失败。</p>
        {errorMessage ? <p>{errorMessage}</p> : null}
        {onRetry ? <button onClick={onRetry}>重试</button> : null}
      </div>
    );
  }
  if (status === 'empty') {
    return <div>暂无{label}。</div>;
  }
  return <>{children}</>;
}
