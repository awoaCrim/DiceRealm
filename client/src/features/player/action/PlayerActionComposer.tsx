import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { TurnStatus } from '@dnd/contracts';
import { useSubmitAction, useTurnList, useTurnView } from '../../../entities/turn/turnQueries';
import { AsyncState } from '../../../shared/ui/AsyncState';

const TURN_STATUS_LABEL: Record<TurnStatus, string> = {
  waiting_for_actions: '等待行动',
  locked: '已锁定',
  resolving: '结算中',
  needs_owner_attention: '需要主持处理',
  completed: '已完成',
};

/**
 * Player 行动页：waiting_for_actions 时可创建/编辑并提交；locked/resolving/
 * needs_owner_attention/completed 时禁用。本地草稿不被 SSE refetch 覆盖，
 * 只在用户未修改或提交成功后才采纳服务端确认正文。
 */
export function PlayerActionComposer() {
  const { campaignId } = useParams();
  const cid = campaignId ?? '';
  const turnList = useTurnList(cid);
  const latest = turnList.data && turnList.data.length > 0 ? turnList.data[turnList.data.length - 1] : undefined;
  const turn = latest?.turn;
  const progress = latest?.progress;
  const view = useTurnView(cid, turn?.id);
  const submit = useSubmitAction(cid);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const lastTurnIdRef = useRef<string | undefined>(undefined);

  const confirmedBody = view.data && 'myAction' in view.data ? (view.data.myAction?.body ?? '') : '';

  // 回合切换时重置草稿与脏标记。
  useEffect(() => {
    if (lastTurnIdRef.current !== turn?.id) {
      lastTurnIdRef.current = turn?.id;
      setDirty(false);
      setDraft(confirmedBody);
    }
  }, [turn?.id, confirmedBody]);

  // 非脏时跟随服务端确认正文（提交成功或其它客户端修改后 refetch）。
  useEffect(() => {
    if (!dirty) {
      setDraft(confirmedBody);
    }
  }, [confirmedBody, dirty]);

  const canEdit = turn?.status === 'waiting_for_actions';

  function handleSubmit() {
    if (!turn || !canEdit || draft.trim() === '') {
      return;
    }
    setSubmitError('');
    submit.mutate(
      { turnId: turn.id, body: draft },
      {
        onSuccess: (nextView) => {
          const body = 'myAction' in nextView ? (nextView.myAction?.body ?? '') : draft;
          setDraft(body);
          setDirty(false);
        },
        onError: (error) => {
          setSubmitError(error instanceof Error ? error.message : '提交失败。');
        },
      },
    );
  }

  const alreadySubmitted = view.data && 'myAction' in view.data && view.data.myAction !== null;

  return (
    <div className="player-action">
      <h1>行动</h1>
      <AsyncState
        status={turnList.isPending ? 'loading' : turnList.isError ? 'error' : !turn ? 'empty' : 'ready'}
        label="行动回合"
        errorMessage={turnList.error instanceof Error ? turnList.error.message : ''}
        onRetry={() => void turnList.refetch()}
      >
        {turn ? (
          <section aria-label="本回合行动">
            <h2>
              第 {turn.number} 回合 · {TURN_STATUS_LABEL[turn.status]}
            </h2>
            {progress ? (
              <p role="status">
                已提交 {progress.submittedPlayerIds.length} / {progress.requiredPlayerIds.length}
              </p>
            ) : null}
            {turn.status === 'locked' ? <p role="status">本回合已锁定。</p> : null}
            {turn.status === 'resolving' ? <p role="status">正在结算中…</p> : null}
            {turn.status === 'needs_owner_attention' ? (
              <p role="status">本回合需要主持处理，等待重新结算。</p>
            ) : null}
            {turn.status === 'completed' ? <p role="status">本回合已完成。</p> : null}
            {alreadySubmitted ? <p role="status">已提交，可修改直到回合锁定。</p> : null}
            <label htmlFor="action-body">行动内容</label>
            <textarea
              id="action-body"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setDirty(true);
              }}
              disabled={!canEdit}
              placeholder="描述你本回合的行动…"
            />
            <button
              onClick={handleSubmit}
              disabled={!canEdit || draft.trim() === '' || submit.isPending}
            >
              {submit.isPending ? '提交中…' : alreadySubmitted ? '更新行动' : '提交行动'}
            </button>
            {submitError ? <p role="alert">{submitError}</p> : null}
          </section>
        ) : null}
      </AsyncState>
    </div>
  );
}
