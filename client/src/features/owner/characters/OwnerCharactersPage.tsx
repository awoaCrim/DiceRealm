import { useParams } from 'react-router-dom';
import type { CharacterReview } from '@dnd/contracts';
import { useCharacterProjection, useReviewCharacter } from '../../../entities/character/characterQueries';
import { abbreviateId } from '../../../shared/lib/abbreviate';
import { readSheetNumber, readSheetString } from '../../../shared/lib/safeSheet';
import { AsyncState } from '../../../shared/ui/AsyncState';

/** Owner 角色审核：待审队列 approve/reject + party 已批准安全摘要。 */
export function OwnerCharactersPage() {
  const { campaignId } = useParams();
  const cid = campaignId ?? '';
  const projection = useCharacterProjection(cid);
  const review = useReviewCharacter(cid);

  const reviews = projection.data?.reviews ?? [];
  const summaries = projection.data?.approvedSummaries ?? [];

  return (
    <div className="owner-characters">
      <h1>角色审核</h1>
      <AsyncState
        status={projection.isPending ? 'loading' : projection.isError ? 'error' : 'ready'}
        label="角色"
        errorMessage={projection.error instanceof Error ? projection.error.message : ''}
        onRetry={() => void projection.refetch()}
      >
        <section aria-label="待审角色">
          <h2>待审角色</h2>
          {reviews.length === 0 ? <p>暂无待审角色。</p> : null}
          <ul>
            {reviews.map((character: CharacterReview) => (
              <li key={character.id} className="character-review-card">
                <h3>{character.name}</h3>
                <p>
                  提交者：<span title={character.playerId}>{abbreviateId(character.playerId)}</span>
                </p>
                <p>
                  AC：{readSheetNumber(character.sheet, 'ac')} · 背景：
                  {readSheetString(character.sheet, 'background') || '（未填）'}
                </p>
                <div>
                  <button
                    onClick={() => review.mutate({ characterId: character.id, action: 'approve' })}
                    disabled={review.isPending}
                  >
                    通过
                  </button>
                  <button
                    onClick={() => review.mutate({ characterId: character.id, action: 'reject' })}
                    disabled={review.isPending}
                  >
                    退回
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="已批准角色">
          <h2>已批准角色</h2>
          {summaries.length === 0 ? <p>暂无已批准角色。</p> : null}
          <ul>
            {summaries.map((summary) => (
              <li key={summary.id}>
                {summary.name} · <span title={summary.playerId}>{abbreviateId(summary.playerId)}</span>
              </li>
            ))}
          </ul>
        </section>
      </AsyncState>
    </div>
  );
}
