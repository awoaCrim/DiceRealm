import { useEffect, useState } from 'react';
import { createRoom, deleteRoom, listRooms } from '../api';
import type { RoomSummary } from '../types';

export function HomePage() {
  const [name, setName] = useState('烛堡之门');
  const [error, setError] = useState('');
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [deletingRoomId, setDeletingRoomId] = useState<string | null>(null);

  async function loadRooms() {
    setRoomsLoading(true);
    try {
      const result = await listRooms();
      setRooms(result.rooms);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRoomsLoading(false);
    }
  }

  useEffect(() => {
    void loadRooms();
  }, []);

  async function submit() {
    setError('');
    try {
      const room = await createRoom({ name });
      window.location.href = room.adminUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeRoom(room: RoomSummary) {
    if (!window.confirm(`确定删除房间“${room.name}”？此操作会删除该房间的玩家、角色、日志和回合数据。`)) return;
    setError('');
    setDeletingRoomId(room.id);
    try {
      await deleteRoom(room.id);
      setRooms((current) => current.filter((item) => item.id !== room.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingRoomId(null);
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
      <section className="card">
        <div className="page-header">
          <h2>已有房间</h2>
          <p className="muted">可以直接进入已有房间，或删除不再需要的房间。</p>
        </div>
        {roomsLoading ? <p className="muted">正在加载房间...</p> : null}
        {!roomsLoading && rooms.length === 0 ? <p className="muted">暂无房间。</p> : null}
        {rooms.length > 0 ? (
          <div className="room-list">
            {rooms.map((room) => (
              <div className="subcard room-list-item" key={room.id}>
                <div>
                  <strong>{room.name}</strong>
                  <p className="muted">
                    第 {room.currentTurn} 回合 · {room.status} · {room.playerCount} 名玩家 · {new Date(room.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="button-row">
                  <a className="button-link" href={room.adminUrl}>进入房间</a>
                  <button onClick={() => void removeRoom(room)} disabled={deletingRoomId === room.id}>
                    {deletingRoomId === room.id ? '删除中...' : '删除'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}
