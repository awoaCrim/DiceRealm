import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAiRunDetail, useAiRuns } from '../../../entities/ai/aiQueries';
import { useRealtimeSnapshot } from '../../../app/realtime/RealtimeBoundary';
import type { AiRunView } from '@dnd/contracts';
import { abbreviateId } from '../../../shared/lib/abbreviate';
import { AsyncState } from '../../../shared/ui/AsyncState';

const RUN_STATUS_LABEL: Record<AiRunView['status'], string> = {
  running: '生成中',
  succeeded: '成功',
  failed: '失败',
};

/** Owner AI run 列表 + 显式展开的详情（context/result/rawDebug 仅 owner）。 */
export function OwnerAiRunPanel({ campaignId, turnId }: { campaignId: string; turnId: string }) {
  const runs = useAiRuns(campaignId, turnId);
  const snapshot = useRealtimeSnapshot();

  return (
    <section aria-label="AI 运行">
      <h2>AI 运行</h2>
      <AsyncState
        status={runs.isPending ? 'loading' : runs.isError ? 'error' : !runs.data || runs.data.length === 0 ? 'empty' : 'ready'}
        label="AI 运行列表"
        errorMessage={runs.error instanceof Error ? runs.error.message : ''}
        onRetry={() => void runs.refetch()}
      >
        <ul className="ai-run-list">
          {runs.data?.map((run) => (
            <li key={run.id} className="ai-run-row">
              <span>{abbreviateId(run.id)}</span>
              <span>#{run.attempt}</span>
              <span>{RUN_STATUS_LABEL[run.status]}</span>
              {run.status === 'failed' && run.errorCode ? <span>{run.errorCode}</span> : null}
              {run.status === 'running' && snapshot?.previews.has(run.id) ? (
                <span className="ai-run-preview">临时生成中：{snapshot.previews.get(run.id)}</span>
              ) : null}
              <RunDetail campaignId={campaignId} run={run} />
            </li>
          ))}
        </ul>
      </AsyncState>
    </section>
  );
}

/** 显式展开的 run 详情；未展开不请求详情，避免把 owner-only 数据带到界面。 */
function RunDetail({ campaignId, run }: { campaignId: string; run: AiRunView }) {
  const [open, setOpen] = useState(false);
  // 未展开时 runId 传 undefined → query disabled，不发请求。
  const detail = useAiRunDetail(campaignId, open ? run.id : undefined);

  return (
    <details className="ai-run-detail" open={open}>
      <summary
        onClick={(event) => {
          // 受控展开：preventDefault 抑制原生 toggle，避免 jsdom/浏览器双击行为差异。
          event.preventDefault();
          setOpen((prev) => !prev);
        }}
      >
        展开详情
      </summary>
      {detail.isPending ? <div role="status">正在加载详情…</div> : null}
      {detail.isError ? <div role="alert">详情加载失败。</div> : null}
      {detail.data ? (
        <div className="ai-run-detail__body">
          <h3>context</h3>
          <pre>{JSON.stringify(detail.data.context, null, 2)}</pre>
          <h3>result</h3>
          <pre>{JSON.stringify(detail.data.result, null, 2)}</pre>
          <h3>rawDebug</h3>
          <pre>{JSON.stringify(detail.data.rawDebug, null, 2)}</pre>
        </div>
      ) : null}
    </details>
  );
}
