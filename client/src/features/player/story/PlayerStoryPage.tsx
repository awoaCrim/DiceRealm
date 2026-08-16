import { useParams } from 'react-router-dom';
import { useRealtimeSnapshot } from '../../../app/realtime/RealtimeBoundary';
import { useTurnList } from '../../../entities/turn/turnQueries';
import { AsyncState } from '../../../shared/ui/AsyncState';
import { TurnStoryHistory } from '../../story/TurnStoryHistory';

/** Player 剧情页：最新回合的投影 entries + SSE AI 预览缓冲。 */
export function PlayerStoryPage() {
  const { campaignId } = useParams();
  const cid = campaignId ?? '';
  const turnList = useTurnList(cid);
  const turns = turnList.data ?? [];
  const snapshot = useRealtimeSnapshot();
  const previews = snapshot?.previews ?? new Map<string, string>();

  return (
    <div className="player-story">
      <h1>剧情</h1>
      <AsyncState
        status={turnList.isPending ? 'loading' : turnList.isError ? 'error' : 'ready'}
        label="回合"
        errorMessage={turnList.error instanceof Error ? turnList.error.message : ''}
        onRetry={() => void turnList.refetch()}
      >
        <TurnStoryHistory campaignId={cid} turns={turns} audience="player" />
      </AsyncState>
      {previews.size > 0 ? (
        <section aria-label="AI 生成预览">
          <h2>AI 结算进行中</h2>
          {[...previews.entries()].map(([runId, text]) => (
            <p key={runId} className="preview-text">
              临时生成中：{text}
            </p>
          ))}
        </section>
      ) : null}
      {snapshot?.previewError ? (
        <p role="alert">AI 生成失败（{snapshot.previewError.code}），请主持重试。</p>
      ) : null}
    </div>
  );
}
