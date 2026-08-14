import { useRealtimeSnapshot } from '../../../app/realtime/RealtimeBoundary';
import { useCampaignDetail } from '../../../entities/campaign/campaignQueries';
import { useCharacterProjection } from '../../../entities/character/characterQueries';
import { useTurnList } from '../../../entities/turn/turnQueries';
import { abbreviateId } from '../../../shared/lib/abbreviate';
import { readSheetNumber, readSheetString } from '../../../shared/lib/safeSheet';

/** Player 信息栏：自己的角色摘要、AC、提交进度、实时状态与交互提示。 */
export function PlayerInspector({ campaignId }: { campaignId: string }) {
  const detail = useCampaignDetail(campaignId);
  const projection = useCharacterProjection(campaignId);
  const turnList = useTurnList(campaignId);
  const snapshot = useRealtimeSnapshot();

  const myCharacter =
    projection.data?.myApproved[0] ??
    projection.data?.myDrafts[0] ??
    projection.data?.myRejected[0] ??
    projection.data?.myPending[0];

  const latest = turnList.data && turnList.data.length > 0 ? turnList.data[turnList.data.length - 1] : undefined;
  const progress = latest?.progress;

  return (
    <aside className="workspace__inspector" aria-label="我的信息">
      <h2>我的信息</h2>
      <dl>
        <dt>角色</dt>
        <dd>{myCharacter ? myCharacter.name : '未创建'}</dd>
        <dt>AC</dt>
        <dd>{myCharacter ? readSheetNumber(myCharacter.sheet, 'ac') : '—'}</dd>
        <dt>提交进度</dt>
        <dd>
          {progress ? `${progress.submittedPlayerIds.length} / ${progress.requiredPlayerIds.length}` : '—'}
        </dd>
        <dt>实时状态</dt>
        <dd>{snapshot ? snapshot.status : '未连接'}</dd>
      </dl>
      {snapshot && snapshot.interactionNoticeCount > 0 ? (
        <p role="status">有 {snapshot.interactionNoticeCount} 个待确认交互提示（当前版本暂不支持回答）。</p>
      ) : null}
      <p>
        成员 <span title={detail.data?.campaign.ownerId}>{abbreviateId(detail.data?.campaign.ownerId ?? '')}</span>（主持）
      </p>
    </aside>
  );
}
