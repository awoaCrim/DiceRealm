import { promptModeLabel, promptRoleLabel, promptSourceLabel, ruleCategoryLabel, ruleReasonLabel, worldBookMatchReasonLabel, worldBookPositionLabel } from '../displayLabels';
import type { PromptPreviewResponse } from '../types';

export function PromptPreviewPanel({ preview }: { preview: PromptPreviewResponse | null }) {
  if (!preview) return null;

  return (
    <div className="prompt-preview">
      <h3>AI 请求预览</h3>
      <p>构建模式：{promptModeLabel(preview.mode)}</p>

      {preview.warnings.length ? (
        <section>
          <h4>警告</h4>
          <ul>{preview.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
        </section>
      ) : null}

      <section>
        <h4>上下文槽位</h4>
        {preview.slots.length ? preview.slots.map((slot, index) => (
          <div className="subcard" key={`${slot.key}-${slot.source}-${index}`}>
            <strong>{slot.key}</strong>
            <p className="muted">{promptSourceLabel(slot.source)}</p>
            <pre>{slot.content}</pre>
          </div>
        )) : <p className="muted">无上下文槽位。</p>}
      </section>

      <section>
        <h4>世界书命中</h4>
        {preview.worldBookMatches.length ? preview.worldBookMatches.map((match, index) => (
          <div className="subcard" key={`${match.worldBookId}-${match.entryId}-${index}`}>
            <strong>{worldBookMatchReasonLabel(match.reason)} · {worldBookPositionLabel(match.position)}</strong>
            <p className="muted">关键词：{match.keys.join(', ') || '常驻'}</p>
            <pre>{match.content}</pre>
          </div>
        )) : <p className="muted">无世界书命中。</p>}
      </section>

      {preview.ruleMatches.length ? (
        <section>
          <h4>5e 规则命中</h4>
          {preview.ruleMatches.map((match) => (
            <div className="subcard" key={match.entryId}>
              <strong>{match.title}</strong>
              <p className="muted">{ruleCategoryLabel(match.category)} · 匹配分 {match.score} · 命中方式：{match.reasons.map(ruleReasonLabel).join('、')}</p>
              <p>{match.summary}</p>
            </div>
          ))}
        </section>
      ) : null}

      <section>
        <h4>提示词块</h4>
        {preview.promptBlocks.length ? preview.promptBlocks.map((block, index) => (
          <div className="subcard" key={`${block.identifier}-${block.source}-${index}`}>
            <strong>{block.displayName || block.identifier}</strong>
            <p className="muted">
              {promptSourceLabel(block.source)} · {promptRoleLabel(block.role)}
              {block.displayName && block.displayName !== block.identifier ? ` · ID: ${block.identifier}` : ''}
            </p>
            <pre>{block.content}</pre>
          </div>
        )) : <p className="muted">无提示词块。</p>}
      </section>

      <section>
        <h4>最终 prompt</h4>
        <pre>{preview.prompt}</pre>
      </section>
    </div>
  );
}
