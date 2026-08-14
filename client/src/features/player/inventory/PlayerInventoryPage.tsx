import { useParams } from 'react-router-dom';
import { useCharacterProjection } from '../../../entities/character/characterQueries';
import { readSheetStringArray } from '../../../shared/lib/safeSheet';
import { AsyncState } from '../../../shared/ui/AsyncState';

/** Player 背包：只读自己的 sheet equipment/spells；类型不符视为空；不显示他人 sheet。 */
export function PlayerInventoryPage() {
  const { campaignId } = useParams();
  const cid = campaignId ?? '';
  const projection = useCharacterProjection(cid);
  const own =
    projection.data?.myApproved[0] ??
    projection.data?.myPending[0] ??
    projection.data?.myDrafts[0] ??
    projection.data?.myRejected[0];

  const sheet = own?.sheet ?? {};
  const equipment = readSheetStringArray(sheet, 'equipment');
  const spells = readSheetStringArray(sheet, 'spells');

  return (
    <div className="player-inventory">
      <h1>背包</h1>
      <AsyncState
        status={projection.isPending ? 'loading' : projection.isError ? 'error' : 'ready'}
        label="背包"
        errorMessage={projection.error instanceof Error ? projection.error.message : ''}
        onRetry={() => void projection.refetch()}
      >
        {own ? (
          <>
            <section aria-label="我的装备">
              <h2>装备</h2>
              {equipment.length === 0 ? <p>暂无装备记录。</p> : null}
              <ul>
                {equipment.map((item, index) => (
                  <li key={`${item}-${index}`}>{item}</li>
                ))}
              </ul>
            </section>
            <section aria-label="我的法术">
              <h2>法术</h2>
              {spells.length === 0 ? <p>暂无法术记录。</p> : null}
              <ul>
                {spells.map((spell, index) => (
                  <li key={`${spell}-${index}`}>{spell}</li>
                ))}
              </ul>
            </section>
          </>
        ) : (
          <p>尚未创建角色。</p>
        )}
      </AsyncState>
    </div>
  );
}
