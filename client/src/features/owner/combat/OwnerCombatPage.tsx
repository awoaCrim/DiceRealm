import { useParams } from 'react-router-dom';
import type { Combatant, Encounter } from '@dnd/contracts';
import { useEncounterList } from '../../../entities/combat/combatQueries';
import { AsyncState } from '../../../shared/ui/AsyncState';

const STATUS_LABEL: Record<Encounter['status'], string> = {
  preparation: '准备中',
  active: '进行中',
  completed: '已结束',
};

const VISIBILITY_LABEL: Record<Combatant['visibility'], string> = {
  public: '公开',
  player_private: '玩家私密',
  owner_only: '仅 Owner',
};

function CombatantCard({ combatant, active }: { combatant: Combatant; active: boolean }) {
  const hpPercent = combatant.hpMax > 0
    ? Math.max(0, Math.min(100, Math.round((combatant.hpCurrent / combatant.hpMax) * 100)))
    : 0;

  return (
    <li className={`combatant-summary${active ? ' is-active' : ''}`}>
      <div className="combatant-summary__heading">
        <div>
          <strong>{combatant.name}</strong>
          {active ? <span className="active-turn-badge">当前行动</span> : null}
        </div>
        <span className={`visibility-badge visibility-badge--${combatant.visibility}`}>
          {VISIBILITY_LABEL[combatant.visibility]}
        </span>
      </div>
      <div className="combatant-summary__stats">
        <span>HP {combatant.hpCurrent}/{combatant.hpMax}</span>
        <span>AC {combatant.ac}</span>
        <span>先攻 {combatant.initiative ?? '未决定'}</span>
      </div>
      <div className="hp-meter" aria-label={`${combatant.name} 生命值 ${combatant.hpCurrent}/${combatant.hpMax}`}>
        <span style={{ width: `${hpPercent}%` }} />
      </div>
      {combatant.conditions.length > 0 ? (
        <ul className="condition-chips" aria-label={`${combatant.name} 状态`}>
          {combatant.conditions.map((condition) => <li key={condition}>{condition}</li>)}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Owner 战斗页是 AI-DM 战斗状态的只读监督视图。
 * AI 根据叙事自动发起遭遇并通过服务端白名单命令推进；普通 Owner 不手工录入战斗员或骰子结果。
 */
export function OwnerCombatPage() {
  const { campaignId } = useParams();
  const list = useEncounterList(campaignId ?? '');
  const encounters = list.data ?? [];
  const unfinished = encounters.find((encounter) => encounter.status !== 'completed');
  const active = unfinished ?? encounters.at(-1);
  const history = active ? encounters.filter((encounter) => encounter.id !== active.id) : encounters;

  return (
    <div className="owner-combat">
      <h1>战斗状态</h1>
      <p className="ai-managed-note">由 AI-DM 根据叙事和规则自动发起并推进。</p>
      <AsyncState
        status={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'}
        label="战斗列表"
        errorMessage={list.error instanceof Error ? list.error.message : ''}
        onRetry={() => void list.refetch()}
      >
        {active ? (
          <section aria-label="当前遭遇" className="encounter-overview">
            <div className="encounter-overview__heading">
              <div>
                <span className={`encounter-status encounter-status--${active.status}`}>
                  {STATUS_LABEL[active.status]}
                </span>
                <h2>{active.name}</h2>
              </div>
              <span className="round-badge">第 {active.round} 轮</span>
            </div>
            <p className="encounter-overview__summary">
              AI-DM 正在维护先攻、生命值和状态。Owner 在此监督投影结果，无需手工执行规则命令。
            </p>
            <ul className="combatant-summary-list" aria-label="战斗员">
              {active.combatants.map((combatant) => (
                <CombatantCard
                  key={combatant.id}
                  combatant={combatant}
                  active={active.activeCombatantId === combatant.id}
                />
              ))}
            </ul>
          </section>
        ) : (
          <section aria-label="当前遭遇" className="ai-managed-empty">
            <h2>当前没有遭遇</h2>
            <p>继续推进剧情即可；当玩家行动触发冲突时，AI-DM 会自动建立并展示战斗。</p>
          </section>
        )}

        {history.length > 0 ? (
          <section aria-label="遭遇记录">
            <div className="section-heading">
              <div>
                <h2>遭遇记录</h2>
                <p>已完成或较早的遭遇记录。</p>
              </div>
              <span className="count-badge">{history.length} 场</span>
            </div>
            <ul className="encounter-history">
              {history.map((encounter) => (
                <li key={encounter.id}>
                  <strong>{encounter.name}</strong>
                  <span>{STATUS_LABEL[encounter.status]} · 第 {encounter.round} 轮</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </AsyncState>
    </div>
  );
}
