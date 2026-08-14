import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { TurnStatus } from '@dnd/contracts';
import { useRealtimeSnapshot } from '../../../app/realtime/RealtimeBoundary';
import { useResolveTurn } from '../../../entities/ai/aiQueries';
import { useStartTurn, useTurnList, useTurnView } from '../../../entities/turn/turnQueries';
import { abbreviateId } from '../../../shared/lib/abbreviate';
import { PlatformHttpError } from '../../../shared/api/platformHttp';
import { AsyncState } from '../../../shared/ui/AsyncState';
import { OwnerAiRunPanel } from './OwnerAiRunPanel';

const TURN_STATUS_LABEL: Record<TurnStatus, string> = {
  waiting_for_actions: '等待行动',
  locked: '已锁定',
  resolving: '结算中',
  needs_owner_attention: '需要主持处理',
  completed: '已完成',
};

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Owner 回合页：最新回合、提交进度、owner 可见行动正文、start/resolve。 */
export function OwnerTurnPage() {
  const { campaignId } = useParams();
  const cid = campaignId ?? '';
  const turnList = useTurnList(cid);
  const latest = turnList.data && turnList.data.length > 0 ? turnList.data[turnList.data.length - 1] : undefined;
  const turn = latest?.turn;
  const progress = latest?.progress;
  const view = useTurnView(cid, turn?.id);
  const startTurn = useStartTurn(cid);
  const resolve = useResolveTurn(cid, turn?.id ?? '');
  const snapshot = useRealtimeSnapshot();
  const idemKeyRef = useRef<string | null>(null);
  const [resolveError, setResolveError] = useState<string>('');

  // 回合切换后旧 key 已绑定旧 turn，服务端会拒绝复用；每次进入新回合强制新 key。
  useEffect(() => {
    idemKeyRef.current = null;
  }, [turn?.id]);

  function ensureKey(): string {
    if (!idemKeyRef.current) {
      idemKeyRef.current = createIdempotencyKey();
    }
    return idemKeyRef.current;
  }

  function handleResolve() {
    setResolveError('');
    resolve.mutate(ensureKey(), {
      onSuccess: () => {
        // 已收到 HTTP 成功响应（201/200）：网络级重复提交语义结束，释放 key。
        idemKeyRef.current = null;
      },
      onError: (error) => {
        // 服务端已确认失败（或非纯网络失败）：重试必须生成新 key。
        const isNetworkOnly = error instanceof PlatformHttpError && error.status === 0;
        if (!isNetworkOnly) {
          idemKeyRef.current = null;
        }
        setResolveError(error instanceof Error ? error.message : '结算请求失败。');
      },
    });
  }

  const canStart = !turn || turn.status === 'completed';
  const canResolve = turn ? ['locked', 'resolving', 'needs_owner_attention'].includes(turn.status) : false;

  return (
    <div className="owner-turn">
      <h1>回合与 AI 运行</h1>
      <AsyncState
        status={turnList.isPending ? 'loading' : turnList.isError ? 'error' : !turn ? 'empty' : 'ready'}
        label="回合"
        errorMessage={turnList.error instanceof Error ? turnList.error.message : ''}
        onRetry={() => void turnList.refetch()}
      >
        {turn ? (
          <section aria-label="最新回合" className="turn-card">
            <h2>
              第 {turn.number} 回合 · {TURN_STATUS_LABEL[turn.status]}
            </h2>
            {progress ? (
              <p>
                已提交 {progress.submittedPlayerIds.length} / {progress.requiredPlayerIds.length}
              </p>
            ) : null}
            {progress ? (
              <ul className="member-chips" aria-label="提交进度">
                {progress.requiredPlayerIds.map((playerId) => (
                  <li key={playerId} title={playerId}>
                    {abbreviateId(playerId)}
                    {progress.submittedPlayerIds.includes(playerId) ? ' ✓' : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {view.data && 'actions' in view.data && view.data.actions.length > 0 ? (
              <div aria-label="玩家行动">
                <h3>行动</h3>
                <ul>
                  {view.data.actions.map((action) => (
                    <li key={action.id} className="action-row">
                      <span className="action-row__player" title={action.playerId}>
                        {abbreviateId(action.playerId)}
                      </span>
                      <p className="action-row__body">{action.body}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}
      </AsyncState>
      <div className="turn-actions">
        {canStart ? (
          <button onClick={() => startTurn.mutate()} disabled={startTurn.isPending}>
            {startTurn.isPending ? '开始中…' : '开始回合'}
          </button>
        ) : null}
        {canResolve ? (
          <button onClick={handleResolve} disabled={resolve.isPending}>
            {resolve.isPending
              ? '结算中…'
              : turn?.status === 'needs_owner_attention'
                ? '重新结算'
                : '发起 AI 结算'}
          </button>
        ) : null}
        {resolveError ? <p role="alert">{resolveError}</p> : null}
      </div>
      {turn ? <OwnerAiRunPanel campaignId={cid} turnId={turn.id} /> : null}
      {snapshot?.interactionNoticeCount ? (
        <p role="status">有 {snapshot.interactionNoticeCount} 个待确认交互提示（当前版本暂不支持回答）。</p>
      ) : null}
    </div>
  );
}
