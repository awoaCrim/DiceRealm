import { useState } from 'react';
import type { TurnListEntry, TurnStatus } from '@dnd/contracts';
import { useTurnEntries } from '../../entities/ai/aiQueries';
import { currentTurnEntry } from '../../entities/turn/turnQueries';
import { AsyncState } from '../../shared/ui/AsyncState';
import { TurnEntries } from './TurnEntries';

const TURN_STATUS_LABEL: Record<TurnStatus, string> = {
  waiting_for_actions: '等待行动',
  locked: '已锁定',
  resolving: '结算中',
  needs_owner_attention: '需要主持处理',
  completed: '已完成',
};

export function TurnStoryHistory({
  campaignId,
  turns,
  audience,
}: {
  campaignId: string;
  turns: TurnListEntry[];
  audience: 'owner' | 'player';
}) {
  if (turns.length === 0) {
    return <p>尚未有剧情回合。</p>;
  }

  const orderedTurns = [...turns].sort((left, right) => left.turn.number - right.turn.number);
  const currentTurnId = currentTurnEntry(orderedTurns)?.turn.id;
  return (
    <section aria-label={audience === 'owner' ? 'DM 剧情记录' : '剧情记录'} className="turn-story-history">
      <div className="section-heading">
        <div>
          <h2>剧情记录</h2>
          <p>{audience === 'owner' ? '按回合查看完整结算结果。' : '按回合查看你能看到的剧情。'}</p>
        </div>
        <span className="count-badge">{turns.length} 个回合</span>
      </div>
      <div className="turn-story-history__list">
        {[...orderedTurns].reverse().map((entry) => (
          <TurnStoryCard
            key={entry.turn.id}
            campaignId={campaignId}
            entry={entry}
            isCurrent={entry.turn.id === currentTurnId}
          />
        ))}
      </div>
    </section>
  );
}

function TurnStoryCard({
  campaignId,
  entry,
  isCurrent,
}: {
  campaignId: string;
  entry: TurnListEntry;
  isCurrent: boolean;
}) {
  const [expanded, setExpanded] = useState(isCurrent);
  const turnId = entry.turn.id;
  const entries = useTurnEntries(campaignId, expanded ? turnId : undefined);
  const panelId = `turn-story-${turnId}`;

  return (
    <article className={`turn-story-card${isCurrent ? ' is-current' : ''}`}>
      <button
        type="button"
        className="turn-story-card__toggle"
        aria-controls={panelId}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>
          第 {entry.turn.number} 回合
          {isCurrent ? ' · 当前回合' : ''}
        </span>
        <span className="turn-story-card__status">{TURN_STATUS_LABEL[entry.turn.status]}</span>
      </button>
      {expanded ? (
        <div id={panelId} className="turn-story-card__body">
          <AsyncState
            status={entries.isPending ? 'loading' : entries.isError ? 'error' : 'ready'}
            label="剧情内容"
            errorMessage={entries.error instanceof Error ? entries.error.message : ''}
            onRetry={() => void entries.refetch()}
          >
            <TurnEntries entries={entries.data ?? []} />
          </AsyncState>
        </div>
      ) : null}
    </article>
  );
}
