import { useEffect, useRef, useState } from 'react';
import { clearGlobalPresetPackage, clearGlobalScriptCard, putGlobalPresetPackage, putGlobalResourceWorldBookBindings, putGlobalScriptCard } from '../api';
import type { GlobalResourceWorldBookBinding, PromptPresetPackage, ResourceWorldBook, ScriptCard } from '../types';

export function GlobalResourceConfigPanel({
  scriptCards,
  resourceWorldBooks,
  presetPackages,
  globalScriptCardId,
  globalWorldBookBindings,
  globalPresetPackageId,
  onChanged,
  setError
}: {
  scriptCards: ScriptCard[];
  resourceWorldBooks: ResourceWorldBook[];
  presetPackages: PromptPresetPackage[];
  globalScriptCardId: string | null;
  globalWorldBookBindings: GlobalResourceWorldBookBinding[];
  globalPresetPackageId: string | null;
  onChanged: () => Promise<void>;
  setError: (message: string) => void;
}) {
  const [selectedScriptCardId, setSelectedScriptCardId] = useState('');
  const [selectedWorldBookIds, setSelectedWorldBookIds] = useState<string[]>([]);
  const [selectedPresetPackageId, setSelectedPresetPackageId] = useState('');
  const scriptCardDirtyRef = useRef(false);
  const worldBooksDirtyRef = useRef(false);
  const presetPackageDirtyRef = useRef(false);

  useEffect(() => {
    if (!scriptCardDirtyRef.current) setSelectedScriptCardId(globalScriptCardId ?? '');
  }, [globalScriptCardId]);

  useEffect(() => {
    if (!worldBooksDirtyRef.current) {
      setSelectedWorldBookIds(globalWorldBookBindings.filter((binding) => binding.enabled).sort((a, b) => a.orderIndex - b.orderIndex).map((binding) => binding.worldBookId));
    }
  }, [globalWorldBookBindings]);

  useEffect(() => {
    if (!presetPackageDirtyRef.current) setSelectedPresetPackageId(globalPresetPackageId ?? '');
  }, [globalPresetPackageId]);

  async function bindScriptCard() {
    if (!selectedScriptCardId) return;
    setError('');
    try {
      await putGlobalScriptCard(selectedScriptCardId);
      scriptCardDirtyRef.current = false;
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function unbindScriptCard() {
    setError('');
    try {
      await clearGlobalScriptCard();
      scriptCardDirtyRef.current = false;
      setSelectedScriptCardId('');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveWorldBookBindings() {
    setError('');
    try {
      const selectedWorldBookIdSet = new Set(selectedWorldBookIds);
      const existingWorldBookIdSet = new Set(globalWorldBookBindings.map((binding) => binding.worldBookId));
      let nextOrderIndex = globalWorldBookBindings.reduce((maxOrderIndex, binding) => Math.max(maxOrderIndex, binding.orderIndex), -1) + 1;
      const bindings = [
        ...globalWorldBookBindings.map((binding) => ({
          ...binding,
          enabled: selectedWorldBookIdSet.has(binding.worldBookId)
        })),
        ...selectedWorldBookIds
          .filter((worldBookId) => !existingWorldBookIdSet.has(worldBookId))
          .map((worldBookId) => ({
            worldBookId,
            enabled: true,
            orderIndex: nextOrderIndex++
          }))
      ].sort((a, b) => a.orderIndex - b.orderIndex);

      await putGlobalResourceWorldBookBindings(bindings);
      worldBooksDirtyRef.current = false;
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function bindPresetPackage() {
    if (!selectedPresetPackageId) return;
    setError('');
    try {
      await putGlobalPresetPackage(selectedPresetPackageId);
      presetPackageDirtyRef.current = false;
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function unbindPresetPackage() {
    setError('');
    try {
      await clearGlobalPresetPackage();
      presetPackageDirtyRef.current = false;
      setSelectedPresetPackageId('');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleWorldBook(worldBookId: string, checked: boolean) {
    worldBooksDirtyRef.current = true;
    setSelectedWorldBookIds((current) => checked ? [...current.filter((id) => id !== worldBookId), worldBookId] : current.filter((id) => id !== worldBookId));
  }

  function updateSelectedScriptCard(scriptCardId: string) {
    scriptCardDirtyRef.current = true;
    setSelectedScriptCardId(scriptCardId);
  }

  function updateSelectedPresetPackage(presetPackageId: string) {
    presetPackageDirtyRef.current = true;
    setSelectedPresetPackageId(presetPackageId);
  }

  return (
    <section className="card">
      <h2>全局资源配置</h2>
      <p className="muted">所有房间都会实时使用这里选择的剧本卡、世界书和 ST 兼容预设包。</p>

      <div className="subcard">
        <h3>主剧本卡</h3>
        <select value={selectedScriptCardId} onChange={(event) => updateSelectedScriptCard(event.target.value)}>
          <option value="">不绑定</option>
          {scriptCards.map((card) => <option key={card.id} value={card.id}>{card.name}</option>)}
        </select>
        <div className="button-row">
          <button onClick={() => void bindScriptCard()} disabled={!selectedScriptCardId}>绑定主剧本卡</button>
          <button onClick={() => void unbindScriptCard()} disabled={!globalScriptCardId}>清除主剧本卡</button>
        </div>
      </div>

      <div className="subcard">
        <h3>全局世界书绑定</h3>
        {resourceWorldBooks.length ? resourceWorldBooks.map((book) => (
          <label className="check-row" key={book.id}>
            <input type="checkbox" checked={selectedWorldBookIds.includes(book.id)} onChange={(event) => toggleWorldBook(book.id, event.target.checked)} /> {book.name}
          </label>
        )) : <p className="muted">暂无全局世界书。</p>}
        <div className="button-row">
          <button onClick={() => void saveWorldBookBindings()}>保存世界书绑定</button>
        </div>
      </div>

      <div className="subcard">
        <h3>ST 兼容预设包</h3>
        <select value={selectedPresetPackageId} onChange={(event) => updateSelectedPresetPackage(event.target.value)}>
          <option value="">不绑定</option>
          {presetPackages.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
        <div className="button-row">
          <button onClick={() => void bindPresetPackage()} disabled={!selectedPresetPackageId}>绑定 ST 兼容预设包</button>
          <button onClick={() => void unbindPresetPackage()} disabled={!globalPresetPackageId}>清除 ST 兼容预设包</button>
        </div>
      </div>
    </section>
  );
}
