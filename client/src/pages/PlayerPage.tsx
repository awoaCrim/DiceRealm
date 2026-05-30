import { useEffect, useState } from 'react';
import { getPlayerState, respondToInteraction, restCharacter, submitAction, subscribeRoom } from '../api';
import { CharacterBuilder } from '../components/CharacterBuilder';
import { CharacterCard } from '../components/CharacterCard';
import { LogList } from '../components/LogList';
import { TurnPanel } from '../components/TurnPanel';
import type { PlayerVisibleState } from '../types';

type PlayerActionType = 'narrative' | 'exploration' | 'social' | 'combat' | 'ooc';
type ExplorationAction = 'stealth' | 'perception' | 'investigation' | 'lockpick' | 'disarmTrap' | 'track' | 'solvePuzzle';
type SocialAction = 'persuade' | 'deceive' | 'intimidate' | 'haggle' | 'negotiate';

const explorationActions: { value: ExplorationAction; label: string; dcInfo: string }[] = [
  { value: 'stealth', label: '潜行', dcInfo: 'DC 12 (敏捷)' },
  { value: 'perception', label: '察觉', dcInfo: 'DC 12 (感知)' },
  { value: 'investigation', label: '调查', dcInfo: 'DC 13 (智力)' },
  { value: 'lockpick', label: '开锁', dcInfo: 'DC 15 (敏捷)' },
  { value: 'disarmTrap', label: '解除陷阱', dcInfo: 'DC 15 (敏捷)' },
  { value: 'track', label: '追踪', dcInfo: 'DC 13 (感知)' },
  { value: 'solvePuzzle', label: '解谜', dcInfo: 'DC 12 (智力)' },
];

const socialActions: { value: SocialAction; label: string; dcInfo: string }[] = [
  { value: 'persuade', label: '说服', dcInfo: 'DC 15 (魅力)' },
  { value: 'deceive', label: '欺骗', dcInfo: 'DC 15 (魅力)' },
  { value: 'intimidate', label: '威吓', dcInfo: 'DC 17 (魅力，偏难)' },
  { value: 'haggle', label: '交易', dcInfo: 'DC 15 (魅力)' },
  { value: 'negotiate', label: '谈判', dcInfo: '3次检定 (魅力)' },
];

export function PlayerPage({ token }: { token: string }) {
  const [state, setState] = useState<PlayerVisibleState | null>(null);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [actionType, setActionType] = useState<PlayerActionType>('narrative');
  const [subAction, setSubAction] = useState('');
  const [isHiddenRoll, setIsHiddenRoll] = useState(false);

  async function refresh() {
    setState(await getPlayerState(token));
  }

  useEffect(() => {
    let unsubscribe = () => {};
    void getPlayerState(token).then((next) => {
      setState(next);
      unsubscribe = subscribeRoom(next.room.id, () => void refresh());
    });
    return () => unsubscribe();
  }, [token]);

  async function submit() {
    setError('');
    try {
      await submitAction(token, action, actionType, isHiddenRoll);
      setAction('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function getSubActionDcInfo(): string | null {
    if (actionType === 'exploration') {
      const found = explorationActions.find((a) => a.value === subAction);
      return found?.dcInfo ?? null;
    }
    if (actionType === 'social') {
      const found = socialActions.find((a) => a.value === subAction);
      return found?.dcInfo ?? null;
    }
    return null;
  }

  async function respond(interactionId: string, response: string) {
    await respondToInteraction(token, interactionId, response);
    await refresh();
  }

  async function doRest(action: 'short' | 'long', hitDiceSpent?: number) {
    if (!state?.character) return;
    setError('');
    try {
      await restCharacter(state.room.id, state.character.id, {
        action,
        actorType: 'player',
        actorId: state.player.id,
        ...(hitDiceSpent !== undefined ? { hitDiceSpent } : {})
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const showResources = state?.resources && state?.character?.confirmed;

  if (!state) return <main className="shell"><p>加载中...</p></main>;

  return (
    <main className="shell">
      <div className="page-header">
        <h1>{state.room.name}</h1>
        <p className="muted">玩家视图 · {state.player.name}</p>
      </div>
      <div className="grid player-layout">
        <aside className="side-stack">
          {state.character?.confirmed ? (
            <CharacterCard character={state.character} />
          ) : (
            <CharacterBuilder
              token={token}
              initialDraft={state.character?.sheet.builderDraft ?? null}
              onChanged={refresh}
              setError={setError}
            />
          )}
          <TurnPanel currentTurn={state.room.currentTurn} status={state.room.status} submittedPlayers={state.submittedPlayers} waitingPlayers={state.waitingPlayers} />
          {showResources ? (
            <section className="card">
              <h2>角色资源</h2>
              <div className="subcard">
                <strong>HP: {state.resources!.hitPoints.current} / {state.resources!.hitPoints.max}</strong>
                {state.resources!.hitPoints.temp > 0 ? <span> (临时 {state.resources!.hitPoints.temp})</span> : null}
                <div className="hp-bar-bg">
                  <div className="hp-bar-fill" style={{
                    width: `${Math.min(100, Math.round(state.resources!.hitPoints.current / state.resources!.hitPoints.max * 100))}%`,
                    background: state.resources!.hitPoints.current > state.resources!.hitPoints.max / 2 ? '#79bd74' : state.resources!.hitPoints.current > 0 ? '#dfa34b' : '#de6f62'
                  }} />
                </div>
              </div>
              {state.resources!.hitDice.total > 0 ? (
                <p>生命骰: {state.resources!.hitDice.remaining} / {state.resources!.hitDice.total} ({state.resources!.hitDice.die})</p>
              ) : null}
              {Object.keys(state.resources!.spellSlots).length > 0 ? (
                <div>
                  <strong>法术位</strong>
                  {Object.entries(state.resources!.spellSlots).map(([level, slots]) => (
                    <p key={level}>{level}环: {slots.total - slots.used} / {slots.total}</p>
                  ))}
                </div>
              ) : null}
              <p>货币: {state.resources!.currency.gp} gp · {state.resources!.currency.sp} sp · {state.resources!.currency.cp} cp</p>
              {state.resources!.conditions.length > 0 ? (
                <p>状态: {state.resources!.conditions.join(', ')}</p>
              ) : null}
              <div className="button-row">
                <button onClick={() => doRest('short', 1)}>短休</button>
                <button onClick={() => doRest('long')}>长休</button>
              </div>
            </section>
          ) : null}
          {state.recentChanges && state.recentChanges.length > 0 ? (
            <section className="card">
              <h2>最近资源变动</h2>
              {state.recentChanges.slice(0, 5).map((change) => (
                <div className="subcard" key={change.id}>
                  <strong>{change.path}</strong>
                  <p>{String(change.before)} → {String(change.after)}</p>
                  <p className="muted">{change.reason}</p>
                </div>
              ))}
            </section>
          ) : null}
          {state.combatState ? (
            <section className="card">
              <h2>战斗</h2>
              <p className="muted">第 {state.combatState.round} 回合 · 当前行动者：{state.combatState.participants[state.combatState.currentTurnIndex]?.name ?? '--'}</p>
              {state.combatState.participants
                .slice()
                .sort((a, b) => (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity))
                .map((p, i) => (
                  <div className="subcard" key={p.id} style={i === state.combatState!.currentTurnIndex ? { border: '2px solid #ffd700' } : undefined}>
                    <strong>{p.name}{p.isNpc ? ' (NPC)' : ''}</strong>
                    <p>先攻: {p.initiative ?? '--'} · AC: {p.ac}</p>
                    <div className="hp-bar-bg">
                      <div className="hp-bar-fill" style={{
                        width: `${Math.min(100, Math.round(p.hp / p.maxHp * 100))}%`,
                        background: p.hp > p.maxHp / 2 ? '#79bd74' : p.hp > 0 ? '#dfa34b' : '#de6f62'
                      }} />
                    </div>
                    <p className="muted">HP: {p.hp}/{p.maxHp}</p>
                  </div>
                ))}
            </section>
          ) : null}
          {state.recentDiceLogs && state.recentDiceLogs.length > 0 ? (
            <section className="card">
              <h2>最近骰点</h2>
              {state.recentDiceLogs.map((log) => (
                <div className="subcard" key={log.id}>
                  <p>{log.reason}：{log.die} [{log.values.join(', ')}] + {log.modifier} = {log.total}{log.success !== undefined ? (log.success ? ' (成功)' : ' (失败)') : ''}</p>
                  <p className="muted">{log.playerName} · {log.createdAt}</p>
                </div>
              ))}
            </section>
          ) : null}
          {state.ruleSummaries.length ? (
            <section className="card">
              <h2>本轮规则摘要</h2>
              {state.ruleSummaries.map((summary) => (
                <div className="subcard" key={summary.entryId}>
                  <strong>{summary.title}</strong>
                  <p>{summary.summary}</p>
                  <p className="muted">{summary.reason}</p>
                </div>
              ))}
            </section>
          ) : null}
          {(state.campaignSummary || (state.quests && state.quests.length > 0) || (state.npcs && state.npcs.length > 0)) ? (
            <section className="card">
              <h2>冒险日志</h2>
              {state.campaignSummary ? (
                <div className="subcard">
                  <strong>最近进展</strong>
                  <p className="muted">回合 {state.campaignSummary.turnStart}-{state.campaignSummary.turnEnd}</p>
                  <p>{state.campaignSummary.summary}</p>
                </div>
              ) : null}
              {state.quests && state.quests.length > 0 ? (
                <div>
                  <strong>任务</strong>
                  {state.quests.filter((q) => q.status === 'active' || q.status === 'in_progress').map((q) => (
                    <div className="subcard" key={q.id}>
                      <strong>{q.title}</strong> <span className="muted">[{q.status}]</span>
                      <p>{q.description}</p>
                    </div>
                  ))}
                </div>
              ) : null}
              {state.npcs && state.npcs.length > 0 ? (
                <div>
                  <strong>已知 NPC</strong>
                  {state.npcs.map((n) => (
                    <div className="subcard" key={n.id}>
                      <strong>{n.name}</strong> <span className="muted">({n.role}, {n.attitude})</span>
                      <p>{n.notes} [{n.location}]</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
          <section className="card action-card">
            <h2>你的行动</h2>
            <label>行动类型
              <select value={actionType} onChange={(event) => { setActionType(event.target.value as PlayerActionType); setSubAction(''); }}>
                <option value="narrative">叙事</option>
                <option value="exploration">探索</option>
                <option value="social">社交</option>
                <option value="combat">战斗</option>
                <option value="ooc">场外</option>
              </select>
            </label>
            {(actionType === 'exploration' || actionType === 'social') ? (
              <label>具体行动
                <select value={subAction} onChange={(event) => setSubAction(event.target.value)}>
                  <option value="">(选择具体行动)</option>
                  {actionType === 'exploration'
                    ? explorationActions.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)
                    : socialActions.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)
                  }
                </select>
              </label>
            ) : null}
            {subAction ? <p className="muted">预计 DC: {getSubActionDcInfo()}</p> : null}
            <label className="check-row">
              <input type="checkbox" checked={isHiddenRoll} onChange={(event) => setIsHiddenRoll(event.target.checked)} />
              隐藏骰点（仅玩家本人可见）
            </label>
            <textarea value={action} onChange={(event) => setAction(event.target.value)} placeholder="描述你的角色本回合想尝试做什么。" />
            <button disabled={!action.trim()} onClick={submit}>提交行动</button>
            {error ? <p>{error}</p> : null}
          </section>
          {state.pendingInteractions.map((interaction) => (
            <section className="card" key={interaction.id}>
              <h2>需要回应</h2>
              <p>{interaction.prompt}</p>
              <div className="button-row">
                <button onClick={() => respond(interaction.id, '我同意或配合。')}>同意 / 配合</button>
                <button onClick={() => respond(interaction.id, '我反抗或拒绝。')}>反抗 / 拒绝</button>
              </div>
            </section>
          ))}
        </aside>
        <section className="content-stack">
          <LogList title="公开日志" logs={state.publicLogs} />
          <LogList title="你的私密故事" logs={state.privateLogs} />
        </section>
      </div>
    </main>
  );
}
