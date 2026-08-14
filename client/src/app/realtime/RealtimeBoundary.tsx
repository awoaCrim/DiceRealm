import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import {
  RealtimeSession,
  type EventSourceFactory,
  type RealtimeSnapshot,
  type RealtimeStatus,
} from './RealtimeSession';

/** 工作区子页面读取实时状态（连接状态、AI preview buffer、interaction notice 数）。 */
export const RealtimeSnapshotContext = createContext<RealtimeSnapshot | null>(null);

export function useRealtimeSnapshot(): RealtimeSnapshot | null {
  return useContext(RealtimeSnapshotContext);
}

function statusLabel(status: RealtimeStatus): string {
  switch (status) {
    case 'connected':
      return '实时连接正常';
    case 'connecting':
      return '正在连接实时服务…';
    case 'retrying':
      return '正在重新连接实时服务…';
    case 'disconnected':
      return '实时连接已断开，正在重连…';
    default:
      return '实时未连接';
  }
}

export interface RealtimeBoundaryProps {
  campaignId: string;
  /** 测试注入 EventSourceFactory；生产缺省使用原生 EventSource。 */
  eventSourceFactory?: EventSourceFactory;
  children: ReactNode;
}

/** campaign workspace 挂载点时管理唯一的 RealtimeSession；渲染连接状态。 */
export function RealtimeBoundary({ campaignId, eventSourceFactory, children }: RealtimeBoundaryProps) {
  const queryClient = useQueryClient();
  const sessionRef = useRef<RealtimeSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new RealtimeSession(queryClient, eventSourceFactory);
  }
  const session = sessionRef.current;

  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const getSnapshot = useCallback(() => session.getSnapshot(), [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    session.start(campaignId);
    return () => {
      session.stop();
    };
  }, [session, campaignId]);

  return (
    <RealtimeSnapshotContext.Provider value={snapshot}>
      <div className="realtime-boundary">
        <div role="status" aria-live="polite" className="realtime-status">
          {statusLabel(snapshot.status)}
        </div>
        {children}
      </div>
    </RealtimeSnapshotContext.Provider>
  );
}
