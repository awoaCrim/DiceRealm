import type { TurnEntry } from '@dnd/contracts';
import { readSheetNumber, readSheetString } from '../../shared/lib/safeSheet';

const ENTRY_LABEL: Record<TurnEntry['entryKind'], string> = {
  narrative: '叙事',
  private_update: '私密结果',
  dice_result: '骰子',
};

/** 共享的 turn entry 渲染器：Player/Owner 都只渲染已知且安全的 payload shape。 */
export function TurnEntries({ entries }: { entries: TurnEntry[] }) {
  if (entries.length === 0) {
    return <p>本回合尚未产生剧情。</p>;
  }
  return (
    <ul className="turn-entries">
      {entries.map((entry) => (
        <li key={entry.id} className={`turn-entry turn-entry--${entry.entryKind}`}>
          <span className="turn-entry__label">{ENTRY_LABEL[entry.entryKind]}</span>
          <EntryBody entry={entry} />
        </li>
      ))}
    </ul>
  );
}

function EntryBody({ entry }: { entry: TurnEntry }) {
  const payload = entry.payload;
  if (entry.entryKind === 'narrative') {
    const text = readSheetString(asRecord(payload), 'text');
    return text ? <p>{text}</p> : <p>（内容暂不可用）</p>;
  }
  if (entry.entryKind === 'private_update') {
    const content = readSheetString(asRecord(payload), 'text');
    return content ? <p>{content}</p> : <p>（内容暂不可用）</p>;
  }
  if (entry.entryKind === 'dice_result') {
    const record = asRecord(payload);
    const formula = readSheetString(record, 'formula');
    const total = readSheetNumber(record, 'total', Number.NaN);
    const label = readSheetString(record, 'label');
    if (!formula || !Number.isFinite(total)) {
      return <p>（骰子结果暂不可用）</p>;
    }
    return (
      <p>
        {label ? `${label}：` : ''}
        {formula} = {total}
      </p>
    );
  }
  return <p>（内容暂不可用）</p>;
}

function asRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}
