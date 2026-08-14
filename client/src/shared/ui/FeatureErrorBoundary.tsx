import { Component, type ErrorInfo, type ReactNode } from 'react';

interface FeatureErrorBoundaryProps {
  /** 脱敏标题，如「战斗面板」。 */
  fallbackTitle?: string;
  children: ReactNode;
}

interface FeatureErrorBoundaryState {
  error: Error | null;
}

/**
 * Feature 级错误边界：以 route panel 为最小单位。一个 panel throw
 * 不会卸载 Shell/header/sidebar 或其它 feature。fallback 只显示脱敏消息。
 */
export class FeatureErrorBoundary extends Component<
  FeatureErrorBoundaryProps,
  FeatureErrorBoundaryState
> {
  state: FeatureErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): FeatureErrorBoundaryState {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // 只记录诊断；不把原始错误渲染给用户。
    console.error('[FeatureErrorBoundary] feature crashed', _error);
  }

  render() {
    if (this.state.error) {
      const title = this.props.fallbackTitle ?? '此模块';
      return (
        <div role="alert" aria-live="assertive">
          <h2>{title}加载失败。</h2>
          <p>此模块出现异常，其它模块不受影响。请重试或返回。</p>
          <button onClick={() => this.setState({ error: null })}>重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}
