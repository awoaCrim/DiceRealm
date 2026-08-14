import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { RealtimeBoundary } from '../../app/realtime/RealtimeBoundary';
import { PlayerHeader } from './components/PlayerHeader';
import { PlayerInspector } from './components/PlayerInspector';
import { useCampaignDetail } from '../../entities/campaign/campaignQueries';
import * as authApi from '../../api/auth/authApi';
import { useSessionActions } from '../../entities/user/userQueries';

/** Player 工作区：Header + 导航 + MainPanel(Outlet) + Inspector。 */
export function PlayerWorkspacePage() {
  const { campaignId } = useParams();
  const navigate = useNavigate();
  const { clearSession } = useSessionActions();
  const detail = useCampaignDetail(campaignId);
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await authApi.logout();
    } catch {
      // 服务端注销失败也清理本地状态并回登录页。
    } finally {
      clearSession();
      navigate('/login', { replace: true });
    }
  }

  const campaignName = detail.data?.campaign?.name ?? '';

  return (
    <RealtimeBoundary campaignId={campaignId ?? ''}>
      <div className="workspace">
        <PlayerHeader campaignName={campaignName} loggingOut={loggingOut} onLogout={handleLogout} />
        <div className="workspace__body">
          <nav className="workspace__sidebar" aria-label="Player 导航">
            <ul>
              <li>
                <PlayerNavLink campaignId={campaignId ?? ''} to="story" label="剧情" />
              </li>
              <li>
                <PlayerNavLink campaignId={campaignId ?? ''} to="action" label="行动" />
              </li>
              <li>
                <PlayerNavLink campaignId={campaignId ?? ''} to="character" label="角色" />
              </li>
              <li>
                <PlayerNavLink campaignId={campaignId ?? ''} to="inventory" label="背包" />
              </li>
              <li>
                <PlayerNavLink campaignId={campaignId ?? ''} to="combat" label="战斗" />
              </li>
            </ul>
          </nav>
          <main className="workspace__main" aria-label="Player 工作区">
            <Outlet />
          </main>
          <PlayerInspector campaignId={campaignId ?? ''} />
        </div>
      </div>
    </RealtimeBoundary>
  );
}

function PlayerNavLink({ campaignId, to, label }: { campaignId: string; to: string; label: string }) {
  return (
    <NavLink
      to={`/campaigns/${encodeURIComponent(campaignId)}/player/${to}`}
      className={({ isActive }) => (isActive ? 'workspace__link is-active' : 'workspace__link')}
    >
      {label}
    </NavLink>
  );
}
