# 全局实时配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前按房间保存的 AI 约束、预设、世界书和 ST 资源绑定改为单例全局配置，并让所有房间在 Prompt Preview 和处理回合时实时使用当前全局配置。

**Architecture:** 新增 `global_config`、`global_world_book_bindings`、`global_prompt_*`、`global_world_book_*` 表和 `globalConfigService`。房间只保留运行态数据；后端每次构建 prompt 时读取当前全局配置快照，前端管理页继续以房间为入口但配置 tab 编辑全局配置。

**Tech Stack:** React + TypeScript + Vite + Vitest + Testing Library；Node.js + Express + SQLite `better-sqlite3`。

---

## File Structure

- Modify: `server/src/db/schema.ts`
  - Add singleton global config tables.
  - Add global native prompt preset/world book tables.
  - Keep old room-scoped tables for compatibility, but runtime will stop reading them.
- Modify: `server/src/domain/types.ts`
  - Remove `roomId` from active prompt/world-book UI-facing types or make global usage explicit.
  - Add `GlobalConfigSnapshot`, `GlobalResourceWorldBookBinding`, and global admin-state fields.
- Create: `server/src/services/globalConfigService.ts`
  - Own all global config reads/writes.
  - Own global native presets/world books.
  - Own global ST resource selection.
- Modify: `server/src/routes/adminRoutes.ts`
  - Register global config routes.
  - Change room creation to `{ name }` only.
  - Use global config for prompt preview and process-turn.
  - Stop creating per-room default presets.
- Modify: `server/src/routes/adminResourceRoutes.ts`
  - Delete resource cleanup should not leave global config pointing at missing resources.
  - Room resource binding endpoints may remain for compatibility but frontend must stop calling them.
- Modify: `server/src/services/aiContextBuilder.ts`
  - Accept global script card and global AI config as explicit prompt inputs.
  - Do not fall back to `room.aiConfig` for runtime behavior.
- Modify: `server/src/services/turnEngine.ts`
  - Pass global script card through native turn processing so process-turn matches Prompt Preview.
- Modify: `server/src/services/sillyTavernPromptBuilder.ts`
  - Accept `aiConfig` explicitly instead of reading `input.room.aiConfig`.
- Modify: `server/src/tests/integration.test.ts`
  - Add coverage for singleton global config, realtime preview, room creation, global native presets/world books, and ST-compatible global resource selection.
- Modify: `server/src/tests/sillyTavernPromptBuilder.test.ts`
  - Update builder input to pass `aiConfig` explicitly.
- Modify: `client/src/types.ts`
  - Add global config client types.
  - Update `AdminState` to include global config and global binding fields.
- Modify: `client/src/api.ts`
  - Change `createRoom` to `{ name }`.
  - Add `/api/admin/config/*` helpers.
  - Change `savePreset`, `activatePreset`, `createWorldBook`, `createWorldBookEntry`, and `saveAiConfig` to global endpoints.
- Modify: `client/src/api.test.tsx`
  - Replace room binding helper expectations with global config helper expectations.
- Modify: `client/src/components/RoomResourceBindingsPanel.tsx`
  - Rename/export as `GlobalResourceConfigPanel` or replace content in-place and update imports.
  - Remove `roomId` prop and call global config helpers.
- Modify: `client/src/components/ResourceImportPanel.tsx`
  - Keep existing import behavior and existing `全局资源库 / 导入` copy unchanged.
- Modify: `client/src/pages/HomePage.tsx`
  - Remove `worldInfo` and `systemPrompt` fields.
  - Explain that all rooms use global config in real time.
- Modify: `client/src/pages/AdminPage.tsx`
  - Treat AI config, presets, world books, and resource config as global state from `AdminState`.
  - Keep tab panels mounted with `hidden`.
- Modify: `client/src/ui-copy.test.tsx`
  - Update mocked `AdminState` for global config.
  - Update UI smoke tests for global wording and removed room fields.

No backend files outside `server/` and no `SillyTavern/` files should be modified. Do not create commits unless the user explicitly asks. All external commands in this plan use the required `rtk` prefix.

---

### Task 1: Add singleton global config storage and API

**Files:**
- Modify: `server/src/db/schema.ts`
- Modify: `server/src/domain/types.ts`
- Create: `server/src/services/globalConfigService.ts`
- Modify: `server/src/routes/adminRoutes.ts`
- Modify: `server/src/tests/integration.test.ts`

- [ ] **Step 1: Write failing integration test for global config defaults and AI config update**

Append this test inside `describe('DND AI-DM integration', ...)` in `server/src/tests/integration.test.ts`:

```ts
  it('stores AI constraints in a singleton global config instead of a room', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const defaultConfigRes = await fetch(`${base}/api/admin/config`);
      expect(defaultConfigRes.status).toBe(200);
      const defaultConfig = await defaultConfigRes.json() as { aiConfig: typeof defaultAiConfig; activeScriptCardId: string | null; activePresetPackageId: string | null; globalWorldBookBindings: unknown[] };
      expect(defaultConfig.aiConfig.coreRules).toBe(defaultAiConfig.coreRules);
      expect(defaultConfig.activeScriptCardId).toBeNull();
      expect(defaultConfig.activePresetPackageId).toBeNull();
      expect(defaultConfig.globalWorldBookBindings).toEqual([]);

      const nextAiConfig = {
        coreRules: '核心约束：全局配置会实时影响所有房间。',
        playerAgencyRules: '玩家自主权：全局规则不能替玩家决定。',
        visibilityRules: '信息隔离：全局规则不能泄露秘密。',
        interactionRules: '互动规则：全局规则要求确认互动。',
        styleRules: '叙事风格：全局中文短句。',
        outputFormatRules: '输出格式：全局严格 JSON。'
      };
      const updateRes = await fetch(`${base}/api/admin/config/ai-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(nextAiConfig)
      });
      expect(updateRes.status).toBe(200);
      expect(await updateRes.json()).toEqual(nextAiConfig);

      const updatedConfigRes = await fetch(`${base}/api/admin/config`);
      const updatedConfig = await updatedConfigRes.json() as { aiConfig: typeof nextAiConfig };
      expect(updatedConfig.aiConfig).toEqual(nextAiConfig);

      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Global Config Room' })
      });
      expect(roomRes.status).toBe(200);
      const room = await roomRes.json() as { roomId: string };

      const roomRow = db.prepare('SELECT ai_config_json FROM rooms WHERE id = ?').get(room.roomId) as { ai_config_json: string };
      expect(JSON.parse(roomRow.ai_config_json)).not.toEqual(nextAiConfig);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [ ] **Step 2: Run focused backend test to verify it fails**

Run:

```bash
rtk npm test -- --run server/src/tests/integration.test.ts -t "stores AI constraints in a singleton global config instead of a room"
```

Expected: FAIL because `/api/admin/config` and `{ name }`-only room creation do not exist yet.

- [ ] **Step 3: Add global tables to schema**

In `server/src/db/schema.ts`, inside the existing `db.exec(` block after `prompt_preset_packages`, add:

```ts
    CREATE TABLE IF NOT EXISTS global_config (
      id TEXT PRIMARY KEY,
      ai_config_json TEXT NOT NULL DEFAULT '{}',
      active_script_card_id TEXT REFERENCES script_cards(id) ON DELETE SET NULL,
      active_preset_package_id TEXT REFERENCES prompt_preset_packages(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_world_book_bindings (
      world_book_id TEXT PRIMARY KEY REFERENCES resource_world_books(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_prompt_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_prompt_blocks (
      id TEXT PRIMARY KEY,
      preset_id TEXT NOT NULL REFERENCES global_prompt_presets(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      position TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      order_index INTEGER NOT NULL,
      content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_world_books (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_world_book_entries (
      id TEXT PRIMARY KEY,
      world_book_id TEXT NOT NULL REFERENCES global_world_books(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      keys_json TEXT NOT NULL,
      secondary_keys_json TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      constant INTEGER NOT NULL DEFAULT 0,
      selective INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 100,
      position TEXT NOT NULL DEFAULT 'after_world',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
```

Keep the existing room-scoped tables in place.

- [ ] **Step 4: Add global config domain types**

In `server/src/domain/types.ts`, add these interfaces after `RoomPresetBinding`:

```ts
export interface GlobalResourceWorldBookBinding {
  worldBookId: string;
  enabled: boolean;
  orderIndex: number;
  createdAt: string;
}

export interface GlobalConfigSnapshot {
  aiConfig: AiConfig;
  activeScriptCardId: string | null;
  activePresetPackageId: string | null;
  globalWorldBookBindings: GlobalResourceWorldBookBinding[];
  presets: PromptPreset[];
  worldBooks: WorldBook[];
  worldBookEntries: WorldBookEntry[];
  scriptCards: ScriptCard[];
  resourceWorldBooks: ResourceWorldBook[];
  resourceWorldBookEntries: ResourceWorldBookEntry[];
  presetPackages: PromptPresetPackage[];
}
```

Leave `Room.aiConfig`, `PromptPreset.roomId`, and `WorldBook.roomId` temporarily for compatibility in this task. Later tasks will stop relying on the room fields at runtime.

- [ ] **Step 5: Create `globalConfigService` with singleton config read/write**

Create `server/src/services/globalConfigService.ts` with this initial content:

```ts
import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { AiConfig, GlobalConfigSnapshot, GlobalResourceWorldBookBinding, PromptBlock, PromptBlockPosition, PromptPreset, WorldBook, WorldBookEntry, WorldBookPosition } from '../domain/types.js';
import { defaultAiConfig, normalizeAiConfig } from './aiContextBuilder.js';
import { listResourceLibrary } from './resourceLibrary.js';

const GLOBAL_CONFIG_ID = 'default';

interface GlobalConfigRow {
  id: string;
  ai_config_json: string;
  active_script_card_id: string | null;
  active_preset_package_id: string | null;
  created_at: string;
  updated_at: string;
}

interface GlobalWorldBookBindingRow {
  world_book_id: string;
  enabled: number;
  order_index: number;
  created_at: string;
}

function parseJsonArray(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mapPromptBlockRow(row: any): PromptBlock {
  return {
    id: row.id,
    presetId: row.presetId,
    name: row.name,
    role: row.role,
    position: row.position as PromptBlockPosition,
    enabled: Boolean(row.enabled),
    orderIndex: row.orderIndex,
    content: row.content
  };
}

function mapWorldBookRow(row: any): WorldBook {
  return {
    id: row.id,
    roomId: 'global',
    name: row.name,
    description: row.description,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapWorldBookEntryRow(row: any): WorldBookEntry {
  return {
    id: row.id,
    worldBookId: row.worldBookId,
    title: row.title,
    keys: parseJsonArray(row.keysJson),
    secondaryKeys: parseJsonArray(row.secondaryKeysJson),
    content: row.content,
    enabled: Boolean(row.enabled),
    constant: Boolean(row.constant),
    selective: Boolean(row.selective),
    priority: row.priority,
    position: row.position as WorldBookPosition,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapGlobalWorldBookBinding(row: GlobalWorldBookBindingRow): GlobalResourceWorldBookBinding {
  return {
    worldBookId: row.world_book_id,
    enabled: Boolean(row.enabled),
    orderIndex: row.order_index,
    createdAt: row.created_at
  };
}

export function ensureGlobalConfig(db: AppDatabase): void {
  const existing = db.prepare('SELECT id FROM global_config WHERE id = ?').get(GLOBAL_CONFIG_ID);
  if (existing) return;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO global_config (id, ai_config_json, active_script_card_id, active_preset_package_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(GLOBAL_CONFIG_ID, JSON.stringify(defaultAiConfig), null, null, now, now);
}

export function getGlobalAiConfig(db: AppDatabase): AiConfig {
  ensureGlobalConfig(db);
  const row = db.prepare('SELECT ai_config_json FROM global_config WHERE id = ?').get(GLOBAL_CONFIG_ID) as { ai_config_json: string };
  return normalizeAiConfig(JSON.parse(row.ai_config_json) as unknown);
}

function syncDefaultGlobalPresetBlocks(db: AppDatabase, aiConfig: AiConfig): void {
  const preset = db.prepare('SELECT id FROM global_prompt_presets WHERE name = ?').get('默认强约束预设') as { id: string } | undefined;
  if (!preset) return;
  const now = new Date().toISOString();
  const blocks = [
    { name: '核心规则', content: aiConfig.coreRules },
    { name: '玩家自主权规则', content: aiConfig.playerAgencyRules },
    { name: '信息隔离规则', content: aiConfig.visibilityRules },
    { name: '玩家互动规则', content: aiConfig.interactionRules },
    { name: '叙事风格规则', content: aiConfig.styleRules },
    { name: '输出格式规则', content: aiConfig.outputFormatRules }
  ];
  const tx = db.transaction(() => {
    const updateBlock = db.prepare('UPDATE global_prompt_blocks SET content = ? WHERE preset_id = ? AND name = ?');
    for (const block of blocks) updateBlock.run(block.content, preset.id, block.name);
    db.prepare('UPDATE global_prompt_presets SET updated_at = ? WHERE id = ?').run(now, preset.id);
  });
  tx();
}

export function updateGlobalAiConfig(db: AppDatabase, aiConfig: AiConfig): AiConfig {
  ensureGlobalConfig(db);
  const normalized = normalizeAiConfig(aiConfig);
  db.prepare('UPDATE global_config SET ai_config_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(normalized), new Date().toISOString(), GLOBAL_CONFIG_ID);
  syncDefaultGlobalPresetBlocks(db, normalized);
  return normalized;
}

export function getGlobalPresets(db: AppDatabase): PromptPreset[] {
  const presetRows = db.prepare('SELECT id, name, description, is_active as isActive, created_at as createdAt, updated_at as updatedAt FROM global_prompt_presets ORDER BY is_active DESC, updated_at DESC').all() as any[];
  const blockRows = db.prepare('SELECT id, preset_id as presetId, name, role, position, enabled, order_index as orderIndex, content FROM global_prompt_blocks ORDER BY order_index ASC').all() as any[];
  const blocksByPreset = new Map<string, PromptBlock[]>();
  for (const row of blockRows) {
    const blocks = blocksByPreset.get(row.presetId) ?? [];
    blocks.push(mapPromptBlockRow(row));
    blocksByPreset.set(row.presetId, blocks);
  }
  return presetRows.map((row) => ({
    id: row.id,
    roomId: 'global',
    name: row.name,
    description: row.description,
    isActive: Boolean(row.isActive),
    blocks: blocksByPreset.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }));
}

export function getActiveGlobalPromptBlocks(db: AppDatabase): PromptBlock[] {
  return getGlobalPresets(db).find((preset) => preset.isActive)?.blocks ?? [];
}

export function getGlobalWorldBooks(db: AppDatabase): WorldBook[] {
  return (db.prepare('SELECT id, name, description, enabled, created_at as createdAt, updated_at as updatedAt FROM global_world_books ORDER BY updated_at DESC').all() as any[]).map(mapWorldBookRow);
}

export function getGlobalWorldBookEntries(db: AppDatabase): WorldBookEntry[] {
  return (db.prepare('SELECT entry.id, entry.world_book_id as worldBookId, entry.title, entry.keys_json as keysJson, entry.secondary_keys_json as secondaryKeysJson, entry.content, entry.enabled, entry.constant, entry.selective, entry.priority, entry.position, entry.created_at as createdAt, entry.updated_at as updatedAt FROM global_world_book_entries entry JOIN global_world_books book ON book.id = entry.world_book_id WHERE book.enabled = 1 ORDER BY entry.priority DESC, entry.updated_at DESC').all() as any[]).map(mapWorldBookEntryRow);
}

export function getGlobalResourceWorldBookBindings(db: AppDatabase): GlobalResourceWorldBookBinding[] {
  const rows = db.prepare('SELECT * FROM global_world_book_bindings ORDER BY order_index ASC, created_at ASC').all() as GlobalWorldBookBindingRow[];
  return rows.map(mapGlobalWorldBookBinding);
}

export function getGlobalConfigSnapshot(db: AppDatabase): GlobalConfigSnapshot {
  ensureGlobalConfig(db);
  const row = db.prepare('SELECT * FROM global_config WHERE id = ?').get(GLOBAL_CONFIG_ID) as GlobalConfigRow;
  const resources = listResourceLibrary(db);
  return {
    aiConfig: normalizeAiConfig(JSON.parse(row.ai_config_json) as unknown),
    activeScriptCardId: row.active_script_card_id,
    activePresetPackageId: row.active_preset_package_id,
    globalWorldBookBindings: getGlobalResourceWorldBookBindings(db),
    presets: getGlobalPresets(db),
    worldBooks: getGlobalWorldBooks(db),
    worldBookEntries: getGlobalWorldBookEntries(db),
    scriptCards: resources.scriptCards,
    resourceWorldBooks: resources.resourceWorldBooks,
    resourceWorldBookEntries: resources.resourceWorldBookEntries,
    presetPackages: resources.presetPackages
  };
}

export function createDefaultGlobalPreset(db: AppDatabase): void {
  const existing = db.prepare('SELECT id FROM global_prompt_presets LIMIT 1').get();
  if (existing) return;
  const aiConfig = getGlobalAiConfig(db);
  const presetId = nanoid();
  const now = new Date().toISOString();
  const blocks = [
    { name: '核心规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 10, content: aiConfig.coreRules },
    { name: '玩家自主权规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 20, content: aiConfig.playerAgencyRules },
    { name: '信息隔离规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 30, content: aiConfig.visibilityRules },
    { name: '玩家互动规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 40, content: aiConfig.interactionRules },
    { name: '叙事风格规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 50, content: aiConfig.styleRules },
    { name: '输出格式规则', role: 'system', position: 'final', enabled: true, orderIndex: 900, content: aiConfig.outputFormatRules }
  ];
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO global_prompt_presets (id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(presetId, '默认强约束预设', '全局默认 AI 约束提示词块。', 1, now, now);
    for (const block of blocks) {
      db.prepare('INSERT INTO global_prompt_blocks (id, preset_id, name, role, position, enabled, order_index, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nanoid(), presetId, block.name, block.role, block.position, block.enabled ? 1 : 0, block.orderIndex, block.content);
    }
  });
  tx();
}
```

This file intentionally imports `nanoid` now because Task 3 will extend it for global preset/world-book writes.

- [ ] **Step 6: Register global config endpoints**

In `server/src/routes/adminRoutes.ts`:

1. Update imports:

```ts
import { createDefaultGlobalPreset, getGlobalConfigSnapshot, updateGlobalAiConfig } from '../services/globalConfigService.js';
```

2. After `registerAdminResourceRoutes(router, db);`, add:

```ts
  ensureGlobalStartupState(db);
```

3. Add this helper above `createAdminRouter`:

```ts
function ensureGlobalStartupState(db: AppDatabase): void {
  createDefaultGlobalPreset(db);
}
```

4. Add global config routes before `router.post('/rooms', ...)`:

```ts
  router.get('/config', (_req, res) => {
    res.json(getGlobalConfigSnapshot(db));
  });

  router.put('/config/ai-config', (req, res) => {
    const aiConfig: AiConfig = normalizeAiConfig(aiConfigSchema.parse(req.body));
    res.json(updateGlobalAiConfig(db, aiConfig));
  });
```

5. Change `createRoomSchema` to:

```ts
const createRoomSchema = z.object({
  name: z.string().min(1)
});
```

6. In `router.post('/rooms', ...)`, replace the room insert values with default compatibility values:

```ts
      db.prepare('INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, ai_config_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(roomId, input.name, '', '此房间实时使用当前全局配置。', 1, 'waiting_for_actions', JSON.stringify(defaultAiConfig), now);
```

7. Replace the opening log insert content with:

```ts
        .run(nanoid(), roomId, turnId, 'public', null, 'Opening Scene', '此房间已创建。请在全局配置中选择主剧本卡后开始游戏。', now);
```

8. Remove the call to `createDefaultPreset(db, roomId, defaultAiConfig, now);` from room creation. Leave the old `createDefaultPreset` function for now; later cleanup can remove it after tests pass.

- [ ] **Step 7: Run focused backend test**

Run:

```bash
rtk npm test -- --run server/src/tests/integration.test.ts -t "stores AI constraints in a singleton global config instead of a room"
```

Expected: PASS for the new singleton config test. The full backend integration file is reconciled in later tasks after the remaining room-scoped tests are rewritten.

---

### Task 2: Use global config for ST resource selection and prompt building

**Files:**
- Modify: `server/src/services/globalConfigService.ts`
- Modify: `server/src/routes/adminRoutes.ts`
- Modify: `server/src/routes/adminResourceRoutes.ts`
- Modify: `server/src/services/sillyTavernPromptBuilder.ts`
- Modify: `server/src/tests/integration.test.ts`
- Modify: `server/src/tests/sillyTavernPromptBuilder.test.ts`

- [ ] **Step 1: Write failing realtime ST-compatible global config test**

In `server/src/tests/integration.test.ts`, replace the test named `returns a SillyTavern-compatible prompt preview when a room has an ST preset package binding` with this test:

```ts
  it('uses the current global ST resource config for every room prompt preview', async () => {
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
        body: JSON.stringify({ name: 'ST Preview Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const scriptRes = await fetch(`${base}/api/admin/resources/script-cards/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ characterCard: { data: { name: 'Gate Script', description: 'A keeper knows Candlekeep rituals.', scenario: 'The gate is sealed.', first_mes: 'The global gate opens.' } } })
      });
      const scriptPayload = await scriptRes.json() as { scriptCard: { id: string } };

      const worldBookRes = await fetch(`${base}/api/admin/resources/world-books/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worldBook: { name: 'Gate Lore', entries: [{ name: 'Candlekeep Gate', keys: ['Candlekeep'], content: 'The gate needs a silver key.', enabled: true, order: 150, position: 'after' }] } })
      });
      const worldBookPayload = await worldBookRes.json() as { worldBook: { id: string } };

      const presetRes = await fetch(`${base}/api/admin/resources/preset-packages/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          openAiSettings: {
            name: 'DND ST Preset',
            prompts: [
              { identifier: 'main', role: 'system', content: 'Imported main prompt.' },
              { identifier: 'charDescription', role: 'system', content: '' },
              { identifier: 'worldInfoAfter', role: 'system', content: '' }
            ],
            prompt_order: [{ order: [
              { identifier: 'main', enabled: true },
              { identifier: 'charDescription', enabled: true },
              { identifier: 'worldInfoAfter', enabled: true },
              { identifier: 'dndOutputContract', enabled: true }
            ] }]
          }
        })
      });
      const presetPayload = await presetRes.json() as { presetPackage: { id: string } };

      expect((await fetch(`${base}/api/admin/config/script-card`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scriptCardId: scriptPayload.scriptCard.id })
      })).status).toBe(200);
      expect((await fetch(`${base}/api/admin/config/resource-world-books`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bindings: [{ worldBookId: worldBookPayload.worldBook.id, enabled: true, orderIndex: 0 }] })
      })).status).toBe(200);
      expect((await fetch(`${base}/api/admin/config/preset-package`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetPackageId: presetPayload.presetPackage.id })
      })).status).toBe(200);

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as PromptPreviewPayload;
      expect(preview.mode).toBe('sillytavern-compatible');
      expect(preview.prompt).toContain('Imported main prompt.');
      expect(preview.slots.some((slot) => slot.key === 'charDescription' && slot.content.includes('keeper knows Candlekeep'))).toBe(true);
      expect(preview.worldBookMatches.some((match) => match.content.includes('silver key') && match.keys.includes('Candlekeep'))).toBe(true);
      expect(preview.prompt).toContain('The gate needs a silver key.');

      await fetch(`${base}/api/admin/config/script-card`, { method: 'DELETE' });
      const previewAfterClearRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      const previewAfterClear = await previewAfterClearRes.json() as PromptPreviewPayload;
      expect(previewAfterClear.prompt).not.toContain('keeper knows Candlekeep');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [ ] **Step 2: Update ST prompt builder unit tests to expect explicit AI config input**

In `server/src/tests/sillyTavernPromptBuilder.test.ts`, update `buildPreview()` to pass `aiConfig`:

```ts
function buildPreview(overrides: Partial<Parameters<typeof buildSillyTavernPromptPreview>[0]> = {}) {
  return buildSillyTavernPromptPreview({
    room,
    aiConfig: defaultAiConfig,
    players,
    publicLogs: [],
    actions,
    interactions: [],
    scriptCard,
    presetPackage,
    worldBookEntries,
    ...overrides
  });
}
```

- [ ] **Step 3: Run tests to verify failures**

Run:

```bash
rtk npm test -- --run server/src/tests/integration.test.ts -t "uses the current global ST resource config for every room prompt preview"
rtk npm test -- --run server/src/tests/sillyTavernPromptBuilder.test.ts
```

Expected: FAIL because global resource config endpoints do not exist and `buildSillyTavernPromptPreview` does not accept `aiConfig` yet.

- [ ] **Step 4: Extend `globalConfigService` for ST resource selection**

In `server/src/services/globalConfigService.ts`, add imports:

```ts
import type { PromptPresetPackage, ResourceWorldBookEntry, ScriptCard } from '../domain/types.js';
import { getPresetPackage, getResourceWorldBook, getResourceWorldBookEntries, getScriptCard } from './resourceLibrary.js';
```

Then add these functions:

```ts
export function setGlobalScriptCard(db: AppDatabase, scriptCardId: string): void {
  if (!getScriptCard(db, scriptCardId)) throw new Error('Script card not found');
  ensureGlobalConfig(db);
  db.prepare('UPDATE global_config SET active_script_card_id = ?, updated_at = ? WHERE id = ?')
    .run(scriptCardId, new Date().toISOString(), GLOBAL_CONFIG_ID);
}

export function clearGlobalScriptCard(db: AppDatabase): void {
  ensureGlobalConfig(db);
  db.prepare('UPDATE global_config SET active_script_card_id = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), GLOBAL_CONFIG_ID);
}

export function setGlobalPresetPackage(db: AppDatabase, presetPackageId: string): void {
  if (!getPresetPackage(db, presetPackageId)) throw new Error('Preset package not found');
  ensureGlobalConfig(db);
  db.prepare('UPDATE global_config SET active_preset_package_id = ?, updated_at = ? WHERE id = ?')
    .run(presetPackageId, new Date().toISOString(), GLOBAL_CONFIG_ID);
}

export function clearGlobalPresetPackage(db: AppDatabase): void {
  ensureGlobalConfig(db);
  db.prepare('UPDATE global_config SET active_preset_package_id = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), GLOBAL_CONFIG_ID);
}

export function replaceGlobalResourceWorldBookBindings(db: AppDatabase, bindings: Array<{ worldBookId: string; enabled: boolean; orderIndex: number }>): GlobalResourceWorldBookBinding[] {
  for (const binding of bindings) {
    if (!getResourceWorldBook(db, binding.worldBookId)) throw new Error('World book not found');
  }
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM global_world_book_bindings').run();
    for (const binding of bindings) {
      db.prepare('INSERT INTO global_world_book_bindings (world_book_id, enabled, order_index, created_at) VALUES (?, ?, ?, ?)')
        .run(binding.worldBookId, binding.enabled ? 1 : 0, binding.orderIndex, now);
    }
  });
  tx();
  return getGlobalResourceWorldBookBindings(db);
}

export function getActiveGlobalScriptCard(db: AppDatabase): ScriptCard | null {
  const snapshot = getGlobalConfigSnapshot(db);
  return snapshot.activeScriptCardId ? getScriptCard(db, snapshot.activeScriptCardId) : null;
}

export function getActiveGlobalPresetPackage(db: AppDatabase): PromptPresetPackage | null {
  const snapshot = getGlobalConfigSnapshot(db);
  return snapshot.activePresetPackageId ? getPresetPackage(db, snapshot.activePresetPackageId) : null;
}

export function getActiveGlobalResourceWorldBookEntries(db: AppDatabase): ResourceWorldBookEntry[] {
  return getGlobalResourceWorldBookBindings(db)
    .filter((binding) => binding.enabled)
    .flatMap((binding) => getResourceWorldBookEntries(db, binding.worldBookId));
}

export function clearMissingGlobalResourceSelections(db: AppDatabase): void {
  ensureGlobalConfig(db);
  db.prepare('UPDATE global_config SET active_script_card_id = NULL WHERE active_script_card_id IS NOT NULL AND active_script_card_id NOT IN (SELECT id FROM script_cards)').run();
  db.prepare('UPDATE global_config SET active_preset_package_id = NULL WHERE active_preset_package_id IS NOT NULL AND active_preset_package_id NOT IN (SELECT id FROM prompt_preset_packages)').run();
  db.prepare('DELETE FROM global_world_book_bindings WHERE world_book_id NOT IN (SELECT id FROM resource_world_books)').run();
}
```

- [ ] **Step 5: Add global resource config endpoints**

In `server/src/routes/adminRoutes.ts`, extend the global config import:

```ts
import { clearGlobalPresetPackage, clearGlobalScriptCard, createDefaultGlobalPreset, getActiveGlobalPresetPackage, getActiveGlobalResourceWorldBookEntries, getActiveGlobalScriptCard, getGlobalAiConfig, getGlobalConfigSnapshot, getGlobalResourceWorldBookBindings, replaceGlobalResourceWorldBookBindings, setGlobalPresetPackage, setGlobalScriptCard, updateGlobalAiConfig } from '../services/globalConfigService.js';
```

Add schemas near existing resource binding schemas:

```ts
const globalScriptConfigSchema = z.object({ scriptCardId: z.string().min(1) });
const globalResourceWorldBookConfigSchema = z.object({
  bindings: z.array(z.object({
    worldBookId: z.string().min(1),
    enabled: z.boolean(),
    orderIndex: z.number().int()
  }))
});
const globalPresetPackageConfigSchema = z.object({ presetPackageId: z.string().min(1) });
```

Add routes after `PUT /config/ai-config`:

```ts
  router.put('/config/script-card', (req, res) => {
    const input = globalScriptConfigSchema.parse(req.body);
    try {
      setGlobalScriptCard(db, input.scriptCardId);
      res.json(getGlobalConfigSnapshot(db));
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/config/script-card', (_req, res) => {
    clearGlobalScriptCard(db);
    res.json(getGlobalConfigSnapshot(db));
  });

  router.put('/config/resource-world-books', (req, res) => {
    const input = globalResourceWorldBookConfigSchema.parse(req.body);
    try {
      const bindings = replaceGlobalResourceWorldBookBindings(db, input.bindings);
      res.json({ bindings });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/config/preset-package', (req, res) => {
    const input = globalPresetPackageConfigSchema.parse(req.body);
    try {
      setGlobalPresetPackage(db, input.presetPackageId);
      res.json(getGlobalConfigSnapshot(db));
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/config/preset-package', (_req, res) => {
    clearGlobalPresetPackage(db);
    res.json(getGlobalConfigSnapshot(db));
  });
```

- [ ] **Step 6: Make ST prompt builder use explicit AI config**

In `server/src/services/sillyTavernPromptBuilder.ts`:

1. Add `AiConfig` to imports from `../domain/types.js`.
2. Add `aiConfig: AiConfig;` to `SillyTavernPromptBuilderInput`.
3. Replace both `renderDndOutputContract(input.room.aiConfig)` calls with:

```ts
renderDndOutputContract(input.aiConfig)
```

- [ ] **Step 7: Use global resource config in room prompt preview**

In `server/src/routes/adminRoutes.ts`, update `buildRoomPromptPreview`:

```ts
function buildRoomPromptPreview(db: AppDatabase, room: Room): { preview: PromptPreviewResponse; context: RoomPromptPreviewContext } {
  const context = loadRoomPromptPreviewContext(db, room);
  const aiConfig = getGlobalAiConfig(db);
  const presetPackage = getActiveGlobalPresetPackage(db);
  if (!presetPackage) return { preview: buildNativePromptPreview(room, context, aiConfig), context };

  return {
    preview: buildSillyTavernPromptPreview({
      room,
      aiConfig,
      players: context.players,
      publicLogs: context.publicLogs,
      actions: context.actions,
      interactions: context.interactions,
      scriptCard: getActiveGlobalScriptCard(db),
      presetPackage,
      worldBookEntries: getActiveGlobalResourceWorldBookEntries(db)
    }),
    context
  };
}
```

Then update `buildNativePromptPreview` signature to accept `aiConfig`:

```ts
function buildNativePromptPreview(room: Room, context: RoomPromptPreviewContext, aiConfig: AiConfig): PromptPreviewResponse {
```

Inside `buildNativePromptPreview`, replace `room.aiConfig` with the `aiConfig` parameter in both `buildTurnPrompt` and `renderDndOutputContract` calls.

- [ ] **Step 8: Make process-turn pass global AI config**

In `router.post('/rooms/:roomId/process-turn', ...)`, before calling `processTurnActions`, add:

```ts
      const aiConfig = getGlobalAiConfig(db);
```

Then replace:

```ts
        aiConfig: room.aiConfig,
```

with:

```ts
        aiConfig,
```

- [ ] **Step 9: Clear global selections after deleting selected resources**

In `server/src/routes/adminResourceRoutes.ts`, import:

```ts
import { clearMissingGlobalResourceSelections } from '../services/globalConfigService.js';
```

After each successful DELETE from `script_cards`, `resource_world_books`, and `prompt_preset_packages`, call:

```ts
    clearMissingGlobalResourceSelections(db);
```

- [ ] **Step 10: Run focused tests**

Run:

```bash
rtk npm test -- --run server/src/tests/integration.test.ts -t "uses the current global ST resource config for every room prompt preview"
rtk npm test -- --run server/src/tests/sillyTavernPromptBuilder.test.ts
```

Expected: PASS for the new global ST-compatible preview test and updated builder unit tests.

---

### Task 3: Move native presets/world books and room creation to global runtime config

**Files:**
- Modify: `server/src/services/globalConfigService.ts`
- Modify: `server/src/routes/adminRoutes.ts`
- Modify: `server/src/services/aiContextBuilder.ts`
- Modify: `server/src/services/turnEngine.ts`
- Modify: `server/src/tests/integration.test.ts`

- [ ] **Step 1: Replace native preset/world-book integration tests with global endpoint coverage**

In `server/src/tests/integration.test.ts`, replace the test named `saves AI constraints and returns them in prompt preview` with:

```ts
  it('updates global AI constraints and returns them in prompt preview for existing rooms', async () => {
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
        body: JSON.stringify({ name: 'Constraint Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const nextAiConfig = {
        coreRules: '核心约束：全局规则必须实时出现在预览中。',
        playerAgencyRules: '玩家自主权：全局规则绝不代替玩家说话。',
        visibilityRules: '信息隔离：全局规则绝不泄露其他玩家私密内容。',
        interactionRules: '互动规则：全局规则要求玩家互相影响时创建确认请求。',
        styleRules: '叙事风格：全局中文短句。',
        outputFormatRules: '输出格式：全局只返回结构化 JSON。'
      };
      const configRes = await fetch(`${base}/api/admin/config/ai-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(nextAiConfig)
      });
      expect(configRes.status).toBe(200);

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as PromptPreviewPayload;
      expect(preview.mode).toBe('native');
      expect(preview.messages).toEqual([{ role: 'system', content: preview.prompt }]);
      expect(preview.slots.some((slot) => slot.key === 'dndOutputContract')).toBe(true);
      expect(preview.promptBlocks.some((block) => block.source === 'dnd-contract')).toBe(true);
      expect(preview.prompt).toContain(nextAiConfig.coreRules);
      expect(preview.prompt).toContain(nextAiConfig.playerAgencyRules);
      expect(preview.prompt).toContain(nextAiConfig.outputFormatRules);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

In `server/src/tests/integration.test.ts`, replace the test named `saves presets and injects triggered world book entries into prompt preview` with:

```ts
  it('uses global native presets and global native world books in prompt preview', async () => {
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
        body: JSON.stringify({ name: 'Lore Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const presetRes = await fetch(`${base}/api/admin/config/presets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '调查预设',
          description: '强调线索公平性。',
          isActive: true,
          blocks: [
            { name: '调查规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 5, content: '调查规则：线索必须可追踪。' },
            { name: '输出格式', role: 'system', position: 'final', enabled: true, orderIndex: 900, content: '输出格式：只返回 JSON。' }
          ]
        })
      });
      expect(presetRes.status).toBe(200);

      const bookRes = await fetch(`${base}/api/admin/config/world-books`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '主世界书', description: '测试世界书', enabled: true })
      });
      expect(bookRes.status).toBe(200);
      const bookPayload = await bookRes.json() as { worldBooks: Array<{ id: string }> };
      const worldBookId = bookPayload.worldBooks[0].id;

      const entryRes = await fetch(`${base}/api/admin/config/world-books/${worldBookId}/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Candlekeep Gate',
          keys: ['Candlekeep'],
          secondaryKeys: [],
          content: 'Candlekeep 的月光门会回应银钥匙。',
          enabled: true,
          constant: true,
          selective: false,
          priority: 200,
          position: 'after_world'
        })
      });
      expect(entryRes.status).toBe(200);

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      const preview = await previewRes.json() as { prompt: string };
      expect(preview.prompt).toContain('调查规则：线索必须可追踪。');
      expect(preview.prompt).toContain('Candlekeep Gate');
      expect(preview.prompt).toContain('Candlekeep 的月光门会回应银钥匙。');
      expect(preview.prompt.indexOf('调查规则')).toBeLessThan(preview.prompt.indexOf('Room: Lore Room'));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

Also update the existing `keeps the full DND contract...` test with these exact request changes:

```ts
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Native Contract Room' })
      });
```

```ts
      const presetRes = await fetch(`${base}/api/admin/config/presets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '弱化输出预设',
          description: '测试最终契约追加。',
          isActive: true,
          blocks: [
            { name: '普通最终块', role: 'system', position: 'final', enabled: true, orderIndex: 10, content: '普通最终块：可以描述风格，但不能替代契约。' }
          ]
        })
      });
```

Update the existing `deduplicates a native preset block...` test with these exact request changes:

```ts
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Duplicate Contract Room' })
      });
```

```ts
      const presetRes = await fetch(`${base}/api/admin/config/presets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '完整契约重复预设',
          description: '测试完整契约去重。',
          isActive: true,
          blocks: [
            { name: '完整契约复制', role: 'system', position: 'final', enabled: true, orderIndex: 10, content: fullContract }
          ]
        })
      });
```

Replace the test named `imports ST resources through admin API and binds them to a room` with:

```ts
  it('imports ST resources through admin API and selects them in global config', async () => {
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
        body: JSON.stringify({ name: 'Import Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const missingScriptDeleteRes = await fetch(`${base}/api/admin/resources/script-cards/missing-script-card`, { method: 'DELETE' });
      expect(missingScriptDeleteRes.status).toBe(404);
      const missingWorldBookDeleteRes = await fetch(`${base}/api/admin/resources/world-books/missing-world-book`, { method: 'DELETE' });
      expect(missingWorldBookDeleteRes.status).toBe(404);
      const missingPresetDeleteRes = await fetch(`${base}/api/admin/resources/preset-packages/missing-preset-package`, { method: 'DELETE' });
      expect(missingPresetDeleteRes.status).toBe(404);

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

      const scriptConfigRes = await fetch(`${base}/api/admin/config/script-card`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scriptCardId: scriptPayload.scriptCard.id })
      });
      expect(scriptConfigRes.status).toBe(200);

      const worldConfigRes = await fetch(`${base}/api/admin/config/resource-world-books`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bindings: [{ worldBookId: worldBookPayload.worldBook.id, enabled: true, orderIndex: 0 }] })
      });
      expect(worldConfigRes.status).toBe(200);

      const presetConfigRes = await fetch(`${base}/api/admin/config/preset-package`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetPackageId: presetPayload.presetPackage.id })
      });
      expect(presetConfigRes.status).toBe(200);

      const adminRes = await fetch(`${base}/api/admin/rooms/${room.roomId}`);
      const adminState = await adminRes.json() as {
        scriptCards: unknown[];
        resourceWorldBooks: unknown[];
        resourceWorldBookEntries: unknown[];
        presetPackages: unknown[];
        globalScriptCardId: string;
        globalWorldBookBindings: unknown[];
        globalPresetPackageId: string;
      };
      expect(adminState.scriptCards).toHaveLength(1);
      expect(adminState.resourceWorldBooks).toHaveLength(1);
      expect(adminState.resourceWorldBookEntries).toHaveLength(1);
      expect(adminState.presetPackages).toHaveLength(1);
      expect(adminState.globalScriptCardId).toBe(scriptPayload.scriptCard.id);
      expect(adminState.globalWorldBookBindings).toHaveLength(1);
      expect(adminState.globalPresetPackageId).toBe(presetPayload.presetPackage.id);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [ ] **Step 2: Add test for opening log from global script card**

Append this test in `server/src/tests/integration.test.ts`:

```ts
  it('creates room opening log from current global script card without snapshotting future config', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const scriptRes = await fetch(`${base}/api/admin/resources/script-cards/import/sillytavern`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ characterCard: { data: { name: 'Opening Script', description: 'First description.', scenario: 'First scenario.', first_mes: 'First global opening.' } } })
      });
      const scriptPayload = await scriptRes.json() as { scriptCard: { id: string } };
      await fetch(`${base}/api/admin/config/script-card`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scriptCardId: scriptPayload.scriptCard.id })
      });

      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Opening Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const opening = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND title = ?').get(room.roomId, 'Opening Scene') as { content: string };
      expect(opening.content).toBe('First global opening.');

      await fetch(`${base}/api/admin/config/script-card`, { method: 'DELETE' });
      const openingAfterConfigChange = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND title = ?').get(room.roomId, 'Opening Scene') as { content: string };
      expect(openingAfterConfigChange.content).toBe('First global opening.');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [ ] **Step 3: Add test for process-turn using current global AI config**

Append this test in `server/src/tests/integration.test.ts`:

```ts
  it('processes turns with the current global AI config instead of room config', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const provider: AiProvider = {
      name: 'global-config-test-provider',
      async generateTurnResult(prompt) {
        expect(prompt).toContain('核心约束：处理回合必须读取全局配置。');
        expect(prompt).toContain('输出格式：处理回合使用全局 JSON 契约。');
        return {
          publicLog: 'Global config processed turn.',
          privateUpdatesByPlayer: {},
          ruleResults: [],
          interactionRequests: []
        };
      }
    };
    const app = createAdminOnlyApp(db, provider);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const nextAiConfig = {
        coreRules: '核心约束：处理回合必须读取全局配置。',
        playerAgencyRules: '玩家自主权：处理回合不能替玩家决定。',
        visibilityRules: '信息隔离：处理回合不能泄露秘密。',
        interactionRules: '互动规则：处理回合需要确认互动。',
        styleRules: '叙事风格：处理回合使用中文。',
        outputFormatRules: '输出格式：处理回合使用全局 JSON 契约。'
      };
      await fetch(`${base}/api/admin/config/ai-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(nextAiConfig)
      });

      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Global Turn Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const player = await playerRes.json() as { playerId: string };
      const turn = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?').get(room.roomId, 1) as { id: string };
      db.prepare('INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('global-config-action', room.roomId, turn.id, player.playerId, 'I test the global config.', new Date().toISOString(), 'submitted');

      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, { method: 'POST' });
      expect(processRes.status).toBe(200);
      const log = db.prepare('SELECT content FROM log_entries WHERE room_id = ? AND title = ?').get(room.roomId, 'Turn 1') as { content: string };
      expect(log.content).toBe('Global config processed turn.');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [ ] **Step 4: Run focused test to verify failures**

Run:

```bash
rtk npm test -- --run server/src/tests/integration.test.ts
```

Expected: FAIL because global native preset/world-book endpoints, global opening log behavior, and process-turn global AI config behavior do not all exist yet.

- [ ] **Step 5: Add global native preset write functions**

In `server/src/services/globalConfigService.ts`, add:

```ts
type GlobalPromptBlockInput = Omit<PromptBlock, 'id' | 'presetId'> & { id?: string };

interface GlobalPromptPresetInput {
  id?: string;
  name: string;
  description: string;
  isActive: boolean;
  blocks: GlobalPromptBlockInput[];
}

export function saveGlobalPreset(db: AppDatabase, input: GlobalPromptPresetInput): PromptPreset[] {
  const now = new Date().toISOString();
  const presetId = input.id ?? nanoid();
  const existing = input.id ? db.prepare('SELECT id FROM global_prompt_presets WHERE id = ?').get(input.id) : null;
  const tx = db.transaction(() => {
    if (input.isActive) db.prepare('UPDATE global_prompt_presets SET is_active = 0').run();
    if (existing) {
      db.prepare('UPDATE global_prompt_presets SET name = ?, description = ?, is_active = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.description, input.isActive ? 1 : 0, now, presetId);
      db.prepare('DELETE FROM global_prompt_blocks WHERE preset_id = ?').run(presetId);
    } else {
      db.prepare('INSERT INTO global_prompt_presets (id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(presetId, input.name, input.description, input.isActive ? 1 : 0, now, now);
    }
    for (const block of input.blocks) {
      db.prepare('INSERT INTO global_prompt_blocks (id, preset_id, name, role, position, enabled, order_index, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(block.id ?? nanoid(), presetId, block.name, block.role, block.position, block.enabled ? 1 : 0, block.orderIndex, block.content);
    }
  });
  tx();
  return getGlobalPresets(db);
}

export function activateGlobalPreset(db: AppDatabase, presetId: string): PromptPreset[] | null {
  const preset = db.prepare('SELECT id FROM global_prompt_presets WHERE id = ?').get(presetId);
  if (!preset) return null;
  const tx = db.transaction(() => {
    db.prepare('UPDATE global_prompt_presets SET is_active = 0').run();
    db.prepare('UPDATE global_prompt_presets SET is_active = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), presetId);
  });
  tx();
  return getGlobalPresets(db);
}
```

- [ ] **Step 6: Add global native world-book write functions**

In `server/src/services/globalConfigService.ts`, add:

```ts
export function createGlobalWorldBook(db: AppDatabase, input: { name: string; description: string; enabled: boolean }): { worldBooks: WorldBook[]; entries: WorldBookEntry[] } {
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO global_world_books (id, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, input.name, input.description, input.enabled ? 1 : 0, now, now);
  return { worldBooks: getGlobalWorldBooks(db), entries: getGlobalWorldBookEntries(db) };
}

export function createGlobalWorldBookEntry(db: AppDatabase, worldBookId: string, input: Omit<WorldBookEntry, 'id' | 'worldBookId' | 'createdAt' | 'updatedAt'>): { worldBooks: WorldBook[]; entries: WorldBookEntry[] } | null {
  const book = db.prepare('SELECT id FROM global_world_books WHERE id = ?').get(worldBookId);
  if (!book) return null;
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO global_world_book_entries (id, world_book_id, title, keys_json, secondary_keys_json, content, enabled, constant, selective, priority, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, worldBookId, input.title, JSON.stringify(input.keys), JSON.stringify(input.secondaryKeys), input.content, input.enabled ? 1 : 0, input.constant ? 1 : 0, input.selective ? 1 : 0, input.priority, input.position, now, now);
  return { worldBooks: getGlobalWorldBooks(db), entries: getGlobalWorldBookEntries(db) };
}

export function updateGlobalWorldBookEntry(db: AppDatabase, worldBookId: string, entryId: string, input: Omit<WorldBookEntry, 'id' | 'worldBookId' | 'createdAt' | 'updatedAt'>): { worldBooks: WorldBook[]; entries: WorldBookEntry[] } | null {
  const book = db.prepare('SELECT id FROM global_world_books WHERE id = ?').get(worldBookId);
  if (!book) return null;
  const result = db.prepare('UPDATE global_world_book_entries SET title = ?, keys_json = ?, secondary_keys_json = ?, content = ?, enabled = ?, constant = ?, selective = ?, priority = ?, position = ?, updated_at = ? WHERE id = ? AND world_book_id = ?')
    .run(input.title, JSON.stringify(input.keys), JSON.stringify(input.secondaryKeys), input.content, input.enabled ? 1 : 0, input.constant ? 1 : 0, input.selective ? 1 : 0, input.priority, input.position, new Date().toISOString(), entryId, worldBookId);
  if (result.changes === 0) return null;
  return { worldBooks: getGlobalWorldBooks(db), entries: getGlobalWorldBookEntries(db) };
}
```

- [ ] **Step 7: Add global native preset/world-book routes**

In `server/src/routes/adminRoutes.ts`, extend global service imports with:

```ts
activateGlobalPreset, createGlobalWorldBook, createGlobalWorldBookEntry, getActiveGlobalPromptBlocks, getGlobalWorldBookEntries, saveGlobalPreset, updateGlobalWorldBookEntry
```

Add global preset routes after config resource routes:

```ts
  router.post('/config/presets', (req, res) => {
    const input = presetSchema.parse(req.body);
    res.json({ presets: saveGlobalPreset(db, input) });
  });

  router.put('/config/presets/:presetId', (req, res) => {
    const input = presetSchema.parse(req.body);
    const presets = saveGlobalPreset(db, { ...input, id: req.params.presetId });
    res.json({ presets });
  });

  router.post('/config/presets/:presetId/activate', (req, res) => {
    const presets = activateGlobalPreset(db, req.params.presetId);
    if (!presets) return res.status(404).json({ error: 'Preset not found' });
    res.json({ presets });
  });
```

Add global world-book routes:

```ts
  router.post('/config/world-books', (req, res) => {
    const input = worldBookSchema.parse(req.body);
    res.json(createGlobalWorldBook(db, input));
  });

  router.post('/config/world-books/:worldBookId/entries', (req, res) => {
    const input = worldBookEntrySchema.parse(req.body);
    const result = createGlobalWorldBookEntry(db, req.params.worldBookId, input);
    if (!result) return res.status(404).json({ error: 'World book not found' });
    res.json(result);
  });

  router.put('/config/world-books/:worldBookId/entries/:entryId', (req, res) => {
    const input = worldBookEntrySchema.parse(req.body);
    const result = updateGlobalWorldBookEntry(db, req.params.worldBookId, req.params.entryId, input);
    if (!result) return res.status(404).json({ error: 'World book entry not found' });
    res.json(result);
  });
```

Leave old room preset/world-book routes in place for now; frontend will stop calling them in Task 4.

- [ ] **Step 8: Use global native presets/world books in preview context**

In `server/src/routes/adminRoutes.ts`, update `loadRoomPromptPreviewContext`:

1. Remove `promptBlocks: getActivePromptBlocks(db, room.id)`.
2. Build native world book matches from global entries:

```ts
  const scanText = buildWorldBookScanText({ roomWorldInfo: room.worldInfo, publicLogs, actions, players });
  const worldBookMatches = matchWorldBookEntries(getGlobalWorldBookEntries(db), scanText);
  return { turn: turn ?? null, players, actions, publicLogs, interactions, promptBlocks: getActiveGlobalPromptBlocks(db), worldBookMatches };
```

- [ ] **Step 9: Add global script card context to native prompt**

In `server/src/services/aiContextBuilder.ts`:

1. Add `ScriptCard` to imports.
2. Add `scriptCard?: ScriptCard | null;` to `buildTurnPrompt` input.
3. Insert script-card sections before `Room: ${input.room.name}`:

```ts
    ...(input.scriptCard ? [
      '# 全局主剧本卡',
      [`名称：${input.scriptCard.name}`, input.scriptCard.description, input.scriptCard.personality, input.scriptCard.scenario].filter(Boolean).join('\n')
    ] : []),
```

In `server/src/routes/adminRoutes.ts`:

1. Add `ScriptCard` to the type imports from `../domain/types.js`.
2. Change `buildNativePromptPreview` to accept the active global script card:

```ts
function buildNativePromptPreview(room: Room, context: RoomPromptPreviewContext, aiConfig: AiConfig, scriptCard: ScriptCard | null): PromptPreviewResponse {
```

3. Pass it through to `buildTurnPrompt`:

```ts
    scriptCard,
```

4. In `buildRoomPromptPreview`, change the native return path to:

```ts
  if (!presetPackage) return { preview: buildNativePromptPreview(room, context, aiConfig, getActiveGlobalScriptCard(db)), context };
```

In `server/src/services/turnEngine.ts`:

1. Add `ScriptCard` to the type imports from `../domain/types.js`.
2. Add `scriptCard?: ScriptCard | null;` to `ProcessTurnActionsInput`.
3. Pass it through to `buildTurnPrompt`:

```ts
    scriptCard: input.scriptCard,
```

In `router.post('/rooms/:roomId/process-turn', ...)`, pass the current global script card into native turn processing:

```ts
        scriptCard: getActiveGlobalScriptCard(db),
```

- [ ] **Step 10: Make opening log use current global script card**

In `server/src/routes/adminRoutes.ts`, add helper above `createAdminRouter`:

```ts
function globalOpeningScene(db: AppDatabase): string {
  const scriptCard = getActiveGlobalScriptCard(db);
  return scriptCard?.firstMes.trim() || scriptCard?.scenario.trim() || '此房间已创建。请在全局配置中选择主剧本卡后开始游戏。';
}
```

In `router.post('/rooms', ...)`, replace the opening log content string with:

```ts
        .run(nanoid(), roomId, turnId, 'public', null, 'Opening Scene', globalOpeningScene(db), now);
```

- [ ] **Step 11: Run focused backend tests**

Run:

```bash
rtk npm test -- --run server/src/tests/integration.test.ts
```

Expected: PASS for backend integration tests after updating remaining room creation payloads to `{ name }` and changing old room-scoped preset/world-book requests to global config endpoints.

---

### Task 4: Update client API and types for global config

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/api.ts`
- Modify: `client/src/api.test.tsx`
- Modify: `client/src/ui-copy.test.tsx`

- [ ] **Step 1: Write failing client API tests for global config helpers**

In `client/src/api.test.tsx`:

1. Replace imports of room binding helpers with global helpers:

```ts
  clearGlobalPresetPackage,
  clearGlobalScriptCard,
  getGlobalConfig,
  putGlobalPresetPackage,
  putGlobalResourceWorldBookBindings,
  putGlobalScriptCard,
  saveGlobalAiConfig,
```

2. Replace the test named `requests room resource binding endpoints with expected methods and bodies` with:

```ts
  it('requests global config endpoints with expected methods and bodies', async () => {
    const fetchMock = mockFetchJson({ aiConfig: {}, bindings: [] });
    const aiConfig = {
      coreRules: '核心',
      playerAgencyRules: '自主',
      visibilityRules: '隔离',
      interactionRules: '互动',
      outputFormatRules: '输出',
      styleRules: '风格'
    };
    const bindings = [{ worldBookId: 'world-1', enabled: true, orderIndex: 0 }];

    await getGlobalConfig();
    await saveGlobalAiConfig(aiConfig);
    await putGlobalScriptCard('script-1');
    await clearGlobalScriptCard();
    await putGlobalResourceWorldBookBindings(bindings);
    await putGlobalPresetPackage('preset-1');
    await clearGlobalPresetPackage();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/config', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/config/ai-config', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(aiConfig)
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/config/script-card', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ scriptCardId: 'script-1' })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/config/script-card', expect.objectContaining({ method: 'DELETE' }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/admin/config/resource-world-books', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ bindings })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(6, '/api/admin/config/preset-package', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ presetPackageId: 'preset-1' })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(7, '/api/admin/config/preset-package', expect.objectContaining({ method: 'DELETE' }));
  });
```

3. Add a test for room creation payload:

```ts
  it('creates rooms with only a name because configuration is global', async () => {
    const fetchMock = mockFetchJson({ roomId: 'room-1', adminUrl: '/admin/room-1' });

    await createRoom({ name: '全局配置房间' });

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/rooms', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: '全局配置房间' })
    }));
  });
```

- [ ] **Step 2: Run client API test to verify it fails**

Run:

```bash
rtk npm test -- --run client/src/api.test.tsx
```

Expected: FAIL because global config helpers and new createRoom signature do not exist.

- [ ] **Step 3: Update client types**

In `client/src/types.ts`:

1. Add:

```ts
export interface GlobalResourceWorldBookBinding {
  worldBookId: string;
  enabled: boolean;
  orderIndex: number;
  createdAt: string;
}

export interface GlobalConfigSnapshot {
  aiConfig: AiConfig;
  activeScriptCardId: string | null;
  activePresetPackageId: string | null;
  globalWorldBookBindings: GlobalResourceWorldBookBinding[];
  presets: PromptPreset[];
  worldBooks: WorldBook[];
  worldBookEntries: WorldBookEntry[];
  scriptCards: ScriptCard[];
  resourceWorldBooks: ResourceWorldBook[];
  resourceWorldBookEntries: ResourceWorldBookEntry[];
  presetPackages: PromptPresetPackage[];
}
```

2. Keep `PromptPreset.roomId` and `WorldBook.roomId` for compatibility because server returns `'global'` while old code still compiles.

3. Update `AdminState` to include global config fields while keeping top-level aliases:

```ts
export interface AdminState {
  room: Room;
  players: Player[];
  turns: Turn[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
  logs: LogEntry[];
  aiGenerations: AiGeneration[];
  globalConfig: GlobalConfigSnapshot;
  presets: PromptPreset[];
  worldBooks: WorldBook[];
  worldBookEntries: WorldBookEntry[];
  scriptCards: ScriptCard[];
  resourceWorldBooks: ResourceWorldBook[];
  resourceWorldBookEntries: ResourceWorldBookEntry[];
  presetPackages: PromptPresetPackage[];
  globalScriptCardId: string | null;
  globalWorldBookBindings: GlobalResourceWorldBookBinding[];
  globalPresetPackageId: string | null;
  roomScriptBinding: RoomScriptBinding | null;
  roomWorldBookBindings: RoomWorldBookBinding[];
  roomPresetBinding: RoomPresetBinding | null;
}
```

Keep `roomScriptBinding`, `roomWorldBookBindings`, and `roomPresetBinding` in `AdminState` as compatibility fields during this change. Task 5 stops reading them from the UI; a later cleanup can remove the unused response fields together with the old room binding endpoints.

- [ ] **Step 4: Update API helpers**

In `client/src/api.ts`:

1. Add `GlobalConfigSnapshot` and `GlobalResourceWorldBookBinding` imports.
2. Replace `createRoom` with:

```ts
export function createRoom(input: { name: string }) {
  return jsonRequest<{ roomId: string; adminUrl: string }>('/api/admin/rooms', { method: 'POST', body: JSON.stringify(input) });
}
```

3. Replace room-scoped AI config helper with global helper:

```ts
export function getGlobalConfig() {
  return jsonRequest<GlobalConfigSnapshot>('/api/admin/config');
}

export function saveGlobalAiConfig(aiConfig: AiConfig) {
  return jsonRequest<AiConfig>('/api/admin/config/ai-config', { method: 'PUT', body: JSON.stringify(aiConfig) });
}
```

4. Keep `previewAiPrompt(roomId)` unchanged.

5. Replace `savePreset` and `activatePreset` with global endpoints:

```ts
export function savePreset(preset: Omit<PromptPreset, 'id' | 'roomId' | 'createdAt' | 'updatedAt'> & { id?: string }) {
  const method = preset.id ? 'PUT' : 'POST';
  const url = preset.id ? `/api/admin/config/presets/${preset.id}` : '/api/admin/config/presets';
  return jsonRequest<{ presets: PromptPreset[] }>(url, { method, body: JSON.stringify(preset) });
}

export function activatePreset(presetId: string) {
  return jsonRequest<{ presets: PromptPreset[] }>(`/api/admin/config/presets/${presetId}/activate`, { method: 'POST' });
}
```

6. Replace `createWorldBook` and `createWorldBookEntry` with global endpoints:

```ts
export function createWorldBook(input: { name: string; description: string; enabled: boolean }) {
  return jsonRequest<{ worldBooks: WorldBook[]; entries: WorldBookEntry[] }>('/api/admin/config/world-books', { method: 'POST', body: JSON.stringify(input) });
}

export function createWorldBookEntry(worldBookId: string, input: Omit<WorldBookEntry, 'id' | 'worldBookId' | 'createdAt' | 'updatedAt'>) {
  return jsonRequest<{ worldBooks: WorldBook[]; entries: WorldBookEntry[] }>(`/api/admin/config/world-books/${worldBookId}/entries`, { method: 'POST', body: JSON.stringify(input) });
}
```

7. Replace room resource binding helpers with global config helpers:

```ts
export function putGlobalScriptCard(scriptCardId: string) {
  return jsonRequest<GlobalConfigSnapshot>('/api/admin/config/script-card', { method: 'PUT', body: JSON.stringify({ scriptCardId }) });
}

export function clearGlobalScriptCard() {
  return jsonRequest<GlobalConfigSnapshot>('/api/admin/config/script-card', { method: 'DELETE' });
}

export function putGlobalResourceWorldBookBindings(bindings: Array<{ worldBookId: string; enabled: boolean; orderIndex: number }>) {
  return jsonRequest<{ bindings: GlobalResourceWorldBookBinding[] }>('/api/admin/config/resource-world-books', { method: 'PUT', body: JSON.stringify({ bindings }) });
}

export function putGlobalPresetPackage(presetPackageId: string) {
  return jsonRequest<GlobalConfigSnapshot>('/api/admin/config/preset-package', { method: 'PUT', body: JSON.stringify({ presetPackageId }) });
}

export function clearGlobalPresetPackage() {
  return jsonRequest<GlobalConfigSnapshot>('/api/admin/config/preset-package', { method: 'DELETE' });
}
```

- [ ] **Step 5: Update server admin state response to match client shape**

In `server/src/routes/adminRoutes.ts`, in `GET /rooms/:roomId`, replace resource binding fields with global config fields:

```ts
    const globalConfig = getGlobalConfigSnapshot(db);
    res.json({
      room: { ...room, aiConfig: globalConfig.aiConfig },
      players,
      turns,
      actions,
      interactions,
      logs,
      aiGenerations,
      globalConfig,
      presets: globalConfig.presets,
      worldBooks: globalConfig.worldBooks,
      worldBookEntries: globalConfig.worldBookEntries,
      scriptCards: globalConfig.scriptCards,
      resourceWorldBooks: globalConfig.resourceWorldBooks,
      resourceWorldBookEntries: globalConfig.resourceWorldBookEntries,
      presetPackages: globalConfig.presetPackages,
      globalScriptCardId: globalConfig.activeScriptCardId,
      globalWorldBookBindings: globalConfig.globalWorldBookBindings,
      globalPresetPackageId: globalConfig.activePresetPackageId,
      roomScriptBinding: null,
      roomWorldBookBindings: [],
      roomPresetBinding: null
    });
```

- [ ] **Step 6: Run API tests**

Run:

```bash
rtk npm test -- --run client/src/api.test.tsx server/src/tests/integration.test.ts
```

Expected: PASS for API helper tests and backend integration tests.

---

### Task 5: Update frontend UI to edit global config

**Files:**
- Modify: `client/src/pages/HomePage.tsx`
- Modify: `client/src/pages/AdminPage.tsx`
- Modify: `client/src/components/RoomResourceBindingsPanel.tsx`
- Modify: `client/src/ui-copy.test.tsx`

- [ ] **Step 1: Update UI smoke tests for global config copy**

In `client/src/ui-copy.test.tsx`:

1. Update the mocked `AdminState` object:
   - Add `globalConfig` with `aiConfig`, `activeScriptCardId: 'script-1'`, `activePresetPackageId: null`, `globalWorldBookBindings: []`, and the existing resource arrays.
   - Add `globalScriptCardId: 'script-1'`.
   - Add `globalWorldBookBindings: []`.
   - Add `globalPresetPackageId: null`.
   - Keep compatibility fields as `roomScriptBinding: null`, `roomWorldBookBindings: []`, and `roomPresetBinding: null`; the UI assertions should no longer depend on those fields.

2. Update the mocked API exports in `vi.mock('./api', ...)` so imported global helpers exist:

```ts
  saveGlobalAiConfig: vi.fn(async (aiConfig) => aiConfig),
  putGlobalScriptCard: vi.fn(),
  clearGlobalScriptCard: vi.fn(),
  putGlobalResourceWorldBookBindings: vi.fn(),
  putGlobalPresetPackage: vi.fn(),
  clearGlobalPresetPackage: vi.fn(),
```

3. Update the homepage test to assert the removed fields:

```ts
  it('首页使用中文创建房间文案', () => {
    render(<HomePage />);

    expect(screen.getByText('创建本地多人跑团房间，并为每位玩家隔离可见信息。')).toBeInTheDocument();
    expect(screen.getByText('所有房间都会实时使用当前全局配置。')).toBeInTheDocument();
    expect(screen.getByText('房间名称')).toBeInTheDocument();
    expect(screen.queryByText('世界信息')).not.toBeInTheDocument();
    expect(screen.queryByText('AI-DM 指令')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建房间' })).toBeInTheDocument();
  });
```

4. Update admin tab test resource expectations:

```ts
    await user.click(screen.getByRole('button', { name: '资源' }));
    expect(screen.getByText('全局资源库 / 导入')).toBeInTheDocument();
    expect(screen.getByText('全局资源配置')).toBeInTheDocument();
    expect(screen.queryByText('房间资源绑定')).not.toBeInTheDocument();
```

5. Rename the test `管理页切换标签页不会清空未保存的主剧本卡选择` to:

```ts
  it('管理页切换标签页不会清空未保存的全局主剧本卡选择', async () => {
```

Keep the interaction the same: enter resource tab, change the first combobox to `script-2`, switch tabs, return, and assert the selection persists.

- [ ] **Step 2: Run UI test to verify failures**

Run:

```bash
rtk npm test -- --run client/src/ui-copy.test.tsx
```

Expected: FAIL because UI still shows room-scoped fields and copy.

- [ ] **Step 3: Update HomePage**

In `client/src/pages/HomePage.tsx`:

1. Remove `worldInfo` and `systemPrompt` state.
2. Change submit to:

```tsx
      const room = await createRoom({ name });
```

3. Replace the form JSX with:

```tsx
        <div className="page-header">
          <h1>DND AI-DM</h1>
          <p className="muted">创建本地多人跑团房间，并为每位玩家隔离可见信息。</p>
          <p className="muted">所有房间都会实时使用当前全局配置。</p>
        </div>
        <label>房间名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        {error ? <p>{error}</p> : null}
        <button onClick={submit}>创建房间</button>
```

- [ ] **Step 4: Convert RoomResourceBindingsPanel to global resource config**

In `client/src/components/RoomResourceBindingsPanel.tsx`:

1. Rename exported function to `GlobalResourceConfigPanel`.
2. Replace imports from `../api` with:

```ts
import { clearGlobalPresetPackage, clearGlobalScriptCard, putGlobalPresetPackage, putGlobalResourceWorldBookBindings, putGlobalScriptCard } from '../api';
```

Replace the type import with:

```ts
import type { GlobalResourceWorldBookBinding, PromptPresetPackage, ResourceWorldBook, ScriptCard } from '../types';
```

3. Replace prop type with:

```ts
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
```

4. Remove `roomId` from effects and dependencies.
5. Replace prop synchronization:

```ts
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
```

6. Replace API calls:

```ts
      await putGlobalScriptCard(selectedScriptCardId);
```

```ts
      await clearGlobalScriptCard();
```

```ts
      await putGlobalResourceWorldBookBindings(selectedWorldBookIds.map((worldBookId, orderIndex) => ({ worldBookId, enabled: true, orderIndex })));
```

```ts
      await putGlobalPresetPackage(selectedPresetPackageId);
```

```ts
      await clearGlobalPresetPackage();
```

7. Replace heading and copy:

```tsx
      <h2>全局资源配置</h2>
      <p className="muted">所有房间都会实时使用这里选择的剧本卡、世界书和 ST 兼容预设包。</p>
```

8. Replace disabled checks:

```tsx
<button onClick={() => void unbindScriptCard()} disabled={!globalScriptCardId}>清除主剧本卡</button>
```

```tsx
<button onClick={() => void unbindPresetPackage()} disabled={!globalPresetPackageId}>清除 ST 兼容预设包</button>
```

Keep the existing dirty refs so tab switching and refresh do not overwrite unsaved local selections.

- [ ] **Step 5: Update AdminPage imports and global state usage**

In `client/src/pages/AdminPage.tsx`:

1. Replace imports:

```ts
import { addPlayer, activatePreset, createWorldBook, createWorldBookEntry, getAdminState, previewAiPrompt, processTurn, saveGlobalAiConfig, savePreset, subscribeRoom } from '../api';
```

```ts
import { GlobalResourceConfigPanel } from '../components/RoomResourceBindingsPanel';
```

2. In `refresh()`, replace:

```ts
setAiConfig(nextState.room.aiConfig);
```

with:

```ts
setAiConfig(nextState.globalConfig.aiConfig);
```

3. In `persistAiConfig()`, replace:

```ts
const saved = await saveAiConfig(roomId, aiConfig);
```

with:

```ts
const saved = await saveGlobalAiConfig(aiConfig);
```

4. In `persistPresetDraft()`, replace:

```ts
const result = await savePreset(roomId, presetDraft);
```

with:

```ts
const result = await savePreset(presetDraft);
```

5. In `usePreset()`, replace:

```ts
const result = await activatePreset(roomId, presetId);
```

with:

```ts
const result = await activatePreset(presetId);
```

6. In `addWorldBook()`, replace:

```ts
const result = await createWorldBook(roomId, { name: worldBookName, description: '用于按关键词注入世界设定和隐藏知识。', enabled: true });
```

with:

```ts
const result = await createWorldBook({ name: worldBookName, description: '用于按关键词注入世界设定和隐藏知识。', enabled: true });
```

7. In `addWorldEntry()`, replace:

```ts
const result = await createWorldBookEntry(roomId, book.id, entryDraft);
```

with:

```ts
const result = await createWorldBookEntry(book.id, entryDraft);
```

8. Update AI tab copy:

```tsx
<p className="muted">所有房间都会实时使用当前全局 AI 约束。像 SillyTavern 预设一样，按固定顺序约束 AI-DM 的身份、玩家自主权、信息隔离、互动裁定、叙事风格和输出格式。</p>
```

9. Replace `<RoomResourceBindingsPanel ... />` with:

```tsx
        <GlobalResourceConfigPanel
          scriptCards={state.scriptCards}
          resourceWorldBooks={state.resourceWorldBooks}
          presetPackages={state.presetPackages}
          globalScriptCardId={state.globalScriptCardId}
          globalWorldBookBindings={state.globalWorldBookBindings}
          globalPresetPackageId={state.globalPresetPackageId}
          onChanged={refresh}
          setError={setError}
        />
```

10. Update preset tab copy:

```tsx
<p className="muted">全局提示词预设会实时影响所有房间，可启用、排序并决定注入位置。</p>
```

11. Update world book tab copy:

```tsx
<p className="muted">全局原生世界书会实时参与所有房间的 AI 上下文构建。</p>
```

- [ ] **Step 6: Update standalone component test imports**

In `client/src/ui-copy.test.tsx`, replace:

```ts
import { RoomResourceBindingsPanel } from './components/RoomResourceBindingsPanel';
```

with:

```ts
import { GlobalResourceConfigPanel } from './components/RoomResourceBindingsPanel';
```

Replace the standalone room binding test with:

```tsx
  it('未保存的全局主剧本卡选择不会被父级旧配置刷新覆盖，保存后调用全局配置 API', async () => {
    const user = userEvent.setup();
    vi.mocked(api.putGlobalScriptCard).mockResolvedValueOnce({} as never);
    const onChanged = vi.fn(async () => {});
    const scriptCards: ScriptCard[] = [
      {
        id: 'script-1',
        name: '旧剧本卡',
        description: '',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        creatorNotes: '',
        visibilityNotes: '',
        sourceType: 'sillytavern_character',
        rawJson: {},
        createdAt: '2026-05-27T00:00:00.000Z',
        updatedAt: '2026-05-27T00:00:00.000Z'
      },
      {
        id: 'script-2',
        name: '新剧本卡',
        description: '',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        creatorNotes: '',
        visibilityNotes: '',
        sourceType: 'sillytavern_character',
        rawJson: {},
        createdAt: '2026-05-27T00:00:00.000Z',
        updatedAt: '2026-05-27T00:00:00.000Z'
      }
    ];
    const props = {
      scriptCards,
      resourceWorldBooks: [],
      presetPackages: [],
      globalScriptCardId: 'script-1',
      globalWorldBookBindings: [],
      globalPresetPackageId: null,
      onChanged,
      setError: vi.fn()
    };

    const { rerender } = render(<GlobalResourceConfigPanel {...props} />);
    const scriptSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;

    await user.selectOptions(scriptSelect, 'script-2');
    rerender(<GlobalResourceConfigPanel {...props} />);

    expect(scriptSelect.value).toBe('script-2');

    await user.click(screen.getByRole('button', { name: '绑定主剧本卡' }));

    await waitFor(() => expect(api.putGlobalScriptCard).toHaveBeenCalledWith('script-2'));
    expect(onChanged).toHaveBeenCalled();
  });
```

- [ ] **Step 7: Run UI tests**

Run:

```bash
rtk npm test -- --run client/src/ui-copy.test.tsx client/src/api.test.tsx
```

Expected: PASS for focused frontend tests.

---

### Task 6: Full validation and browser verification

**Files:**
- No source changes unless validation finds a bug.

- [ ] **Step 1: Run full tests**

Run:

```bash
rtk npm test
```

Expected: PASS for all test files.

- [ ] **Step 2: Run typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
rtk npm run build
```

Expected: PASS.

- [ ] **Step 4: Browser verification**

Run the dev server:

```bash
rtk npm run dev
```

Verify in browser:

- Homepage loads.
- Homepage create-room form only shows `房间名称`; it does not show `世界信息` or `AI-DM 指令`.
- Homepage says all rooms use current global configuration in real time.
- Create a room and open admin page.
- Admin page tabs still show `总览`, `AI 约束`, `资源`, `预设`, `世界书`.
- `AI 约束` tab says all rooms use global AI constraints in real time.
- Save AI constraints, preview prompt, confirm prompt uses saved global text.
- `资源` tab shows `全局资源库 / 导入` and `全局资源配置`; it does not show `房间资源绑定`.
- Import ST script card, world book, and preset package; select them in global resource config.
- Prompt Preview for the existing room switches to `sillytavern-compatible` without recreating the room.
- Clear or change global script card and confirm the same room preview changes on the next preview request.
- Create a second room and confirm its preview uses the same current global config.
- `预设` tab still supports collapsed prompt blocks and adding a block auto-expands it.
- `世界书` tab creates global native world book entries and existing rooms can use them in preview.
- Create a player link and open the player page; player view still renders.

- [ ] **Step 5: Cleanup generated files**

Check generated files:

```bash
rtk git status --short
rtk git check-ignore -v server/dnd.sqlite server/dist client/dist
```

Expected:

- No unexpected temporary files.
- `server/dnd.sqlite`, `server/dist`, and `client/dist` are ignored.
- No temporary Playwright/browser artifacts remain.
- Do not commit unless the user explicitly asks.
