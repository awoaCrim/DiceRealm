export function TurnPanel({ currentTurn, status, submittedPlayers, waitingPlayers }: {
  currentTurn: number;
  status: string;
  submittedPlayers: string[];
  waitingPlayers: string[];
}) {
  const statusText: Record<string, { label: string; hint: string }> = {
    setup: { label: '准备中', hint: '等待主持人完成房间和角色准备。' },
    waiting_for_actions: { label: '等待行动', hint: '请提交本回合行动；已提交后等待其他玩家。' },
    ready_to_resolve: { label: '等待结算', hint: '所有必要行动已完成，等待主持人生成 AI 回合提示词。' },
    processing: { label: '结算中', hint: '主持人正在处理本回合，请暂时不要提交新行动。' },
    waiting_for_interaction: { label: '等待回应', hint: '本回合需要玩家先回应互动请求，回应完成后主持人再继续结算。' },
    needs_admin_attention: { label: '需要主持人处理', hint: '本回合需要主持人检查警告或错误后继续。' }
  };
  const displayStatus = statusText[status] ?? { label: status, hint: '当前回合状态由主持人控制。' };
  return (
    <section className="card">
      <h2>第 {currentTurn} 回合</h2>
      <p>状态：<strong>{displayStatus.label}</strong></p>
      <p className="muted">{displayStatus.hint}</p>
      <h3>已提交</h3>
      <p>{submittedPlayers.length ? submittedPlayers.join(', ') : '暂无玩家提交。'}</p>
      <h3>等待中</h3>
      <p>{waitingPlayers.length ? waitingPlayers.join(', ') : '所有玩家都已提交。'}</p>
    </section>
  );
}
