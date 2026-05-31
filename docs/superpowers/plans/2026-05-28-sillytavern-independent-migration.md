# SillyTavern Independent Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone SillyTavern-compatible one-time resource import path for script cards, world books, preset packages, room bindings, and ST-style prompt preview/runtime construction.

**Architecture:** Browser file inputs parse SillyTavern JSON and send JSON payloads to `/api/admin`; the server stores imported resources in a global resource library and room binding tables. Runtime prompt construction chooses the existing native builder unless a room has a ST preset package binding, then renders ST-like slots, applies `prompt_order`, and appends the DND output contract.

**Tech Stack:** Node.js, TypeScript, Express, better-sqlite3, Zod, React, Vite, Vitest, Testing Library.

---

## Execution Guardrails

- Before editing code, run `rtk git branch --show-current` and confirm the branch matches the user-approved branch. The current branch at plan-writing time was `master`.
- Do not create or switch branches.
- All shell commands in this plan use the required `rtk` prefix.
- Commit steps are included as checkpoints. Run commit steps only if the user explicitly authorizes commits in the execution session. If commits are not authorized, leave changes uncommitted and report the checkpoint status.
- Do not modify `SillyTavern/` runtime code. Read it only as a source-format reference.
- Do not add Anthropic SDK or switch AI providers. Keep the current OpenAI-compatible provider surface unchanged.
- Do not create temporary scripts. If a worker creates one for debugging, delete it before finishing the task or add its exact path to `.gitignore` and verify with `rtk git check-ignore -v <path>`.

## File Structure

### Server domain and storage

- Modify `server/src/db/schema.ts`
  - Add global resource library tables and room binding tables.
- Modify `server/src/domain/types.ts`
  - Add imported resource types, ST prompt preview types, and binding types.
- Create `server/src/services/sillyTavernImport.ts`
  - Pure parsing and normalization of ST character cards, world books, and preset packages.
- Create `server/src/services/resourceLibrary.ts`
  - Database persistence, mappers, list/get helpers, and binding writes for imported resources.
- Create `server/src/services/sillyTavernPromptBuilder.ts`
  - ST-style slot rendering, prompt-order application, world-book match rendering, and preview structure.
- Modify `server/src/services/aiContextBuilder.ts`
  - Expose DND output contract rendering as a reusable function.
- Modify `server/src/services/worldBookService.ts`
  - Add reusable world-book keyword matching helpers that support imported resource entries.
- Modify `server/src/services/turnEngine.ts`
  - Allow a prebuilt prompt string so admin runtime can select ST-compatible construction without changing AI provider shape.

### Server routes

- Create `server/src/routes/adminResourceRoutes.ts`
  - Register global resource API endpoints and room binding endpoints on the existing admin router.
- Modify `server/src/routes/adminRoutes.ts`
  - Register resource routes, include global resources/bindings in admin state, and select prompt mode for preview/process-turn.
- Modify `server/src/app.ts`
  - Increase JSON body limit to `10mb` for imported ST resources.

### Client

- Modify `client/src/types.ts`
  - Add imported resource, binding, and prompt preview response types.
- Modify `client/src/api.ts`
  - Add import, list, binding, and structured prompt preview API helpers.
- Create `client/src/components/ResourceImportPanel.tsx`
  - Global resource import/list UI.
- Create `client/src/components/RoomResourceBindingsPanel.tsx`
  - Room script/world-book/preset binding UI.
- Create `client/src/components/PromptPreviewPanel.tsx`
  - Structured prompt preview UI.
- Modify `client/src/pages/AdminPage.tsx`
  - Wire the new panels into the admin page and stop treating prompt preview as a plain string only.

### Tests

- Create `server/src/tests/sillyTavernImport.test.ts`
- Create `server/src/tests/resourceLibrary.test.ts`
- Create `server/src/tests/sillyTavernPromptBuilder.test.ts`
- Modify `server/src/tests/integration.test.ts`
- Modify `client/src/ui-copy.test.tsx`

---

### Task 1: Add resource-library schema and shared types

**Files:**
- Modify: `server/src/db/schema.ts`
- Modify: `server/src/domain/types.ts`
- Test: `server/src/tests/resourceLibrary.test.ts`

- [ ] **Step 1: Confirm branch before editing**

Run:

```bash
rtk git branch --show-current
```

Expected: prints `master`, or the user has explicitly confirmed another current branch.

- [ ] **Step 2: Write the failing schema test**

Create `server/src/tests/resourceLibrary.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';

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
});
```

- [ ] **Step 3: Run the failing test**

Run:

```bash
rtk npm test -- server/src/tests/resourceLibrary.test.ts
```

Expected: FAIL because the new tables do not exist.

- [ ] **Step 4: Add schema tables**

In `server/src/db/schema.ts`, inside the existing `db.exec(` migration string and after the existing `world_book_entries` table definition, add this SQL block before the closing backtick:

```sql

    CREATE TABLE IF NOT EXISTS script_cards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      personality TEXT NOT NULL DEFAULT '',
      scenario TEXT NOT NULL DEFAULT '',
      first_mes TEXT NOT NULL DEFAULT '',
      mes_example TEXT NOT NULL DEFAULT '',
      creator_notes TEXT NOT NULL DEFAULT '',
      visibility_notes TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_world_books (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_world_book_entries (
      id TEXT PRIMARY KEY,
      world_book_id TEXT NOT NULL REFERENCES resource_world_books(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      keys_json TEXT NOT NULL,
      secondary_keys_json TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      constant INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 100,
      order_index INTEGER NOT NULL DEFAULT 0,
      position TEXT NOT NULL DEFAULT 'after',
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_preset_packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      openai_settings_json TEXT NOT NULL,
      context_template_json TEXT,
      instruct_template_json TEXT,
      sysprompt_json TEXT,
      reasoning_template_json TEXT,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_script_bindings (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      script_card_id TEXT NOT NULL REFERENCES script_cards(id) ON DELETE CASCADE,
      binding_type TEXT NOT NULL DEFAULT 'main',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_world_book_bindings (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      world_book_id TEXT NOT NULL REFERENCES resource_world_books(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (room_id, world_book_id)
    );

    CREATE TABLE IF NOT EXISTS room_preset_bindings (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      preset_package_id TEXT NOT NULL REFERENCES prompt_preset_packages(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
```

- [ ] **Step 5: Add shared domain types**

In `server/src/domain/types.ts`, after `WorldBookMatch`, add:

```ts
export type ImportedWorldBookPosition = 'before' | 'after';
export type ResourceSourceType = 'sillytavern_character' | 'sillytavern_world_book' | 'sillytavern_preset_package';

export interface ScriptCard {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  visibilityNotes: string;
  sourceType: ResourceSourceType;
  rawJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceWorldBook {
  id: string;
  name: string;
  sourceType: ResourceSourceType;
  rawJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceWorldBookEntry {
  id: string;
  worldBookId: string;
  title: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  priority: number;
  orderIndex: number;
  position: ImportedWorldBookPosition;
  rawJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceWorldBookMatch {
  entry: ResourceWorldBookEntry;
  matchedKeys: string[];
  reason: 'constant' | 'primary-key' | 'primary-and-secondary-key';
}

export interface PromptPresetPackage {
  id: string;
  name: string;
  sourceType: ResourceSourceType;
  openAiSettings: unknown;
  contextTemplate: unknown | null;
  instructTemplate: unknown | null;
  sysprompt: unknown | null;
  reasoningTemplate: unknown | null;
  rawJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface RoomScriptBinding {
  roomId: string;
  scriptCardId: string;
  bindingType: 'main';
  enabled: boolean;
  createdAt: string;
}

export interface RoomWorldBookBinding {
  roomId: string;
  worldBookId: string;
  enabled: boolean;
  orderIndex: number;
  createdAt: string;
}

export interface RoomPresetBinding {
  roomId: string;
  presetPackageId: string;
  enabled: boolean;
  createdAt: string;
}

export interface PromptPreviewMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PromptPreviewSlot {
  key: string;
  source: string;
  content: string;
}

export interface PromptPreviewWorldBookMatch {
  worldBookId: string;
  entryId: string;
  keys: string[];
  reason: 'constant' | 'primary-key' | 'primary-and-secondary-key';
  position: ImportedWorldBookPosition;
  content: string;
}

export interface PromptPreviewBlock {
  identifier: string;
  source: 'st-preset' | 'runtime-slot' | 'dnd-contract' | 'native-preset';
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PromptPreviewResponse {
  mode: 'native' | 'sillytavern-compatible';
  prompt: string;
  messages: PromptPreviewMessage[];
  slots: PromptPreviewSlot[];
  worldBookMatches: PromptPreviewWorldBookMatch[];
  promptBlocks: PromptPreviewBlock[];
  warnings: string[];
}
```

Then extend `AdminState` by adding these fields before the closing brace:

```ts
  scriptCards: ScriptCard[];
  resourceWorldBooks: ResourceWorldBook[];
  resourceWorldBookEntries: ResourceWorldBookEntry[];
  presetPackages: PromptPresetPackage[];
  roomScriptBinding: RoomScriptBinding | null;
  roomWorldBookBindings: RoomWorldBookBinding[];
  roomPresetBinding: RoomPresetBinding | null;
```

- [ ] **Step 6: Verify schema test passes**

Run:

```bash
rtk npm test -- server/src/tests/resourceLibrary.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck server**

Run:

```bash
rtk npm run typecheck --workspace server
```

Expected: PASS.

- [ ] **Step 8: Commit checkpoint if authorized**

Run only with explicit commit authorization:

```bash
rtk git add server/src/db/schema.ts server/src/domain/types.ts server/src/tests/resourceLibrary.test.ts && rtk git commit -m "feat: add imported resource schema"
```

Expected: commit succeeds.

---

### Task 2: Parse SillyTavern resource JSON without persistence

**Files:**
- Create: `server/src/services/sillyTavernImport.ts`
- Modify: `server/src/tests/sillyTavernImport.test.ts`

- [ ] **Step 1: Write parser tests**

Create `server/src/tests/sillyTavernImport.test.ts` with:

```ts
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
    const parsed = parseSillyTavernPresetPackage({
      openAiSettings: {
        name: 'DND DM',
        prompts: [{ identifier: 'main', role: 'system', content: 'You are DM.' }],
        prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }]
      },
      contextTemplate: { name: 'Default', story_string: '{{description}}\n{{scenario}}' },
      instructTemplate: { name: 'ChatML', input_sequence: '<|im_start|>user' },
      sysprompt: { name: 'DND Dungeon Master', content: '中文 DM 约束' },
      reasoningTemplate: { name: 'OpenAI Harmony', prefix: '<reasoning>', suffix: '</reasoning>', separator: '\n' }
    });

    expect(parsed.name).toBe('DND DM');
    expect(parsed.openAiSettings).toHaveProperty('prompt_order');
    expect(parsed.contextTemplate).toHaveProperty('story_string');
    expect(parsed.instructTemplate).toHaveProperty('input_sequence');
    expect(parsed.sysprompt).toHaveProperty('content');
    expect(parsed.reasoningTemplate).toHaveProperty('prefix');
    expect(parsed.warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the failing parser tests**

Run:

```bash
rtk npm test -- server/src/tests/sillyTavernImport.test.ts
```

Expected: FAIL because `sillyTavernImport.ts` does not exist.

- [ ] **Step 3: Create the parser implementation**

Create `server/src/services/sillyTavernImport.ts` with:

```ts
export interface ParsedScriptCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  visibilityNotes: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  rawJson: unknown;
}

export interface ParsedWorldBookEntry {
  title: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  priority: number;
  orderIndex: number;
  position: 'before' | 'after';
  rawJson: unknown;
}

export interface ParsedWorldBook {
  name: string;
  entries: ParsedWorldBookEntry[];
  rawJson: unknown;
  warnings: string[];
}

export interface ParsedCharacterCardImport {
  script: ParsedScriptCard;
  embeddedWorldBook: ParsedWorldBook | null;
  warnings: string[];
}

export interface ParsedPresetPackage {
  name: string;
  openAiSettings: unknown;
  contextTemplate: unknown | null;
  instructTemplate: unknown | null;
  sysprompt: unknown | null;
  reasoningTemplate: unknown | null;
  rawJson: unknown;
  warnings: string[];
}

export interface PresetPackageInput {
  openAiSettings: unknown;
  contextTemplate?: unknown;
  instructTemplate?: unknown;
  sysprompt?: unknown;
  reasoningTemplate?: unknown;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown, message: string): RecordValue {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function optionalRecord(value: unknown): RecordValue | null {
  return isRecord(value) ? value : null;
}

function stringField(record: RecordValue, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return fallback;
}

function numberField(record: RecordValue, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return fallback;
}

function booleanField(record: RecordValue, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
  }
  return fallback;
}

function stringArrayField(record: RecordValue, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
    if (typeof value === 'string' && value.trim()) return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizePosition(value: unknown): 'before' | 'after' {
  if (value === 'before' || value === 'before_world' || value === 0) return 'before';
  return 'after';
}

function extractWorldBookEntries(rawEntries: unknown): RecordValue[] {
  if (Array.isArray(rawEntries)) return rawEntries.filter(isRecord);
  if (isRecord(rawEntries)) return Object.values(rawEntries).filter(isRecord);
  return [];
}

function parseWorldBookEntry(entry: RecordValue, index: number): ParsedWorldBookEntry {
  const title = stringField(entry, ['name', 'comment', 'title'], `Entry ${index + 1}`);
  const keys = stringArrayField(entry, ['keys', 'key']);
  const secondaryKeys = stringArrayField(entry, ['secondaryKeys', 'secondary_keys', 'keysecondary']);
  const disabled = booleanField(entry, ['disable', 'disabled'], false);
  return {
    title,
    keys,
    secondaryKeys,
    content: stringField(entry, ['content'], ''),
    enabled: booleanField(entry, ['enabled'], !disabled),
    constant: booleanField(entry, ['constant'], false),
    priority: numberField(entry, ['priority', 'order'], 100),
    orderIndex: numberField(entry, ['order_index', 'insertion_order', 'uid'], index),
    position: normalizePosition(entry.position),
    rawJson: entry
  };
}

export function parseSillyTavernWorldBook(input: unknown, fallbackName = 'Imported World Book'): ParsedWorldBook {
  const record = asRecord(input, 'World book JSON must be an object.');
  const name = stringField(record, ['name'], fallbackName);
  const entries = extractWorldBookEntries(record.entries).map(parseWorldBookEntry);
  const warnings = entries
    .filter((entry) => entry.enabled && !entry.constant && entry.keys.length === 0)
    .map((entry) => `World book entry "${entry.title}" has no keys and is not constant, so it will not activate until edited.`);
  return { name, entries, rawJson: input, warnings };
}

export function parseSillyTavernCharacterCard(input: unknown): ParsedCharacterCardImport {
  const root = asRecord(input, 'Character card JSON must be an object.');
  const data = optionalRecord(root.data) ?? root;
  const name = stringField(data, ['name'], 'Imported Script Card');
  const script: ParsedScriptCard = {
    name,
    description: stringField(data, ['description']),
    personality: stringField(data, ['personality']),
    scenario: stringField(data, ['scenario']),
    firstMes: stringField(data, ['first_mes', 'firstMes']),
    mesExample: stringField(data, ['mes_example', 'mesExample']),
    creatorNotes: stringField(data, ['creator_notes', 'creatorNotes']),
    visibilityNotes: stringField(data, ['visibility_notes', 'visibilityNotes']),
    systemPrompt: stringField(data, ['system_prompt', 'systemPrompt']),
    postHistoryInstructions: stringField(data, ['post_history_instructions', 'postHistoryInstructions']),
    rawJson: input
  };
  const warnings: string[] = [];
  if (!script.scenario) warnings.push(`Script card "${name}" has an empty scenario.`);
  if (script.systemPrompt) warnings.push('Character card system_prompt was preserved in rawJson and not imported into script fields.');
  if (script.postHistoryInstructions) warnings.push('Character card post_history_instructions was preserved in rawJson and not imported into script fields.');
  const characterBook = data.character_book;
  const embeddedWorldBook = isRecord(characterBook) ? parseSillyTavernWorldBook(characterBook, `${name} Character Book`) : null;
  return {
    script,
    embeddedWorldBook,
    warnings: embeddedWorldBook ? [...warnings, ...embeddedWorldBook.warnings] : warnings
  };
}

export function parseSillyTavernPresetPackage(input: PresetPackageInput): ParsedPresetPackage {
  const openAiSettings = asRecord(input.openAiSettings, 'OpenAI Settings JSON must be an object.');
  const name = stringField(openAiSettings, ['name', 'preset_name'], 'Imported ST Preset');
  const warnings: string[] = [];
  if (!Array.isArray(openAiSettings.prompts)) warnings.push(`Preset package "${name}" has no prompts array.`);
  if (!Array.isArray(openAiSettings.prompt_order)) warnings.push(`Preset package "${name}" has no prompt_order; default ordering will be used.`);
  return {
    name,
    openAiSettings,
    contextTemplate: input.contextTemplate ?? null,
    instructTemplate: input.instructTemplate ?? null,
    sysprompt: input.sysprompt ?? null,
    reasoningTemplate: input.reasoningTemplate ?? null,
    rawJson: input,
    warnings
  };
}
```

- [ ] **Step 4: Verify parser tests pass**

Run:

```bash
rtk npm test -- server/src/tests/sillyTavernImport.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run server typecheck**

Run:

```bash
rtk npm run typecheck --workspace server
```

Expected: PASS.

- [ ] **Step 6: Commit checkpoint if authorized**

Run only with explicit commit authorization:

```bash
rtk git add server/src/services/sillyTavernImport.ts server/src/tests/sillyTavernImport.test.ts && rtk git commit -m "feat: parse sillytavern resource imports"
```

Expected: commit succeeds.

---

### Task 3: Persist imported resources and room bindings

**Files:**
- Create: `server/src/services/resourceLibrary.ts`
- Modify: `server/src/tests/resourceLibrary.test.ts`

- [ ] **Step 1: Extend repository tests**

Append these imports to `server/src/tests/resourceLibrary.test.ts`:

```ts
import { saveImportedPresetPackage, saveImportedScriptCard, saveImportedWorldBook, listResourceLibrary, bindRoomPresetPackage, bindRoomScriptCard, replaceRoomWorldBookBindings, getRoomResourceBindings } from '../services/resourceLibrary.js';
import { parseSillyTavernCharacterCard, parseSillyTavernPresetPackage, parseSillyTavernWorldBook } from '../services/sillyTavernImport.js';
```

Append these tests inside the existing `describe('resource library schema', () => { ... })` block:

```ts
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
          system_prompt: 'Preserved only',
          character_book: { name: 'Embedded Lore', entries: [{ name: 'Bell', keys: ['bell'], content: 'A bell rings.', enabled: true }] }
        }
      });

      const result = saveImportedScriptCard(db, parsed);
      const library = listResourceLibrary(db);

      expect(result.scriptCard.name).toBe('Script One');
      expect(result.scriptCard.description).toBe('Script description');
      expect(JSON.stringify(result.scriptCard.rawJson)).toContain('Preserved only');
      expect(result.importedWorldBook?.name).toBe('Embedded Lore');
      expect(library.scriptCards).toHaveLength(1);
      expect(library.resourceWorldBooks).toHaveLength(1);
      expect(library.resourceWorldBookEntries).toHaveLength(1);
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
```

- [ ] **Step 2: Run the failing repository tests**

Run:

```bash
rtk npm test -- server/src/tests/resourceLibrary.test.ts
```

Expected: FAIL because `resourceLibrary.ts` does not exist.

- [ ] **Step 3: Create resource persistence helpers**

Create `server/src/services/resourceLibrary.ts` with these imports and exported functions:

```ts
import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { ParsedCharacterCardImport, ParsedPresetPackage, ParsedWorldBook } from './sillyTavernImport.js';
import type { PromptPresetPackage, ResourceWorldBook, ResourceWorldBookEntry, RoomPresetBinding, RoomScriptBinding, RoomWorldBookBinding, ScriptCard } from '../domain/types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function mapScriptCard(row: any): ScriptCard {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    personality: row.personality,
    scenario: row.scenario,
    firstMes: row.firstMes,
    mesExample: row.mesExample,
    creatorNotes: row.creatorNotes,
    visibilityNotes: row.visibilityNotes,
    sourceType: row.sourceType,
    rawJson: parseJson(row.rawJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapWorldBook(row: any): ResourceWorldBook {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.sourceType,
    rawJson: parseJson(row.rawJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapWorldBookEntry(row: any): ResourceWorldBookEntry {
  return {
    id: row.id,
    worldBookId: row.worldBookId,
    title: row.title,
    keys: JSON.parse(row.keysJson) as string[],
    secondaryKeys: JSON.parse(row.secondaryKeysJson) as string[],
    content: row.content,
    enabled: Boolean(row.enabled),
    constant: Boolean(row.constant),
    priority: row.priority,
    orderIndex: row.orderIndex,
    position: row.position,
    rawJson: parseJson(row.rawJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapPresetPackage(row: any): PromptPresetPackage {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.sourceType,
    openAiSettings: parseJson(row.openAiSettingsJson),
    contextTemplate: parseJson(row.contextTemplateJson),
    instructTemplate: parseJson(row.instructTemplateJson),
    sysprompt: parseJson(row.syspromptJson),
    reasoningTemplate: parseJson(row.reasoningTemplateJson),
    rawJson: parseJson(row.rawJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapScriptBinding(row: any): RoomScriptBinding {
  return { roomId: row.roomId, scriptCardId: row.scriptCardId, bindingType: row.bindingType, enabled: Boolean(row.enabled), createdAt: row.createdAt };
}

function mapWorldBookBinding(row: any): RoomWorldBookBinding {
  return { roomId: row.roomId, worldBookId: row.worldBookId, enabled: Boolean(row.enabled), orderIndex: row.orderIndex, createdAt: row.createdAt };
}

function mapPresetBinding(row: any): RoomPresetBinding {
  return { roomId: row.roomId, presetPackageId: row.presetPackageId, enabled: Boolean(row.enabled), createdAt: row.createdAt };
}

export function saveImportedWorldBook(db: AppDatabase, parsed: ParsedWorldBook, sourceType: 'sillytavern_world_book' | 'sillytavern_character' = 'sillytavern_world_book'): { worldBook: ResourceWorldBook; entries: ResourceWorldBookEntry[]; warnings: string[] } {
  const id = nanoid();
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO resource_world_books (id, name, source_type, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, parsed.name, sourceType, JSON.stringify(parsed.rawJson), now, now);
    parsed.entries.forEach((entry, index) => {
      db.prepare('INSERT INTO resource_world_book_entries (id, world_book_id, title, keys_json, secondary_keys_json, content, enabled, constant, priority, order_index, position, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nanoid(), id, entry.title, JSON.stringify(entry.keys), JSON.stringify(entry.secondaryKeys), entry.content, entry.enabled ? 1 : 0, entry.constant ? 1 : 0, entry.priority, entry.orderIndex || index, entry.position, JSON.stringify(entry.rawJson), now, now);
    });
  });
  tx();
  return { worldBook: getResourceWorldBook(db, id)!, entries: getResourceWorldBookEntries(db, id), warnings: parsed.warnings };
}

export function saveImportedScriptCard(db: AppDatabase, parsed: ParsedCharacterCardImport): { scriptCard: ScriptCard; importedWorldBook: ResourceWorldBook | null; warnings: string[] } {
  const id = nanoid();
  const now = nowIso();
  db.prepare('INSERT INTO script_cards (id, name, description, personality, scenario, first_mes, mes_example, creator_notes, visibility_notes, source_type, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, parsed.script.name, parsed.script.description, parsed.script.personality, parsed.script.scenario, parsed.script.firstMes, parsed.script.mesExample, parsed.script.creatorNotes, parsed.script.visibilityNotes, 'sillytavern_character', JSON.stringify(parsed.script.rawJson), now, now);
  const embedded = parsed.embeddedWorldBook ? saveImportedWorldBook(db, parsed.embeddedWorldBook, 'sillytavern_character').worldBook : null;
  return { scriptCard: getScriptCard(db, id)!, importedWorldBook: embedded, warnings: parsed.warnings };
}

export function saveImportedPresetPackage(db: AppDatabase, parsed: ParsedPresetPackage): { presetPackage: PromptPresetPackage; warnings: string[] } {
  const id = nanoid();
  const now = nowIso();
  db.prepare('INSERT INTO prompt_preset_packages (id, name, source_type, openai_settings_json, context_template_json, instruct_template_json, sysprompt_json, reasoning_template_json, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, parsed.name, 'sillytavern_preset_package', JSON.stringify(parsed.openAiSettings), parsed.contextTemplate ? JSON.stringify(parsed.contextTemplate) : null, parsed.instructTemplate ? JSON.stringify(parsed.instructTemplate) : null, parsed.sysprompt ? JSON.stringify(parsed.sysprompt) : null, parsed.reasoningTemplate ? JSON.stringify(parsed.reasoningTemplate) : null, JSON.stringify(parsed.rawJson), now, now);
  return { presetPackage: getPresetPackage(db, id)!, warnings: parsed.warnings };
}

export function listScriptCards(db: AppDatabase): ScriptCard[] {
  return (db.prepare('SELECT id, name, description, personality, scenario, first_mes as firstMes, mes_example as mesExample, creator_notes as creatorNotes, visibility_notes as visibilityNotes, source_type as sourceType, raw_json as rawJson, created_at as createdAt, updated_at as updatedAt FROM script_cards ORDER BY updated_at DESC').all() as any[]).map(mapScriptCard);
}

export function getScriptCard(db: AppDatabase, id: string): ScriptCard | null {
  const row = db.prepare('SELECT id, name, description, personality, scenario, first_mes as firstMes, mes_example as mesExample, creator_notes as creatorNotes, visibility_notes as visibilityNotes, source_type as sourceType, raw_json as rawJson, created_at as createdAt, updated_at as updatedAt FROM script_cards WHERE id = ?').get(id) as any;
  return row ? mapScriptCard(row) : null;
}

export function listResourceWorldBooks(db: AppDatabase): ResourceWorldBook[] {
  return (db.prepare('SELECT id, name, source_type as sourceType, raw_json as rawJson, created_at as createdAt, updated_at as updatedAt FROM resource_world_books ORDER BY updated_at DESC').all() as any[]).map(mapWorldBook);
}

export function getResourceWorldBook(db: AppDatabase, id: string): ResourceWorldBook | null {
  const row = db.prepare('SELECT id, name, source_type as sourceType, raw_json as rawJson, created_at as createdAt, updated_at as updatedAt FROM resource_world_books WHERE id = ?').get(id) as any;
  return row ? mapWorldBook(row) : null;
}

export function getResourceWorldBookEntries(db: AppDatabase, worldBookId: string): ResourceWorldBookEntry[] {
  return (db.prepare('SELECT id, world_book_id as worldBookId, title, keys_json as keysJson, secondary_keys_json as secondaryKeysJson, content, enabled, constant, priority, order_index as orderIndex, position, raw_json as rawJson, created_at as createdAt, updated_at as updatedAt FROM resource_world_book_entries WHERE world_book_id = ? ORDER BY priority DESC, order_index ASC, created_at ASC').all(worldBookId) as any[]).map(mapWorldBookEntry);
}

export function listResourceWorldBookEntries(db: AppDatabase): ResourceWorldBookEntry[] {
  return (db.prepare('SELECT id, world_book_id as worldBookId, title, keys_json as keysJson, secondary_keys_json as secondaryKeysJson, content, enabled, constant, priority, order_index as orderIndex, position, raw_json as rawJson, created_at as createdAt, updated_at as updatedAt FROM resource_world_book_entries ORDER BY priority DESC, order_index ASC, created_at ASC').all() as any[]).map(mapWorldBookEntry);
}

export function listPresetPackages(db: AppDatabase): PromptPresetPackage[] {
  return (db.prepare('SELECT id, name, source_type as sourceType, openai_settings_json as openAiSettingsJson, context_template_json as contextTemplateJson, instruct_template_json as instructTemplateJson, sysprompt_json as syspromptJson, reasoning_template_json as reasoningTemplateJson, raw_json as rawJson, created_at as createdAt, updated_at as updatedAt FROM prompt_preset_packages ORDER BY updated_at DESC').all() as any[]).map(mapPresetPackage);
}

export function getPresetPackage(db: AppDatabase, id: string): PromptPresetPackage | null {
  const row = db.prepare('SELECT id, name, source_type as sourceType, openai_settings_json as openAiSettingsJson, context_template_json as contextTemplateJson, instruct_template_json as instructTemplateJson, sysprompt_json as syspromptJson, reasoning_template_json as reasoningTemplateJson, raw_json as rawJson, created_at as createdAt, updated_at as updatedAt FROM prompt_preset_packages WHERE id = ?').get(id) as any;
  return row ? mapPresetPackage(row) : null;
}

export function listResourceLibrary(db: AppDatabase): { scriptCards: ScriptCard[]; resourceWorldBooks: ResourceWorldBook[]; resourceWorldBookEntries: ResourceWorldBookEntry[]; presetPackages: PromptPresetPackage[] } {
  return { scriptCards: listScriptCards(db), resourceWorldBooks: listResourceWorldBooks(db), resourceWorldBookEntries: listResourceWorldBookEntries(db), presetPackages: listPresetPackages(db) };
}

export function bindRoomScriptCard(db: AppDatabase, roomId: string, scriptCardId: string): RoomScriptBinding {
  const now = nowIso();
  db.prepare('INSERT INTO room_script_bindings (room_id, script_card_id, binding_type, enabled, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET script_card_id = excluded.script_card_id, binding_type = excluded.binding_type, enabled = excluded.enabled')
    .run(roomId, scriptCardId, 'main', 1, now);
  return getRoomResourceBindings(db, roomId).scriptBinding!;
}

export function unbindRoomScriptCard(db: AppDatabase, roomId: string): void {
  db.prepare('DELETE FROM room_script_bindings WHERE room_id = ?').run(roomId);
}

export function replaceRoomWorldBookBindings(db: AppDatabase, roomId: string, bindings: Array<{ worldBookId: string; enabled: boolean; orderIndex: number }>): RoomWorldBookBinding[] {
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM room_world_book_bindings WHERE room_id = ?').run(roomId);
    for (const binding of bindings) {
      db.prepare('INSERT INTO room_world_book_bindings (room_id, world_book_id, enabled, order_index, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(roomId, binding.worldBookId, binding.enabled ? 1 : 0, binding.orderIndex, now);
    }
  });
  tx();
  return getRoomResourceBindings(db, roomId).worldBookBindings;
}

export function bindRoomPresetPackage(db: AppDatabase, roomId: string, presetPackageId: string): RoomPresetBinding {
  const now = nowIso();
  db.prepare('INSERT INTO room_preset_bindings (room_id, preset_package_id, enabled, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET preset_package_id = excluded.preset_package_id, enabled = excluded.enabled')
    .run(roomId, presetPackageId, 1, now);
  return getRoomResourceBindings(db, roomId).presetBinding!;
}

export function unbindRoomPresetPackage(db: AppDatabase, roomId: string): void {
  db.prepare('DELETE FROM room_preset_bindings WHERE room_id = ?').run(roomId);
}

export function getRoomResourceBindings(db: AppDatabase, roomId: string): { scriptBinding: RoomScriptBinding | null; worldBookBindings: RoomWorldBookBinding[]; presetBinding: RoomPresetBinding | null } {
  const scriptRow = db.prepare('SELECT room_id as roomId, script_card_id as scriptCardId, binding_type as bindingType, enabled, created_at as createdAt FROM room_script_bindings WHERE room_id = ?').get(roomId) as any;
  const worldRows = db.prepare('SELECT room_id as roomId, world_book_id as worldBookId, enabled, order_index as orderIndex, created_at as createdAt FROM room_world_book_bindings WHERE room_id = ? ORDER BY order_index ASC').all(roomId) as any[];
  const presetRow = db.prepare('SELECT room_id as roomId, preset_package_id as presetPackageId, enabled, created_at as createdAt FROM room_preset_bindings WHERE room_id = ?').get(roomId) as any;
  return {
    scriptBinding: scriptRow ? mapScriptBinding(scriptRow) : null,
    worldBookBindings: worldRows.map(mapWorldBookBinding),
    presetBinding: presetRow ? mapPresetBinding(presetRow) : null
  };
}
```

- [ ] **Step 4: Verify repository tests pass**

Run:

```bash
rtk npm test -- server/src/tests/resourceLibrary.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run all server tests touched so far**

Run:

```bash
rtk npm test -- server/src/tests/resourceLibrary.test.ts server/src/tests/sillyTavernImport.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit checkpoint if authorized**

Run only with explicit commit authorization:

```bash
rtk git add server/src/services/resourceLibrary.ts server/src/tests/resourceLibrary.test.ts && rtk git commit -m "feat: persist imported resource library"
```

Expected: commit succeeds.

---

### Task 4: Add admin resource API and room binding API

**Files:**
- Create: `server/src/routes/adminResourceRoutes.ts`
- Modify: `server/src/routes/adminRoutes.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/tests/integration.test.ts`

- [ ] **Step 1: Write integration tests for import and binding endpoints**

Append this test to `server/src/tests/integration.test.ts` inside `describe('DND AI-DM integration', () => { ... })`:

```ts
  it('imports ST resources through admin API and binds them to a room', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Import Room', worldInfo: 'A gate near Candlekeep.', systemPrompt: 'Fair DM' })
      });
      const room = await roomRes.json() as { roomId: string };

      const scriptRes = await fetch(`${base}/api/admin/resources/script-cards/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ characterCard: { data: { name: 'Gate Script', description: 'Gate background', scenario: 'The gate is sealed.' } } })
      });
      expect(scriptRes.status).toBe(200);
      const scriptPayload = await scriptRes.json() as { scriptCard: { id: string; name: string } };
      expect(scriptPayload.scriptCard.name).toBe('Gate Script');

      const worldBookRes = await fetch(`${base}/api/admin/resources/world-books/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worldBook: { name: 'Gate Lore', entries: [{ name: 'Candlekeep Gate', keys: ['Candlekeep'], content: 'The gate needs a silver key.', enabled: true, order: 150 }] } })
      });
      expect(worldBookRes.status).toBe(200);
      const worldBookPayload = await worldBookRes.json() as { worldBook: { id: string; name: string } };

      const presetRes = await fetch(`${base}/api/admin/resources/preset-packages/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ openAiSettings: { name: 'DND ST Preset', prompts: [{ identifier: 'main', role: 'system', content: 'Imported main prompt.' }], prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }] } })
      });
      expect(presetRes.status).toBe(200);
      const presetPayload = await presetRes.json() as { presetPackage: { id: string; name: string } };

      const scriptBindRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/resource-bindings/script`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scriptCardId: scriptPayload.scriptCard.id })
      });
      expect(scriptBindRes.status).toBe(200);

      const worldBindRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/resource-bindings/world-books`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bindings: [{ worldBookId: worldBookPayload.worldBook.id, enabled: true, orderIndex: 0 }] })
      });
      expect(worldBindRes.status).toBe(200);

      const presetBindRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/resource-bindings/preset-package`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetPackageId: presetPayload.presetPackage.id })
      });
      expect(presetBindRes.status).toBe(200);

      const adminRes = await fetch(`${base}/api/admin/rooms/${room.roomId}`);
      const adminState = await adminRes.json() as { scriptCards: unknown[]; resourceWorldBooks: unknown[]; presetPackages: unknown[]; roomScriptBinding: { scriptCardId: string }; roomWorldBookBindings: unknown[]; roomPresetBinding: { presetPackageId: string } };
      expect(adminState.scriptCards).toHaveLength(1);
      expect(adminState.resourceWorldBooks).toHaveLength(1);
      expect(adminState.presetPackages).toHaveLength(1);
      expect(adminState.roomScriptBinding.scriptCardId).toBe(scriptPayload.scriptCard.id);
      expect(adminState.roomWorldBookBindings).toHaveLength(1);
      expect(adminState.roomPresetBinding.presetPackageId).toBe(presetPayload.presetPackage.id);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [ ] **Step 2: Run the failing integration test**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts
```

Expected: FAIL because resource endpoints are not registered.

- [ ] **Step 3: Create the resource route registrar**

Create `server/src/routes/adminResourceRoutes.ts` with:

```ts
import type { Router } from 'express';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import { parseSillyTavernCharacterCard, parseSillyTavernPresetPackage, parseSillyTavernWorldBook } from '../services/sillyTavernImport.js';
import { bindRoomPresetPackage, bindRoomScriptCard, getPresetPackage, getResourceWorldBook, getResourceWorldBookEntries, getRoomResourceBindings, getScriptCard, listResourceLibrary, replaceRoomWorldBookBindings, saveImportedPresetPackage, saveImportedScriptCard, saveImportedWorldBook, unbindRoomPresetPackage, unbindRoomScriptCard } from '../services/resourceLibrary.js';

const scriptImportSchema = z.object({ characterCard: z.unknown() });
const worldBookImportSchema = z.object({ worldBook: z.unknown(), fallbackName: z.string().optional() });
const presetPackageImportSchema = z.object({
  openAiSettings: z.unknown(),
  contextTemplate: z.unknown().optional(),
  instructTemplate: z.unknown().optional(),
  sysprompt: z.unknown().optional(),
  reasoningTemplate: z.unknown().optional()
});
const scriptBindingSchema = z.object({ scriptCardId: z.string().min(1) });
const worldBookBindingsSchema = z.object({ bindings: z.array(z.object({ worldBookId: z.string().min(1), enabled: z.boolean(), orderIndex: z.number().int() })) });
const presetBindingSchema = z.object({ presetPackageId: z.string().min(1) });

function requireRoom(db: AppDatabase, roomId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId));
}

export function registerAdminResourceRoutes(router: Router, db: AppDatabase): void {
  router.get('/resources/script-cards', (_req, res) => {
    res.json({ scriptCards: listResourceLibrary(db).scriptCards });
  });

  router.post('/resources/script-cards/import/sillytavern', (req, res) => {
    const input = scriptImportSchema.parse(req.body);
    const parsed = parseSillyTavernCharacterCard(input.characterCard);
    const result = saveImportedScriptCard(db, parsed);
    res.json(result);
  });

  router.get('/resources/script-cards/:scriptCardId', (req, res) => {
    const scriptCard = getScriptCard(db, req.params.scriptCardId);
    if (!scriptCard) return res.status(404).json({ error: 'Script card not found' });
    res.json({ scriptCard });
  });

  router.delete('/resources/script-cards/:scriptCardId', (req, res) => {
    db.prepare('DELETE FROM script_cards WHERE id = ?').run(req.params.scriptCardId);
    res.json({ ok: true });
  });

  router.get('/resources/world-books', (_req, res) => {
    const library = listResourceLibrary(db);
    res.json({ worldBooks: library.resourceWorldBooks, entries: library.resourceWorldBookEntries });
  });

  router.post('/resources/world-books/import/sillytavern', (req, res) => {
    const input = worldBookImportSchema.parse(req.body);
    const parsed = parseSillyTavernWorldBook(input.worldBook, input.fallbackName ?? 'Imported World Book');
    const result = saveImportedWorldBook(db, parsed);
    res.json(result);
  });

  router.get('/resources/world-books/:worldBookId', (req, res) => {
    const worldBook = getResourceWorldBook(db, req.params.worldBookId);
    if (!worldBook) return res.status(404).json({ error: 'World book not found' });
    res.json({ worldBook, entries: getResourceWorldBookEntries(db, req.params.worldBookId) });
  });

  router.get('/resources/world-books/:worldBookId/entries', (req, res) => {
    if (!getResourceWorldBook(db, req.params.worldBookId)) return res.status(404).json({ error: 'World book not found' });
    res.json({ entries: getResourceWorldBookEntries(db, req.params.worldBookId) });
  });

  router.delete('/resources/world-books/:worldBookId', (req, res) => {
    db.prepare('DELETE FROM resource_world_books WHERE id = ?').run(req.params.worldBookId);
    res.json({ ok: true });
  });

  router.get('/resources/preset-packages', (_req, res) => {
    res.json({ presetPackages: listResourceLibrary(db).presetPackages });
  });

  router.post('/resources/preset-packages/import/sillytavern', (req, res) => {
    const input = presetPackageImportSchema.parse(req.body);
    const parsed = parseSillyTavernPresetPackage(input);
    const result = saveImportedPresetPackage(db, parsed);
    res.json(result);
  });

  router.get('/resources/preset-packages/:presetPackageId', (req, res) => {
    const presetPackage = getPresetPackage(db, req.params.presetPackageId);
    if (!presetPackage) return res.status(404).json({ error: 'Preset package not found' });
    res.json({ presetPackage });
  });

  router.delete('/resources/preset-packages/:presetPackageId', (req, res) => {
    db.prepare('DELETE FROM prompt_preset_packages WHERE id = ?').run(req.params.presetPackageId);
    res.json({ ok: true });
  });

  router.get('/rooms/:roomId/resource-bindings/script', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    res.json({ binding: getRoomResourceBindings(db, req.params.roomId).scriptBinding });
  });

  router.put('/rooms/:roomId/resource-bindings/script', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    const input = scriptBindingSchema.parse(req.body);
    if (!getScriptCard(db, input.scriptCardId)) return res.status(404).json({ error: 'Script card not found' });
    res.json({ binding: bindRoomScriptCard(db, req.params.roomId, input.scriptCardId) });
  });

  router.delete('/rooms/:roomId/resource-bindings/script', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    unbindRoomScriptCard(db, req.params.roomId);
    res.json({ ok: true });
  });

  router.get('/rooms/:roomId/resource-bindings/world-books', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    res.json({ bindings: getRoomResourceBindings(db, req.params.roomId).worldBookBindings });
  });

  router.put('/rooms/:roomId/resource-bindings/world-books', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    const input = worldBookBindingsSchema.parse(req.body);
    for (const binding of input.bindings) {
      if (!getResourceWorldBook(db, binding.worldBookId)) return res.status(404).json({ error: `World book not found: ${binding.worldBookId}` });
    }
    res.json({ bindings: replaceRoomWorldBookBindings(db, req.params.roomId, input.bindings) });
  });

  router.get('/rooms/:roomId/resource-bindings/preset-package', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    res.json({ binding: getRoomResourceBindings(db, req.params.roomId).presetBinding });
  });

  router.put('/rooms/:roomId/resource-bindings/preset-package', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    const input = presetBindingSchema.parse(req.body);
    if (!getPresetPackage(db, input.presetPackageId)) return res.status(404).json({ error: 'Preset package not found' });
    res.json({ binding: bindRoomPresetPackage(db, req.params.roomId, input.presetPackageId) });
  });

  router.delete('/rooms/:roomId/resource-bindings/preset-package', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    unbindRoomPresetPackage(db, req.params.roomId);
    res.json({ ok: true });
  });
}
```

- [ ] **Step 4: Register resource routes in admin router**

In `server/src/routes/adminRoutes.ts`, add this import:

```ts
import { registerAdminResourceRoutes } from './adminResourceRoutes.js';
import { getRoomResourceBindings, listResourceLibrary } from '../services/resourceLibrary.js';
```

Inside `createAdminRouter`, immediately after `const router = Router();`, add:

```ts
  registerAdminResourceRoutes(router, db);
```

In the existing `router.get('/rooms/:roomId', ...)` handler, before `res.json(...)`, add:

```ts
    const resourceLibrary = listResourceLibrary(db);
    const resourceBindings = getRoomResourceBindings(db, req.params.roomId);
```

Replace the existing `res.json({ room, players, turns, actions, interactions, logs, aiGenerations, presets, worldBooks, worldBookEntries });` with:

```ts
    res.json({
      room,
      players,
      turns,
      actions,
      interactions,
      logs,
      aiGenerations,
      presets,
      worldBooks,
      worldBookEntries,
      scriptCards: resourceLibrary.scriptCards,
      resourceWorldBooks: resourceLibrary.resourceWorldBooks,
      resourceWorldBookEntries: resourceLibrary.resourceWorldBookEntries,
      presetPackages: resourceLibrary.presetPackages,
      roomScriptBinding: resourceBindings.scriptBinding,
      roomWorldBookBindings: resourceBindings.worldBookBindings,
      roomPresetBinding: resourceBindings.presetBinding
    });
```

- [ ] **Step 5: Increase JSON body limit**

In `server/src/app.ts`, replace:

```ts
  app.use(express.json({ limit: '2mb' }));
```

with:

```ts
  app.use(express.json({ limit: '10mb' }));
```

- [ ] **Step 6: Verify integration tests pass**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run server typecheck**

Run:

```bash
rtk npm run typecheck --workspace server
```

Expected: PASS.

- [ ] **Step 8: Commit checkpoint if authorized**

Run only with explicit commit authorization:

```bash
rtk git add server/src/routes/adminResourceRoutes.ts server/src/routes/adminRoutes.ts server/src/app.ts server/src/tests/integration.test.ts && rtk git commit -m "feat: add imported resource admin api"
```

Expected: commit succeeds.

---

### Task 5: Build ST-compatible prompt preview data

**Files:**
- Create: `server/src/services/sillyTavernPromptBuilder.ts`
- Modify: `server/src/services/aiContextBuilder.ts`
- Modify: `server/src/services/worldBookService.ts`
- Create: `server/src/tests/sillyTavernPromptBuilder.test.ts`

- [ ] **Step 1: Write prompt builder tests**

Create `server/src/tests/sillyTavernPromptBuilder.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { defaultAiConfig } from '../services/aiContextBuilder.js';
import { buildSillyTavernPromptPreview } from '../services/sillyTavernPromptBuilder.js';
import type { Player, PlayerAction, PromptPresetPackage, ResourceWorldBookEntry, Room, ScriptCard } from '../domain/types.js';

const room: Room = {
  id: 'room-1',
  name: 'ST Prompt Room',
  systemPrompt: 'Fair DM',
  worldInfo: 'A Candlekeep gate.',
  currentTurn: 1,
  status: 'processing',
  aiConfig: defaultAiConfig,
  createdAt: '2026-05-28T00:00:00.000Z'
};

const scriptCard: ScriptCard = {
  id: 'script-1',
  name: 'Gate Script',
  description: 'A sealed gate under moonlight.',
  personality: 'NPCs speak carefully.',
  scenario: 'The party stands before the Candlekeep gate.',
  firstMes: 'The gate waits.',
  mesExample: 'DM: The hinges do not move.',
  creatorNotes: 'The bell clue is hidden.',
  visibilityNotes: '',
  sourceType: 'sillytavern_character',
  rawJson: {},
  createdAt: room.createdAt,
  updatedAt: room.createdAt
};

const presetPackage: PromptPresetPackage = {
  id: 'preset-1',
  name: 'ST Preset',
  sourceType: 'sillytavern_preset_package',
  openAiSettings: {
    name: 'ST Preset',
    prompts: [
      { identifier: 'main', role: 'system', content: 'Imported main prompt.' },
      { identifier: 'charDescription', role: 'system', marker: true, content: '' },
      { identifier: 'worldInfoBefore', role: 'system', marker: true, content: '' },
      { identifier: 'scenario', role: 'system', marker: true, content: '' },
      { identifier: 'chatHistory', role: 'user', marker: true, content: '' }
    ],
    prompt_order: [{ order: [
      { identifier: 'main', enabled: true },
      { identifier: 'charDescription', enabled: true },
      { identifier: 'worldInfoBefore', enabled: true },
      { identifier: 'scenario', enabled: true },
      { identifier: 'chatHistory', enabled: true }
    ] }]
  },
  contextTemplate: null,
  instructTemplate: null,
  sysprompt: { name: 'DND Dungeon Master', content: '中文 DM 系统提示。' },
  reasoningTemplate: null,
  rawJson: {},
  createdAt: room.createdAt,
  updatedAt: room.createdAt
};

const players: Player[] = [
  { id: 'player-1', roomId: 'room-1', name: 'Ari', token: 'token', isConnected: false, createdAt: room.createdAt }
];

const actions: PlayerAction[] = [
  { id: 'action-1', roomId: 'room-1', turnId: 'turn-1', playerId: 'player-1', text: 'I inspect Candlekeep.', submittedAt: room.createdAt, status: 'submitted' }
];

const worldBookEntries: ResourceWorldBookEntry[] = [
  { id: 'entry-1', worldBookId: 'book-1', title: 'Candlekeep Gate', keys: ['Candlekeep'], secondaryKeys: [], content: 'The gate responds to silver keys.', enabled: true, constant: false, priority: 100, orderIndex: 0, position: 'before', rawJson: {}, createdAt: room.createdAt, updatedAt: room.createdAt }
];

describe('buildSillyTavernPromptPreview', () => {
  it('renders ST prompt order with runtime slots and final DND contract', () => {
    const preview = buildSillyTavernPromptPreview({
      room,
      players,
      publicLogs: [],
      actions,
      interactions: [],
      scriptCard,
      presetPackage,
      worldBookEntries
    });

    expect(preview.mode).toBe('sillytavern-compatible');
    expect(preview.prompt).toContain('Imported main prompt.');
    expect(preview.prompt).toContain('中文 DM 系统提示。');
    expect(preview.prompt).toContain('A sealed gate under moonlight.');
    expect(preview.prompt).toContain('The gate responds to silver keys.');
    expect(preview.prompt).toContain('The party stands before the Candlekeep gate.');
    expect(preview.prompt).toContain('Ari: I inspect Candlekeep.');
    expect(preview.prompt).toContain(defaultAiConfig.outputFormatRules);
    expect(preview.prompt.indexOf('Imported main prompt.')).toBeLessThan(preview.prompt.indexOf('A sealed gate under moonlight.'));
    expect(preview.prompt.indexOf('Ari: I inspect Candlekeep.')).toBeLessThan(preview.prompt.indexOf(defaultAiConfig.outputFormatRules));
    expect(preview.worldBookMatches[0]).toMatchObject({ worldBookId: 'book-1', entryId: 'entry-1', reason: 'primary-key', position: 'before' });
  });
});
```

- [ ] **Step 2: Run the failing prompt builder test**

Run:

```bash
rtk npm test -- server/src/tests/sillyTavernPromptBuilder.test.ts
```

Expected: FAIL because `sillyTavernPromptBuilder.ts` does not exist.

- [ ] **Step 3: Expose DND output contract helper**

In `server/src/services/aiContextBuilder.ts`, after `parseAiConfigJson`, add:

```ts
export function renderDndOutputContract(aiConfig: AiConfig): string {
  const normalized = normalizeAiConfig(aiConfig);
  return [
    '# DND 输出契约',
    normalized.playerAgencyRules,
    normalized.visibilityRules,
    normalized.interactionRules,
    normalized.outputFormatRules
  ].join('\n');
}
```

- [ ] **Step 4: Add imported world-book matching helpers**

In `server/src/services/worldBookService.ts`, update the import line to include imported types:

```ts
import type { LogEntry, Player, PlayerAction, ResourceWorldBookEntry, ResourceWorldBookMatch, WorldBookEntry, WorldBookMatch } from '../domain/types.js';
```

After `matchWorldBookEntries`, add:

```ts
export function matchResourceWorldBookEntries(entries: ResourceWorldBookEntry[], scanText: string): ResourceWorldBookMatch[] {
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) => {
      if (entry.constant) return { entry, matchedKeys: ['常驻'], reason: 'constant' as const };
      const primaryKey = includesAnyKeyword(scanText, entry.keys);
      if (!primaryKey) return null;
      if (entry.secondaryKeys.length > 0) {
        const secondaryKey = includesAnyKeyword(scanText, entry.secondaryKeys);
        if (!secondaryKey) return null;
        return { entry, matchedKeys: [primaryKey, secondaryKey], reason: 'primary-and-secondary-key' as const };
      }
      return { entry, matchedKeys: [primaryKey], reason: 'primary-key' as const };
    })
    .filter((match): match is ResourceWorldBookMatch => Boolean(match))
    .sort((left, right) => right.entry.priority - left.entry.priority || left.entry.orderIndex - right.entry.orderIndex || left.entry.title.localeCompare(right.entry.title));
}

export function renderResourceWorldBookMatches(matches: ResourceWorldBookMatch[], position: 'before' | 'after'): string {
  const positioned = matches.filter((match) => match.entry.position === position);
  if (positioned.length === 0) return '';
  return positioned.map((match) => `## ${match.entry.title}\n触发：${match.matchedKeys.join(', ')}\n${match.entry.content}`).join('\n\n');
}
```

- [ ] **Step 5: Create ST prompt builder implementation**

Create `server/src/services/sillyTavernPromptBuilder.ts` with:

```ts
import type { InteractionRequest, LogEntry, Player, PlayerAction, PromptPreviewBlock, PromptPreviewResponse, PromptPresetPackage, ResourceWorldBookEntry, Room, ScriptCard } from '../domain/types.js';
import { renderDndOutputContract, summarizeActionsInSubmissionOrder } from './aiContextBuilder.js';
import { buildWorldBookScanText, matchResourceWorldBookEntries, renderResourceWorldBookMatches } from './worldBookService.js';

interface BuildSillyTavernPromptPreviewInput {
  room: Room;
  players: Player[];
  publicLogs: LogEntry[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
  scriptCard: ScriptCard | null;
  presetPackage: PromptPresetPackage;
  worldBookEntries: ResourceWorldBookEntry[];
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function role(value: unknown): 'system' | 'user' | 'assistant' {
  return value === 'user' || value === 'assistant' ? value : 'system';
}

function promptIdentifier(prompt: RecordValue): string {
  return text(prompt.identifier) || text(prompt.name);
}

function getPrompts(openAiSettings: unknown): RecordValue[] {
  if (!isRecord(openAiSettings)) return [];
  return Array.isArray(openAiSettings.prompts) ? openAiSettings.prompts.filter(isRecord) : [];
}

function getPromptOrder(openAiSettings: unknown, prompts: RecordValue[]): string[] {
  if (!isRecord(openAiSettings) || !Array.isArray(openAiSettings.prompt_order)) return prompts.map(promptIdentifier).filter(Boolean);
  const first = openAiSettings.prompt_order.find(isRecord);
  if (!first || !Array.isArray(first.order)) return prompts.map(promptIdentifier).filter(Boolean);
  return first.order
    .filter(isRecord)
    .filter((item) => item.enabled !== false)
    .map((item) => text(item.identifier))
    .filter(Boolean);
}

function renderLogs(logs: LogEntry[]): string {
  return logs.map((log) => `- ${log.title}: ${log.content}`).join('\n') || '- No public log yet.';
}

function renderInteractions(interactions: InteractionRequest[]): string {
  return interactions.map((interaction) => `- ${interaction.prompt}`).join('\n') || '- None.';
}

function renderSysprompt(presetPackage: PromptPresetPackage): string {
  if (!isRecord(presetPackage.sysprompt)) return '';
  return text(presetPackage.sysprompt.content);
}

export function buildSillyTavernPromptPreview(input: BuildSillyTavernPromptPreviewInput): PromptPreviewResponse {
  const scanText = buildWorldBookScanText({ roomWorldInfo: input.room.worldInfo, publicLogs: input.publicLogs, actions: input.actions, players: input.players });
  const matches = matchResourceWorldBookEntries(input.worldBookEntries, [scanText, input.scriptCard?.description ?? '', input.scriptCard?.scenario ?? ''].join('\n\n'));
  const dndContract = renderDndOutputContract(input.room.aiConfig);
  const slots = new Map<string, { source: string; content: string }>([
    ['main', { source: 'st-preset/sysprompt', content: renderSysprompt(input.presetPackage) }],
    ['worldInfoBefore', { source: 'resource-world-books', content: renderResourceWorldBookMatches(matches, 'before') }],
    ['worldInfoAfter', { source: 'resource-world-books', content: renderResourceWorldBookMatches(matches, 'after') }],
    ['charDescription', { source: 'script-card.description', content: input.scriptCard?.description ?? '' }],
    ['charPersonality', { source: 'script-card.personality', content: input.scriptCard?.personality ?? '' }],
    ['scenario', { source: 'script-card.scenario', content: input.scriptCard?.scenario ?? '' }],
    ['dialogueExamples', { source: 'script-card.mes_example', content: input.scriptCard?.mesExample ?? '' }],
    ['chatHistory', { source: 'dnd-public-log', content: renderLogs(input.publicLogs) }],
    ['dndTurnState', { source: 'dnd-runtime', content: `Room: ${input.room.name}\nTurn: ${input.room.currentTurn}\nStatus: ${input.room.status}` }],
    ['dndPlayerActions', { source: 'dnd-runtime', content: summarizeActionsInSubmissionOrder(input.actions, input.players) || '- No submitted actions yet.' }],
    ['dndPendingInteractions', { source: 'dnd-runtime', content: renderInteractions(input.interactions) }],
    ['dndOutputContract', { source: 'dnd-contract', content: dndContract }]
  ]);

  const prompts = getPrompts(input.presetPackage.openAiSettings);
  const promptByIdentifier = new Map(prompts.map((prompt) => [promptIdentifier(prompt), prompt]));
  const identifiers = getPromptOrder(input.presetPackage.openAiSettings, prompts);
  const blocks: PromptPreviewBlock[] = [];

  for (const identifier of identifiers) {
    const prompt = promptByIdentifier.get(identifier);
    const slot = slots.get(identifier);
    const promptContent = prompt ? text(prompt.content) : '';
    const mergedMain = identifier === 'main' ? [promptContent, slot?.content ?? ''].filter(Boolean).join('\n\n') : '';
    const content = mergedMain || slot?.content || promptContent;
    if (!content.trim()) continue;
    blocks.push({
      identifier,
      source: slot ? 'runtime-slot' : 'st-preset',
      role: role(prompt?.role),
      content
    });
  }

  for (const [identifier, slot] of slots) {
    if (['main', 'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'dialogueExamples', 'chatHistory'].includes(identifier)) continue;
    if (!slot.content.trim()) continue;
    blocks.push({ identifier, source: identifier === 'dndOutputContract' ? 'dnd-contract' : 'runtime-slot', role: identifier === 'dndPlayerActions' ? 'user' : 'system', content: slot.content });
  }

  const hasContract = blocks.some((block) => block.identifier === 'dndOutputContract');
  if (!hasContract) blocks.push({ identifier: 'dndOutputContract', source: 'dnd-contract', role: 'system', content: dndContract });

  const messages = blocks.map((block) => ({ role: block.role, content: block.content }));
  const prompt = blocks.map((block) => `# ${block.identifier}\n${block.content}`).join('\n\n');

  return {
    mode: 'sillytavern-compatible',
    prompt,
    messages,
    slots: Array.from(slots.entries()).map(([key, slot]) => ({ key, source: slot.source, content: slot.content })),
    worldBookMatches: matches.map((match) => ({ worldBookId: match.entry.worldBookId, entryId: match.entry.id, keys: match.matchedKeys, reason: match.reason, position: match.entry.position, content: match.entry.content })),
    promptBlocks: blocks,
    warnings: []
  };
}
```

- [ ] **Step 6: Verify prompt builder tests pass**

Run:

```bash
rtk npm test -- server/src/tests/sillyTavernPromptBuilder.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run server typecheck**

Run:

```bash
rtk npm run typecheck --workspace server
```

Expected: PASS.

- [ ] **Step 8: Commit checkpoint if authorized**

Run only with explicit commit authorization:

```bash
rtk git add server/src/services/sillyTavernPromptBuilder.ts server/src/services/aiContextBuilder.ts server/src/services/worldBookService.ts server/src/tests/sillyTavernPromptBuilder.test.ts && rtk git commit -m "feat: build sillytavern compatible prompts"
```

Expected: commit succeeds.

---

### Task 6: Use ST-compatible prompt mode in preview and turn processing

**Files:**
- Modify: `server/src/routes/adminRoutes.ts`
- Modify: `server/src/services/turnEngine.ts`
- Modify: `server/src/tests/integration.test.ts`

- [ ] **Step 1: Add integration test for ST-compatible prompt preview**

Append this test to `server/src/tests/integration.test.ts`:

```ts
  it('returns structured ST-compatible prompt preview when a preset package is bound', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Preview Room', worldInfo: 'A Candlekeep gate.', systemPrompt: 'Fair DM' })
      });
      const room = await roomRes.json() as { roomId: string };

      const script = await (await fetch(`${base}/api/admin/resources/script-cards/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ characterCard: { data: { name: 'Preview Script', description: 'Script description', scenario: 'Script scenario' } } })
      })).json() as { scriptCard: { id: string } };

      const world = await (await fetch(`${base}/api/admin/resources/world-books/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worldBook: { name: 'Preview Lore', entries: [{ name: 'Candlekeep Lore', keys: ['Candlekeep'], content: 'Matched lore content.', enabled: true, position: 'before' }] } })
      })).json() as { worldBook: { id: string } };

      const preset = await (await fetch(`${base}/api/admin/resources/preset-packages/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ openAiSettings: { name: 'Preview Preset', prompts: [{ identifier: 'main', role: 'system', content: 'Imported main.' }, { identifier: 'charDescription', role: 'system', content: '' }, { identifier: 'worldInfoBefore', role: 'system', content: '' }, { identifier: 'scenario', role: 'system', content: '' }], prompt_order: [{ order: [{ identifier: 'main', enabled: true }, { identifier: 'charDescription', enabled: true }, { identifier: 'worldInfoBefore', enabled: true }, { identifier: 'scenario', enabled: true }] }] } })
      })).json() as { presetPackage: { id: string } };

      await fetch(`${base}/api/admin/rooms/${room.roomId}/resource-bindings/script`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scriptCardId: script.scriptCard.id }) });
      await fetch(`${base}/api/admin/rooms/${room.roomId}/resource-bindings/world-books`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bindings: [{ worldBookId: world.worldBook.id, enabled: true, orderIndex: 0 }] }) });
      await fetch(`${base}/api/admin/rooms/${room.roomId}/resource-bindings/preset-package`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ presetPackageId: preset.presetPackage.id }) });

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      const preview = await previewRes.json() as { mode: string; prompt: string; slots: unknown[]; worldBookMatches: unknown[]; promptBlocks: unknown[] };
      expect(preview.mode).toBe('sillytavern-compatible');
      expect(preview.prompt).toContain('Imported main.');
      expect(preview.prompt).toContain('Script description');
      expect(preview.prompt).toContain('Matched lore content.');
      expect(preview.prompt).toContain('Script scenario');
      expect(preview.slots.length).toBeGreaterThan(0);
      expect(preview.worldBookMatches.length).toBe(1);
      expect(preview.promptBlocks.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [ ] **Step 2: Run the failing preview integration test**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts
```

Expected: FAIL because preview still returns `{ prompt }` without ST-compatible mode.

- [ ] **Step 3: Allow turn engine to use a prebuilt prompt**

In `server/src/services/turnEngine.ts`, add this optional field to `ProcessTurnActionsInput`:

```ts
  promptOverride?: string;
```

Replace the `const prompt = buildTurnPrompt({ ... });` block in `processTurnActions` with:

```ts
  const prompt = input.promptOverride ?? buildTurnPrompt({
    room: input.room,
    players: input.players,
    publicLogs: input.publicLogs,
    actions: orderedActions,
    interactions: input.interactions,
    aiConfig: input.aiConfig,
    promptBlocks: input.promptBlocks,
    worldBookMatches: input.worldBookMatches
  });
```

- [ ] **Step 4: Add prompt-mode helpers to admin routes**

In `server/src/routes/adminRoutes.ts`, extend imports from `resourceLibrary`:

```ts
import { getPresetPackage, getResourceWorldBookEntries, getRoomResourceBindings, getScriptCard, listResourceLibrary } from '../services/resourceLibrary.js';
```

Add this import:

```ts
import { buildSillyTavernPromptPreview } from '../services/sillyTavernPromptBuilder.js';
```

Replace the current `function buildPromptPreview(db: AppDatabase, room: Room): string { ... }` with:

```ts
function buildNativePromptPreview(db: AppDatabase, room: Room) {
  const turn = db.prepare('SELECT id, room_id as roomId, number, status, started_at as startedAt, ended_at as endedAt FROM turns WHERE room_id = ? AND number = ?').get(room.id, room.currentTurn) as any;
  const players = db.prepare('SELECT id, room_id as roomId, name, token, is_connected as isConnected, created_at as createdAt FROM players WHERE room_id = ? ORDER BY created_at ASC').all(room.id) as any[];
  const actions = turn ? db.prepare('SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text, submitted_at as submittedAt, status FROM actions WHERE turn_id = ? ORDER BY submitted_at ASC').all(turn.id) as any[] : [];
  const publicLogs = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at ASC').all(room.id, 'public') as any[];
  const interactions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, source_player_id as sourcePlayerId, target_player_id as targetPlayerId, type, prompt, target_response as targetResponse, status, created_at as createdAt FROM interaction_requests WHERE room_id = ? AND status != ? ORDER BY created_at ASC').all(room.id, 'resolved') as any[];
  const scanText = buildWorldBookScanText({ roomWorldInfo: room.worldInfo, publicLogs, actions, players });
  const worldBookMatches = matchWorldBookEntries(getWorldBookEntries(db, room.id), scanText);
  const prompt = buildTurnPrompt({ room, players, publicLogs, actions, interactions, aiConfig: room.aiConfig, promptBlocks: getActivePromptBlocks(db, room.id), worldBookMatches });
  return { mode: 'native' as const, prompt, messages: [{ role: 'user' as const, content: prompt }], slots: [], worldBookMatches: [], promptBlocks: [], warnings: [] };
}

function getBoundResourceWorldBookEntries(db: AppDatabase, roomId: string) {
  const bindings = getRoomResourceBindings(db, roomId).worldBookBindings.filter((binding) => binding.enabled).sort((left, right) => left.orderIndex - right.orderIndex);
  return bindings.flatMap((binding) => getResourceWorldBookEntries(db, binding.worldBookId));
}

function buildRoomPromptPreview(db: AppDatabase, room: Room) {
  const turn = db.prepare('SELECT id, room_id as roomId, number, status, started_at as startedAt, ended_at as endedAt FROM turns WHERE room_id = ? AND number = ?').get(room.id, room.currentTurn) as any;
  const players = db.prepare('SELECT id, room_id as roomId, name, token, is_connected as isConnected, created_at as createdAt FROM players WHERE room_id = ? ORDER BY created_at ASC').all(room.id) as any[];
  const actions = turn ? db.prepare('SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text, submitted_at as submittedAt, status FROM actions WHERE turn_id = ? ORDER BY submitted_at ASC').all(turn.id) as any[] : [];
  const publicLogs = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at ASC').all(room.id, 'public') as any[];
  const interactions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, source_player_id as sourcePlayerId, target_player_id as targetPlayerId, type, prompt, target_response as targetResponse, status, created_at as createdAt FROM interaction_requests WHERE room_id = ? AND status != ? ORDER BY created_at ASC').all(room.id, 'resolved') as any[];
  const bindings = getRoomResourceBindings(db, room.id);
  if (!bindings.presetBinding?.enabled) return buildNativePromptPreview(db, room);
  const presetPackage = getPresetPackage(db, bindings.presetBinding.presetPackageId);
  if (!presetPackage) return buildNativePromptPreview(db, room);
  const scriptCard = bindings.scriptBinding?.enabled ? getScriptCard(db, bindings.scriptBinding.scriptCardId) : null;
  return buildSillyTavernPromptPreview({ room, players, publicLogs, actions, interactions, scriptCard, presetPackage, worldBookEntries: getBoundResourceWorldBookEntries(db, room.id) });
}
```

Then replace the preview route body:

```ts
    res.json({ prompt: buildPromptPreview(db, room) });
```

with:

```ts
    res.json(buildRoomPromptPreview(db, room));
```

- [ ] **Step 5: Use ST-compatible prompt during process-turn**

In `server/src/routes/adminRoutes.ts`, inside `router.post('/rooms/:roomId/process-turn', ...)`, before the `try {` block, add:

```ts
    const promptPreview = buildRoomPromptPreview(db, room);
```

In the call to `processTurnActions`, add the `promptOverride` field:

```ts
      const result = await processTurnActions({ room, turn, players, actions, publicLogs, interactions, aiProvider, aiConfig: room.aiConfig, promptBlocks: getActivePromptBlocks(db, req.params.roomId), worldBookMatches, promptOverride: promptPreview.mode === 'sillytavern-compatible' ? promptPreview.prompt : undefined });
```

- [ ] **Step 6: Verify integration test passes**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts server/src/tests/sillyTavernPromptBuilder.test.ts server/src/tests/turnEngine.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run server typecheck**

Run:

```bash
rtk npm run typecheck --workspace server
```

Expected: PASS.

- [ ] **Step 8: Commit checkpoint if authorized**

Run only with explicit commit authorization:

```bash
rtk git add server/src/routes/adminRoutes.ts server/src/services/turnEngine.ts server/src/tests/integration.test.ts && rtk git commit -m "feat: use sillytavern prompt mode at runtime"
```

Expected: commit succeeds.

---

### Task 7: Add client types and API helpers

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/api.ts`
- Modify: `client/src/ui-copy.test.tsx`

- [ ] **Step 1: Update the API mock test shape first**

In `client/src/ui-copy.test.tsx`, extend the mocked `AdminState` object returned by `getAdminState` with:

```ts
    scriptCards: [],
    resourceWorldBooks: [],
    resourceWorldBookEntries: [],
    presetPackages: [],
    roomScriptBinding: null,
    roomWorldBookBindings: [],
    roomPresetBinding: null
```

Change the mocked `previewAiPrompt` return from:

```ts
  previewAiPrompt: vi.fn(async () => ({ prompt: '核心约束\n输出格式' })),
```

to:

```ts
  previewAiPrompt: vi.fn(async () => ({
    mode: 'native',
    prompt: '核心约束\n输出格式',
    messages: [{ role: 'user', content: '核心约束\n输出格式' }],
    slots: [],
    worldBookMatches: [],
    promptBlocks: [],
    warnings: []
  })),
```

Also add mocked API functions:

```ts
  importScriptCard: vi.fn(),
  importResourceWorldBook: vi.fn(),
  importPresetPackage: vi.fn(),
  bindRoomScriptCard: vi.fn(),
  unbindRoomScriptCard: vi.fn(),
  saveRoomWorldBookBindings: vi.fn(),
  bindRoomPresetPackage: vi.fn(),
  unbindRoomPresetPackage: vi.fn()
```

- [ ] **Step 2: Run the failing client test**

Run:

```bash
rtk npm test -- client/src/ui-copy.test.tsx
```

Expected: FAIL because the client types and API exports do not exist yet.

- [ ] **Step 3: Add client resource and preview types**

In `client/src/types.ts`, after `WorldBookEntry`, add:

```ts
export interface ScriptCard {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  visibilityNotes: string;
  sourceType: string;
  rawJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceWorldBook {
  id: string;
  name: string;
  sourceType: string;
  rawJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceWorldBookEntry {
  id: string;
  worldBookId: string;
  title: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  priority: number;
  orderIndex: number;
  position: 'before' | 'after';
  rawJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PromptPresetPackage {
  id: string;
  name: string;
  sourceType: string;
  openAiSettings: unknown;
  contextTemplate: unknown | null;
  instructTemplate: unknown | null;
  sysprompt: unknown | null;
  reasoningTemplate: unknown | null;
  rawJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface RoomScriptBinding {
  roomId: string;
  scriptCardId: string;
  bindingType: 'main';
  enabled: boolean;
  createdAt: string;
}

export interface RoomWorldBookBinding {
  roomId: string;
  worldBookId: string;
  enabled: boolean;
  orderIndex: number;
  createdAt: string;
}

export interface RoomPresetBinding {
  roomId: string;
  presetPackageId: string;
  enabled: boolean;
  createdAt: string;
}

export interface PromptPreviewResponse {
  mode: 'native' | 'sillytavern-compatible';
  prompt: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  slots: Array<{ key: string; source: string; content: string }>;
  worldBookMatches: Array<{ worldBookId: string; entryId: string; keys: string[]; reason: string; position: 'before' | 'after'; content: string }>;
  promptBlocks: Array<{ identifier: string; source: string; role: string; content: string }>;
  warnings: string[];
}
```

Then extend `AdminState` with:

```ts
  scriptCards: ScriptCard[];
  resourceWorldBooks: ResourceWorldBook[];
  resourceWorldBookEntries: ResourceWorldBookEntry[];
  presetPackages: PromptPresetPackage[];
  roomScriptBinding: RoomScriptBinding | null;
  roomWorldBookBindings: RoomWorldBookBinding[];
  roomPresetBinding: RoomPresetBinding | null;
```

- [ ] **Step 4: Add client API functions**

In `client/src/api.ts`, update the import line to include new types:

```ts
import type { AdminState, AiConfig, PlayerVisibleState, PromptPreset, PromptPreviewResponse, ResourceWorldBook, ResourceWorldBookEntry, RoomPresetBinding, RoomScriptBinding, RoomWorldBookBinding, ScriptCard, PromptPresetPackage, WorldBook, WorldBookEntry } from './types';
```

Replace `previewAiPrompt` with:

```ts
export function previewAiPrompt(roomId: string) {
  return jsonRequest<PromptPreviewResponse>(`/api/admin/rooms/${roomId}/ai-prompt-preview`);
}
```

Add these helpers after `createWorldBookEntry`:

```ts
export function importScriptCard(characterCard: unknown) {
  return jsonRequest<{ scriptCard: ScriptCard; importedWorldBook: ResourceWorldBook | null; warnings: string[] }>('/api/admin/resources/script-cards/import/sillytavern', { method: 'POST', body: JSON.stringify({ characterCard }) });
}

export function importResourceWorldBook(worldBook: unknown) {
  return jsonRequest<{ worldBook: ResourceWorldBook; entries: ResourceWorldBookEntry[]; warnings: string[] }>('/api/admin/resources/world-books/import/sillytavern', { method: 'POST', body: JSON.stringify({ worldBook }) });
}

export function importPresetPackage(input: { openAiSettings: unknown; contextTemplate?: unknown; instructTemplate?: unknown; sysprompt?: unknown; reasoningTemplate?: unknown }) {
  return jsonRequest<{ presetPackage: PromptPresetPackage; warnings: string[] }>('/api/admin/resources/preset-packages/import/sillytavern', { method: 'POST', body: JSON.stringify(input) });
}

export function bindRoomScriptCard(roomId: string, scriptCardId: string) {
  return jsonRequest<{ binding: RoomScriptBinding }>(`/api/admin/rooms/${roomId}/resource-bindings/script`, { method: 'PUT', body: JSON.stringify({ scriptCardId }) });
}

export function unbindRoomScriptCard(roomId: string) {
  return jsonRequest<{ ok: true }>(`/api/admin/rooms/${roomId}/resource-bindings/script`, { method: 'DELETE' });
}

export function saveRoomWorldBookBindings(roomId: string, bindings: Array<{ worldBookId: string; enabled: boolean; orderIndex: number }>) {
  return jsonRequest<{ bindings: RoomWorldBookBinding[] }>(`/api/admin/rooms/${roomId}/resource-bindings/world-books`, { method: 'PUT', body: JSON.stringify({ bindings }) });
}

export function bindRoomPresetPackage(roomId: string, presetPackageId: string) {
  return jsonRequest<{ binding: RoomPresetBinding }>(`/api/admin/rooms/${roomId}/resource-bindings/preset-package`, { method: 'PUT', body: JSON.stringify({ presetPackageId }) });
}

export function unbindRoomPresetPackage(roomId: string) {
  return jsonRequest<{ ok: true }>(`/api/admin/rooms/${roomId}/resource-bindings/preset-package`, { method: 'DELETE' });
}
```

- [ ] **Step 5: Verify client test and typecheck**

Run:

```bash
rtk npm test -- client/src/ui-copy.test.tsx && rtk npm run typecheck --workspace client
```

Expected: PASS.

- [ ] **Step 6: Commit checkpoint if authorized**

Run only with explicit commit authorization:

```bash
rtk git add client/src/types.ts client/src/api.ts client/src/ui-copy.test.tsx && rtk git commit -m "feat: add client resource api types"
```

Expected: commit succeeds.

---

### Task 8: Add admin import, binding, and structured preview UI

**Files:**
- Create: `client/src/components/ResourceImportPanel.tsx`
- Create: `client/src/components/RoomResourceBindingsPanel.tsx`
- Create: `client/src/components/PromptPreviewPanel.tsx`
- Modify: `client/src/pages/AdminPage.tsx`
- Modify: `client/src/ui-copy.test.tsx`

- [ ] **Step 1: Add UI copy assertions**

In `client/src/ui-copy.test.tsx`, inside the existing admin page test, add these expectations after the world-book assertions:

```ts
    expect(screen.getByText('全局资源库 / 导入')).toBeInTheDocument();
    expect(screen.getByText('导入 ST 角色卡为剧本卡')).toBeInTheDocument();
    expect(screen.getByText('导入 ST 世界书')).toBeInTheDocument();
    expect(screen.getByText('导入 ST 预设包')).toBeInTheDocument();
    expect(screen.getByText('房间资源绑定')).toBeInTheDocument();
    expect(screen.getByText('主剧本卡')).toBeInTheDocument();
    expect(screen.getByText('ST 兼容预设包')).toBeInTheDocument();
```

- [ ] **Step 2: Run the failing UI test**

Run:

```bash
rtk npm test -- client/src/ui-copy.test.tsx
```

Expected: FAIL because the new UI text does not exist.

- [ ] **Step 3: Create a JSON file reader helper inside the import panel**

Create `client/src/components/ResourceImportPanel.tsx` with:

```tsx
import { useState } from 'react';
import { importPresetPackage, importResourceWorldBook, importScriptCard } from '../api';
import type { PromptPresetPackage, ResourceWorldBook, ScriptCard } from '../types';

async function readJsonFile(file: File | null): Promise<unknown | undefined> {
  if (!file) return undefined;
  const text = await file.text();
  return JSON.parse(text) as unknown;
}

interface ResourceImportPanelProps {
  scriptCards: ScriptCard[];
  resourceWorldBooks: ResourceWorldBook[];
  presetPackages: PromptPresetPackage[];
  onImported: () => Promise<void>;
  onError: (message: string) => void;
}

export function ResourceImportPanel({ scriptCards, resourceWorldBooks, presetPackages, onImported, onError }: ResourceImportPanelProps) {
  const [scriptFile, setScriptFile] = useState<File | null>(null);
  const [worldBookFile, setWorldBookFile] = useState<File | null>(null);
  const [openAiSettingsFile, setOpenAiSettingsFile] = useState<File | null>(null);
  const [contextFile, setContextFile] = useState<File | null>(null);
  const [instructFile, setInstructFile] = useState<File | null>(null);
  const [syspromptFile, setSyspromptFile] = useState<File | null>(null);
  const [reasoningFile, setReasoningFile] = useState<File | null>(null);
  const [result, setResult] = useState('');

  async function importScript() {
    try {
      const characterCard = await readJsonFile(scriptFile);
      if (!characterCard) throw new Error('请选择 ST 角色卡 JSON 文件。');
      const imported = await importScriptCard(characterCard);
      setResult(`已导入剧本卡：${imported.scriptCard.name}${imported.importedWorldBook ? `；附带世界书：${imported.importedWorldBook.name}` : ''}${imported.warnings.length ? `；警告：${imported.warnings.join('；')}` : ''}`);
      await onImported();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function importWorldBook() {
    try {
      const worldBook = await readJsonFile(worldBookFile);
      if (!worldBook) throw new Error('请选择 ST 世界书 JSON 文件。');
      const imported = await importResourceWorldBook(worldBook);
      setResult(`已导入世界书：${imported.worldBook.name}；条目：${imported.entries.length}${imported.warnings.length ? `；警告：${imported.warnings.join('；')}` : ''}`);
      await onImported();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function importPreset() {
    try {
      const openAiSettings = await readJsonFile(openAiSettingsFile);
      if (!openAiSettings) throw new Error('请选择 OpenAI Settings JSON 文件。');
      const imported = await importPresetPackage({
        openAiSettings,
        contextTemplate: await readJsonFile(contextFile),
        instructTemplate: await readJsonFile(instructFile),
        sysprompt: await readJsonFile(syspromptFile),
        reasoningTemplate: await readJsonFile(reasoningFile)
      });
      setResult(`已导入预设包：${imported.presetPackage.name}${imported.warnings.length ? `；警告：${imported.warnings.join('；')}` : ''}`);
      await onImported();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="card">
      <h2>全局资源库 / 导入</h2>
      <p className="muted">上传 SillyTavern JSON 文件。导入只进入全局资源库，不会自动写入房间日志或开场消息。</p>

      <div className="subcard">
        <h3>导入 ST 角色卡为剧本卡</h3>
        <input type="file" accept="application/json,.json" onChange={(event) => setScriptFile(event.target.files?.[0] ?? null)} />
        <button onClick={importScript}>导入剧本卡</button>
      </div>

      <div className="subcard">
        <h3>导入 ST 世界书</h3>
        <input type="file" accept="application/json,.json" onChange={(event) => setWorldBookFile(event.target.files?.[0] ?? null)} />
        <button onClick={importWorldBook}>导入世界书</button>
      </div>

      <div className="subcard">
        <h3>导入 ST 预设包</h3>
        <label>OpenAI Settings<input type="file" accept="application/json,.json" onChange={(event) => setOpenAiSettingsFile(event.target.files?.[0] ?? null)} /></label>
        <label>Context Template<input type="file" accept="application/json,.json" onChange={(event) => setContextFile(event.target.files?.[0] ?? null)} /></label>
        <label>Instruct Template<input type="file" accept="application/json,.json" onChange={(event) => setInstructFile(event.target.files?.[0] ?? null)} /></label>
        <label>Sysprompt<input type="file" accept="application/json,.json" onChange={(event) => setSyspromptFile(event.target.files?.[0] ?? null)} /></label>
        <label>Reasoning Template<input type="file" accept="application/json,.json" onChange={(event) => setReasoningFile(event.target.files?.[0] ?? null)} /></label>
        <button onClick={importPreset}>导入预设包</button>
      </div>

      {result ? <p>{result}</p> : null}

      <h3>已导入资源</h3>
      <p>剧本卡：{scriptCards.length}</p>
      {scriptCards.map((script) => <p key={script.id}>{script.name}</p>)}
      <p>世界书：{resourceWorldBooks.length}</p>
      {resourceWorldBooks.map((book) => <p key={book.id}>{book.name}</p>)}
      <p>预设包：{presetPackages.length}</p>
      {presetPackages.map((preset) => <p key={preset.id}>{preset.name}</p>)}
    </section>
  );
}
```

- [ ] **Step 4: Create room binding panel**

Create `client/src/components/RoomResourceBindingsPanel.tsx` with:

```tsx
import { useState } from 'react';
import { bindRoomPresetPackage, bindRoomScriptCard, saveRoomWorldBookBindings, unbindRoomPresetPackage, unbindRoomScriptCard } from '../api';
import type { PromptPresetPackage, ResourceWorldBook, RoomPresetBinding, RoomScriptBinding, RoomWorldBookBinding, ScriptCard } from '../types';

interface RoomResourceBindingsPanelProps {
  roomId: string;
  scriptCards: ScriptCard[];
  resourceWorldBooks: ResourceWorldBook[];
  presetPackages: PromptPresetPackage[];
  roomScriptBinding: RoomScriptBinding | null;
  roomWorldBookBindings: RoomWorldBookBinding[];
  roomPresetBinding: RoomPresetBinding | null;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}

export function RoomResourceBindingsPanel(props: RoomResourceBindingsPanelProps) {
  const [scriptCardId, setScriptCardId] = useState(props.roomScriptBinding?.scriptCardId ?? '');
  const [presetPackageId, setPresetPackageId] = useState(props.roomPresetBinding?.presetPackageId ?? '');
  const [selectedWorldBookIds, setSelectedWorldBookIds] = useState(() => new Set(props.roomWorldBookBindings.map((binding) => binding.worldBookId)));

  async function saveScript() {
    try {
      if (!scriptCardId) throw new Error('请选择主剧本卡。');
      await bindRoomScriptCard(props.roomId, scriptCardId);
      await props.onSaved();
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearScript() {
    try {
      await unbindRoomScriptCard(props.roomId);
      setScriptCardId('');
      await props.onSaved();
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    }
  }

  function toggleWorldBook(worldBookId: string, checked: boolean) {
    setSelectedWorldBookIds((current) => {
      const next = new Set(current);
      if (checked) next.add(worldBookId);
      else next.delete(worldBookId);
      return next;
    });
  }

  async function saveWorldBooks() {
    try {
      const bindings = Array.from(selectedWorldBookIds).map((worldBookId, index) => ({ worldBookId, enabled: true, orderIndex: index }));
      await saveRoomWorldBookBindings(props.roomId, bindings);
      await props.onSaved();
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function savePreset() {
    try {
      if (!presetPackageId) throw new Error('请选择 ST 兼容预设包。');
      await bindRoomPresetPackage(props.roomId, presetPackageId);
      await props.onSaved();
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearPreset() {
    try {
      await unbindRoomPresetPackage(props.roomId);
      setPresetPackageId('');
      await props.onSaved();
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="card">
      <h2>房间资源绑定</h2>
      <p className="muted">绑定资源只影响 AI 上下文构建，不会自动写入房间日志或开场消息。</p>

      <div className="subcard">
        <h3>主剧本卡</h3>
        <select value={scriptCardId} onChange={(event) => setScriptCardId(event.target.value)}>
          <option value="">未绑定</option>
          {props.scriptCards.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}
        </select>
        <button onClick={saveScript}>绑定为主剧本</button>
        <button onClick={clearScript}>解绑主剧本</button>
      </div>

      <div className="subcard">
        <h3>世界书绑定</h3>
        {props.resourceWorldBooks.map((book) => (
          <label className="check-row" key={book.id}>
            <input type="checkbox" checked={selectedWorldBookIds.has(book.id)} onChange={(event) => toggleWorldBook(book.id, event.target.checked)} /> {book.name}
          </label>
        ))}
        <button onClick={saveWorldBooks}>保存世界书绑定</button>
      </div>

      <div className="subcard">
        <h3>ST 兼容预设包</h3>
        <select value={presetPackageId} onChange={(event) => setPresetPackageId(event.target.value)}>
          <option value="">未绑定</option>
          {props.presetPackages.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
        <button onClick={savePreset}>绑定预设包</button>
        <button onClick={clearPreset}>解绑预设包</button>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Create structured prompt preview panel**

Create `client/src/components/PromptPreviewPanel.tsx` with:

```tsx
import type { PromptPreviewResponse } from '../types';

export function PromptPreviewPanel({ preview }: { preview: PromptPreviewResponse | null }) {
  if (!preview) return null;
  return (
    <section className="subcard">
      <h3>Prompt Preview</h3>
      <p>构建模式：{preview.mode}</p>
      {preview.warnings.length ? <p>警告：{preview.warnings.join('；')}</p> : null}
      {preview.slots.length ? (
        <details open>
          <summary>动态槽位</summary>
          {preview.slots.map((slot) => <pre className="prompt-preview" key={slot.key}>{slot.key} · {slot.source}\n{slot.content}</pre>)}
        </details>
      ) : null}
      {preview.worldBookMatches.length ? (
        <details open>
          <summary>世界书命中</summary>
          {preview.worldBookMatches.map((match) => <pre className="prompt-preview" key={match.entryId}>{match.reason} · {match.keys.join(', ')}\n{match.content}</pre>)}
        </details>
      ) : null}
      {preview.promptBlocks.length ? (
        <details>
          <summary>Prompt Blocks</summary>
          {preview.promptBlocks.map((block) => <pre className="prompt-preview" key={`${block.identifier}-${block.source}`}>{block.identifier} · {block.source} · {block.role}\n{block.content}</pre>)}
        </details>
      ) : null}
      <details open>
        <summary>最终 Prompt</summary>
        <pre className="prompt-preview">{preview.prompt}</pre>
      </details>
    </section>
  );
}
```

- [ ] **Step 6: Wire panels into AdminPage**

In `client/src/pages/AdminPage.tsx`, update imports:

```tsx
import { addPlayer, activatePreset, createWorldBook, createWorldBookEntry, getAdminState, previewAiPrompt, processTurn, saveAiConfig, savePreset, subscribeRoom } from '../api';
import { PromptPreviewPanel } from '../components/PromptPreviewPanel';
import { ResourceImportPanel } from '../components/ResourceImportPanel';
import { RoomResourceBindingsPanel } from '../components/RoomResourceBindingsPanel';
import type { AdminState, AiConfig, PromptBlock, PromptPreset, PromptPreviewResponse, WorldBookEntry } from '../types';
```

Change prompt preview state:

```tsx
  const [promptPreview, setPromptPreview] = useState<PromptPreviewResponse | null>(null);
```

Change `loadPromptPreview` to:

```tsx
  async function loadPromptPreview() {
    setError('');
    try {
      const preview = await previewAiPrompt(roomId);
      setPromptPreview(preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
```

Replace:

```tsx
              {promptPreview ? <pre className="prompt-preview">{promptPreview}</pre> : null}
```

with:

```tsx
              <PromptPreviewPanel preview={promptPreview} />
```

After the AI constraints section and before `预设管理`, insert:

```tsx
          <ResourceImportPanel
            scriptCards={state.scriptCards}
            resourceWorldBooks={state.resourceWorldBooks}
            presetPackages={state.presetPackages}
            onImported={refresh}
            onError={setError}
          />
          <RoomResourceBindingsPanel
            roomId={roomId}
            scriptCards={state.scriptCards}
            resourceWorldBooks={state.resourceWorldBooks}
            presetPackages={state.presetPackages}
            roomScriptBinding={state.roomScriptBinding}
            roomWorldBookBindings={state.roomWorldBookBindings}
            roomPresetBinding={state.roomPresetBinding}
            onSaved={refresh}
            onError={setError}
          />
```

- [ ] **Step 7: Verify UI test and client typecheck pass**

Run:

```bash
rtk npm test -- client/src/ui-copy.test.tsx && rtk npm run typecheck --workspace client
```

Expected: PASS.

- [ ] **Step 8: Commit checkpoint if authorized**

Run only with explicit commit authorization:

```bash
rtk git add client/src/components/ResourceImportPanel.tsx client/src/components/RoomResourceBindingsPanel.tsx client/src/components/PromptPreviewPanel.tsx client/src/pages/AdminPage.tsx client/src/ui-copy.test.tsx && rtk git commit -m "feat: add sillytavern resource admin ui"
```

Expected: commit succeeds.

---

### Task 9: Full validation and cleanup

**Files:**
- Modify only files required by failures discovered in this task.

- [ ] **Step 1: Run full test suite**

Run:

```bash
rtk npm test
```

Expected: PASS.

- [ ] **Step 2: Run full typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full build**

Run:

```bash
rtk npm run build
```

Expected: PASS.

- [ ] **Step 4: Inspect worktree for temporary files**

Run:

```bash
rtk git status --short
```

Expected: only planned source, test, and spec/plan files are present. No temporary scripts or generated test data are present.

- [ ] **Step 5: Manual browser validation**

Start the app:

```bash
rtk npm run dev
```

Expected: server and client dev processes start.

In the browser, verify this golden path:

1. Create or open a room.
2. In “全局资源库 / 导入”, upload a ST character card JSON and confirm it appears as a script card.
3. Upload a ST world book JSON and confirm it appears in the world-book resource list.
4. Upload an OpenAI Settings JSON as the required ST preset package file. Add context/instruct/sysprompt/reasoning JSON files when available.
5. In “房间资源绑定”, bind one main script card, one world book, and one ST preset package.
6. Click “预览 AI 请求”. Confirm the preview shows `sillytavern-compatible`, dynamic slots, world-book matches, prompt blocks, and final prompt.
7. Submit player actions and process the turn. Confirm the request completes or records an AI provider error in the existing AI 错误 area without crashing the admin page.

- [ ] **Step 6: Stop dev server**

Stop the dev server with the terminal interrupt used by the session. Do not kill unrelated processes.

- [ ] **Step 7: Final status check**

Run:

```bash
rtk git status --short
```

Expected: all changes are intentional. If commit authorization was not granted, changes remain uncommitted for user review.

- [ ] **Step 8: Final commit checkpoint if authorized**

Run only with explicit commit authorization:

```bash
rtk git add server/src client/src docs/superpowers/specs/2026-05-28-sillytavern-independent-migration-design.md docs/superpowers/plans/2026-05-28-sillytavern-independent-migration.md package.json package-lock.json && rtk git commit -m "feat: migrate sillytavern resources into standalone app"
```

Expected: commit succeeds if there are staged changes and hooks pass.

---

## Self-Review

### Spec coverage

- Global resource library: covered by Tasks 1, 3, and 4.
- ST character-card import as script card: covered by Tasks 2, 3, 4, and 8.
- Embedded `character_book` import as world book: covered by Tasks 2 and 3.
- ST world-book import with basic fields: covered by Tasks 2, 3, and 5.
- ST preset package import: covered by Tasks 2, 3, 4, and 8.
- Room bindings: covered by Tasks 3, 4, and 8.
- ST-style slot prompt construction: covered by Tasks 5 and 6.
- Prompt Preview debug structure: covered by Tasks 5, 6, and 8.
- DND output contract final append: covered by Tasks 5 and 6.
- Native mode fallback: covered by Tasks 5 and 6 through unchanged native preview and existing tests.
- No runtime dependence on `SillyTavern/`: covered by the architecture and all tasks using only uploaded JSON.
- No chat/log migration: preserved by import endpoints only accepting resources.
- No AI provider switch: preserved by Task 6 using `promptOverride` with existing `AiProvider.generateTurnResult(prompt)`.

### Placeholder scan

The plan contains concrete file paths, code blocks, commands, and expected outcomes. It does not contain open-ended implementation placeholders.

### Type consistency

Server names used consistently:

- `ScriptCard`
- `ResourceWorldBook`
- `ResourceWorldBookEntry`
- `PromptPresetPackage`
- `RoomScriptBinding`
- `RoomWorldBookBinding`
- `RoomPresetBinding`
- `PromptPreviewResponse`

Client names mirror the server types. Route helpers use the same endpoint paths as the design spec.
