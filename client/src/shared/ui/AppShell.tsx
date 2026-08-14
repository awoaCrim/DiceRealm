import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import * as authApi from '../../api/auth/authApi';
import { useSessionActions } from '../../entities/user/userQueries';

/** 已登录应用壳：品牌 + 退出登录；页面内容在 main 中渲染。 */
export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { clearSession } = useSessionActions();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await authApi.logout();
    } catch {
      // 即使服务端注销失败，也清理本地缓存并回登录页（本地状态仍是可信来源）。
    } finally {
      clearSession();
      navigate('/login', { replace: true });
    }
  }

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <span className="app-shell__brand">DND AI-DM</span>
        <button
          className="app-shell__logout"
          onClick={handleLogout}
          disabled={loggingOut}
        >
          退出登录
        </button>
      </header>
      <main className="app-shell__main">{children}</main>
    </div>
  );
}
