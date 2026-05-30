export function TurnPanel({ currentTurn, status, submittedPlayers, waitingPlayers }: {
  currentTurn: number;
  status: string;
  submittedPlayers: string[];
  waitingPlayers: string[];
}) {
  return (
    <section className="card">
      <h2>第 {currentTurn} 回合</h2>
      <p>状态：<strong>{status}</strong></p>
      <h3>已提交</h3>
      <p>{submittedPlayers.length ? submittedPlayers.join(', ') : '暂无玩家提交。'}</p>
      <h3>等待中</h3>
      <p>{waitingPlayers.length ? waitingPlayers.join(', ') : '所有玩家都已提交。'}</p>
    </section>
  );
}
