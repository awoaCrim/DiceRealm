import { formatIsoDateTime } from '../displayLabels';
import type { LogEntry } from '../types';

function renderLogContent(content: string) {
  const sections = content.split(/\n{2,}/).filter((section) => section.trim());
  return sections.map((section, index) => {
    const trimmed = section.trim();
    if (trimmed.startsWith('🎲 系统骰点：') || trimmed.startsWith('🎲 隐藏骰点：')) {
      const diceText = trimmed.replace(/^🎲\s*(?:系统骰点|隐藏骰点)：\s*/, '').trim();
      return (
        <p className="log-dice-block" key={`${index}-${trimmed.slice(0, 12)}`}>
          （{diceText}）
        </p>
      );
    }
    if (/^（.+掷出.+）$/.test(trimmed)) {
      return <p className="log-dice-block" key={`${index}-${trimmed.slice(0, 12)}`}>{trimmed}</p>;
    }
    return <p key={`${index}-${trimmed.slice(0, 12)}`}>{trimmed}</p>;
  });
}

export function LogList({ title, logs }: { title: string; logs: LogEntry[] }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {logs.length === 0 ? <p className="muted">暂无记录。</p> : null}
      {logs.map((log) => (
        <article className="log-entry" key={log.id}>
          <strong>{log.title}</strong>
          {renderLogContent(log.content)}
          <small className="muted">{formatIsoDateTime(log.createdAt)}</small>
        </article>
      ))}
    </section>
  );
}
