import { useEffect, useRef, useState } from 'react';
import { getPlayerState, respondToInteraction, submitAction, subscribeRoom } from '../api';
import { CharacterBuilder } from '../components/CharacterBuilder';
import { CharacterCard } from '../components/CharacterCard';
import { LogList } from '../components/LogList';
import { TurnPanel } from '../components/TurnPanel';
import type { PlayerVisibleState } from '../types';

type PlayerActionType = 'in_character_action' | 'player_question' | 'meta_question' | 'observe' | 'wait' | 'skip' | 'ready' | 'follow' | 'combat_action' | 'narrative' | 'exploration' | 'social' | 'combat' | 'ooc';
type ExplorationAction = 'stealth' | 'perception' | 'investigation' | 'lockpick' | 'disarmTrap' | 'track' | 'solvePuzzle';
type SocialAction = 'persuade' | 'deceive' | 'intimidate' | 'haggle' | 'negotiate';
type PlayerTab = 'story' | 'character' | 'backpack' | 'status';
type LogTab = 'public' | 'private';

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

const playerTabs: Array<{ id: PlayerTab; label: string }> = [
  { id: 'story', label: '剧情' },
  { id: 'character', label: '人物卡' },
  { id: 'backpack', label: '背包' },
  { id: 'status', label: '状态' }
];

const itemInfo: Record<string, { type: string; detail: string }> = {
  长剑: { type: '武器', detail: '近战武器，1d8 挥砍伤害；双手使用时为 1d10。' },
  盾牌: { type: '防具', detail: '装备后护甲等级 +2。' },
  轻弩: { type: '武器', detail: '远程武器，1d8 穿刺伤害，射程 80/320，需要弩矢。' },
  巨剑: { type: '武器', detail: '双手近战武器，2d6 挥砍伤害。' },
  奥术法器: { type: '施法工具', detail: '术士可用作施法焦点。' },
  弩矢: { type: '弹药', detail: '用于弩类武器的弹药，通常命中后消耗。' },
  治疗包: { type: '工具', detail: '可用于稳定 0 HP 生物，通常有有限使用次数。' }
};

function inferActionType(text: string, selected: PlayerActionType): PlayerActionType {
  if (selected !== 'in_character_action') return selected;
  const trimmed = text.trim();
  if (/^(我是谁|我现在是谁|我的角色是谁)[？?]?$/.test(trimmed)) return 'player_question';
  if (/[？?]$/.test(trimmed)) return 'player_question';
  if (/^(观察|查看|环顾|侦查|搜索)/.test(trimmed)) return 'observe';
  if (/^(等待|静观|观望|不行动)/.test(trimmed)) return 'wait';
  return selected;
}

function inferActionVisibility(actionType: PlayerActionType): 'public' | 'private' {
  return actionType === 'player_question' || actionType === 'meta_question' ? 'private' : 'public';
}

function describeItem(name: string): { type: string; detail: string } {
  return itemInfo[name] ?? { type: '物品', detail: '角色持有的可见物品；具体规则效果由当前规则与场景决定。' };
}

function combatHealthText(label: string): string {
  switch (label) {
    case 'healthy': return '状态良好';
    case 'injured': return '受伤';
    case 'bloodied': return '重伤';
    case 'defeated': return '倒下';
    default: return '未知';
  }
}

function actionTypeLabel(type: string | undefined): string {
  switch (type) {
    case 'player_question': return '玩家问题';
    case 'meta_question': return '场外问题';
    case 'observe': return '观察';
    case 'wait': return '等待';
    case 'skip': return '跳过';
    case 'ready': return '准备';
    case 'follow': return '跟随';
    case 'combat_action':
    case 'combat': return '战斗行动';
    case 'exploration': return '探索行动';
    case 'social': return '社交行动';
    case 'ooc': return '场外说明';
    default: return '角色行动';
  }
}

function actionVisibilityLabel(visibility: string | undefined): string {
  switch (visibility) {
    case 'private': return '私人';
    case 'dm_only': return '仅主持人';
    default: return '公开';
  }
}

function actionStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'complete': return '已结算';
    case 'processing': return '处理中';
    default: return '已提交';
  }
}

export function PlayerPage({ token }: { token: string }) {
  const [state, setState] = useState<PlayerVisibleState | null>(null);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [isSubmittingAction, setIsSubmittingAction] = useState(false);
  const [actionType, setActionType] = useState<PlayerActionType>('in_character_action');
  const [subAction, setSubAction] = useState('');
  const [isHiddenRoll, setIsHiddenRoll] = useState(false);
  const [activeTab, setActiveTab] = useState<PlayerTab>('story');
  const [activeLogTab, setActiveLogTab] = useState<LogTab>('public');
  const [interactionResponses, setInteractionResponses] = useState<Record<string, string>>({});
  const [interactionNotice, setInteractionNotice] = useState('');
  const logScrollRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    setState(await getPlayerState(token));
  }

  useEffect(() => {
    let unsubscribe = () => {};
    void getPlayerState(token).then((next) => {
      setState(next);
      if (next.character && !next.character.confirmed) setActiveTab('character');
      unsubscribe = subscribeRoom(next.room.id, () => void refresh());
    });
    return () => unsubscribe();
  }, [token]);

  useEffect(() => {
    if (activeTab !== 'story') return;
    const node = logScrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [activeTab, activeLogTab, state?.publicLogs.length, state?.privateLogs.length]);

  async function submit() {
    setError('');
    setActionNotice('');
    if (!action.trim() || isSubmittingAction) return;
    setIsSubmittingAction(true);
    try {
      const inferredType = inferActionType(action, actionType);
      await submitAction(token, action, inferredType, isHiddenRoll, inferActionVisibility(inferredType));
      setAction('');
      await refresh();
      setActionNotice('行动已提交，等待 DM 处理。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmittingAction(false);
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
    const trimmed = response.trim();
    if (!trimmed) return;
    setError('');
    setInteractionNotice('');
    try {
      await respondToInteraction(token, interactionId, trimmed);
      setInteractionResponses((current) => {
        const next = { ...current };
        delete next[interactionId];
        return next;
      });
      await refresh();
      setInteractionNotice('回应已提交，等待主持人继续结算。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!state) return <main className="shell"><p>加载中...</p></main>;
  const canSubmitAction = state.room.status === 'waiting_for_actions';
  const actionDisabledReason = canSubmitAction
    ? ''
    : state.room.status === 'waiting_for_interaction'
      ? (state.pendingInteractions.length > 0
        ? '请先回应下方互动请求，本回合暂不能提交新行动。'
        : '正在等待其他玩家回应互动请求，本回合暂不能提交新行动。')
      : state.room.status === 'ready_to_resolve'
        ? '所有必要行动已完成，等待主持人结算，本回合暂不能修改行动。'
        : '当前回合未开放行动提交。';
  const showResources = state.resources && state.character?.confirmed;
  const hasBackpackContent = Boolean(state.character?.sheet.equipment.length)
    || Boolean(state.resources?.ammo.length)
    || Boolean(state.resources?.consumables.length)
    || Boolean(state.resources && (
      state.resources.currency.gp > 0
      || state.resources.currency.sp > 0
      || state.resources.currency.cp > 0
    ));

  return (
    <main className="shell player-shell">
      <div className="page-header player-page-header">
        <div>
          <h1>{state.room.name}</h1>
          <p className="muted">玩家视图 · {state.player.name}</p>
        </div>
        <nav className="player-tab-nav" aria-label="玩家功能区">
          {playerTabs.map((tab) => (
            <button
              className={activeTab === tab.id ? 'active' : ''}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'story' ? (
        <div className="player-story-layout">
          <section className="content-stack">
            <section className="card player-log-panel">
              <div className="inline-tab-row" role="tablist" aria-label="日志类型">
                <button className={activeLogTab === 'public' ? 'active' : ''} onClick={() => setActiveLogTab('public')} type="button">公开剧情</button>
                <button className={activeLogTab === 'private' ? 'active' : ''} onClick={() => setActiveLogTab('private')} type="button">私人剧情</button>
              </div>
              <div className="player-log-scroll" ref={logScrollRef}>
                <LogList title={activeLogTab === 'public' ? '公开剧情' : '私人剧情'} logs={activeLogTab === 'public' ? state.publicLogs : state.privateLogs} />
              </div>
            </section>
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
                        {n.location ? <p className="muted">{n.location}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
          </section>
          <aside className="side-stack">
            <TurnPanel currentTurn={state.room.currentTurn} status={state.room.status} submittedPlayers={state.submittedPlayers} waitingPlayers={state.waitingPlayers} />
            <section className="card action-card">
              <h2>你的行动</h2>
              <label>行动类型
                <select value={actionType} onChange={(event) => { setActionType(event.target.value as PlayerActionType); setSubAction(''); }}>
                  <option value="in_character_action">角色行动</option>
                  <option value="observe">观察</option>
                  <option value="wait">等待</option>
                  <option value="ready">准备</option>
                  <option value="follow">跟随</option>
                  <option value="combat_action">战斗行动</option>
                  <option value="player_question">玩家问题</option>
                  <option value="meta_question">场外问题</option>
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
              {state.currentAction ? (
                <div className="subcard">
                  <h3>本回合已提交</h3>
                  <p>{state.currentAction.text}</p>
                  <p className="muted">
                    {actionTypeLabel(state.currentAction.actionType)} · {actionVisibilityLabel(state.currentAction.visibility)} · {actionStatusLabel(state.currentAction.status)}
                    {state.currentAction.submittedAt ? ` · ${state.currentAction.submittedAt}` : ''}
                  </p>
                  <p className="muted">
                    {canSubmitAction ? '再次提交会替换你本回合的行动。' : '当前回合已锁定，不能再修改本次行动。'}
                  </p>
                </div>
              ) : null}
              <label className="check-row">
                <input type="checkbox" checked={isHiddenRoll} onChange={(event) => setIsHiddenRoll(event.target.checked)} />
                隐藏骰点（仅玩家本人可见）
              </label>
              <textarea
                value={action}
                disabled={!canSubmitAction || isSubmittingAction}
                onChange={(event) => {
                  setAction(event.target.value);
                  setActionNotice('');
                }}
                placeholder="描述你的角色本回合想尝试做什么。"
              />
              <button disabled={!canSubmitAction || !action.trim() || isSubmittingAction} onClick={submit}>
                {isSubmittingAction ? '提交中...' : '提交行动'}
              </button>
              {!canSubmitAction ? <p className="muted">{actionDisabledReason}</p> : null}
              {actionNotice ? <p className="form-success">{actionNotice}</p> : null}
              {error ? <p className="form-error">{error}</p> : null}
            </section>
            {interactionNotice ? <p className="form-success">{interactionNotice}</p> : null}
            {state.pendingInteractions.map((interaction) => (
              <section className="card" key={interaction.id}>
                <h2>需要回应</h2>
                <p>{interaction.prompt}</p>
                <div className="button-row">
                  <button onClick={() => respond(interaction.id, '我同意或配合。')}>同意 / 配合</button>
                  <button onClick={() => respond(interaction.id, '我反抗或拒绝。')}>反抗 / 拒绝</button>
                </div>
                <label>自定义回应
                  <textarea
                    value={interactionResponses[interaction.id] ?? ''}
                    onChange={(event) => setInteractionResponses((current) => ({ ...current, [interaction.id]: event.target.value }))}
                    placeholder="写下你的具体回应、条件或反问。"
                  />
                </label>
                <button
                  disabled={!interactionResponses[interaction.id]?.trim()}
                  onClick={() => respond(interaction.id, interactionResponses[interaction.id] ?? '')}
                >
                  提交回应
                </button>
              </section>
            ))}
          </aside>
        </div>
      ) : null}

      {activeTab === 'character' ? (
        <section className="player-tab-panel">
          {state.character?.confirmed ? (
            <div>
              <section className="card">
                <h2>完整人物卡</h2>
                <div className="character-sheet-grid">
                  <div className="subcard">
                    <h3>身份</h3>
                    <p><strong>{state.character.sheet.name}</strong></p>
                    <p>{state.character.sheet.species}{state.character.sheet.subSpecies ? `（${state.character.sheet.subSpecies}）` : ''} · {state.character.sheet.className}{state.character.sheet.classDetail ? `（${state.character.sheet.classDetail}）` : ''} · {state.character.sheet.level} 级</p>
                    <p>背景：{state.character.sheet.background || '未填写'}</p>
                    {state.character.sheet.concept ? <p>概念：{state.character.sheet.concept}</p> : null}
                  </div>
                  <div className="subcard">
                    <h3>核心数值</h3>
                    <p>HP：{state.character.sheet.hitPoints.current} / {state.character.sheet.hitPoints.max}</p>
                    <p>AC：{state.character.sheet.armorClass ?? '--'}</p>
                    <p>熟练加值：+{state.character.sheet.proficiencyBonus ?? 2}</p>
                  </div>
                  <div className="subcard">
                    <h3>属性</h3>
                    <div className="ability-grid">
                      <span>力量 {state.character.sheet.abilityScores.str}</span>
                      <span>敏捷 {state.character.sheet.abilityScores.dex}</span>
                      <span>体质 {state.character.sheet.abilityScores.con}</span>
                      <span>智力 {state.character.sheet.abilityScores.int}</span>
                      <span>感知 {state.character.sheet.abilityScores.wis}</span>
                      <span>魅力 {state.character.sheet.abilityScores.cha}</span>
                    </div>
                  </div>
                  <div className="subcard">
                    <h3>技能 / 熟练</h3>
                    <p>技能：{state.character.sheet.skills.length ? state.character.sheet.skills.join('、') : '无'}</p>
                    <p>语言：{state.character.sheet.languages?.length ? state.character.sheet.languages.join('、') : '无'}</p>
                    <p>熟练：{state.character.sheet.proficiencies?.length ? state.character.sheet.proficiencies.join('、') : '无'}</p>
                  </div>
                  <div className="subcard">
                    <h3>装备 / 法术</h3>
                    <p>装备：{state.character.sheet.equipment.length ? state.character.sheet.equipment.join('、') : '无'}</p>
                    <p>法术：{state.character.sheet.spells.length ? state.character.sheet.spells.join('、') : '无'}</p>
                  </div>
                  <div className="subcard">
                    <h3>个性 / 备注</h3>
                    <p>{state.character.sheet.privateNotes || '暂无备注。'}</p>
                  </div>
                </div>
              </section>
            </div>
          ) : (
            <CharacterBuilder
              token={token}
              initialDraft={state.character?.sheet.builderDraft ?? null}
              onChanged={refresh}
              setError={setError}
            />
          )}
        </section>
      ) : null}

      {activeTab === 'backpack' ? (
        <section className="card player-tab-panel">
          <h2>背包</h2>
          <p className="muted">{state.character?.sheet.name ?? state.player.name} 的可见装备、消耗品和货币。</p>
          {state.character ? (
            <>
              <div className="subcard">
                <h3>装备</h3>
                {state.character.sheet.equipment.length > 0 ? (
                  <div className="inventory-grid">
                    {state.character.sheet.equipment.map((item) => {
                      const info = describeItem(item);
                      return (
                        <article className="inventory-item-card" key={item}>
                          <strong>{item}</strong>
                          <span>{info.type}</span>
                          <p>{info.detail}</p>
                        </article>
                      );
                    })}
                  </div>
                ) : <p className="muted">暂无装备。</p>}
              </div>
              <div className="subcard">
                <h3>弹药 / 消耗品</h3>
                {(state.resources?.ammo.length || state.resources?.consumables.length) ? (
                  <div className="inventory-grid">
                    {state.resources?.ammo.map((ammo) => {
                      const info = describeItem(ammo.name);
                      return (
                        <article className="inventory-item-card" key={ammo.name}>
                          <strong>{ammo.name}</strong>
                          <span>{info.type}</span>
                          <p>{ammo.name}: {ammo.current} / {ammo.max}</p>
                          <p>{info.detail}</p>
                        </article>
                      );
                    })}
                    {state.resources?.consumables.map((item) => {
                      const info = describeItem(item.name);
                      return (
                        <article className="inventory-item-card" key={item.name}>
                          <strong>{item.name}</strong>
                          <span>{info.type}</span>
                          <p>{item.name}: {item.quantity}</p>
                          <p>{info.detail}</p>
                        </article>
                      );
                    })}
                  </div>
                ) : null}
                {!state.resources?.ammo.length && !state.resources?.consumables.length ? <p className="muted">暂无弹药或消耗品。</p> : null}
              </div>
              <div className="subcard">
                <h3>货币</h3>
                {state.resources ? <p>{state.resources.currency.gp} gp · {state.resources.currency.sp} sp · {state.resources.currency.cp} cp</p> : <p className="muted">暂无货币记录。</p>}
              </div>
            </>
          ) : <p className="muted">确认角色后会显示背包。</p>}
          {!hasBackpackContent ? <p className="muted">当前没有可见物品。</p> : null}
        </section>
      ) : null}

      {activeTab === 'status' ? (
        <div className="player-status-layout">
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
                .map((p, i) => (
                  <div className="subcard" key={p.id} style={i === state.combatState!.currentTurnIndex ? { border: '2px solid #ffd700' } : undefined}>
                    <strong>{p.name}{p.isNpc ? ' (NPC)' : ''}</strong>
                    <p>先攻: {p.initiative ?? '--'}{p.ac !== null ? ` · AC: ${p.ac}` : ''}</p>
                    {p.hp !== null && p.maxHp !== null ? (
                      <>
                        <div className="hp-bar-bg">
                          <div className="hp-bar-fill" style={{
                            width: `${Math.min(100, Math.round(p.hp / p.maxHp * 100))}%`,
                            background: p.hp > p.maxHp / 2 ? '#79bd74' : p.hp > 0 ? '#dfa34b' : '#de6f62'
                          }} />
                        </div>
                        <p className="muted">HP: {p.hp}/{p.maxHp}</p>
                      </>
                    ) : (
                      <p className="muted">状态：{combatHealthText(p.healthLabel)}</p>
                    )}
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
        </div>
      ) : null}
    </main>
  );
}
