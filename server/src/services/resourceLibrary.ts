import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type {
  PromptPresetPackage,
  ResourceSourceType,
  ResourceWorldBook,
  ResourceWorldBookEntry,
  RoomPresetBinding,
  RoomScriptBinding,
  RoomWorldBookBinding,
  ScriptCard
} from '../domain/types.js';
import type { ParsedCharacterCardImport, ParsedPresetPackage, ParsedWorldBook } from './sillyTavernImport.js';

interface ScriptCardRow {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  visibility_notes: string;
  source_type: ResourceSourceType;
  raw_json: string;
  created_at: string;
  updated_at: string;
}

interface ResourceWorldBookRow {
  id: string;
  name: string;
  source_type: ResourceSourceType;
  raw_json: string;
  created_at: string;
  updated_at: string;
}

interface ResourceWorldBookEntryRow {
  id: string;
  world_book_id: string;
  title: string;
  keys_json: string;
  secondary_keys_json: string;
  content: string;
  enabled: number;
  constant: number;
  priority: number;
  order_index: number;
  position: ResourceWorldBookEntry['position'];
  raw_json: string;
  created_at: string;
  updated_at: string;
}

interface PromptPresetPackageRow {
  id: string;
  name: string;
  source_type: ResourceSourceType;
  openai_settings_json: string;
  context_template_json: string | null;
  instruct_template_json: string | null;
  sysprompt_json: string | null;
  reasoning_template_json: string | null;
  raw_json: string;
  created_at: string;
  updated_at: string;
}

interface RoomScriptBindingRow {
  room_id: string;
  script_card_id: string;
  binding_type: 'main';
  enabled: number;
  created_at: string;
}

interface RoomWorldBookBindingRow {
  room_id: string;
  world_book_id: string;
  enabled: number;
  order_index: number;
  created_at: string;
}

interface RoomPresetBindingRow {
  room_id: string;
  preset_package_id: string;
  enabled: number;
  created_at: string;
}

export interface ResourceLibrarySnapshot {
  scriptCards: ScriptCard[];
  resourceWorldBooks: ResourceWorldBook[];
  resourceWorldBookEntries: ResourceWorldBookEntry[];
  presetPackages: PromptPresetPackage[];
}

export interface RoomResourceBindings {
  scriptBinding: RoomScriptBinding | null;
  worldBookBindings: RoomWorldBookBinding[];
  presetBinding: RoomPresetBinding | null;
}

function parseJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse ${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonArray(value: string, context: string): string[] {
  const parsed = parseJson(value, context);
  if (!Array.isArray(parsed)) {
    throw new Error(`Failed to parse ${context}: expected array`);
  }
  return parsed.filter((item): item is string => typeof item === 'string');
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function mapScriptCard(row: ScriptCardRow): ScriptCard {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    personality: row.personality,
    scenario: row.scenario,
    firstMes: row.first_mes,
    mesExample: row.mes_example,
    creatorNotes: row.creator_notes,
    visibilityNotes: row.visibility_notes,
    sourceType: row.source_type,
    rawJson: parseJson(row.raw_json, `script_cards.raw_json for ${row.id}`),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapResourceWorldBook(row: ResourceWorldBookRow): ResourceWorldBook {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    rawJson: parseJson(row.raw_json, `resource_world_books.raw_json for ${row.id}`),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapResourceWorldBookEntry(row: ResourceWorldBookEntryRow): ResourceWorldBookEntry {
  return {
    id: row.id,
    worldBookId: row.world_book_id,
    title: row.title,
    keys: parseJsonArray(row.keys_json, `resource_world_book_entries.keys_json for ${row.id}`),
    secondaryKeys: parseJsonArray(row.secondary_keys_json, `resource_world_book_entries.secondary_keys_json for ${row.id}`),
    content: row.content,
    enabled: Boolean(row.enabled),
    constant: Boolean(row.constant),
    priority: row.priority,
    orderIndex: row.order_index,
    position: row.position,
    rawJson: parseJson(row.raw_json, `resource_world_book_entries.raw_json for ${row.id}`),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPresetPackage(row: PromptPresetPackageRow): PromptPresetPackage {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    openAiSettings: parseJson(row.openai_settings_json, `prompt_preset_packages.openai_settings_json for ${row.id}`),
    contextTemplate: row.context_template_json === null ? null : parseJson(row.context_template_json, `prompt_preset_packages.context_template_json for ${row.id}`),
    instructTemplate: row.instruct_template_json === null ? null : parseJson(row.instruct_template_json, `prompt_preset_packages.instruct_template_json for ${row.id}`),
    sysprompt: row.sysprompt_json === null ? null : parseJson(row.sysprompt_json, `prompt_preset_packages.sysprompt_json for ${row.id}`),
    reasoningTemplate: row.reasoning_template_json === null ? null : parseJson(row.reasoning_template_json, `prompt_preset_packages.reasoning_template_json for ${row.id}`),
    rawJson: parseJson(row.raw_json, `prompt_preset_packages.raw_json for ${row.id}`),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRoomScriptBinding(row: RoomScriptBindingRow): RoomScriptBinding {
  return {
    roomId: row.room_id,
    scriptCardId: row.script_card_id,
    bindingType: row.binding_type,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at
  };
}

function mapRoomWorldBookBinding(row: RoomWorldBookBindingRow): RoomWorldBookBinding {
  return {
    roomId: row.room_id,
    worldBookId: row.world_book_id,
    enabled: Boolean(row.enabled),
    orderIndex: row.order_index,
    createdAt: row.created_at
  };
}

function mapRoomPresetBinding(row: RoomPresetBindingRow): RoomPresetBinding {
  return {
    roomId: row.room_id,
    presetPackageId: row.preset_package_id,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at
  };
}

function insertImportedWorldBook(db: AppDatabase, parsed: ParsedWorldBook, sourceType: Extract<ResourceSourceType, 'sillytavern_character' | 'sillytavern_world_book'>, now: string): string {
  const worldBookId = nanoid();

  db.prepare('INSERT INTO resource_world_books (id, name, source_type, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(worldBookId, parsed.name, sourceType, stringifyJson(parsed.rawJson), now, now);

  for (const entry of parsed.entries) {
    db.prepare('INSERT INTO resource_world_book_entries (id, world_book_id, title, keys_json, secondary_keys_json, content, enabled, constant, priority, order_index, position, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        nanoid(),
        worldBookId,
        entry.title,
        stringifyJson(entry.keys),
        stringifyJson(entry.secondaryKeys),
        entry.content,
        entry.enabled ? 1 : 0,
        entry.constant ? 1 : 0,
        entry.priority,
        entry.orderIndex,
        entry.position,
        stringifyJson(entry.rawJson),
        now,
        now
      );
  }

  return worldBookId;
}

function insertImportedScriptCard(db: AppDatabase, parsed: ParsedCharacterCardImport, now: string): string {
  const scriptCardId = nanoid();
  const script = parsed.script;

  db.prepare('INSERT INTO script_cards (id, name, description, personality, scenario, first_mes, mes_example, creator_notes, visibility_notes, source_type, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      scriptCardId,
      script.name,
      script.description,
      script.personality,
      script.scenario,
      script.firstMes,
      script.mesExample,
      script.creatorNotes,
      script.visibilityNotes,
      'sillytavern_character',
      stringifyJson(script.rawJson),
      now,
      now
    );

  return scriptCardId;
}

export function saveImportedWorldBook(db: AppDatabase, parsed: ParsedWorldBook, sourceType: Extract<ResourceSourceType, 'sillytavern_character' | 'sillytavern_world_book'> = 'sillytavern_world_book'): { worldBook: ResourceWorldBook; entries: ResourceWorldBookEntry[]; warnings: string[] } {
  const now = new Date().toISOString();
  let worldBookId = '';

  const transaction = db.transaction(() => {
    worldBookId = insertImportedWorldBook(db, parsed, sourceType, now);
  });
  transaction();

  const worldBook = getResourceWorldBook(db, worldBookId);
  if (!worldBook) throw new Error(`Failed to save resource world book ${worldBookId}.`);

  return {
    worldBook,
    entries: getResourceWorldBookEntries(db, worldBookId),
    warnings: parsed.warnings
  };
}

export function saveImportedScriptCard(db: AppDatabase, parsed: ParsedCharacterCardImport): { scriptCard: ScriptCard; importedWorldBook: ResourceWorldBook | null; warnings: string[] } {
  const now = new Date().toISOString();
  const embeddedWorldBook = parsed.embeddedWorldBook ?? null;
  let scriptCardId = '';
  let worldBookId: string | null = null;

  const transaction = db.transaction(() => {
    scriptCardId = insertImportedScriptCard(db, parsed, now);
    if (embeddedWorldBook) {
      worldBookId = insertImportedWorldBook(db, embeddedWorldBook, 'sillytavern_character', now);
    }
  });
  transaction();

  const scriptCard = getScriptCard(db, scriptCardId);
  if (!scriptCard) throw new Error(`Failed to save script card ${scriptCardId}.`);

  return {
    scriptCard,
    importedWorldBook: worldBookId ? getResourceWorldBook(db, worldBookId) : null,
    warnings: parsed.warnings
  };
}

export function saveImportedPresetPackage(db: AppDatabase, parsed: ParsedPresetPackage): { presetPackage: PromptPresetPackage; warnings: string[] } {
  const now = new Date().toISOString();
  const presetPackageId = nanoid();

  db.prepare('INSERT INTO prompt_preset_packages (id, name, source_type, openai_settings_json, context_template_json, instruct_template_json, sysprompt_json, reasoning_template_json, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      presetPackageId,
      parsed.name,
      'sillytavern_preset_package',
      stringifyJson(parsed.openAiSettings),
      parsed.contextTemplate === null ? null : stringifyJson(parsed.contextTemplate),
      parsed.instructTemplate === null ? null : stringifyJson(parsed.instructTemplate),
      parsed.sysprompt === null ? null : stringifyJson(parsed.sysprompt),
      parsed.reasoningTemplate === null ? null : stringifyJson(parsed.reasoningTemplate),
      stringifyJson(parsed.rawJson),
      now,
      now
    );

  const presetPackage = getPresetPackage(db, presetPackageId);
  if (!presetPackage) throw new Error(`Failed to save preset package ${presetPackageId}.`);
  return { presetPackage, warnings: parsed.warnings };
}

export function listScriptCards(db: AppDatabase): ScriptCard[] {
  const rows = db.prepare('SELECT * FROM script_cards ORDER BY created_at ASC, name ASC').all() as ScriptCardRow[];
  return rows.map(mapScriptCard);
}

export function getScriptCard(db: AppDatabase, id: string): ScriptCard | null {
  const row = db.prepare('SELECT * FROM script_cards WHERE id = ?').get(id) as ScriptCardRow | undefined;
  return row ? mapScriptCard(row) : null;
}

export function listResourceWorldBooks(db: AppDatabase): ResourceWorldBook[] {
  const rows = db.prepare('SELECT * FROM resource_world_books ORDER BY created_at ASC, name ASC').all() as ResourceWorldBookRow[];
  return rows.map(mapResourceWorldBook);
}

export function getResourceWorldBook(db: AppDatabase, id: string): ResourceWorldBook | null {
  const row = db.prepare('SELECT * FROM resource_world_books WHERE id = ?').get(id) as ResourceWorldBookRow | undefined;
  return row ? mapResourceWorldBook(row) : null;
}

export function getResourceWorldBookEntries(db: AppDatabase, worldBookId: string): ResourceWorldBookEntry[] {
  const rows = db.prepare('SELECT * FROM resource_world_book_entries WHERE world_book_id = ? ORDER BY order_index ASC, created_at ASC').all(worldBookId) as ResourceWorldBookEntryRow[];
  return rows.map(mapResourceWorldBookEntry);
}

export function listResourceWorldBookEntries(db: AppDatabase): ResourceWorldBookEntry[] {
  const rows = db.prepare('SELECT * FROM resource_world_book_entries ORDER BY world_book_id ASC, order_index ASC, created_at ASC').all() as ResourceWorldBookEntryRow[];
  return rows.map(mapResourceWorldBookEntry);
}

export function listPresetPackages(db: AppDatabase): PromptPresetPackage[] {
  const rows = db.prepare('SELECT * FROM prompt_preset_packages ORDER BY created_at ASC, name ASC').all() as PromptPresetPackageRow[];
  return rows.map(mapPresetPackage);
}

export function getPresetPackage(db: AppDatabase, id: string): PromptPresetPackage | null {
  const row = db.prepare('SELECT * FROM prompt_preset_packages WHERE id = ?').get(id) as PromptPresetPackageRow | undefined;
  return row ? mapPresetPackage(row) : null;
}

export function listResourceLibrary(db: AppDatabase): ResourceLibrarySnapshot {
  return {
    scriptCards: listScriptCards(db),
    resourceWorldBooks: listResourceWorldBooks(db),
    resourceWorldBookEntries: listResourceWorldBookEntries(db),
    presetPackages: listPresetPackages(db)
  };
}

export function bindRoomScriptCard(db: AppDatabase, roomId: string, scriptCardId: string): RoomScriptBinding {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO room_script_bindings (room_id, script_card_id, binding_type, enabled, created_at)
    VALUES (?, ?, 'main', 1, ?)
    ON CONFLICT(room_id) DO UPDATE SET
      script_card_id = excluded.script_card_id,
      binding_type = 'main',
      enabled = 1,
      created_at = excluded.created_at
  `).run(roomId, scriptCardId, now);

  const binding = db.prepare('SELECT * FROM room_script_bindings WHERE room_id = ?').get(roomId) as RoomScriptBindingRow | undefined;
  if (!binding) throw new Error(`Failed to bind script card ${scriptCardId} to room ${roomId}.`);
  return mapRoomScriptBinding(binding);
}

export function unbindRoomScriptCard(db: AppDatabase, roomId: string): void {
  db.prepare('DELETE FROM room_script_bindings WHERE room_id = ?').run(roomId);
}

export function replaceRoomWorldBookBindings(db: AppDatabase, roomId: string, bindings: Array<{ worldBookId: string; enabled: boolean; orderIndex: number }>): RoomWorldBookBinding[] {
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM room_world_book_bindings WHERE room_id = ?').run(roomId);
    for (const binding of bindings) {
      db.prepare('INSERT INTO room_world_book_bindings (room_id, world_book_id, enabled, order_index, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(roomId, binding.worldBookId, binding.enabled ? 1 : 0, binding.orderIndex, now);
    }
  });
  transaction();

  return getRoomResourceBindings(db, roomId).worldBookBindings;
}

export function bindRoomPresetPackage(db: AppDatabase, roomId: string, presetPackageId: string): RoomPresetBinding {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO room_preset_bindings (room_id, preset_package_id, enabled, created_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(room_id) DO UPDATE SET
      preset_package_id = excluded.preset_package_id,
      enabled = 1,
      created_at = excluded.created_at
  `).run(roomId, presetPackageId, now);

  const binding = db.prepare('SELECT * FROM room_preset_bindings WHERE room_id = ?').get(roomId) as RoomPresetBindingRow | undefined;
  if (!binding) throw new Error(`Failed to bind preset package ${presetPackageId} to room ${roomId}.`);
  return mapRoomPresetBinding(binding);
}

export function unbindRoomPresetPackage(db: AppDatabase, roomId: string): void {
  db.prepare('DELETE FROM room_preset_bindings WHERE room_id = ?').run(roomId);
}

export function getRoomResourceBindings(db: AppDatabase, roomId: string): RoomResourceBindings {
  const scriptRow = db.prepare('SELECT * FROM room_script_bindings WHERE room_id = ?').get(roomId) as RoomScriptBindingRow | undefined;
  const worldBookRows = db.prepare('SELECT * FROM room_world_book_bindings WHERE room_id = ? ORDER BY order_index ASC, created_at ASC').all(roomId) as RoomWorldBookBindingRow[];
  const presetRow = db.prepare('SELECT * FROM room_preset_bindings WHERE room_id = ?').get(roomId) as RoomPresetBindingRow | undefined;

  return {
    scriptBinding: scriptRow ? mapRoomScriptBinding(scriptRow) : null,
    worldBookBindings: worldBookRows.map(mapRoomWorldBookBinding),
    presetBinding: presetRow ? mapRoomPresetBinding(presetRow) : null
  };
}
