import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Outlet } from 'react-router-dom';
import { RealtimeBoundary } from '../../app/realtime/RealtimeBoundary';
import { OwnerHeader } from './components/OwnerHeader';
import { OwnerSidebar } from './components/OwnerSidebar';
import { OwnerInspector } from './components/OwnerInspector';
import { useCampaignDetail } from '../../entities/campaign/campaignQueries';
import * as authApi from '../../api/auth/authApi';
import { useSessionActions } from '../../entities/user/userQueries';

/** Owner 三栏工作区：Header + Sidebar + MainPanel(Outlet) + Inspector。 */
export function OwnerWorkspacePage() {
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
        <OwnerHeader campaignName={campaignName} loggingOut={loggingOut} onLogout={handleLogout} />
        <div className="workspace__body">
          <OwnerSidebar campaignId={campaignId ?? ''} />
          <main className="workspace__main" aria-label="Owner 工作区">
            <Outlet />
          </main>
          <OwnerInspector campaignId={campaignId ?? ''} />
        </div>
      </div>
    </RealtimeBoundary>
  );
}
