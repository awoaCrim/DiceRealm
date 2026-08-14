import { useState, type FormEvent } from 'react';
import type { CharacterDraftInput } from '@dnd/contracts';
import {
  readSheetNumber,
  readSheetString,
  readSheetStringArray,
} from '../../../shared/lib/safeSheet';

export interface CharacterEditorInitial {
  name: string;
  sheet: Record<string, unknown>;
}

export interface PlatformCharacterEditorProps {
  /** 已有角色（draft/rejected）预填；新建传 null。 */
  initial: CharacterEditorInitial | null;
  busy: boolean;
  onSubmit: (input: CharacterDraftInput) => void;
}

const ABILITY_FIELDS = [
  { key: 'str', label: '力量' },
  { key: 'dex', label: '敏捷' },
  { key: 'con', label: '体质' },
  { key: 'int', label: '智力' },
  { key: 'wis', label: '感知' },
  { key: 'cha', label: '魅力' },
] as const;

function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseNumber(raw: string): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Platform 精简角色编辑器：姓名、AC、六项属性、装备、法术、背景、备注。
 * 只写 contract 的 CharacterDraftInput { name, sheet }，不依赖 legacy CharacterBuilder。
 */
export function PlatformCharacterEditor({ initial, busy, onSubmit }: PlatformCharacterEditorProps) {
  const sheet = initial?.sheet ?? {};
  const [name, setName] = useState(initial?.name ?? '');
  const [ac, setAc] = useState(readSheetNumber(sheet, 'ac', 10));
  const [abilities, setAbilities] = useState<Record<string, number>>(() =>
    Object.fromEntries(ABILITY_FIELDS.map((field) => [field.key, readSheetNumber(sheet, field.key, 10)])),
  );
  const [equipment, setEquipment] = useState(readSheetStringArray(sheet, 'equipment').join('\n'));
  const [spells, setSpells] = useState(readSheetStringArray(sheet, 'spells').join('\n'));
  const [background, setBackground] = useState(readSheetString(sheet, 'background'));
  const [notes, setNotes] = useState(readSheetString(sheet, 'notes'));

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === '') {
      return;
    }
    const abilitySheet: Record<string, number> = {};
    for (const field of ABILITY_FIELDS) {
      abilitySheet[field.key] = abilities[field.key];
    }
    onSubmit({
      name,
      sheet: {
        ac,
        ...abilitySheet,
        equipment: parseLines(equipment),
        spells: parseLines(spells),
        background,
        notes,
      },
    });
  }

  return (
    <form className="character-editor" onSubmit={handleSubmit}>
      <label>
        姓名
        <input value={name} onChange={(event) => setName(event.target.value)} required />
      </label>
      <label>
        AC
        <input
          type="number"
          value={ac}
          onChange={(event) => setAc(parseNumber(event.target.value))}
        />
      </label>
      <fieldset className="character-editor__abilities">
        <legend>六项属性</legend>
        {ABILITY_FIELDS.map((field) => (
          <label key={field.key}>
            {field.label}
            <input
              type="number"
              value={abilities[field.key]}
              onChange={(event) =>
                setAbilities((prev) => ({ ...prev, [field.key]: parseNumber(event.target.value) }))
              }
            />
          </label>
        ))}
      </fieldset>
      <label>
        装备（每行一件）
        <textarea
          value={equipment}
          onChange={(event) => setEquipment(event.target.value)}
          rows={4}
        />
      </label>
      <label>
        法术（每行一个）
        <textarea value={spells} onChange={(event) => setSpells(event.target.value)} rows={4} />
      </label>
      <label>
        背景
        <input value={background} onChange={(event) => setBackground(event.target.value)} />
      </label>
      <label>
        备注
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
      </label>
      <button type="submit" disabled={busy || name.trim() === ''}>
        {busy ? '保存中…' : '保存'}
      </button>
    </form>
  );
}
