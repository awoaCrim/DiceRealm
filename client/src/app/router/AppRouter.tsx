import { createBrowserRouter, createMemoryRouter, Navigate, type RouteObject } from 'react-router-dom';
import type { DataRouter } from 'react-router-dom';
import type { QueryClient } from '@tanstack/react-query';
import { LoginPage } from '../../features/auth/LoginPage';
import { RegisterPage } from '../../features/auth/RegisterPage';
import { CampaignListPage } from '../../features/campaigns/CampaignListPage';
import { CreateCampaignPage } from '../../features/campaigns/CreateCampaignPage';
import { JoinCampaignPage } from '../../features/campaigns/JoinCampaignPage';
import { OwnerWorkspacePage } from '../../features/owner/OwnerWorkspacePage';
import { OwnerTurnPage } from '../../features/owner/turn/OwnerTurnPage';
import { OwnerCharactersPage } from '../../features/owner/characters/OwnerCharactersPage';
import { OwnerWorldPage } from '../../features/owner/world/OwnerWorldPage';
import { OwnerCombatPage } from '../../features/owner/combat/OwnerCombatPage';
import { OwnerArchivesPage } from '../../features/owner/archives/OwnerArchivesPage';
import { OwnerAiProviderPage } from '../../features/owner/ai/OwnerAiProviderPage';
import { OwnerAiLogsPage } from '../../features/owner/ai/OwnerAiLogsPage';
import { PlayerWorkspacePage } from '../../features/player/PlayerWorkspacePage';
import { PlayerStoryPage } from '../../features/player/story/PlayerStoryPage';
import { PlayerActionComposer } from '../../features/player/action/PlayerActionComposer';
import { PlayerCharacterPage } from '../../features/player/character/PlayerCharacterPage';
import { PlayerInventoryPage } from '../../features/player/inventory/PlayerInventoryPage';
import { PlayerCombatPage } from '../../features/player/combat/PlayerCombatPage';
import { CampaignRoleGuard, GuestOnlyRoute, ProtectedRoute, RootRedirect } from './RouteGuards';
import { FeatureErrorBoundary } from '../../shared/ui/FeatureErrorBoundary';

/** 应用内 404：不退回 legacy 首页。 */
export function NotFoundPage() {
  return (
    <main>
      <h1>页面不存在</h1>
      <p>请求的地址不存在，请从导航重新进入。</p>
    </main>
  );
}

export interface CreateAppRouterOptions {
  /** 测试注入初始 URL（MemoryRouter）；缺省时使用真实浏览器 router。 */
  initialEntries?: string[];
}

/** 新应用路由树：认证/角色守卫 + 新页面；legacy 旧入口 URL 由 catch-all NotFoundPage 处理，不 redirect。 */
export function createAppRoutes(): RouteObject[] {
  return [
    {
      path: '/login',
      element: (
        <GuestOnlyRoute>
          <LoginPage />
        </GuestOnlyRoute>
      ),
    },
    {
      path: '/register',
      element: (
        <GuestOnlyRoute>
          <RegisterPage />
        </GuestOnlyRoute>
      ),
    },
    {
      path: '/campaigns',
      element: (
        <ProtectedRoute>
          <CampaignListPage />
        </ProtectedRoute>
      ),
    },
    {
      path: '/campaigns/new',
      element: (
        <ProtectedRoute>
          <CreateCampaignPage />
        </ProtectedRoute>
      ),
    },
    {
      path: '/campaigns/join/:campaignId',
      element: (
        <ProtectedRoute>
          <JoinCampaignPage />
        </ProtectedRoute>
      ),
    },
    {
      path: '/campaigns/:campaignId/owner',
      element: (
        <ProtectedRoute>
          <CampaignRoleGuard role="owner">
            <OwnerWorkspacePage />
          </CampaignRoleGuard>
        </ProtectedRoute>
      ),
      children: [
        { index: true, element: <Navigate to="turn" replace /> },
        { path: 'turn', element: <OwnerTurnPage /> },
        { path: 'characters', element: <OwnerCharactersPage /> },
        { path: 'world', element: <OwnerWorldPage /> },
        { path: 'combat', element: <OwnerCombatPage /> },
        { path: 'archives', element: <OwnerArchivesPage /> },
        { path: 'ai-provider', element: <OwnerAiProviderPage /> },
        { path: 'ai-logs', element: <OwnerAiLogsPage /> },
      ],
    },
    {
      path: '/campaigns/:campaignId/player',
      element: (
        <ProtectedRoute>
          <CampaignRoleGuard role="player">
            <PlayerWorkspacePage />
          </CampaignRoleGuard>
        </ProtectedRoute>
      ),
      children: [
        { index: true, element: <Navigate to="story" replace /> },
        {
          path: 'story',
          element: (
            <FeatureErrorBoundary fallbackTitle="剧情面板">
              <PlayerStoryPage />
            </FeatureErrorBoundary>
          ),
        },
        {
          path: 'action',
          element: (
            <FeatureErrorBoundary fallbackTitle="行动面板">
              <PlayerActionComposer />
            </FeatureErrorBoundary>
          ),
        },
        {
          path: 'character',
          element: (
            <FeatureErrorBoundary fallbackTitle="角色面板">
              <PlayerCharacterPage />
            </FeatureErrorBoundary>
          ),
        },
        {
          path: 'inventory',
          element: (
            <FeatureErrorBoundary fallbackTitle="背包面板">
              <PlayerInventoryPage />
            </FeatureErrorBoundary>
          ),
        },
        {
          path: 'combat',
          element: (
            <FeatureErrorBoundary fallbackTitle="战斗面板">
              <PlayerCombatPage />
            </FeatureErrorBoundary>
          ),
        },
      ],
    },
    // legacy 旧入口：不再挂迁移提示；旧 URL 由 catch-all NotFoundPage 处理，不 redirect。
    { path: '/', element: <RootRedirect /> },
    { path: '*', element: <NotFoundPage /> },
  ];
}

/** 稳定 router：浏览器模式（生产）或 MemoryRouter（测试 initialEntries）。 */
export function createAppRouter(_queryClient: QueryClient, options: CreateAppRouterOptions = {}): DataRouter {
  const routes = createAppRoutes();
  if (options.initialEntries) {
    return createMemoryRouter(routes, { initialEntries: options.initialEntries });
  }
  return createBrowserRouter(routes);
}
