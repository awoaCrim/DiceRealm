import { useParams } from 'react-router-dom';
import type { Encounter } from '@dnd/contracts';
import { useEncounterList } from '../../../entities/combat/combatQueries';
import { AsyncState } from '../../../shared/ui/AsyncState';

const ENCOUNTER_STATUS_LABEL: Record<Encounter['status'], string> = {
  preparation: '准备中',
  active: '进行中',
  completed: '已完成',
};

/** Player 战斗：只读投影 encounters/combatants；无任何写按钮；activeCombatantId 缺失时不推断。 */
export function PlayerCombatPage() {
  const { campaignId } = useParams();
  const cid = campaignId ?? '';
  const encounters = useEncounterList(cid);

  return (
    <div className="player-combat">
      <h1>战斗</h1>
      <AsyncState
        status={
          encounters.isPending
            ? 'loading'
            : encounters.isError
              ? 'error'
              : !encounters.data || encounters.data.length === 0
                ? 'empty'
                : 'ready'
        }
        label="战斗"
        errorMessage={encounters.error instanceof Error ? encounters.error.message : ''}
        onRetry={() => void encounters.refetch()}
      >
        <ul>
          {encounters.data?.map((encounter) => (
            <li key={encounter.id} className="encounter-card">
              <h2>{encounter.name}</h2>
              <p>
                {ENCOUNTER_STATUS_LABEL[encounter.status]}
                {encounter.status === 'active' && encounter.round > 0 ? ` · 第 ${encounter.round} 轮` : ''}
              </p>
              <ul aria-label="战斗员">
                {encounter.combatants.map((combatant) => (
                  <li key={combatant.id}>
                    <span className="combatant-name">{combatant.name}</span>
                    {combatant.initiative !== null ? ` · 先攻 ${combatant.initiative}` : ''}
                    {' · HP '}
                    {combatant.hpCurrent}/{combatant.hpMax}
                    {combatant.conditions.length > 0 ? ` · ${combatant.conditions.join('、')}` : ''}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </AsyncState>
    </div>
  );
}
