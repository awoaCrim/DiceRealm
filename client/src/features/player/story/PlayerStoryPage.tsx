import { useParams } from 'react-router-dom';
import { useRealtimeSnapshot } from '../../../app/realtime/RealtimeBoundary';
import { useTurnEntries } from '../../../entities/ai/aiQueries';
import { useTurnList } from '../../../entities/turn/turnQueries';
import { AsyncState } from '../../../shared/ui/AsyncState';
import { TurnEntries } from './TurnEntries';

/** Player 剧情页：最新回合的投影 entries + SSE AI 预览缓冲。 */
export function PlayerStoryPage() {
  const { campaignId } = useParams();
  const cid = campaignId ?? '';
  const turnList = useTurnList(cid);
  const turns = turnList.data ?? [];
  const latest = turns[turns.length - 1];
  // 剧情展示最近一个有内容的回合：新回合（waiting）尚无 entries 时回退到上一个已结算回合，
  // 保证结算成功后玩家仍能看到公开叙事与自己的私密结果。
  const storyTurn =
    latest && latest.turn.status === 'waiting_for_actions' && turns.length >= 2
      ? turns[turns.length - 2]
      : latest;
  const turnId = storyTurn?.turn.id;
  const entries = useTurnEntries(cid, turnId);
  const snapshot = useRealtimeSnapshot();
  const previews = snapshot?.previews ?? new Map<string, string>();

  return (
    <div className="player-story">
      <h1>剧情</h1>
      {turnId ? (
        <AsyncState
          status={entries.isPending ? 'loading' : entries.isError ? 'error' : 'ready'}
          label="剧情内容"
          errorMessage={entries.error instanceof Error ? entries.error.message : ''}
          onRetry={() => void entries.refetch()}
        >
          <TurnEntries entries={entries.data ?? []} />
        </AsyncState>
      ) : (
        <p>尚未有进行中的回合。</p>
      )}
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
