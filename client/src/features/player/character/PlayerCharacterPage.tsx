import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ApprovedCharacter, CharacterDraftInput } from '@dnd/contracts';
import {
  useCharacterProjection,
  useCreateCharacter,
  useSubmitCharacter,
  useUpdateCharacter,
} from '../../../entities/character/characterQueries';
import { readSheetNumber, readSheetObject } from '../../../shared/lib/safeSheet';
import { AsyncState } from '../../../shared/ui/AsyncState';
import { PlatformCharacterEditor } from './PlatformCharacterEditor';

/** approved.derived.ac 是 { value, sources }；缺失时回退 sheet.ac。 */
function derivedAc(approved: ApprovedCharacter): number {
  const derivedAc = readSheetObject(approved.derived, 'ac');
  if (derivedAc && typeof derivedAc.value === 'number' && Number.isFinite(derivedAc.value)) {
    return derivedAc.value;
  }
  return readSheetNumber(approved.sheet, 'ac');
}

/**
 * Player 角色页：无角色时创建；draft/rejected 可编辑并提交审核；
 * pending 只读；approved 显示派生 AC。不 import legacy CharacterBuilder。
 */
export function PlayerCharacterPage() {
  const { campaignId } = useParams();
  const cid = campaignId ?? '';
  const projection = useCharacterProjection(cid);
  const create = useCreateCharacter(cid);
  const update = useUpdateCharacter(cid);
  const submit = useSubmitCharacter(cid);
  const [savedId, setSavedId] = useState<string | null>(null);

  const rejected = projection.data?.myRejected[0];
  const draft = projection.data?.myDrafts[0];
  const pending = projection.data?.myPending[0];
  const approved = projection.data?.myApproved[0];
  const editable = rejected ?? draft;
  const busy = create.isPending || update.isPending;
  const reviewId = savedId ?? editable?.id ?? null;

  function handleSave(input: CharacterDraftInput) {
    if (editable) {
      update.mutate(
        { characterId: editable.id, input },
        { onSuccess: (character) => setSavedId(character.id) },
      );
    } else {
      create.mutate(input, { onSuccess: (character) => setSavedId(character.id) });
    }
  }

  return (
    <div className="player-character">
      <h1>角色</h1>
      <AsyncState
        status={projection.isPending ? 'loading' : projection.isError ? 'error' : 'ready'}
        label="角色"
        errorMessage={projection.error instanceof Error ? projection.error.message : ''}
        onRetry={() => void projection.refetch()}
      >
        {pending ? (
          <section aria-label="我的待审角色" className="character-status-card">
            <h2>{pending.name}</h2>
            <p>AC：{readSheetNumber(pending.sheet, 'ac')}</p>
            <p role="status">审核中，等待主持确认。</p>
          </section>
        ) : approved && !editable ? (
          <section aria-label="我的已批准角色" className="character-status-card">
            <h2>{approved.name}</h2>
            <p>AC（派生）：{derivedAc(approved)}</p>
            <p role="status">已批准。</p>
          </section>
        ) : (
          <section aria-label="角色编辑">
            <h2>{editable ? '编辑角色' : '创建角色'}</h2>
            <PlatformCharacterEditor
              key={editable?.id ?? 'new'}
              initial={editable ?? null}
              busy={busy}
              onSubmit={handleSave}
            />
            {reviewId ? (
              <button onClick={() => submit.mutate(reviewId)} disabled={submit.isPending}>
                {submit.isPending ? '提交中…' : '提交审核'}
              </button>
            ) : null}
          </section>
        )}
      </AsyncState>
    </div>
  );
}
