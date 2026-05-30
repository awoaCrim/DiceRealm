import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import {
  bindRoomPresetPackage,
  bindRoomScriptCard,
  getRoomResourceBindings,
  listResourceLibrary,
  listScriptCards,
  replaceRoomWorldBookBindings,
  saveImportedPresetPackage,
  saveImportedScriptCard,
  saveImportedWorldBook,
  unbindRoomPresetPackage,
  unbindRoomScriptCard
} from '../services/resourceLibrary.js';
import { parseSillyTavernCharacterCard, parseSillyTavernPresetPackage, parseSillyTavernWorldBook } from '../services/sillyTavernImport.js';

describe('resource library schema', () => {
  it('creates global resource and room binding tables', () => {
    const db = createMemoryDb();
    try {
      migrate(db);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
      const names = tables.map((table) => table.name);

      expect(names).toContain('script_cards');
      expect(names).toContain('resource_world_books');
      expect(names).toContain('resource_world_book_entries');
      expect(names).toContain('prompt_preset_packages');
      expect(names).toContain('room_script_bindings');
      expect(names).toContain('room_world_book_bindings');
      expect(names).toContain('room_preset_bindings');
    } finally {
      db.close();
    }
  });

  it('persists imported script cards with embedded world books', () => {
    const db = createMemoryDb();
    try {
      migrate(db);
      const parsed = parseSillyTavernCharacterCard({
        data: {
          name: 'Script One',
          description: 'Script description',
          personality: 'Calm factions',
          scenario: 'A locked hall',
          first_mes: 'The hall waits.',
          mes_example: 'DM: Dust falls.',
          creator_notes: 'Private DM note',
          visibility_notes: 'DM only',
          system_prompt: 'Preserved only',
          character_book: { name: 'Embedded Lore', entries: [{ name: 'Bell', keys: ['bell'], content: 'A bell rings.', enabled: true }] }
        }
      });

      const result = saveImportedScriptCard(db, parsed);
      const library = listResourceLibrary(db);

      expect(result.scriptCard.name).toBe('Script One');
      expect(result.scriptCard.description).toBe('Script description');
      expect(result.scriptCard.visibilityNotes).toBe('DM only');
      expect(JSON.stringify(result.scriptCard.rawJson)).toContain('Preserved only');
      expect(result.importedWorldBook?.name).toBe('Embedded Lore');
      expect(library.scriptCards).toHaveLength(1);
      expect(library.resourceWorldBooks).toHaveLength(1);
      expect(library.resourceWorldBookEntries).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('does not duplicate embedded world book warnings when saving script cards', () => {
    const db = createMemoryDb();
    try {
      migrate(db);
      const parsed = parseSillyTavernCharacterCard({
        data: {
          name: 'Script With Warning',
          character_book: { name: 'Warning Lore', entries: [{ name: 'No Keys', content: 'Cannot activate.', enabled: true }] }
        }
      });

      const result = saveImportedScriptCard(db, parsed);

      expect(parsed.warnings).toHaveLength(1);
      expect(result.warnings).toEqual(parsed.warnings);
    } finally {
      db.close();
    }
  });

  it('rolls back script card imports when embedded world book persistence fails', () => {
    const db = createMemoryDb();
    try {
      migrate(db);
      const parsed = parseSillyTavernCharacterCard({
        data: {
          name: 'Atomic Script',
          character_book: { name: 'Atomic Lore', entries: [{ name: 'Loop', keys: ['loop'], content: 'Loop lore.' }] }
        }
      });
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      parsed.embeddedWorldBook!.entries[0]!.rawJson = circular;

      expect(() => saveImportedScriptCard(db, parsed)).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM script_cards').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM resource_world_books').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM resource_world_book_entries').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('throws contextual errors for corrupt persisted JSON fields', () => {
    const db = createMemoryDb();
    try {
      migrate(db);
      db.prepare('INSERT INTO script_cards (id, name, description, personality, scenario, first_mes, mes_example, creator_notes, visibility_notes, source_type, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('script-bad-json', 'Broken', '', '', '', '', '', '', '', 'sillytavern_character', '{bad', '2026-05-28T00:00:00.000Z', '2026-05-28T00:00:00.000Z');

      expect(() => listScriptCards(db)).toThrow('Failed to parse script_cards.raw_json for script-bad-json');
    } finally {
      db.close();
    }
  });

  it('persists world books, preset packages, and room bindings', () => {
    const db = createMemoryDb();
    try {
      migrate(db);
      db.prepare('INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, ai_config_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('room-1', 'Room', 'Fair DM', 'World info', 1, 'waiting_for_actions', '{}', '2026-05-28T00:00:00.000Z');

      const worldBook = saveImportedWorldBook(db, parseSillyTavernWorldBook({ name: 'Lore', entries: [{ name: 'Gate', keys: ['gate'], content: 'Gate lore.' }] }, 'Lore')).worldBook;
      const preset = saveImportedPresetPackage(db, parseSillyTavernPresetPackage({ openAiSettings: { name: 'Preset', prompts: [], prompt_order: [] } })).presetPackage;
      const script = saveImportedScriptCard(db, parseSillyTavernCharacterCard({ data: { name: 'Script', scenario: 'Scene' } })).scriptCard;

      bindRoomScriptCard(db, 'room-1', script.id);
      replaceRoomWorldBookBindings(db, 'room-1', [{ worldBookId: worldBook.id, enabled: true, orderIndex: 0 }]);
      bindRoomPresetPackage(db, 'room-1', preset.id);

      const bindings = getRoomResourceBindings(db, 'room-1');
      expect(bindings.scriptBinding?.scriptCardId).toBe(script.id);
      expect(bindings.worldBookBindings).toEqual([{ roomId: 'room-1', worldBookId: worldBook.id, enabled: true, orderIndex: 0, createdAt: expect.any(String) }]);
      expect(bindings.presetBinding?.presetPackageId).toBe(preset.id);
    } finally {
      db.close();
    }
  });

  it('replaces only target room world book bindings and upserts or unbinds target room script and preset bindings', () => {
    const db = createMemoryDb();
    try {
      migrate(db);
      db.prepare('INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, ai_config_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('room-1', 'Room 1', 'Fair DM', 'World info', 1, 'waiting_for_actions', '{}', '2026-05-28T00:00:00.000Z');
      db.prepare('INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, ai_config_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('room-2', 'Room 2', 'Fair DM', 'World info', 1, 'waiting_for_actions', '{}', '2026-05-28T00:00:00.000Z');

      const worldBookOne = saveImportedWorldBook(db, parseSillyTavernWorldBook({ name: 'Lore 1', entries: [] }, 'Lore 1')).worldBook;
      const worldBookTwo = saveImportedWorldBook(db, parseSillyTavernWorldBook({ name: 'Lore 2', entries: [] }, 'Lore 2')).worldBook;
      const scriptOne = saveImportedScriptCard(db, parseSillyTavernCharacterCard({ data: { name: 'Script 1' } })).scriptCard;
      const scriptTwo = saveImportedScriptCard(db, parseSillyTavernCharacterCard({ data: { name: 'Script 2' } })).scriptCard;
      const presetOne = saveImportedPresetPackage(db, parseSillyTavernPresetPackage({ openAiSettings: { name: 'Preset 1', prompts: [], prompt_order: [] } })).presetPackage;
      const presetTwo = saveImportedPresetPackage(db, parseSillyTavernPresetPackage({ openAiSettings: { name: 'Preset 2', prompts: [], prompt_order: [] } })).presetPackage;

      bindRoomScriptCard(db, 'room-1', scriptOne.id);
      bindRoomScriptCard(db, 'room-1', scriptTwo.id);
      bindRoomScriptCard(db, 'room-2', scriptOne.id);
      bindRoomPresetPackage(db, 'room-1', presetOne.id);
      bindRoomPresetPackage(db, 'room-1', presetTwo.id);
      bindRoomPresetPackage(db, 'room-2', presetOne.id);
      replaceRoomWorldBookBindings(db, 'room-2', [{ worldBookId: worldBookOne.id, enabled: true, orderIndex: 0 }]);

      const firstRoomOneWorldBooks = replaceRoomWorldBookBindings(db, 'room-1', [
        { worldBookId: worldBookOne.id, enabled: true, orderIndex: 0 },
        { worldBookId: worldBookTwo.id, enabled: false, orderIndex: 1 }
      ]);
      expect(new Set(firstRoomOneWorldBooks.map((binding) => binding.createdAt)).size).toBe(1);

      replaceRoomWorldBookBindings(db, 'room-1', [{ worldBookId: worldBookTwo.id, enabled: true, orderIndex: 0 }]);
      unbindRoomScriptCard(db, 'room-1');
      unbindRoomPresetPackage(db, 'room-1');

      expect(getRoomResourceBindings(db, 'room-1')).toEqual({
        scriptBinding: null,
        worldBookBindings: [{ roomId: 'room-1', worldBookId: worldBookTwo.id, enabled: true, orderIndex: 0, createdAt: expect.any(String) }],
        presetBinding: null
      });
      expect(getRoomResourceBindings(db, 'room-2')).toEqual({
        scriptBinding: { roomId: 'room-2', scriptCardId: scriptOne.id, bindingType: 'main', enabled: true, createdAt: expect.any(String) },
        worldBookBindings: [{ roomId: 'room-2', worldBookId: worldBookOne.id, enabled: true, orderIndex: 0, createdAt: expect.any(String) }],
        presetBinding: { roomId: 'room-2', presetPackageId: presetOne.id, enabled: true, createdAt: expect.any(String) }
      });
    } finally {
      db.close();
    }
  });
});
