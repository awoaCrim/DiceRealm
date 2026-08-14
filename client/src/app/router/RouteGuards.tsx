import type { ReactNode } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useCampaignDetail } from '../../entities/campaign/campaignQueries';
import { useSessionQuery } from '../../entities/user/userQueries';
import { PlatformHttpError } from '../../shared/api/platformHttp';

function SessionLoading() {
  return <div role="status">正在恢复登录状态…</div>;
}

/** /me 非 AUTH_REQUIRED 的失败（如瞬时网络错误）显示可重试状态，绝不当作未登录。 */
function SessionError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert">
      <p>登录状态检查失败。</p>
      <button onClick={onRetry}>重试</button>
    </div>
  );
}

/** 已登录才能访问；guest 带安全 returnTo 跳 /login。 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const session = useSessionQuery();
  const location = useLocation();
  if (session.isPending) {
    return <SessionLoading />;
  }
  if (session.isError) {
    return <SessionError onRetry={() => void session.refetch()} />;
  }
  if (!session.data) {
    const returnTo = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  return <>{children}</>;
}

/** 仅 guest 可访问（/login、/register）；已登录跳 /campaigns。 */
export function GuestOnlyRoute({ children }: { children: ReactNode }) {
  const session = useSessionQuery();
  if (session.isPending) {
    return <SessionLoading />;
  }
  if (session.isError) {
    return <SessionError onRetry={() => void session.refetch()} />;
  }
  if (session.data) {
    return <Navigate to="/campaigns" replace />;
  }
  return <>{children}</>;
}

/** 根路由：已登录 → /campaigns；未登录 → /login。 */
export function RootRedirect() {
  const session = useSessionQuery();
  if (session.isPending) {
    return <SessionLoading />;
  }
  if (session.isError) {
    return <SessionError onRetry={() => void session.refetch()} />;
  }
  if (session.data) {
    return <Navigate to="/campaigns" replace />;
  }
  return <Navigate to="/login" replace />;
}

/** 战役角色守卫：URL 工作区与成员角色不一致时重定向；非成员回 /campaigns。 */
export function CampaignRoleGuard({ role, children }: { role: 'owner' | 'player'; children: ReactNode }) {
  const { campaignId } = useParams();
  const session = useSessionQuery();
  const detail = useCampaignDetail(campaignId);
  if (session.isPending || detail.isPending) {
    return <div role="status">正在加载战役…</div>;
  }
  if (detail.isError) {
    if (detail.error instanceof PlatformHttpError && detail.error.code === 'CAMPAIGN_NOT_FOUND') {
      return <Navigate to="/campaigns" replace />;
    }
    return <div role="alert">战役加载失败。</div>;
  }
  const userId = session.data?.userId;
  const member = detail.data?.members.find((entry) => entry.userId === userId);
  if (!member) {
    return <Navigate to="/campaigns" replace />;
  }
  if (member.role !== role) {
    const target =
      member.role === 'owner'
        ? `/campaigns/${campaignId}/owner`
        : `/campaigns/${campaignId}/player`;
    return <Navigate to={target} replace />;
  }
  return <>{children}</>;
}
