import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import * as authApi from '../../api/auth/authApi';
import { useSessionActions } from '../../entities/user/userQueries';
import { PlatformHttpError } from '../../shared/api/platformHttp';

/** 登录页：401 只显示表单错误；returnTo 仅接受安全站内路径。 */
export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const { refreshSession } = useSessionActions();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const registeredLogin = (location.state as { registeredLogin?: string } | null)?.registeredLogin;
  useEffect(() => {
    if (registeredLogin) {
      setLogin(registeredLogin);
    }
  }, [registeredLogin]);

  const returnTo = useMemo(() => {
    const raw = searchParams.get('returnTo');
    if (raw && raw.startsWith('/') && !raw.startsWith('//')) {
      return raw;
    }
    return '/campaigns';
  }, [searchParams]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await authApi.login({ login: login.trim(), password });
      await refreshSession();
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err instanceof PlatformHttpError ? err.message : '登录失败。');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-page">
      <main className="auth-card">
        <h1>登录</h1>
        {registeredLogin ? <p role="status">注册成功，请登录。</p> : null}
        {error ? <div role="alert">{error}</div> : null}
        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="login">登录名</label>
            <input
              id="login"
              aria-label="登录名"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="password">密码</label>
            <input
              id="password"
              aria-label="密码"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <button type="submit" disabled={pending}>登录</button>
        </form>
        <p><Link to="/register">没有账号？注册</Link></p>
      </main>
    </div>
  );
}
