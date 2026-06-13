import { promptModeLabel, promptRoleLabel, promptSourceLabel, ruleCategoryLabel, ruleReasonLabel, worldBookMatchReasonLabel, worldBookPositionLabel } from '../displayLabels';
import type { PromptPreviewResponse } from '../types';

export function PromptPreviewPanel({ preview }: { preview: PromptPreviewResponse | null }) {
  if (!preview) return null;
  const promptLength = preview.prompt.length;

  return (
    <div className="prompt-preview">
      <h3>本轮 AI 请求预览</h3>
      <p className="muted">先看摘要，确认 AI 会参考哪些资料；完整 prompt 和原始槽位在下方调试详情里。</p>

      <section>
        <h4>请求摘要</h4>
        <div className="prompt-summary-grid">
          <div className="subcard">
            <strong>构建模式</strong>
            <p>{promptModeLabel(preview.mode)}</p>
          </div>
          <div className="subcard">
            <strong>本轮上下文</strong>
            <p>{preview.slots.length} 个槽位 · {promptLength} 字符</p>
          </div>
          <div className="subcard">
            <strong>战役数据库命中</strong>
            <p>{preview.worldBookMatches.length} 条 AI 参考资料</p>
          </div>
          <div className="subcard">
            <strong>5e 规则</strong>
            <p>{preview.ruleMatches.length} 条规则摘要</p>
          </div>
          <div className="subcard">
            <strong>主持规则块</strong>
            <p>{preview.promptBlocks.length} 个提示词块</p>
          </div>
        </div>
      </section>

      {preview.warnings.length ? (
        <section>
          <h4>警告</h4>
          <ul>{preview.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
        </section>
      ) : null}

      <section>
        <h4>战役数据库命中</h4>
        <p className="muted">这些资料由常驻或关键词命中进入 AI 上下文。旧世界书条目会逐步迁移为数据库记录的 AI 参考规则。</p>
        {preview.worldBookMatches.length ? preview.worldBookMatches.map((match, index) => (
          <div className="subcard" key={`${match.worldBookId}-${match.entryId}-${index}`}>
            <strong>{worldBookMatchReasonLabel(match.reason)} · {worldBookPositionLabel(match.position)}</strong>
            <p className="muted">关键词：{match.keys.join(', ') || '常驻'}</p>
            <pre>{match.content}</pre>
          </div>
        )) : <p className="muted">无战役数据库命中。</p>}
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

      <details>
        <summary>调试详情：上下文槽位</summary>
        {preview.slots.length ? preview.slots.map((slot, index) => (
          <div className="subcard" key={`${slot.key}-${slot.source}-${index}`}>
            <strong>{slot.key}</strong>
            <p className="muted">{promptSourceLabel(slot.source)}</p>
            <pre>{slot.content}</pre>
          </div>
        )) : <p className="muted">无上下文槽位。</p>}
      </details>

      <details>
        <summary>调试详情：提示词块</summary>
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
      </details>

      <details>
        <summary>调试详情：完整 prompt</summary>
        <pre>{preview.prompt}</pre>
      </details>
    </div>
  );
}
