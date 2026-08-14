import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  useArchiveList,
  useCreateManualArchive,
  useRestoreArchive,
} from '../../../entities/archive/archiveQueries';
import { abbreviateId } from '../../../shared/lib/abbreviate';
import { AsyncState } from '../../../shared/ui/AsyncState';

/** Owner 存档页：list / manual create / restore（restore 前确认）。 */
export function OwnerArchivesPage() {
  const { campaignId } = useParams();
  const cid = campaignId ?? '';
  const list = useArchiveList(cid);
  const createManual = useCreateManualArchive(cid);
  const restore = useRestoreArchive(cid);
  const [label, setLabel] = useState('');
  const archives = list.data ?? [];

  function handleRestore(archiveId: string) {
    if (window.confirm('恢复存档会覆盖当前战役状态，确定继续吗？')) {
      restore.mutate(archiveId);
    }
  }

  return (
    <div className="owner-archives">
      <h1>存档</h1>
      <AsyncState
        status={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'}
        label="存档列表"
        errorMessage={list.error instanceof Error ? list.error.message : ''}
        onRetry={() => void list.refetch()}
      >
        <section aria-label="手动存档">
          <h2>手动存档</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (label.trim()) {
                createManual.mutate(label.trim(), { onSuccess: () => setLabel('') });
              }
            }}
          >
            <label>
              存档说明
              <input value={label} onChange={(event) => setLabel(event.target.value)} required />
            </label>
            <button type="submit" disabled={createManual.isPending}>
              {createManual.isPending ? '存档中…' : '创建存档'}
            </button>
          </form>
        </section>
        <section aria-label="存档列表">
          <h2>存档列表</h2>
          {archives.length === 0 ? <p>暂无存档。</p> : null}
          <ul>
            {archives.map((archive) => (
              <li key={archive.id} className="archive-row">
                <span>{archive.label ?? '自动存档'}</span>
                <span>· {archive.kind === 'manual' ? '手动' : '自动'}</span>
                <span>· v{archive.version}</span>
                <span>· {abbreviateId(archive.createdByUserId)}</span>
                {archive.superseded ? <span>（已作废）</span> : null}
                {!archive.superseded ? (
                  <button onClick={() => handleRestore(archive.id)} disabled={restore.isPending}>
                    恢复
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </AsyncState>
    </div>
  );
}
