import { describe, expect, it } from 'vitest';
import { parseSillyTavernCharacterCard, parseSillyTavernPresetPackage, parseSillyTavernWorldBook } from '../services/sillyTavernImport.js';

describe('SillyTavern import parsing', () => {
  it('maps a Character Card V2 object into a script card and embedded world book', () => {
    const parsed = parseSillyTavernCharacterCard({
      spec: 'chara_card_v2',
      data: {
        name: 'Candlekeep Mystery',
        description: 'A sealed library scenario.',
        personality: 'Measured, observant NPCs.',
        scenario: 'The party enters Candlekeep at midnight.',
        first_mes: 'The bronze door opens.',
        mes_example: '<START> DM: The corridor is quiet.',
        creator_notes: 'Keep the secret bell private.',
        visibility_notes: 'Only admins should see the bell clue.',
        system_prompt: 'Do not store this as script content.',
        post_history_instructions: 'Do not store this either.',
        character_book: {
          name: 'Candlekeep Lore',
          entries: [
            {
              name: 'Silver Key',
              keys: ['silver key'],
              secondary_keys: ['door'],
              content: 'The silver key opens the moon door.',
              enabled: true,
              constant: false,
              insertion_order: 7,
              order: 50,
              position: 'before'
            }
          ]
        }
      }
    });

    expect(parsed.script.name).toBe('Candlekeep Mystery');
    expect(parsed.script.description).toBe('A sealed library scenario.');
    expect(parsed.script.visibilityNotes).toBe('Only admins should see the bell clue.');
    expect(parsed.script.systemPrompt).toBe('Do not store this as script content.');
    expect(parsed.script.postHistoryInstructions).toBe('Do not store this either.');
    expect(parsed.embeddedWorldBook?.name).toBe('Candlekeep Lore');
    expect(parsed.embeddedWorldBook?.entries[0]).toMatchObject({
      title: 'Silver Key',
      keys: ['silver key'],
      secondaryKeys: ['door'],
      priority: 50,
      orderIndex: 7,
      position: 'before'
    });
  });

  it('parses ST world info maps and warns about inert entries', () => {
    const parsed = parseSillyTavernWorldBook({
      name: 'Dungeon Lore',
      entries: {
        '0': {
          comment: 'Hidden Shrine',
          key: ['shrine'],
          keysecondary: ['moon'],
          content: 'The shrine reacts to moonlight.',
          disable: false,
          constant: false,
          order: 200,
          position: 1
        },
        '1': {
          comment: 'No Keys',
          key: [],
          content: 'This cannot activate in the first version.',
          disable: false,
          constant: false
        }
      }
    }, 'Fallback Lore');

    expect(parsed.name).toBe('Dungeon Lore');
    expect(parsed.entries[0]).toMatchObject({
      title: 'Hidden Shrine',
      keys: ['shrine'],
      secondaryKeys: ['moon'],
      content: 'The shrine reacts to moonlight.',
      enabled: true,
      constant: false,
      priority: 200,
      position: 'after'
    });
    expect(parsed.warnings).toContain('World book entry "No Keys" has no keys and is not constant, so it will not activate until edited.');
  });

  it('parses a preset package while preserving prompt order and optional templates', () => {
    const input = {
      openAiSettings: {
        name: 'DND DM',
        prompts: [{ identifier: 'main', role: 'system', content: 'You are DM.' }],
        prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }]
      },
      contextTemplate: { name: 'Default', story_string: '{{description}}\n{{scenario}}' },
      instructTemplate: { name: 'ChatML', input_sequence: '<|im_start|>user' },
      sysprompt: { name: 'DND Dungeon Master', content: '中文 DM 约束' },
      reasoningTemplate: { name: 'OpenAI Harmony', prefix: '<reasoning>', suffix: '</reasoning>', separator: '\n' }
    };
    const parsed = parseSillyTavernPresetPackage(input);

    expect(parsed.name).toBe('DND DM');
    expect(parsed.openAiSettings).toHaveProperty('prompt_order');
    expect(parsed.contextTemplate).toHaveProperty('story_string');
    expect(parsed.instructTemplate).toHaveProperty('input_sequence');
    expect(parsed.sysprompt).toHaveProperty('content');
    expect(parsed.reasoningTemplate).toHaveProperty('prefix');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.rawJson).toBe(input);
  });

  it('rejects non-object character cards with a stable error', () => {
    expect(() => parseSillyTavernCharacterCard(null)).toThrow(new TypeError('SillyTavern character card must be an object.'));
    expect(() => parseSillyTavernCharacterCard('not an object')).toThrow(new TypeError('SillyTavern character card must be an object.'));
  });

  it('rejects non-object world books with a stable error', () => {
    expect(() => parseSillyTavernWorldBook(null)).toThrow(new TypeError('SillyTavern world book must be an object.'));
    expect(() => parseSillyTavernWorldBook([])).toThrow(new TypeError('SillyTavern world book must be an object.'));
  });

  it('rejects preset packages without an openAiSettings object with a stable error', () => {
    const error = new TypeError('SillyTavern preset package requires an openAiSettings object.');

    expect(() => parseSillyTavernPresetPackage(null as never)).toThrow(error);
    expect(() => parseSillyTavernPresetPackage({} as never)).toThrow(error);
    expect(() => parseSillyTavernPresetPackage({ openAiSettings: [] } as never)).toThrow(error);
  });

  it('warns about malformed world book entries and keeps valid entries', () => {
    const arrayParsed = parseSillyTavernWorldBook({
      entries: [
        { comment: 'Valid Array Entry', key: ['valid'], content: 'Kept.' },
        'bad entry'
      ]
    });
    const mapParsed = parseSillyTavernWorldBook({
      entries: {
        '0': { comment: 'Valid Map Entry', key: ['valid'], content: 'Kept.' },
        '1': 'bad entry'
      }
    });

    expect(arrayParsed.entries).toHaveLength(1);
    expect(arrayParsed.entries[0]?.title).toBe('Valid Array Entry');
    expect(arrayParsed.warnings).toContain('World book entry at index 1 is not an object and was skipped.');
    expect(mapParsed.entries).toHaveLength(1);
    expect(mapParsed.entries[0]?.title).toBe('Valid Map Entry');
    expect(mapParsed.warnings).toContain('World book entry "1" is not an object and was skipped.');
  });

  it('preserves rawJson for character roots, data, embedded world books, and entries', () => {
    const entry = { name: 'Raw Entry', keys: ['raw'], content: 'Raw content.' };
    const characterBook = { name: 'Raw Book', entries: [entry] };
    const data = { name: 'Raw Character', description: 'Raw description.', character_book: characterBook };
    const root = { spec: 'chara_card_v2', data };

    const parsed = parseSillyTavernCharacterCard(root);

    expect(parsed.rawJson).toBe(root);
    expect(parsed.script.rawJson).toBe(data);
    expect(parsed.embeddedWorldBook?.rawJson).toBe(characterBook);
    expect(parsed.embeddedWorldBook?.entries[0]?.rawJson).toBe(entry);
  });

  it('uses fallback names for empty character, world book, and preset names', () => {
    expect(parseSillyTavernCharacterCard({ name: '' }).script.name).toBe('Imported ST Character');
    expect(parseSillyTavernWorldBook({ name: '' }, 'Fallback Lore').name).toBe('Fallback Lore');
    expect(parseSillyTavernPresetPackage({ openAiSettings: { name: '', preset_name: '' } }).name).toBe('Imported ST Preset');
  });
});
