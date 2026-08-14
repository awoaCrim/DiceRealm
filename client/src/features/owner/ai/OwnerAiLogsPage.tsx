import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { AiRunView } from '@dnd/contracts';
import { useAiRunDetail, useCampaignAiRuns } from '../../../entities/ai/aiQueries';
import { abbreviateId } from '../../../shared/lib/abbreviate';
import { AsyncState } from '../../../shared/ui/AsyncState';

const RUN_STATUS_LABEL: Record<AiRunView['status'], string> = {
  running: '生成中',
  succeeded: '成功',
  failed: '失败',
};

/** Owner 战役级 AI 审计日志：列出全部 run，详情显式展开且由服务端 owner 权限保护。 */
export function OwnerAiLogsPage() {
  const { campaignId } = useParams();
  const runs = useCampaignAiRuns(campaignId);

  return (
    <div className="owner-ai-logs">
      <h1>AI 日志</h1>
      <p className="ai-managed-note">记录 AI-DM 每次回合结算的 Provider、模型、状态与错误；详情仅 Owner 可见。</p>
      <AsyncState
        status={runs.isPending ? 'loading' : runs.isError ? 'error' : !runs.data || runs.data.length === 0 ? 'empty' : 'ready'}
        label="AI 日志"
        errorMessage={runs.error instanceof Error ? runs.error.message : ''}
        onRetry={() => void runs.refetch()}
      >
        <section aria-label="AI 日志列表" className="ai-log-table-wrap">
          <table className="ai-log-table">
            <thead>
              <tr><th>序号</th><th>回合</th><th>Provider / 模型</th><th>状态</th><th>开始时间</th><th>详情</th></tr>
            </thead>
            <tbody>
              {runs.data?.map((run) => <RunRow key={run.id} campaignId={campaignId ?? ''} run={run} />)}
            </tbody>
          </table>
        </section>
      </AsyncState>
    </div>
  );
}

function RunRow({ campaignId, run }: { campaignId: string; run: AiRunView }) {
  const [open, setOpen] = useState(false);
  const detail = useAiRunDetail(campaignId, open ? run.id : undefined);
  const statusClass = run.status === 'succeeded' ? 'ok' : run.status === 'failed' ? 'danger' : 'warning';

  return (
    <>
      <tr>
        <td title={run.id}>#{run.campaignSequence}</td>
        <td title={run.turnId}>{abbreviateId(run.turnId)}</td>
        <td><strong>{run.provider}</strong><span className="ai-log-model">{run.model}</span></td>
        <td><span className={`status-chip ${statusClass}`}>{RUN_STATUS_LABEL[run.status]}</span>{run.errorCode ? <small className="ai-log-error">{run.errorCode}</small> : null}</td>
        <td>{formatDate(run.startedAt)}</td>
        <td><button type="button" onClick={() => setOpen((value) => !value)}>{open ? '收起详情' : '查看详情'}</button></td>
      </tr>
      {open ? (
        <tr className="ai-log-detail-row">
          <td colSpan={6}>
            {detail.isPending ? <div role="status">正在加载详情…</div> : null}
            {detail.isError ? <div role="alert">详情加载失败。</div> : null}
            {detail.data ? <div className="ai-log-detail-grid"><JsonBlock title="context" value={detail.data.context} /><JsonBlock title="result" value={detail.data.result} /><JsonBlock title="rawDebug" value={detail.data.rawDebug} /></div> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return <div><h3>{title}</h3><pre>{JSON.stringify(value, null, 2)}</pre></div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}
