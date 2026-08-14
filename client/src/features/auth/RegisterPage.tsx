import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as authApi from '../../api/auth/authApi';
import { PlatformHttpError } from '../../shared/api/platformHttp';

/** 注册页：成功不自动登录，跳 /login 并预填登录名。 */
export function RegisterPage() {
  const navigate = useNavigate();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('两次输入的密码不一致。');
      return;
    }
    setPending(true);
    try {
      const user = await authApi.register({ login: login.trim(), password });
      navigate('/login', { replace: true, state: { registeredLogin: user.login } });
    } catch (err) {
      setError(err instanceof PlatformHttpError ? err.message : '注册失败。');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-page">
      <main className="auth-card">
        <h1>注册</h1>
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
              autoComplete="new-password"
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="confirm-password">确认密码</label>
            <input
              id="confirm-password"
              aria-label="确认密码"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <button type="submit" disabled={pending}>注册</button>
        </form>
        <p><Link to="/login">已有账号？登录</Link></p>
      </main>
    </div>
  );
}
