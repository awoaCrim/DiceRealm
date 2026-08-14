import { useRealtimeSnapshot } from '../../../app/realtime/RealtimeBoundary';
import { useCampaignDetail } from '../../../entities/campaign/campaignQueries';
import { abbreviateId } from '../../../shared/lib/abbreviate';

/** Owner 右侧信息栏：成员列表（ID 缩写）、实时连接状态。 */
export function OwnerInspector({ campaignId }: { campaignId: string }) {
  const detail = useCampaignDetail(campaignId);
  const snapshot = useRealtimeSnapshot();
  const members = detail.data?.members ?? [];

  return (
    <aside className="workspace__inspector" aria-label="战役信息">
      <h2>战役信息</h2>
      <dl>
        <dt>成员</dt>
        <dd>{members.length} 人</dd>
        <dt>实时状态</dt>
        <dd>{snapshot ? snapshot.status : '未连接'}</dd>
      </dl>
      <ul className="member-chips">
        {members.map((member) => (
          <li key={member.userId} title={member.userId}>
            {abbreviateId(member.userId)} · {member.role === 'owner' ? '主持' : '玩家'}
          </li>
        ))}
      </ul>
    </aside>
  );
}
