import { Link } from 'react-router-dom';
import { AppShell } from '../../shared/ui/AppShell';
import { useCampaignList } from '../../entities/campaign/campaignQueries';
import { PlatformHttpError } from '../../shared/api/platformHttp';

/** 战役列表：ready/empty/error/retry；按角色卡片进入对应工作区。 */
export function CampaignListPage() {
  const { data, isPending, isError, error, refetch } = useCampaignList();

  let content;
  if (isPending) {
    content = <div role="status">正在加载战役列表…</div>;
  } else if (isError) {
    content = (
      <div role="alert">
        <p>战役列表加载失败。</p>
        <p>{error instanceof PlatformHttpError ? error.message : ''}</p>
        <button onClick={() => void refetch()}>重试</button>
      </div>
    );
  } else if (!data || data.length === 0) {
    content = (
      <div>
        <p>暂无战役。</p>
        <Link to="/campaigns/new">创建战役</Link>
      </div>
    );
  } else {
    content = (
      <ul className="campaign-grid">
        {data.map((campaign) => (
          <li key={campaign.id}>
            <article className="campaign-card">
              <h2>{campaign.name}</h2>
              <p>规则：{campaign.ruleset} · {campaign.role === 'owner' ? '主持' : '玩家'}</p>
              <Link
                aria-label={campaign.role === 'owner' ? '进入 Owner 工作区' : '进入 Player 工作区'}
                to={`/campaigns/${campaign.id}/${campaign.role === 'owner' ? 'owner' : 'player'}`}
              >
                进入{campaign.role === 'owner' ? ' Owner' : ' Player'} 工作区
              </Link>
            </article>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <AppShell>
      <h1>我的战役</h1>
      {content}
    </AppShell>
  );
}
