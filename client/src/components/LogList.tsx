import { formatIsoDateTime } from '../displayLabels';
import type { LogEntry } from '../types';

export function LogList({ title, logs }: { title: string; logs: LogEntry[] }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {logs.length === 0 ? <p className="muted">暂无记录。</p> : null}
      {logs.map((log) => (
        <article className="log-entry" key={log.id}>
          <strong>{log.title}</strong>
          <p>{log.content}</p>
          <small className="muted">{formatIsoDateTime(log.createdAt)}</small>
        </article>
      ))}
    </section>
  );
}
