import { useState } from 'react';
import { createRoom } from '../api';

export function HomePage() {
  const [name, setName] = useState('烛堡之门');
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    try {
      const room = await createRoom({ name });
      window.location.href = room.adminUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="shell">
      <section className="card">
        <div className="page-header">
          <h1>DND AI-DM</h1>
          <p className="muted">创建本地多人跑团房间，并为每位玩家隔离可见信息。</p>
          <p className="muted">所有房间都会实时使用当前全局配置。</p>
        </div>
        <label>房间名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        {error ? <p>{error}</p> : null}
        <button onClick={submit}>创建房间</button>
      </section>
    </main>
  );
}
