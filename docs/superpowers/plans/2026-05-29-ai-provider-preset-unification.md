# AI Provider Preset Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增可在管理台保存和测试的全局 AI 接口配置，并把独立“AI 约束”运行时来源完全并入全局预设/提示词块体系。

**Architecture:** `global_config` 继续作为单例配置行，新增 `ai_provider_config_json` 保存 provider/baseUrl/apiKey/model；`process-turn` 每次从数据库读取当前 provider 配置并创建 provider。Prompt 构建不再读取 `AiConfig` / `ai_config_json`，用户可编辑规则只来自当前启用的全局预设 blocks，DND 输出契约作为固定引擎契约追加。

**Tech Stack:** TypeScript, Express, SQLite (`better-sqlite3`), React, Vite, Vitest, Testing Library, Playwright MCP.

---

## 协作约束

- 按用户全局规则：继续在当前 `master` 分支开发，不创建新分支、不创建 worktree。
- 所有外部 CLI 命令必须加 `rtk` 前缀。
- 不自动提交；每个任务末尾只做检查点说明。只有用户明确要求提交时才运行 `git add` / `git commit`。
- 如果实现中创建临时脚本或验证文件，结束前删除；若必须保留，追加精确路径到 `.gitignore` 并用 `rtk git check-ignore -v <path>` 验证。

## File Structure

- Modify: `server/src/db/schema.ts`
  - 为 `global_config` 增加 `ai_provider_config_json` 字段和既有数据库迁移。
- Modify: `server/src/domain/types.ts`
  - 增加 `AiProviderConfig` / provider 类型；让全局配置快照可返回 provider 配置。
- Modify: `server/src/config.ts`
  - 移除运行时 AI provider 的 env 配置职责，只保留端口和数据库路径。
- Modify: `server/src/services/globalConfigService.ts`
  - 管理 AI provider config 的默认值、解析、校验、读取、保存。
  - 保留旧 `ai_config_json` 作为默认预设迁移/兼容来源。
- Modify: `server/src/services/aiProvider.ts`
  - 让 OpenAI-compatible provider 接收 `AiProviderConfig`，新增 `createAiProviderFromConfig()` 和 `testAiProviderConfig()`。
- Modify: `server/src/app.ts`
  - 不再启动时创建固定 `aiProvider`。
- Modify: `server/src/routes/adminRoutes.ts`
  - 新增 `/api/admin/config/ai-provider` GET/PUT/test。
  - `process-turn` 每次读取 DB provider 配置。
  - Prompt preview 不再读取 `getGlobalAiConfig()`。
- Modify: `server/src/services/aiContextBuilder.ts`
  - `renderDndOutputContract()` 改为固定引擎契约。
  - `buildTurnPrompt()` 移除 `aiConfig` 输入和 `defaultPromptBlocks(aiConfig)` 运行时 fallback。
- Modify: `server/src/services/sillyTavernPromptBuilder.ts`
  - 移除 `aiConfig` 输入；ST-compatible prompt 的 `dndOutputContract` 使用固定引擎契约。
- Modify: `server/src/services/turnEngine.ts`
  - 移除 `aiConfig` 输入透传。
- Modify: `server/src/tests/integration.test.ts`
  - 覆盖 AI provider 配置 API、运行时 provider 实时读取、prompt 不再依赖 `ai_config_json`。
- Modify: `client/src/types.ts`
  - 增加 `AiProviderConfig` 类型。
- Modify: `client/src/api.ts`
  - 增加 AI provider config helpers；移除前端产品入口对 `saveGlobalAiConfig()` 的依赖。
- Modify: `client/src/api.test.tsx`
  - 覆盖新 AI provider helper；删除全局 AI 约束 helper 调用断言。
- Modify: `client/src/pages/AdminPage.tsx`
  - 标签从 `AI 约束` 改为 `AI 接口`。
  - 新增 provider/baseUrl/apiKey/model 表单和保存/测试按钮。
  - Prompt Preview 移到 `预设` 页。
- Modify: `client/src/ui-copy.test.tsx`
  - 覆盖管理台标签、AI 接口表单、预设页 preview、错误提示。

---

### Task 1: Add DB-backed AI provider config service

**Files:**
- Modify: `server/src/db/schema.ts:201-208,300-304`
- Modify: `server/src/domain/types.ts:13-31,268-280`
- Modify: `server/src/services/globalConfigService.ts:3-38,215-249,453-468`
- Modify: `server/src/tests/integration.test.ts:33-95`

- [ ] **Step 1: Write failing integration tests for provider config defaults, save, and validation**

Add this test block near the top of `describe('DND AI-DM integration', ...)` in `server/src/tests/integration.test.ts`, after the first end-to-end room test:

```ts
  it('stores global AI provider config with defaults and validates openai-compatible input', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const defaultRes = await fetch(`${base}/api/admin/config/ai-provider`);
      expect(defaultRes.status).toBe(200);
      expect(await defaultRes.json()).toEqual({
        provider: 'mock',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini'
      });

      const invalidRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '' })
      });
      expect(invalidRes.status).toBe(400);
      expect(invalidRes.headers.get('content-type')).toContain('application/json');

      const savedConfig = {
        provider: 'openai-compatible',
        baseUrl: 'https://example.test/v1/',
        apiKey: 'sk-local-test',
        model: 'test-model'
      };
      const saveRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(savedConfig)
      });
      expect(saveRes.status).toBe(200);
      expect(await saveRes.json()).toEqual(savedConfig);

      const getRes = await fetch(`${base}/api/admin/config/ai-provider`);
      expect(await getRes.json()).toEqual(savedConfig);

      const snapshotRes = await fetch(`${base}/api/admin/config`);
      const snapshot = await snapshotRes.json() as { aiProviderConfig: unknown };
      expect(snapshot.aiProviderConfig).toEqual(savedConfig);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "stores global AI provider config"
```

Expected: FAIL because `/api/admin/config/ai-provider` does not exist yet.

- [ ] **Step 3: Add `AiProviderConfig` domain types**

In `server/src/domain/types.ts`, add the provider type directly after `AiConfig`:

```ts
export type AiProviderKind = 'mock' | 'openai-compatible';

export interface AiProviderConfig {
  provider: AiProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
}
```

Then update `GlobalConfigSnapshot`:

```ts
export interface GlobalConfigSnapshot {
  aiConfig: AiConfig;
  aiProviderConfig: AiProviderConfig;
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

- [ ] **Step 4: Add the schema column and migration**

In `server/src/db/schema.ts`, update the `global_config` table definition:

```sql
    CREATE TABLE IF NOT EXISTS global_config (
      id TEXT PRIMARY KEY,
      ai_config_json TEXT NOT NULL DEFAULT '{}',
      ai_provider_config_json TEXT NOT NULL DEFAULT '{"provider":"mock","baseUrl":"https://api.openai.com/v1","apiKey":"","model":"gpt-4o-mini"}',
      active_script_card_id TEXT REFERENCES script_cards(id) ON DELETE SET NULL,
      active_preset_package_id TEXT REFERENCES prompt_preset_packages(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
```

After the existing `rooms` column migration at the end of `migrate()`, add:

```ts
  const globalConfigColumns = db.prepare('PRAGMA table_info(global_config)').all() as Array<{ name: string }>;
  if (!globalConfigColumns.some((column) => column.name === 'ai_provider_config_json')) {
    db.prepare('ALTER TABLE global_config ADD COLUMN ai_provider_config_json TEXT NOT NULL DEFAULT \'{"provider":"mock","baseUrl":"https://api.openai.com/v1","apiKey":"","model":"gpt-4o-mini"}\'').run();
  }
```

- [ ] **Step 5: Add provider config parsing and persistence service**

In `server/src/services/globalConfigService.ts`, update imports:

```ts
import type {
  AiConfig,
  AiProviderConfig,
  GlobalConfigSnapshot,
  GlobalResourceWorldBookBinding,
  PromptBlock,
  PromptBlockPosition,
  PromptPreset,
  PromptPresetPackage,
  ResourceWorldBookEntry,
  ScriptCard,
  WorldBook,
  WorldBookEntry,
  WorldBookPosition
} from '../domain/types.js';
```

Add this default near the existing constants:

```ts
export const defaultAiProviderConfig: AiProviderConfig = {
  provider: 'mock',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini'
};
```

Update `GlobalConfigRow`:

```ts
interface GlobalConfigRow {
  id: string;
  ai_config_json: string;
  ai_provider_config_json: string;
  active_script_card_id: string | null;
  active_preset_package_id: string | null;
  created_at: string;
  updated_at: string;
}
```

Add these helpers after `mapGlobalResourceWorldBookBindingRow()`:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : fallback;
}

export function normalizeAiProviderConfig(input: unknown): AiProviderConfig {
  if (!isRecord(input)) return defaultAiProviderConfig;
  const providerValue = input.provider;
  const provider = providerValue === 'openai-compatible' || providerValue === 'mock'
    ? providerValue
    : defaultAiProviderConfig.provider;
  const baseUrl = stringField(input, 'baseUrl', defaultAiProviderConfig.baseUrl);
  const apiKey = stringField(input, 'apiKey', defaultAiProviderConfig.apiKey);
  const model = stringField(input, 'model', defaultAiProviderConfig.model);

  if (provider === 'openai-compatible') {
    if (!baseUrl) throw new GlobalConfigResourceError('API Base URL is required for openai-compatible provider', 400);
    if (!apiKey) throw new GlobalConfigResourceError('API Key is required for openai-compatible provider', 400);
    if (!model) throw new GlobalConfigResourceError('Model is required for openai-compatible provider', 400);
    try {
      new URL(baseUrl);
    } catch {
      throw new GlobalConfigResourceError('API Base URL must be a valid URL', 400);
    }
  }

  return { provider, baseUrl, apiKey, model };
}

export function parseAiProviderConfigJson(json: string | null | undefined): AiProviderConfig {
  if (!json) return defaultAiProviderConfig;
  try {
    return normalizeAiProviderConfig(JSON.parse(json));
  } catch {
    return defaultAiProviderConfig;
  }
}
```

Update `ensureGlobalConfig()` insert SQL:

```ts
  db.prepare('INSERT INTO global_config (id, ai_config_json, ai_provider_config_json, active_script_card_id, active_preset_package_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(GLOBAL_CONFIG_ID, JSON.stringify(defaultAiConfig), JSON.stringify(defaultAiProviderConfig), null, null, now, now);
```

Add service functions after `getGlobalAiConfig()`:

```ts
export function getGlobalAiProviderConfig(db: AppDatabase): AiProviderConfig {
  return parseAiProviderConfigJson(ensureGlobalConfig(db).ai_provider_config_json);
}

export function updateGlobalAiProviderConfig(db: AppDatabase, input: unknown): AiProviderConfig {
  const normalized = normalizeAiProviderConfig(input);
  ensureGlobalConfig(db);
  db.prepare('UPDATE global_config SET ai_provider_config_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(normalized), new Date().toISOString(), GLOBAL_CONFIG_ID);
  return normalized;
}
```

Update `getGlobalConfigSnapshot()`:

```ts
  return {
    aiConfig: parseAiConfigJson(config.ai_config_json),
    aiProviderConfig: parseAiProviderConfigJson(config.ai_provider_config_json),
    activeScriptCardId: config.active_script_card_id,
    activePresetPackageId: config.active_preset_package_id,
    globalWorldBookBindings: getGlobalResourceWorldBookBindings(db),
    presets: getGlobalPresets(db),
    worldBooks: getGlobalWorldBooks(db),
    worldBookEntries: getGlobalWorldBookEntries(db),
    scriptCards: resourceLibrary.scriptCards,
    resourceWorldBooks: resourceLibrary.resourceWorldBooks,
    resourceWorldBookEntries: resourceLibrary.resourceWorldBookEntries,
    presetPackages: resourceLibrary.presetPackages
  };
```

- [ ] **Step 6: Add temporary route stubs to make the service reachable**

In `server/src/routes/adminRoutes.ts`, import the new service functions:

```ts
  getGlobalAiProviderConfig,
  normalizeAiProviderConfig,
  updateGlobalAiProviderConfig,
```

Add schema near `aiConfigSchema`:

```ts
const aiProviderConfigSchema = z.object({
  provider: z.enum(['mock', 'openai-compatible']),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default('')
});
```

Add routes after `router.get('/config', ...)`:

```ts
  router.get('/config/ai-provider', (_req, res) => {
    res.json(getGlobalAiProviderConfig(db));
  });

  router.put('/config/ai-provider', (req, res) => {
    try {
      const input = normalizeAiProviderConfig(aiProviderConfigSchema.parse(req.body));
      res.json(updateGlobalAiProviderConfig(db, input));
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });
```

The test endpoint is added in Task 2.

- [ ] **Step 7: Run the provider config test**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "stores global AI provider config"
```

Expected: PASS.

- [ ] **Step 8: Checkpoint**

Do not commit. Record changed files with:

```bash
rtk git status --short
```

Expected changed files include `server/src/db/schema.ts`, `server/src/domain/types.ts`, `server/src/services/globalConfigService.ts`, `server/src/routes/adminRoutes.ts`, and `server/src/tests/integration.test.ts`.

---

### Task 2: Refactor provider creation and wire runtime process-turn to DB config

**Files:**
- Modify: `server/src/config.ts:3-21`
- Modify: `server/src/services/aiProvider.ts:1-69`
- Modify: `server/src/app.ts:1-22`
- Modify: `server/src/routes/adminRoutes.ts:1-37,343-359,665-729`
- Modify: `server/src/tests/integration.test.ts:1-31,518-565`

- [ ] **Step 1: Write failing integration tests for test endpoint and runtime provider reload**

In `server/src/tests/integration.test.ts`, add `import http from 'node:http';` at the top:

```ts
import http from 'node:http';
```

Add this helper after `createAdminOnlyApp()`:

```ts
async function createOpenAiStub(handler: (body: unknown) => { status?: number; body: unknown }) {
  const requests: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push(body);
    const result = handler(body);
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No stub port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
```

Add this test after the Task 1 provider config test:

```ts
  it('tests openai-compatible config without writing ai_generations', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const aiStub = await createOpenAiStub(() => ({
      body: {
        choices: [{
          message: {
            content: JSON.stringify({
              publicLog: 'test ok',
              privateUpdatesByPlayer: {},
              ruleResults: [],
              interactionRequests: []
            })
          }
        }]
      }
    }));
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const testRes = await fetch(`${base}/api/admin/config/ai-provider/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: aiStub.baseUrl, apiKey: 'sk-test', model: 'stub-model' })
      });
      expect(testRes.status).toBe(200);
      expect(await testRes.json()).toEqual({ ok: true });
      expect(aiStub.requests).toHaveLength(1);
      expect(db.prepare('SELECT COUNT(*) as count FROM ai_generations').get()).toEqual({ count: 0 });

      const failedTestRes = await fetch(`${base}/api/admin/config/ai-provider/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: 'not-a-url', apiKey: 'sk-test', model: 'stub-model' })
      });
      expect(failedTestRes.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await aiStub.close();
      db.close();
    }
  });
```

Add this test after the first end-to-end process-turn test:

```ts
  it('uses the saved AI provider config for an existing room on the next process-turn', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const aiStub = await createOpenAiStub((body) => {
      expect(body).toMatchObject({ model: 'runtime-model' });
      return {
        body: {
          choices: [{
            message: {
              content: JSON.stringify({
                publicLog: 'Runtime provider answered.',
                privateUpdatesByPlayer: {},
                ruleResults: ['runtime provider used'],
                interactionRequests: []
              })
            }
          }]
        }
      };
    });
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Runtime Provider Room' })
      });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const player = await playerRes.json() as { token: string };

      const saveProviderRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: aiStub.baseUrl, apiKey: 'sk-runtime', model: 'runtime-model' })
      });
      expect(saveProviderRes.status).toBe(200);

      await fetch(`${base}/api/player/${player.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I inspect the runtime provider.' })
      });
      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, { method: 'POST' });
      expect(processRes.status).toBe(200);

      const generation = db.prepare('SELECT provider, output FROM ai_generations WHERE room_id = ? ORDER BY created_at DESC LIMIT 1').get(room.roomId) as { provider: string; output: string };
      expect(generation.provider).toBe('openai-compatible');
      expect(generation.output).toContain('Runtime provider answered.');
      expect(aiStub.requests).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await aiStub.close();
      db.close();
    }
  });
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "AI provider|saved AI provider config"
```

Expected: FAIL because `test` route does not exist and `process-turn` still uses a startup provider.

- [ ] **Step 3: Refactor `server/src/config.ts`**

Replace the file with:

```ts
import 'dotenv/config';

export interface AppConfig {
  port: number;
  databasePath: string;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    databasePath: process.env.DATABASE_PATH ?? 'dnd.sqlite'
  };
}
```

- [ ] **Step 4: Refactor `server/src/services/aiProvider.ts`**

Replace imports and provider factory with `AiProviderConfig` based code:

```ts
import type { AiProviderConfig, AiTurnResult } from '../domain/types.js';

export interface AiProvider {
  name: string;
  generateTurnResult(prompt: string): Promise<AiTurnResult>;
}

export class MockAiProvider implements AiProvider {
  name = 'mock';

  async generateTurnResult(prompt: string): Promise<AiTurnResult> {
    return {
      publicLog: `The party's actions echo through the scene.\n\n${prompt.slice(0, 240)}`,
      privateUpdatesByPlayer: {},
      ruleResults: ['Mock ruling: no rule conflict detected.'],
      interactionRequests: []
    };
  }
}

export class OpenAiCompatibleProvider implements AiProvider {
  name = 'openai-compatible';

  constructor(private readonly config: AiProviderConfig) {}

  async generateTurnResult(prompt: string): Promise<AiTurnResult> {
    if (!this.config.apiKey) {
      throw new Error('API Key is required when provider=openai-compatible');
    }

    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: 'Return strict JSON only. Never include markdown fences.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      })
    });

    if (!response.ok) {
      throw new Error(`AI provider failed with ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI provider returned no content');

    const parsed = JSON.parse(content) as AiTurnResult;
    return {
      publicLog: parsed.publicLog ?? '',
      privateUpdatesByPlayer: parsed.privateUpdatesByPlayer ?? {},
      ruleResults: parsed.ruleResults ?? [],
      interactionRequests: parsed.interactionRequests ?? []
    };
  }
}

export function createAiProviderFromConfig(config: AiProviderConfig): AiProvider {
  if (config.provider === 'openai-compatible') return new OpenAiCompatibleProvider(config);
  return new MockAiProvider();
}

export async function testAiProviderConfig(config: AiProviderConfig): Promise<void> {
  if (config.provider === 'mock') return;
  await createAiProviderFromConfig(config).generateTurnResult([
    'Return strict JSON with exactly these fields:',
    'publicLog as a short string, privateUpdatesByPlayer as an object,',
    'ruleResults as an array, interactionRequests as an array.'
  ].join(' '));
}
```

- [ ] **Step 5: Stop creating provider at app startup**

In `server/src/app.ts`, remove `createAiProvider` import and startup provider creation:

```ts
import cors from 'cors';
import express from 'express';
import type { AppDatabase } from './db/connection.js';
import { createAdminRouter } from './routes/adminRoutes.js';
import { createPlayerRouter } from './routes/playerRoutes.js';
import { createSseRouter } from './routes/sseRoutes.js';

export function createApp(db: AppDatabase) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/admin', createAdminRouter(db));
  app.use('/api/player', createPlayerRouter(db));
  app.use('/events', createSseRouter(db));

  return app;
}
```

- [ ] **Step 6: Wire provider config into admin routes**

In `server/src/routes/adminRoutes.ts`, replace the provider import:

```ts
import { createAiProviderFromConfig, testAiProviderConfig } from '../services/aiProvider.js';
```

Remove the `AiProvider` type import. Change router signature:

```ts
export function createAdminRouter(db: AppDatabase): Router {
```

Add the test route after the `PUT /config/ai-provider` route:

```ts
  router.post('/config/ai-provider/test', async (req, res) => {
    try {
      const hasBody = Boolean(req.body) && Object.keys(req.body as Record<string, unknown>).length > 0;
      const config = hasBody
        ? normalizeAiProviderConfig(aiProviderConfigSchema.parse(req.body))
        : getGlobalAiProviderConfig(db);
      await testAiProviderConfig(config);
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof GlobalConfigResourceError) {
        handleGlobalConfigResourceError(error, res);
        return;
      }
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
```

In `POST /rooms/:roomId/process-turn`, change provider creation before calling `processTurnActions`:

```ts
      const aiProvider = createAiProviderFromConfig(getGlobalAiProviderConfig(db));
      const result = await processTurnActions({
        room,
        turn,
        players,
        actions,
        publicLogs,
        interactions,
        aiProvider,
        scriptCard: getActiveGlobalScriptCard(db),
        promptBlocks,
        worldBookMatches,
        promptOverride: preview.mode === 'sillytavern-compatible' ? preview.prompt : undefined
      });
```

Keep the existing `ai_generations.provider` writes using `aiProvider.name`.

- [ ] **Step 7: Update the failing AI failure test**

Replace the old `createAdminOnlyApp(db, failingProvider)` usage in `server/src/tests/integration.test.ts` with an OpenAI stub that returns 502:

```ts
    const failingStub = await createOpenAiStub(() => ({
      status: 502,
      body: { error: 'simulated AI failure' }
    }));
    const app = createApp(db);
```

Inside the test `try` block, before submitting the player action, save the failing provider config:

```ts
      const providerRes = await fetch(`${base}/api/admin/config/ai-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: failingStub.baseUrl, apiKey: 'sk-failing', model: 'failing-model' })
      });
      expect(providerRes.status).toBe(200);
```

In the `finally` block, close the stub:

```ts
      await failingStub.close();
```

Remove the now-unused `createAdminOnlyApp()` helper and `AiProvider` test import when TypeScript reports them unused.

- [ ] **Step 8: Run the provider runtime tests**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "AI provider|saved AI provider config|needing admin attention"
```

Expected: PASS.

- [ ] **Step 9: Checkpoint**

Do not commit. Run:

```bash
rtk npm run typecheck --workspace server
```

Expected: PASS.

---

### Task 3: Remove `AiConfig` from runtime prompt building

**Files:**
- Modify: `server/src/services/aiContextBuilder.ts:1-140`
- Modify: `server/src/services/sillyTavernPromptBuilder.ts:1-231`
- Modify: `server/src/services/turnEngine.ts:1-35`
- Modify: `server/src/routes/adminRoutes.ts:10-37,235-287,665-692`
- Modify: `server/src/tests/integration.test.ts:96-142,649-768,770-797`

- [ ] **Step 1: Write failing tests proving `ai_config_json` is no longer runtime truth**

Replace the existing test named `saves global AI constraints and returns them in native prompt preview` in `server/src/tests/integration.test.ts` with:

```ts
  it('uses preset blocks rather than global ai_config_json for native prompt preview', async () => {
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
        body: JSON.stringify({ name: 'Preset Truth Room' })
      });
      const room = await roomRes.json() as { roomId: string };

      const configRes = await fetch(`${base}/api/admin/config/ai-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          coreRules: '核心规则：来自兼容接口并同步到默认预设。',
          playerAgencyRules: '玩家自主权：来自默认预设。',
          visibilityRules: '信息隔离：来自默认预设。',
          interactionRules: '互动规则：来自默认预设。',
          styleRules: '叙事风格：来自默认预设。',
          outputFormatRules: '输出格式：来自默认预设。'
        })
      });
      expect(configRes.status).toBe(200);

      db.prepare('UPDATE global_config SET ai_config_json = ? WHERE id = ?').run(JSON.stringify({
        coreRules: '毒化核心规则：不应出现在 preview。',
        playerAgencyRules: '毒化玩家自主权：不应出现在 preview。',
        visibilityRules: '毒化信息隔离：不应出现在 preview。',
        interactionRules: '毒化互动规则：不应出现在 preview。',
        styleRules: '毒化叙事风格：不应出现在 preview。',
        outputFormatRules: '毒化输出格式：不应出现在 preview。'
      }), 'default');

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as PromptPreviewPayload;
      expect(preview.mode).toBe('native');
      expect(preview.prompt).toContain('核心规则：来自兼容接口并同步到默认预设。');
      expect(preview.prompt).toContain('输出格式：来自默认预设。');
      expect(preview.prompt).not.toContain('毒化核心规则');
      expect(preview.prompt).not.toContain('毒化输出格式');
      expect(preview.promptBlocks.at(-1)).toMatchObject({ identifier: 'dndOutputContract', source: 'dnd-contract' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

In the ST prompt preview test, replace the old `uniqueGlobalOutputFormatRules` section with this assertion:

```ts
      db.prepare('UPDATE global_config SET ai_config_json = ? WHERE id = ?').run(JSON.stringify({
        ...defaultAiConfig,
        outputFormatRules: '毒化 ST 输出格式：不应进入固定引擎契约。'
      }), 'default');
```

Then replace:

```ts
      expect(preview.prompt).toContain(uniqueGlobalOutputFormatRules);
```

with:

```ts
      expect(preview.prompt).toContain('# DND 输出契约');
      expect(preview.prompt).not.toContain('毒化 ST 输出格式');
```

- [ ] **Step 2: Run the failing prompt tests**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "preset blocks rather than global ai_config_json|current global ST resource config"
```

Expected: FAIL because preview still reads `getGlobalAiConfig(db)` and passes it into prompt builders.

- [ ] **Step 3: Make DND output contract fixed and remove `aiConfig` from native prompt input**

In `server/src/services/aiContextBuilder.ts`, keep `defaultAiConfig`, `normalizeAiConfig()`, and `parseAiConfigJson()` for legacy migration. Replace `renderDndOutputContract(aiConfig: AiConfig)` with:

```ts
const fixedDndOutputContract = [
  '# DND 输出契约',
  '严格 JSON 输出：只返回一个 JSON 对象，不使用 Markdown 代码块，不输出 JSON 之外的解释。',
  'JSON 字段必须包含 publicLog、privateUpdatesByPlayer、ruleResults、interactionRequests。',
  '信息隔离：publicLog 只能包含所有玩家可见的信息；privateUpdatesByPlayer 只能按玩家 ID 写入该玩家可见的私密结果。',
  '玩家自主权：不得替任何玩家决定意图、台词、同意、反抗、情绪、选择或 PvP 回应。',
  '玩家互动确认：当一个玩家的行动会强制影响另一个玩家的选择、资源、身体或秘密时，必须创建 interactionRequests 等待目标玩家确认或回应。'
].join('\n');

export function renderDndOutputContract(): string {
  return fixedDndOutputContract;
}
```

Delete `defaultPromptBlocks()` from `aiContextBuilder.ts`.

Update `buildTurnPrompt()` input and body:

```ts
export function buildTurnPrompt(input: {
  room: Room;
  players: Player[];
  publicLogs: LogEntry[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
  scriptCard?: ScriptCard | null;
  promptBlocks?: PromptBlock[];
  worldBookMatches?: WorldBookMatch[];
}): string {
  const finalContract = renderDndOutputContract();
  const promptBlocks = (input.promptBlocks ?? [])
    .filter((block) => !(block.enabled && block.content.trim() === finalContract));
  const worldBookMatches = input.worldBookMatches ?? [];
  const sections = [
    ...renderPromptBlocks(promptBlocks, 'before_world'),
    ...(input.scriptCard ? [
      '# 全局主剧本卡',
      [
        `名称：${input.scriptCard.name}`,
        input.scriptCard.description,
        input.scriptCard.personality,
        input.scriptCard.scenario
      ].filter(Boolean).join('\n')
    ] : []),
    `Room: ${input.room.name}`,
    `World: ${input.room.worldInfo}`,
    ...renderPromptBlocks(promptBlocks, 'after_world'),
    '# 世界书触发条目',
    renderWorldBookMatches(worldBookMatches),
    'Public log so far:',
    input.publicLogs.map((log) => `- ${log.title}: ${log.content}`).join('\n') || '- No public log yet.',
    ...renderPromptBlocks(promptBlocks, 'before_actions'),
    'Submitted actions in order:',
    summarizeActionsInSubmissionOrder(input.actions, input.players) || '- No submitted actions yet.',
    'Pending interactions:',
    input.interactions.map((interaction) => `- ${interaction.prompt}`).join('\n') || '- None.',
    ...renderPromptBlocks(promptBlocks, 'after_actions'),
    ...renderPromptBlocks(promptBlocks, 'final')
  ];
  sections.push(finalContract);
  return sections.join('\n\n');
}
```

- [ ] **Step 4: Remove `aiConfig` from ST prompt builder**

In `server/src/services/sillyTavernPromptBuilder.ts`, remove `AiConfig` from imports and `SillyTavernPromptBuilderInput`.

Change the slot value:

```ts
    ['dndOutputContract', 'dnd-contract', renderDndOutputContract()]
```

Change the final pushed contract block:

```ts
  promptBlocks.push({
    identifier: 'dndOutputContract',
    role: 'system',
    source: 'dnd-contract',
    content: renderDndOutputContract().trim()
  });
```

- [ ] **Step 5: Remove `aiConfig` from turn engine**

In `server/src/services/turnEngine.ts`, update imports:

```ts
import type { AiTurnResult, InteractionRequest, LogEntry, Player, PlayerAction, PromptBlock, Room, ScriptCard, Turn, WorldBookMatch } from '../domain/types.js';
```

Update `ProcessTurnActionsInput`:

```ts
export interface ProcessTurnActionsInput {
  room: Room;
  turn: Turn;
  players: Player[];
  actions: PlayerAction[];
  publicLogs: LogEntry[];
  interactions: InteractionRequest[];
  aiProvider: AiProvider;
  scriptCard?: ScriptCard | null;
  promptBlocks?: PromptBlock[];
  worldBookMatches?: WorldBookMatch[];
  promptOverride?: string;
}
```

Remove `aiConfig` from `buildTurnPrompt()` call:

```ts
  const prompt = input.promptOverride ?? buildTurnPrompt({
    room: input.room,
    players: input.players,
    publicLogs: input.publicLogs,
    actions: orderedActions,
    interactions: input.interactions,
    scriptCard: input.scriptCard,
    promptBlocks: input.promptBlocks,
    worldBookMatches: input.worldBookMatches
  });
```

- [ ] **Step 6: Remove runtime `getGlobalAiConfig()` from admin preview/process-turn**

In `server/src/routes/adminRoutes.ts`, keep `defaultAiConfig`, `normalizeAiConfig`, `parseAiConfigJson`, and `renderDndOutputContract` imports for room mapping and legacy endpoints, but remove `getGlobalAiConfig` from global config service imports.

Change native preview signature:

```ts
function buildNativePromptPreview(room: Room, context: RoomPromptPreviewContext, scriptCard: ScriptCard | null): PromptPreviewResponse {
```

Inside it, remove `aiConfig` from `buildTurnPrompt()` and set:

```ts
  const dndOutputContract = renderDndOutputContract();
```

Change `buildRoomPromptPreview()` return type and body:

```ts
function buildRoomPromptPreview(db: AppDatabase, room: Room): { preview: PromptPreviewResponse; context: RoomPromptPreviewContext } {
  const context = loadRoomPromptPreviewContext(db, room);
  const presetPackage = getActiveGlobalPresetPackage(db);
  const scriptCard = getActiveGlobalScriptCard(db);
  if (!presetPackage) return { preview: buildNativePromptPreview(room, context, scriptCard), context };

  return {
    preview: buildSillyTavernPromptPreview({
      room,
      players: context.players,
      publicLogs: context.publicLogs,
      actions: context.actions,
      interactions: context.interactions,
      scriptCard,
      presetPackage,
      worldBookEntries: getActiveGlobalResourceWorldBookEntries(db)
    }),
    context
  };
}
```

In `POST /rooms/:roomId/process-turn`, destructure without `aiConfig`:

```ts
    const { preview, context } = buildRoomPromptPreview(db, room);
```

And remove `aiConfig` from `processTurnActions()` input.

- [ ] **Step 7: Keep compatibility route syncing default preset blocks**

Leave `PUT /api/admin/config/ai-config` in `server/src/routes/adminRoutes.ts`, but treat it as compatibility only:

```ts
  router.put('/config/ai-config', (req, res) => {
    try {
      const aiConfig: AiConfig = normalizeAiConfig(aiConfigSchema.parse(req.body));
      res.json(updateGlobalAiConfig(db, aiConfig));
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });
```

Do not call `getGlobalAiConfig()` from preview or process-turn. `updateGlobalAiConfig()` remains useful because it updates `global_config.ai_config_json` and replaces default global preset blocks.

- [ ] **Step 8: Run prompt unification tests**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "preset blocks rather than global ai_config_json|current global ST resource config|full DND contract|deduplicates"
```

Expected: PASS.

- [ ] **Step 9: Run server typecheck**

Run:

```bash
rtk npm run typecheck --workspace server
```

Expected: PASS with no unused `AiConfig` runtime imports in prompt builders or `turnEngine.ts`.

---

### Task 4: Update client API and shared client types

**Files:**
- Modify: `client/src/types.ts:13-31,268-280`
- Modify: `client/src/api.ts:1-70`
- Modify: `client/src/api.test.tsx:1-140`

- [ ] **Step 1: Write failing client API helper tests**

In `client/src/api.test.tsx`, update imports by replacing `saveGlobalAiConfig` with the new helpers:

```ts
  getGlobalAiProviderConfig,
  saveGlobalAiProviderConfig,
  testGlobalAiProviderConfig,
```

Replace the existing global config helper test with:

```ts
  it('requests global config and AI provider endpoints with expected methods and bodies', async () => {
    const fetchMock = mockFetchJson({ aiConfig: {}, aiProviderConfig: {}, bindings: [] });
    const providerConfig = {
      provider: 'openai-compatible' as const,
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model'
    };
    const bindings = [{ worldBookId: 'world-1', enabled: true, orderIndex: 0 }];

    await getGlobalConfig();
    await getGlobalAiProviderConfig();
    await saveGlobalAiProviderConfig(providerConfig);
    await testGlobalAiProviderConfig(providerConfig);
    await testGlobalAiProviderConfig();
    await putGlobalScriptCard('script-1');
    await clearGlobalScriptCard();
    await putGlobalResourceWorldBookBindings(bindings);
    await putGlobalPresetPackage('preset-1');
    await clearGlobalPresetPackage();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/config', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/config/ai-provider', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/config/ai-provider', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(providerConfig)
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/config/ai-provider/test', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(providerConfig)
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/admin/config/ai-provider/test', expect.objectContaining({
      method: 'POST'
    }));
    expect(fetchMock.mock.calls[4][1]).not.toHaveProperty('body');
    expect(fetchMock).toHaveBeenNthCalledWith(6, '/api/admin/config/script-card', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ scriptCardId: 'script-1' })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(7, '/api/admin/config/script-card', expect.objectContaining({ method: 'DELETE' }));
    expect(fetchMock).toHaveBeenNthCalledWith(8, '/api/admin/config/resource-world-books', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ bindings })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(9, '/api/admin/config/preset-package', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ presetPackageId: 'preset-1' })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(10, '/api/admin/config/preset-package', expect.objectContaining({ method: 'DELETE' }));
  });
```

- [ ] **Step 2: Run the failing client API test**

Run:

```bash
rtk npm test -- client/src/api.test.tsx -t "AI provider endpoints"
```

Expected: FAIL because the helpers and type do not exist.

- [ ] **Step 3: Add client `AiProviderConfig` type**

In `client/src/types.ts`, add after `AiConfig`:

```ts
export type AiProviderKind = 'mock' | 'openai-compatible';

export interface AiProviderConfig {
  provider: AiProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
}
```

Update `GlobalConfigSnapshot`:

```ts
export interface GlobalConfigSnapshot {
  aiConfig: AiConfig;
  aiProviderConfig: AiProviderConfig;
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

- [ ] **Step 4: Add client API helpers**

In `client/src/api.ts`, import `AiProviderConfig`:

```ts
  AiProviderConfig,
```

Add helpers after `getGlobalConfig()`:

```ts
export function getGlobalAiProviderConfig() {
  return jsonRequest<AiProviderConfig>('/api/admin/config/ai-provider');
}

export function saveGlobalAiProviderConfig(config: AiProviderConfig) {
  return jsonRequest<AiProviderConfig>('/api/admin/config/ai-provider', {
    method: 'PUT',
    body: JSON.stringify(config)
  });
}

export function testGlobalAiProviderConfig(config?: AiProviderConfig) {
  return jsonRequest<{ ok: true }>('/api/admin/config/ai-provider/test', {
    method: 'POST',
    ...(config ? { body: JSON.stringify(config) } : {})
  });
}
```

Remove `saveGlobalAiConfig()` from `client/src/api.ts` if no client code imports it after Task 5. Keep `getAiConfig()` and `saveAiConfig()` only if TypeScript reports existing legacy callers.

- [ ] **Step 5: Run client API tests**

Run:

```bash
rtk npm test -- client/src/api.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Checkpoint**

Do not commit. Run:

```bash
rtk npm run typecheck --workspace client
```

Expected: it may still fail until Task 5 removes `saveGlobalAiConfig` UI imports. If it fails only for AdminPage imports, proceed to Task 5.

---

### Task 5: Replace `AI 约束` UI with `AI 接口` and move preview to presets

**Files:**
- Modify: `client/src/pages/AdminPage.tsx:1-366`
- Modify: `client/src/ui-copy.test.tsx:16-160,213-295`

- [ ] **Step 1: Write failing UI tests for the new product concepts**

In `client/src/ui-copy.test.tsx`, update the API mock:

```ts
  getGlobalAiProviderConfig: vi.fn(async () => ({
    provider: 'mock',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini'
  })),
  saveGlobalAiProviderConfig: vi.fn(async (config) => config),
  testGlobalAiProviderConfig: vi.fn(async () => ({ ok: true })),
```

Remove the `saveGlobalAiConfig` mock.

In mocked `globalConfig`, add:

```ts
      aiProviderConfig: {
        provider: 'mock',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini'
      },
```

Replace the admin tab test section assertions with:

```ts
    expect(await screen.findByRole('button', { name: '总览' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI 接口' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'AI 约束' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '资源' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '预设' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '世界书' })).toBeInTheDocument();

    expect(screen.getByText('玩家')).toBeInTheDocument();
    expect(screen.getByText('全部日志')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'AI 接口' }));
    expect(screen.getByRole('heading', { name: 'AI 接口' })).toBeInTheDocument();
    expect(screen.getByText('只配置模型服务连接，不包含 prompt、规则或约束内容。')).toBeInTheDocument();
    expect(screen.getByLabelText('Provider')).toBeInTheDocument();
    expect(screen.getByLabelText('API Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存 AI 接口' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '资源' }));
```

In the same test, after switching to `预设`, add:

```ts
    expect(screen.getByRole('button', { name: '预览 AI 请求' })).toBeInTheDocument();
```

Update the tab persistence test to click `AI 接口` instead of `AI 约束`:

```ts
    await user.click(screen.getByRole('button', { name: 'AI 接口' }));
```

Replace the error display test with:

```ts
  it('非总览标签页操作失败时显示统一错误提示', async () => {
    const user = userEvent.setup();
    vi.mocked(api.testGlobalAiProviderConfig).mockRejectedValueOnce(new Error('连接失败'));
    vi.mocked(api.previewAiPrompt).mockRejectedValueOnce(new Error('预览失败'));
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: 'AI 接口' }));
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('连接失败');

    await user.click(screen.getByRole('button', { name: '预设' }));
    await user.click(screen.getByRole('button', { name: '预览 AI 请求' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('预览失败');
  });
```

Add a UI behavior test after the admin tab test:

```ts
  it('AI 接口页能保存并测试 provider 配置', async () => {
    const user = userEvent.setup();
    render(<AdminPage roomId="room-1" />);

    await user.click(await screen.findByRole('button', { name: 'AI 接口' }));
    await user.selectOptions(screen.getByLabelText('Provider'), 'openai-compatible');
    await user.clear(screen.getByLabelText('API Base URL'));
    await user.type(screen.getByLabelText('API Base URL'), 'https://example.test/v1');
    await user.clear(screen.getByLabelText('API Key'));
    await user.type(screen.getByLabelText('API Key'), 'sk-test');
    await user.clear(screen.getByLabelText('Model'));
    await user.type(screen.getByLabelText('Model'), 'test-model');

    await user.click(screen.getByRole('button', { name: '保存 AI 接口' }));
    await waitFor(() => expect(api.saveGlobalAiProviderConfig).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model'
    }));

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(api.testGlobalAiProviderConfig).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model'
    }));
    expect(screen.getByText('连接测试成功。')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the failing UI tests**

Run:

```bash
rtk npm test -- client/src/ui-copy.test.tsx -t "管理员页|AI 接口|非总览"
```

Expected: FAIL because AdminPage still renders `AI 约束` and imports `saveGlobalAiConfig`.

- [ ] **Step 3: Update AdminPage imports and tab model**

In `client/src/pages/AdminPage.tsx`, replace imports:

```ts
import { addPlayer, activatePreset, createWorldBook, createWorldBookEntry, getAdminState, getGlobalAiProviderConfig, previewAiPrompt, processTurn, saveGlobalAiProviderConfig, savePreset, subscribeRoom, testGlobalAiProviderConfig } from '../api';
import type { AdminState, AiProviderConfig, PromptBlock, PromptPreset, PromptPreviewResponse, WorldBookEntry } from '../types';
```

Replace tab type and labels:

```ts
type AdminTab = 'overview' | 'aiProvider' | 'resources' | 'presets' | 'worldBooks';

const adminTabs: Array<{ id: AdminTab; label: string }> = [
  { id: 'overview', label: '总览' },
  { id: 'aiProvider', label: 'AI 接口' },
  { id: 'resources', label: '资源' },
  { id: 'presets', label: '预设' },
  { id: 'worldBooks', label: '世界书' }
];
```

- [ ] **Step 4: Replace AI constraint state with provider state**

Remove:

```ts
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null);
  const aiConfigDirtyRef = useRef(false);
```

Add:

```ts
  const [aiProviderConfig, setAiProviderConfig] = useState<AiProviderConfig | null>(null);
  const aiProviderConfigDirtyRef = useRef(false);
  const [aiProviderMessage, setAiProviderMessage] = useState('');
```

Replace `refresh()` with:

```ts
  async function refresh() {
    const [nextState, nextAiProviderConfig] = await Promise.all([
      getAdminState(roomId),
      getGlobalAiProviderConfig()
    ]);
    setState(nextState);
    if (!aiProviderConfigDirtyRef.current) {
      setAiProviderConfig(nextAiProviderConfig);
    }
  }
```

Update `useEffect()` initialization:

```ts
    aiProviderConfigDirtyRef.current = false;
```

Remove `updateAiConfig()` and `persistAiConfig()`. Add:

```ts
  function updateAiProviderConfig<K extends keyof AiProviderConfig>(key: K, value: AiProviderConfig[K]) {
    aiProviderConfigDirtyRef.current = true;
    setAiProviderConfig((current) => current ? { ...current, [key]: value } : current);
    setAiProviderMessage('');
  }

  async function persistAiProviderConfig() {
    if (!aiProviderConfig) return;
    setError('');
    setAiProviderMessage('');
    try {
      const saved = await saveGlobalAiProviderConfig(aiProviderConfig);
      aiProviderConfigDirtyRef.current = false;
      setAiProviderConfig(saved);
      setAiProviderMessage('AI 接口已保存。');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function testAiProvider() {
    if (!aiProviderConfig) return;
    setError('');
    setAiProviderMessage('');
    try {
      await testGlobalAiProviderConfig(aiProviderConfig);
      setAiProviderMessage('连接测试成功。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
```

- [ ] **Step 5: Replace AI tab JSX**

Replace the old `<section className="card" role="tabpanel" hidden={activeTab !== 'ai'}>` with:

```tsx
      <section className="card" role="tabpanel" hidden={activeTab !== 'aiProvider'}>
        {aiProviderConfig ? (
          <>
            <h2>AI 接口</h2>
            <p className="muted">只配置模型服务连接，不包含 prompt、规则或约束内容。</p>
            <label>Provider
              <select
                aria-label="Provider"
                value={aiProviderConfig.provider}
                onChange={(event) => updateAiProviderConfig('provider', event.target.value as AiProviderConfig['provider'])}
              >
                <option value="mock">mock</option>
                <option value="openai-compatible">openai-compatible</option>
              </select>
            </label>
            <label>API Base URL
              <input
                aria-label="API Base URL"
                value={aiProviderConfig.baseUrl}
                onChange={(event) => updateAiProviderConfig('baseUrl', event.target.value)}
              />
            </label>
            <label>API Key
              <input
                aria-label="API Key"
                type="password"
                value={aiProviderConfig.apiKey}
                onChange={(event) => updateAiProviderConfig('apiKey', event.target.value)}
              />
            </label>
            <label>Model
              <input
                aria-label="Model"
                value={aiProviderConfig.model}
                onChange={(event) => updateAiProviderConfig('model', event.target.value)}
              />
            </label>
            <div className="button-row">
              <button onClick={persistAiProviderConfig}>保存 AI 接口</button>
              <button onClick={testAiProvider}>测试连接</button>
            </div>
            {aiProviderMessage ? <p>{aiProviderMessage}</p> : null}
          </>
        ) : null}
      </section>
```

- [ ] **Step 6: Move prompt preview to preset tab**

In the preset tab (`hidden={activeTab !== 'presets'}`), after the existing preset editor or after the edit-current button block, add:

```tsx
        <div className="button-row">
          <button onClick={loadPromptPreview}>预览 AI 请求</button>
        </div>
        <PromptPreviewPanel preview={promptPreview} />
```

Ensure the AI 接口 tab does not render `PromptPreviewPanel`.

- [ ] **Step 7: Run UI tests**

Run:

```bash
rtk npm test -- client/src/ui-copy.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Run client API tests and typecheck**

Run:

```bash
rtk npm test -- client/src/api.test.tsx && rtk npm run typecheck --workspace client
```

Expected: PASS.

- [ ] **Step 9: Checkpoint**

Do not commit. Run:

```bash
rtk git status --short
```

Expected changed files include `client/src/pages/AdminPage.tsx`, `client/src/types.ts`, `client/src/api.ts`, `client/src/api.test.tsx`, and `client/src/ui-copy.test.tsx`.

---

### Task 6: Full validation and browser verification

**Files:**
- Verify: all modified server/client files
- Potentially modify: `.gitignore` only if a new temporary verification artifact is created and must remain

- [ ] **Step 1: Run the full automated test suite**

Run:

```bash
rtk npm test
```

Expected: all Vitest suites PASS.

- [ ] **Step 2: Run full typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: server and client typecheck PASS.

- [ ] **Step 3: Run production build**

Run:

```bash
rtk npm run build
```

Expected: server and client builds PASS.

- [ ] **Step 4: Start or reuse the dev servers for browser verification**

If no dev servers are running, start them in background commands from the project root:

```bash
rtk npm run dev --workspace server
```

```bash
rtk npm run dev --workspace client
```

Expected ports:
- Server: `http://localhost:3000`
- Client: `http://127.0.0.1:5180/`

If Vite reports `Port 5180 is already in use`, navigate to `http://127.0.0.1:5180/` and verify whether the existing dev server is serving this project before starting another client server.

- [ ] **Step 5: Browser verify the management tabs**

Using Playwright MCP:

1. Navigate to `http://127.0.0.1:5180/`.
2. Create a room named `AI 接口验证房间`.
3. Confirm admin tabs are exactly visible as:
   - `总览`
   - `AI 接口`
   - `资源`
   - `预设`
   - `世界书`
4. Confirm `AI 约束` is not visible as a tab.

Expected: the management page shows the new tab set and no standalone AI constraint entry.

- [ ] **Step 6: Browser verify AI provider save/test**

In the same browser session:

1. Open `AI 接口`.
2. Select `mock` provider.
3. Save with `保存 AI 接口`.
4. Click `测试连接`.

Expected:
- Save succeeds without alert.
- Test shows `连接测试成功。`.

- [ ] **Step 7: Browser verify preset preview source**

In the same browser session:

1. Open `预设`.
2. Click `编辑当前预设`.
3. Expand a prompt block.
4. Change its content to include `浏览器验证唯一提示词块`.
5. Save the preset.
6. Click `预览 AI 请求` on the `预设` tab.

Expected:
- Prompt Preview appears on `预设` tab.
- Preview contains `浏览器验证唯一提示词块`.
- Preview contains `# DND 输出契约`.

- [ ] **Step 8: Browser verify invalid OpenAI-compatible test does not affect room state**

In the same browser session:

1. Open `AI 接口`.
2. Select `openai-compatible`.
3. Clear `API Base URL` or enter `not-a-url`.
4. Click `测试连接`.
5. Return to `总览`.

Expected:
- Error alert appears for invalid config.
- Room remains usable and does not enter `needs_admin_attention` because provider test does not process a turn.

- [ ] **Step 9: Inspect browser console**

Use Playwright console messages.

Expected:
- No React/runtime errors.
- A missing `favicon.ico` warning/error is acceptable if it is the only console error.

- [ ] **Step 10: Check temporary artifacts**

Run:

```bash
rtk git status --short
```

If a new temporary browser artifact appears and must remain, add an exact ignore entry to `.gitignore` and verify it:

```bash
rtk git check-ignore -v <artifact-path>
```

Expected: no new unignored temporary scripts or generated verification files remain.

---

## Plan self-review

**Spec coverage:**
- AI 接口配置入库：Tasks 1, 2, 4, 5。
- 管理台保存/测试 provider/baseUrl/apiKey/model：Tasks 2, 5, 6。
- 删除独立“AI 约束”产品入口：Task 5。
- `AiConfig` / `ai_config_json` 不再作为 preview / process-turn 运行时真源：Task 3。
- 全局预设/提示词块作为唯一可编辑 prompt 规则来源：Task 3 + Task 5。
- 既有房间下一次 process-turn 实时使用当前 provider 配置：Task 2。
- 固定 DND 引擎契约保留：Task 3。
- 测试、类型检查、构建、浏览器验证：Task 6。

**Placeholder scan:**
- 本计划没有 `TBD`、未定义步骤、空白代码块或“之后补充”的实现说明。

**Type consistency:**
- Server/client 都使用 `AiProviderConfig`、`provider: 'mock' | 'openai-compatible'`、`baseUrl`、`apiKey`、`model`。
- 新 API helper 名称与后端路由一致：`getGlobalAiProviderConfig()`、`saveGlobalAiProviderConfig()`、`testGlobalAiProviderConfig()`。
- Prompt builder 统一使用无参数 `renderDndOutputContract()`。
