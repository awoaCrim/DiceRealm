import type { PromptPreviewResponse } from '../types';

export function PromptPreviewPanel({ preview }: { preview: PromptPreviewResponse | null }) {
  if (!preview) return null;

  return (
    <div className="prompt-preview">
      <h3>AI 请求预览</h3>
      <p>构建模式：{preview.mode}</p>

      {preview.warnings.length ? (
        <section>
          <h4>warnings</h4>
          <ul>{preview.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
        </section>
      ) : null}

      <section>
        <h4>slots</h4>
        {preview.slots.length ? preview.slots.map((slot, index) => (
          <div className="subcard" key={`${slot.key}-${slot.source}-${index}`}>
            <strong>{slot.key}</strong>
            <p className="muted">{slot.source}</p>
            <pre>{slot.content}</pre>
          </div>
        )) : <p className="muted">无 slots。</p>}
      </section>

      <section>
        <h4>worldBookMatches</h4>
        {preview.worldBookMatches.length ? preview.worldBookMatches.map((match, index) => (
          <div className="subcard" key={`${match.worldBookId}-${match.entryId}-${index}`}>
            <strong>{match.reason} · {match.position}</strong>
            <p className="muted">关键词：{match.keys.join(', ') || '常驻'}</p>
            <pre>{match.content}</pre>
          </div>
        )) : <p className="muted">无 worldBookMatches。</p>}
      </section>

      {preview.ruleMatches.length ? (
        <section>
          <h4>5e 规则命中</h4>
          {preview.ruleMatches.map((match) => (
            <div className="subcard" key={match.entryId}>
              <strong>{match.title}</strong>
              <p className="muted">{match.category} · score {match.score} · {match.reasons.join(', ')}</p>
              <p>{match.summary}</p>
            </div>
          ))}
        </section>
      ) : null}

      <section>
        <h4>promptBlocks</h4>
        {preview.promptBlocks.length ? preview.promptBlocks.map((block, index) => (
          <div className="subcard" key={`${block.identifier}-${block.source}-${index}`}>
            <strong>{block.displayName || block.identifier}</strong>
            <p className="muted">
              {block.source} · {block.role}
              {block.displayName && block.displayName !== block.identifier ? ` · ID: ${block.identifier}` : ''}
            </p>
            <pre>{block.content}</pre>
          </div>
        )) : <p className="muted">无 promptBlocks。</p>}
      </section>

      <section>
        <h4>最终 prompt</h4>
        <pre>{preview.prompt}</pre>
      </section>
    </div>
  );
}
