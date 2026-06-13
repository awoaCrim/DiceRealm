import type { ReactNode } from 'react';
import { formatIsoDateTime } from '../displayLabels';
import type { LogEntry } from '../types';

type InlineTokenKind = 'dialogue' | 'formula' | 'difficulty' | 'success' | 'failure';

interface InlineTokenMatch {
  start: number;
  end: number;
  kind: InlineTokenKind;
  text: string;
  priority: number;
}

const inlineTokenPatterns: Array<{ regex: RegExp; kind: InlineTokenKind; priority: number }> = [
  { regex: /“[^”]+”|「[^」]+」|"[^"\n]+"/g, kind: 'dialogue', priority: 1 },
  { regex: /(?:说道|说|问|喊|回答|低声道|道|表示|提醒|嘀咕|补充)[^。！？\n]{0,24}[：:]\s*[^“「"。！？\n][^。！？\n]*[。！？]?/g, kind: 'dialogue', priority: 2 },
  { regex: /\d+\s*[+\-]\s*\d+\s*=\s*\d+/g, kind: 'formula', priority: 3 },
  { regex: /\b(?:DC|AC)\s*\d+\b/g, kind: 'difficulty', priority: 4 },
  { regex: /大成功|成功|命中/g, kind: 'success', priority: 5 },
  { regex: /大失败|失败|未命中/g, kind: 'failure', priority: 5 }
];

function tokenClassName(kind: InlineTokenKind): string {
  switch (kind) {
    case 'dialogue': return 'log-dialogue';
    case 'formula': return 'log-roll-total';
    case 'difficulty': return 'log-roll-dc';
    case 'success': return 'log-roll-success';
    case 'failure': return 'log-roll-failure';
  }
}

function collectInlineTokenMatches(text: string): InlineTokenMatch[] {
  const candidates: InlineTokenMatch[] = [];
  for (const pattern of inlineTokenPatterns) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      const start = match.index ?? -1;
      const value = match[0];
      if (start < 0 || !value) continue;
      candidates.push({
        start,
        end: start + value.length,
        kind: pattern.kind,
        text: value,
        priority: pattern.priority
      });
    }
  }

  const accepted: InlineTokenMatch[] = [];
  for (const candidate of candidates.sort((a, b) => a.start - b.start || a.priority - b.priority || b.end - a.end)) {
    if (accepted.some((item) => candidate.start < item.end && candidate.end > item.start)) continue;
    accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

function renderInlineLogText(text: string, keyPrefix: string): ReactNode[] {
  const matches = collectInlineTokenMatches(text);
  if (matches.length === 0) return [text];

  const nodes: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.start > cursor) nodes.push(text.slice(cursor, match.start));
    nodes.push(
      <span className={tokenClassName(match.kind)} key={`${keyPrefix}-${index}-${match.start}`}>
        {match.text}
      </span>
    );
    cursor = match.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderLogContent(content: string) {
  const sections = content.split(/\n{2,}/).filter((section) => section.trim());
  return sections.map((section, index) => {
    const trimmed = section.trim();
    if (trimmed.startsWith('🎲 系统骰点：') || trimmed.startsWith('🎲 隐藏骰点：')) {
      const diceText = trimmed.replace(/^🎲\s*(?:系统骰点|隐藏骰点)：\s*/, '').trim();
      return (
        <p className="log-dice-block" key={`${index}-${trimmed.slice(0, 12)}`}>
          {renderInlineLogText(`（${diceText}）`, `dice-${index}`)}
        </p>
      );
    }
    if (/^（.+掷出.+）$/.test(trimmed)) {
      return (
        <p className="log-dice-block" key={`${index}-${trimmed.slice(0, 12)}`}>
          {renderInlineLogText(trimmed, `dice-inline-${index}`)}
        </p>
      );
    }
    return <p key={`${index}-${trimmed.slice(0, 12)}`}>{renderInlineLogText(trimmed, `text-${index}`)}</p>;
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
