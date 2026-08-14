import { useParams } from 'react-router-dom';
import type { WorldFact } from '@dnd/contracts';
import { useWorldProjection } from '../../../entities/world/worldQueries';
import { abbreviateId } from '../../../shared/lib/abbreviate';
import { AsyncState } from '../../../shared/ui/AsyncState';

const KIND_LABEL: Record<string, string> = {
  location: '地点',
  npc: 'NPC',
  item: '物品',
  lore: '传说',
  faction: '势力',
  quest: '任务',
  custom: '其它',
};

const VISIBILITY_LABEL: Record<WorldFact['visibility'], string> = {
  public: '所有玩家可见',
  player_private: '指定玩家可见',
  owner_only: '仅 AI-DM / Owner 可见',
};

/**
 * Owner 世界页是 AI-DM 世界模型的只读监督视图。
 * 世界事实由 AI 结算链路自动维护；普通 Owner 工作区不暴露数据库式 create/edit/delete 表单。
 */
export function OwnerWorldPage() {
  const { campaignId } = useParams();
  const projection = useWorldProjection(campaignId ?? '');
  const facts = projection.data?.facts ?? [];

  return (
    <div className="owner-world">
      <h1>世界状态</h1>
      <p className="ai-managed-note">由 AI-DM 根据剧情与玩家行动自动维护。</p>
      <AsyncState
        status={projection.isPending ? 'loading' : projection.isError ? 'error' : 'ready'}
        label="世界事实"
        errorMessage={projection.error instanceof Error ? projection.error.message : ''}
        onRetry={() => void projection.refetch()}
      >
        <section aria-label="世界事实列表">
          <div className="section-heading">
            <div>
              <h2>当前世界</h2>
              <p>这里展示 AI 已确认并写入战役状态的地点、人物、物品、势力、任务与秘密。</p>
            </div>
            <span className="count-badge">{facts.length} 条事实</span>
          </div>
          {facts.length === 0 ? (
            <div className="ai-managed-empty">
              <h3>世界尚未展开</h3>
              <p>开始回合并结算玩家行动后，AI-DM 会在剧情需要时自动建立世界事实。</p>
            </div>
          ) : (
            <ul className="world-fact-list">
              {facts.map((fact) => (
                <li key={fact.id} className="world-fact-card">
                  <div className="fact-card__heading">
                    <div>
                      <span className="fact-card__kind">{KIND_LABEL[fact.kind] ?? fact.kind}</span>
                      <h3>{fact.title}</h3>
                    </div>
                    <span className={`visibility-badge visibility-badge--${fact.visibility}`}>
                      {VISIBILITY_LABEL[fact.visibility]}
                    </span>
                  </div>
                  <p className="fact-card__content">{fact.content}</p>
                  {fact.knownBy.length > 0 ? (
                    <p className="fact-card__audience">
                      可见成员：{fact.knownBy.map((id) => abbreviateId(id)).join('、')}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </AsyncState>
    </div>
  );
}
