# 5e Embedding Rule Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the next 5e rules slice: configurable Embedding provider, vector indexing for approved PHB rule entries, hybrid keyword/semantic rule retrieval, silent AI-DM prompt injection, prompt-preview visibility, and player-facing short rule summaries.

**Architecture:** This plan builds on the completed PHB extraction foundation: approved `rule_world_book_entries` remain the source of truth, `embeddingService` owns provider calls and config validation, `ruleRetrievalService` owns indexing/search/scoring, and `aiContextBuilder` consumes retrieved rules without coupling prompt generation to provider details. Admin APIs expose embedding config, connection test, indexing, and retrieval preview; player state exposes only short summaries, never hidden rule text.

**Tech Stack:** TypeScript, Express, SQLite/better-sqlite3, Zod, React, Vite, Vitest, Testing Library, OpenAI-compatible `/embeddings` API.

---

## Scope Check

The approved 5e design still contains several independent subsystems. The PHB extraction foundation is complete. This plan implements only Phase 2 from the approved design:

- Global Embedding interface configuration.
- Mock and OpenAI-compatible embedding provider abstraction.
- Vector storage for approved PHB rule entries.
- Hybrid keyword + semantic retrieval.
- Silent AI-DM prompt injection of matched 5e rule entries.
- Prompt preview showing which 5e rules were injected.
- Player state exposing short rule summaries.

This plan does **not** implement the player character builder, structured character resources, AI-DM resource patches, or rollback. Those are separate plans.

## File Structure

### Server files

- Modify: `server/src/domain/types.ts`
  - Add `EmbeddingProviderConfig`, `RuleEntryEmbedding`, `RuleRetrievalMatch`, and `RuleSummary` types.
  - Extend `PromptPreviewResponse` and `PlayerVisibleState` to include rule retrieval data.
- Modify: `server/src/db/schema.ts`
  - Add `embedding_provider_config_json` to `global_config`.
  - Add `rule_entry_embeddings` and `rule_context_hits` tables.
- Create: `server/src/services/embeddingService.ts`
  - Normalize/test embedding provider config.
  - Generate mock embeddings for tests and OpenAI-compatible embeddings for real providers.
- Create: `server/src/services/ruleRetrievalService.ts`
  - Index approved `rule_world_book_entries`.
  - Search by keyword and cosine similarity.
  - Store current turn/player-visible short rule summaries.
- Modify: `server/src/services/globalConfigService.ts`
  - Persist and expose global embedding config.
- Modify: `server/src/services/aiContextBuilder.ts`
  - Add retrieved rule entries to `buildTurnPrompt` and prompt preview structures.
- Modify: `server/src/services/visibilityService.ts`
  - Include short rule summaries in player-visible state.
- Modify: `server/src/routes/adminRoutes.ts`
  - Add global embedding config/test/index/retrieval-preview endpoints.
  - Use retrieved rules while building process-turn prompt and prompt preview.
- Modify: `server/src/routes/playerRoutes.ts`
  - Load latest short rule summaries for the player state response.
- Test: `server/src/tests/embeddingService.test.ts`
  - Provider normalization, mock embeddings, OpenAI-compatible request shape/errors.
- Test: `server/src/tests/ruleRetrievalService.test.ts`
  - Indexing, cosine scoring, keyword fallback, approved-only behavior, context hit persistence.
- Modify/Test: `server/src/tests/integration.test.ts`
  - Admin API, prompt preview, and player state integration tests.

### Client files

- Modify: `client/src/types.ts`
  - Mirror embedding config, rule retrieval matches, and player rule summaries.
- Modify: `client/src/api.ts`
  - Add embedding config/test/index/retrieval-preview request functions.
- Modify: `client/src/pages/AdminPage.tsx`
  - Add Embedding settings panel under the AI interface tab or resources tab.
- Modify: `client/src/components/PromptPreviewPanel.tsx`
  - Display 5e rule matches separately from world-book matches.
- Modify: `client/src/pages/PlayerPage.tsx` or `client/src/components/CharacterCard.tsx`
  - Display short rule summaries from player state.
- Test: `client/src/api.test.tsx`
  - Embedding API request functions.
- Modify/Test: `client/src/ui-copy.test.tsx`
  - Embedding settings UI and prompt-preview rule match display.

### Documentation and verification

- Modify: `docs/superpowers/plans/2026-05-30-5e-embedding-rule-injection.md`
  - Track execution with checkboxes.
- Do not commit automatically. If the user explicitly asks for a commit, use `rtk git add ... && rtk git commit ...` and include the required Claude co-author trailer.

---

## Task 1: Server embedding config types and schema

**Files:**
- Modify: `server/src/domain/types.ts`
- Modify: `server/src/db/schema.ts`
- Modify: `server/src/tests/integration.test.ts`

- [x] **Step 1: Write failing integration test for default embedding config and schema**

Append this test inside `describe('DND AI-DM integration', () => { ... })` in `server/src/tests/integration.test.ts`:

```ts
  it('stores global embedding provider config separately from chat provider config', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const defaultRes = await fetch(`${base}/api/admin/config/embedding-provider`);
      expect(defaultRes.status).toBe(200);
      expect(await defaultRes.json()).toEqual({
        provider: 'mock',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'text-embedding-3-small',
        dimensions: 8
      });

      const savedConfig = {
        provider: 'openai-compatible',
        baseUrl: 'https://embedding.example.test/v1',
        apiKey: 'embedding-key',
        model: 'text-embedding-3-small',
        dimensions: 1536
      };
      const saveRes = await fetch(`${base}/api/admin/config/embedding-provider`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(savedConfig)
      });
      expect(saveRes.status).toBe(200);
      expect(await saveRes.json()).toEqual(savedConfig);

      const configRes = await fetch(`${base}/api/admin/config`);
      expect(configRes.status).toBe(200);
      const snapshot = await configRes.json() as { embeddingProviderConfig?: unknown; aiProviderConfig?: unknown };
      expect(snapshot.embeddingProviderConfig).toEqual(savedConfig);
      expect(snapshot.aiProviderConfig).not.toEqual(savedConfig);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "stores global embedding provider config"
```

Expected: FAIL with `404` for `/api/admin/config/embedding-provider`.

- [x] **Step 3: Add server domain types**

In `server/src/domain/types.ts`, add these types after `AiProviderConfig`:

```ts
export type EmbeddingProviderKind = 'mock' | 'openai-compatible';

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

export interface RuleEntryEmbedding {
  entryId: string;
  embedding: number[];
  contentHash: string;
  indexedAt: string;
}

export interface RuleRetrievalMatch {
  entryId: string;
  title: string;
  category: string;
  summary: string;
  content: string;
  keys: string[];
  sourceRef: string;
  score: number;
  reasons: Array<'keyword' | 'semantic'>;
}

export interface RuleSummary {
  entryId: string;
  title: string;
  summary: string;
  reason: string;
  createdAt: string;
}
```

Extend `GlobalConfigSnapshot` with:

```ts
  embeddingProviderConfig: EmbeddingProviderConfig;
```

Extend `PromptPreviewResponse` with:

```ts
  ruleMatches: Array<{
    entryId: string;
    title: string;
    category: string;
    score: number;
    reasons: Array<'keyword' | 'semantic'>;
    summary: string;
  }>;
```

Extend `PlayerVisibleState` with:

```ts
  ruleSummaries: RuleSummary[];
```

- [x] **Step 4: Add schema fields and tables**

In `server/src/db/schema.ts`, update `global_config` table creation to include:

```sql
      embedding_provider_config_json TEXT NOT NULL DEFAULT '{"provider":"mock","baseUrl":"https://api.openai.com/v1","apiKey":"","model":"text-embedding-3-small","dimensions":8}',
```

Add this table block after `rule_world_book_entries` and before `character_options`:

```sql
    CREATE TABLE IF NOT EXISTS rule_entry_embeddings (
      entry_id TEXT NOT NULL PRIMARY KEY REFERENCES rule_world_book_entries(id) ON DELETE CASCADE,
      embedding_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rule_context_hits (
      id TEXT NOT NULL PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      entry_id TEXT NOT NULL REFERENCES rule_world_book_entries(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      reason TEXT NOT NULL,
      score REAL NOT NULL,
      created_at TEXT NOT NULL
    );
```

After existing global config `ai_provider_config_json` ALTER block, add:

```ts
  if (!globalConfigColumns.some((column) => column.name === 'embedding_provider_config_json')) {
    db.prepare('ALTER TABLE global_config ADD COLUMN embedding_provider_config_json TEXT NOT NULL DEFAULT \'{"provider":"mock","baseUrl":"https://api.openai.com/v1","apiKey":"","model":"text-embedding-3-small","dimensions":8}\'').run();
  }
```

After existing PHB indexes, add:

```ts
  db.prepare('CREATE INDEX IF NOT EXISTS rule_context_hits_room_turn_idx ON rule_context_hits(room_id, turn_id, created_at)').run();
```

- [x] **Step 5: Add placeholder config service exports and routes**

In `server/src/services/globalConfigService.ts`, import `EmbeddingProviderConfig` and add:

```ts
export const defaultEmbeddingProviderConfig: EmbeddingProviderConfig = {
  provider: 'mock',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'text-embedding-3-small',
  dimensions: 8
};

export function normalizeEmbeddingProviderConfig(input: unknown): EmbeddingProviderConfig {
  if (!input || typeof input !== 'object') return defaultEmbeddingProviderConfig;
  const value = input as Partial<Record<keyof EmbeddingProviderConfig, unknown>>;
  if (value.provider !== undefined && value.provider !== 'mock' && value.provider !== 'openai-compatible') {
    throw new GlobalConfigResourceError('Embedding provider must be mock or openai-compatible', 400);
  }
  const provider = value.provider ?? 'mock';
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const dimensions = typeof value.dimensions === 'number' && Number.isInteger(value.dimensions) && value.dimensions > 0
    ? value.dimensions
    : defaultEmbeddingProviderConfig.dimensions;

  if (provider === 'mock') return { provider, baseUrl, apiKey, model, dimensions };
  if (!baseUrl || !apiKey || !model) {
    throw new GlobalConfigResourceError('OpenAI-compatible embedding provider requires baseUrl, apiKey, and model', 400);
  }
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new GlobalConfigResourceError('OpenAI-compatible embedding provider baseUrl must use http or https', 400);
    }
  } catch (error) {
    if (error instanceof GlobalConfigResourceError) throw error;
    throw new GlobalConfigResourceError('OpenAI-compatible embedding provider baseUrl must be a valid URL', 400);
  }
  return { provider, baseUrl, apiKey, model, dimensions };
}

export function parseEmbeddingProviderConfigJson(json: string | null | undefined): EmbeddingProviderConfig {
  if (!json) return defaultEmbeddingProviderConfig;
  try {
    return normalizeEmbeddingProviderConfig(JSON.parse(json));
  } catch {
    return defaultEmbeddingProviderConfig;
  }
}

export function getGlobalEmbeddingProviderConfig(db: AppDatabase): EmbeddingProviderConfig {
  return parseEmbeddingProviderConfigJson((ensureGlobalConfig(db) as GlobalConfigRow & { embedding_provider_config_json?: string }).embedding_provider_config_json);
}

export function updateGlobalEmbeddingProviderConfig(db: AppDatabase, input: unknown): EmbeddingProviderConfig {
  const normalized = normalizeEmbeddingProviderConfig(input);
  ensureGlobalConfig(db);
  db.prepare('UPDATE global_config SET embedding_provider_config_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(normalized), new Date().toISOString(), GLOBAL_CONFIG_ID);
  return normalized;
}
```

Also update `GlobalConfigRow` to include `embedding_provider_config_json: string;`, `ensureGlobalConfig` INSERT to include the column/value, and `getGlobalConfigSnapshot` to include `embeddingProviderConfig: getGlobalEmbeddingProviderConfig(db)`.

In `server/src/routes/adminRoutes.ts`, add schema:

```ts
const embeddingProviderConfigSchema = z.object({
  provider: z.enum(['mock', 'openai-compatible']),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  dimensions: z.number().int().positive().default(8)
});
```

Import `getGlobalEmbeddingProviderConfig` and `updateGlobalEmbeddingProviderConfig`, then add routes after AI provider routes:

```ts
  router.get('/config/embedding-provider', (_req, res) => {
    res.json(getGlobalEmbeddingProviderConfig(db));
  });

  router.put('/config/embedding-provider', (req, res) => {
    try {
      const input = embeddingProviderConfigSchema.parse(req.body);
      res.json(updateGlobalEmbeddingProviderConfig(db, input));
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });
```

- [x] **Step 6: Run focused test**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "stores global embedding provider config"
```

Expected: PASS.

---

## Task 2: Embedding provider service

**Files:**
- Create: `server/src/services/embeddingService.ts`
- Create: `server/src/tests/embeddingService.test.ts`
- Modify: `server/src/routes/adminRoutes.ts`

- [x] **Step 1: Write failing embedding service tests**

Create `server/src/tests/embeddingService.test.ts`:

```ts
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import type { EmbeddingProviderConfig } from '../domain/types.js';
import { createEmbeddingProviderFromConfig, testEmbeddingProviderConfig } from '../services/embeddingService.js';

type EmbeddingStubResponse = { status?: number; statusText?: string; body?: unknown; rawBody?: string };

async function createEmbeddingStub(handler: (body: any) => EmbeddingStubResponse | Promise<EmbeddingStubResponse>) {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      requests.push(body);
      const result = await handler(body);
      res.statusCode = result.status ?? 200;
      if (result.statusText) res.statusMessage = result.statusText;
      res.setHeader('content-type', 'application/json');
      res.end(result.rawBody ?? JSON.stringify(result.body));
    })().catch((error) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No stub port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

describe('embeddingService', () => {
  it('returns deterministic mock embeddings with configured dimensions', async () => {
    const provider = createEmbeddingProviderFromConfig({ provider: 'mock', baseUrl: '', apiKey: '', model: '', dimensions: 4 });

    const first = await provider.embed('攻击检定');
    const second = await provider.embed('攻击检定');
    const different = await provider.embed('长休恢复');

    expect(first).toHaveLength(4);
    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
    expect(first.every((value) => Number.isFinite(value))).toBe(true);
  });

  it('calls an OpenAI-compatible embeddings endpoint', async () => {
    const stub = await createEmbeddingStub((body) => ({
      body: { data: [{ embedding: [0.1, 0.2, 0.3] }], model: body.model }
    }));
    const config: EmbeddingProviderConfig = { provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'embedding-key', model: 'embed-model', dimensions: 3 };

    try {
      const provider = createEmbeddingProviderFromConfig(config);
      await expect(provider.embed('测试文本')).resolves.toEqual([0.1, 0.2, 0.3]);
      expect(stub.requests).toEqual([{ model: 'embed-model', input: '测试文本', dimensions: 3 }]);
      await expect(testEmbeddingProviderConfig(config)).resolves.toBeUndefined();
    } finally {
      await stub.close();
    }
  });

  it('returns stable errors for malformed embedding responses', async () => {
    const stub = await createEmbeddingStub(() => ({ body: { data: [{ embedding: ['bad'] }] } }));
    const config: EmbeddingProviderConfig = { provider: 'openai-compatible', baseUrl: stub.baseUrl, apiKey: 'embedding-key', model: 'embed-model', dimensions: 3 };

    try {
      const provider = createEmbeddingProviderFromConfig(config);
      await expect(provider.embed('测试文本')).rejects.toThrow('Embedding provider returned invalid embedding vector');
    } finally {
      await stub.close();
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- server/src/tests/embeddingService.test.ts
```

Expected: FAIL because `embeddingService.ts` does not exist.

- [x] **Step 3: Implement embedding service**

Create `server/src/services/embeddingService.ts`:

```ts
import type { EmbeddingProviderConfig } from '../domain/types.js';

const EMBEDDING_PROVIDER_TIMEOUT_MS = 30_000;
const EMBEDDING_PROVIDER_ERROR_BODY_MAX_CHARS = 1000;

export interface EmbeddingProvider {
  name: string;
  embed(text: string): Promise<number[]>;
}

function assertHttpUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OpenAI-compatible embedding provider baseUrl must use http or https');
  }
}

function embeddingsUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  assertHttpUrl(parsed);
  const base = new URL(parsed.toString().replace(/\/*$/, '/'));
  return new URL('embeddings', base).toString();
}

function sanitizeProviderBody(body: string, apiKey: string): string {
  const redacted = apiKey ? body.split(apiKey).join('[REDACTED_API_KEY]') : body;
  return redacted.length > EMBEDDING_PROVIDER_ERROR_BODY_MAX_CHARS
    ? `${redacted.slice(0, EMBEDDING_PROVIDER_ERROR_BODY_MAX_CHARS)}…`
    : redacted;
}

function parseJsonWithMessage(text: string, message: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function validateEmbeddingVector(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error('Embedding provider returned invalid embedding vector');
  }
  return value;
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => Number((value / magnitude).toFixed(8)));
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  name = 'mock';

  constructor(private readonly dimensions: number) {}

  async embed(text: string): Promise<number[]> {
    const values = Array.from({ length: this.dimensions }, (_, index) => {
      let hash = 2166136261 + index;
      for (const char of text) {
        hash ^= char.charCodeAt(0) + index;
        hash = Math.imul(hash, 16777619);
      }
      return ((hash >>> 0) % 2000) / 1000 - 1;
    });
    return normalizeVector(values);
  }
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  name = 'openai-compatible';

  constructor(private readonly config: EmbeddingProviderConfig) {}

  async embed(text: string): Promise<number[]> {
    if (!this.config.apiKey) throw new Error('apiKey is required when provider=openai-compatible');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, EMBEDDING_PROVIDER_TIMEOUT_MS);

    try {
      const response = await fetch(embeddingsUrl(this.config.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({ model: this.config.model, input: text, dimensions: this.config.dimensions }),
        signal: controller.signal
      });
      const responseText = await response.text();
      if (!response.ok) {
        const statusText = response.statusText ? ` ${response.statusText}` : '';
        throw new Error(`Embedding provider failed with ${response.status}${statusText}: ${sanitizeProviderBody(responseText, this.config.apiKey)}`);
      }
      const data = parseJsonWithMessage(responseText, 'Embedding provider returned invalid JSON response');
      if (!isPlainObject(data) || !Array.isArray(data.data) || !isPlainObject(data.data[0])) {
        throw new Error('Embedding provider returned invalid JSON response');
      }
      return validateEmbeddingVector(data.data[0].embedding);
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error(`Embedding provider request timed out after ${EMBEDDING_PROVIDER_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createEmbeddingProviderFromConfig(config: EmbeddingProviderConfig): EmbeddingProvider {
  if (config.provider === 'openai-compatible') {
    assertHttpUrl(new URL(config.baseUrl));
    return new OpenAiCompatibleEmbeddingProvider(config);
  }
  return new MockEmbeddingProvider(config.dimensions);
}

export async function testEmbeddingProviderConfig(config: EmbeddingProviderConfig): Promise<void> {
  if (config.provider === 'mock') return;
  await createEmbeddingProviderFromConfig(config).embed('connection test');
}
```

- [x] **Step 4: Add admin test endpoint**

In `server/src/routes/adminRoutes.ts`, import `testEmbeddingProviderConfig` and add route after `PUT /config/embedding-provider`:

```ts
  router.post('/config/embedding-provider/test', async (req, res) => {
    try {
      const body = req.body;
      const usesSavedConfig = body === undefined || (isPlainObject(body) && Object.keys(body).length === 0);
      if (!usesSavedConfig && !isPlainObject(body)) {
        throw new GlobalConfigResourceError('Embedding provider test payload must be an object', 400);
      }
      const config = usesSavedConfig
        ? getGlobalEmbeddingProviderConfig(db)
        : updateGlobalEmbeddingProviderConfig(db, embeddingProviderConfigSchema.parse(body));
      await testEmbeddingProviderConfig(config);
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

Important implementation note: if saving on test is not desired, replace `updateGlobalEmbeddingProviderConfig(...)` with `normalizeEmbeddingProviderConfig(...)`. The test in Task 1 only requires PUT saving; Task 2 test only requires provider behavior.

- [x] **Step 5: Run embedding service tests**

Run:

```bash
rtk npm test -- server/src/tests/embeddingService.test.ts
```

Expected: PASS.

---

## Task 3: Rule indexing and hybrid retrieval service

**Files:**
- Create: `server/src/services/ruleRetrievalService.ts`
- Create: `server/src/tests/ruleRetrievalService.test.ts`
- Modify: `server/src/services/phbExtractionService.ts` only if an approved rule lookup helper is needed.

- [x] **Step 1: Write failing retrieval service tests**

Create `server/src/tests/ruleRetrievalService.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { createPhbExtractionJob, listPhbExtractionDrafts, reviewPhbExtractionDraft } from '../services/phbExtractionService.js';
import {
  indexApprovedRuleEntries,
  retrieveRuleMatches,
  storeRuleContextHits,
  listRuleSummariesForRoom
} from '../services/ruleRetrievalService.js';
import { createEmbeddingProviderFromConfig } from '../services/embeddingService.js';

function seedApprovedRules(db: ReturnType<typeof createMemoryDb>) {
  const { drafts } = createPhbExtractionJob(db, {
    name: 'PHB 检索样例',
    drafts: [
      { kind: 'rule_entry', title: '攻击检定', category: 'combat', summary: '攻击时掷 d20 对抗 AC。', content: '攻击检定用于判断攻击是否命中目标 AC。', keys: ['攻击检定', 'AC', '命中'], sourceRef: 'PHB p.194', priority: 200 },
      { kind: 'rule_entry', title: '长休', category: 'rest', summary: '长休恢复生命值和部分资源。', content: '长休通常需要至少 8 小时。', keys: ['长休', '恢复'], sourceRef: 'PHB p.186', priority: 100 },
      { kind: 'character_option', optionType: 'class', title: '战士', summary: '战士不是规则条目。', sourceRef: 'PHB p.70' }
    ]
  });
  for (const draft of drafts.filter((item) => item.kind === 'rule_entry')) {
    reviewPhbExtractionDraft(db, draft.id, { status: 'approved' });
  }
  return drafts;
}

describe('ruleRetrievalService', () => {
  it('indexes only approved rule entries', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedApprovedRules(db);
      const provider = createEmbeddingProviderFromConfig({ provider: 'mock', baseUrl: '', apiKey: '', model: '', dimensions: 8 });

      const result = await indexApprovedRuleEntries(db, provider);

      expect(result.indexed).toBe(2);
      const count = db.prepare('SELECT COUNT(*) as count FROM rule_entry_embeddings').get() as { count: number };
      expect(count.count).toBe(2);
    } finally {
      db.close();
    }
  });

  it('retrieves matches by keyword and semantic score', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedApprovedRules(db);
      const provider = createEmbeddingProviderFromConfig({ provider: 'mock', baseUrl: '', apiKey: '', model: '', dimensions: 8 });
      await indexApprovedRuleEntries(db, provider);

      const matches = await retrieveRuleMatches(db, provider, '我挥剑攻击强盗，看看能不能命中 AC。', { limit: 3 });

      expect(matches[0]).toMatchObject({ title: '攻击检定', category: 'combat' });
      expect(matches[0].reasons).toContain('keyword');
      expect(matches.every((match) => match.score > 0)).toBe(true);
      expect(matches.map((match) => match.title)).not.toContain('战士');
    } finally {
      db.close();
    }
  });

  it('stores short player-visible rule summaries', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedApprovedRules(db);
      const provider = createEmbeddingProviderFromConfig({ provider: 'mock', baseUrl: '', apiKey: '', model: '', dimensions: 8 });
      await indexApprovedRuleEntries(db, provider);
      const matches = await retrieveRuleMatches(db, provider, '短休后还能长休吗？', { limit: 2 });

      storeRuleContextHits(db, { roomId: 'room-1', turnId: 'turn-1', matches });
      const summaries = listRuleSummariesForRoom(db, 'room-1', 5);

      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries[0]).toHaveProperty('entryId');
      expect(summaries[0].reason).toContain('参考规则');
      expect(summaries[0].summary.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- server/src/tests/ruleRetrievalService.test.ts
```

Expected: FAIL because `ruleRetrievalService.ts` does not exist.

- [x] **Step 3: Implement retrieval service**

Create `server/src/services/ruleRetrievalService.ts`:

```ts
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { RuleRetrievalMatch, RuleSummary } from '../domain/types.js';
import type { EmbeddingProvider } from './embeddingService.js';

type RuleEntryRow = {
  id: string;
  title: string;
  category: string;
  summary: string;
  content: string;
  keysJson: string;
  sourceRef: string;
  priority: number;
};

function parseKeys(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function contentForEmbedding(row: RuleEntryRow): string {
  return [row.title, row.category, row.summary, row.content, parseKeys(row.keysJson).join(' ')].filter(Boolean).join('\n');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function approvedRuleRows(db: AppDatabase): RuleEntryRow[] {
  return db.prepare(`
    SELECT id, title, category, summary, content, keys_json as keysJson, source_ref as sourceRef, priority
    FROM rule_world_book_entries
    WHERE enabled = 1
    ORDER BY priority DESC, title ASC
  `).all() as RuleEntryRow[];
}

function mapRowToMatch(row: RuleEntryRow, score: number, reasons: RuleRetrievalMatch['reasons']): RuleRetrievalMatch {
  return {
    entryId: row.id,
    title: row.title,
    category: row.category,
    summary: row.summary,
    content: row.content,
    keys: parseKeys(row.keysJson),
    sourceRef: row.sourceRef,
    score: Number(score.toFixed(6)),
    reasons
  };
}

export async function indexApprovedRuleEntries(db: AppDatabase, provider: EmbeddingProvider): Promise<{ indexed: number; skipped: number }> {
  let indexed = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  for (const row of approvedRuleRows(db)) {
    const text = contentForEmbedding(row);
    const hash = sha256(text);
    const existing = db.prepare('SELECT content_hash as contentHash FROM rule_entry_embeddings WHERE entry_id = ?').get(row.id) as { contentHash: string } | undefined;
    if (existing?.contentHash === hash) {
      skipped += 1;
      continue;
    }
    const embedding = await provider.embed(text);
    db.prepare(`
      INSERT INTO rule_entry_embeddings (entry_id, embedding_json, content_hash, indexed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET embedding_json = excluded.embedding_json, content_hash = excluded.content_hash, indexed_at = excluded.indexed_at
    `).run(row.id, JSON.stringify(embedding), hash, now);
    indexed += 1;
  }
  return { indexed, skipped };
}

export async function retrieveRuleMatches(db: AppDatabase, provider: EmbeddingProvider, query: string, options: { limit?: number } = {}): Promise<RuleRetrievalMatch[]> {
  const limit = options.limit ?? 5;
  const queryEmbedding = await provider.embed(query);
  const embeddingRows = db.prepare(`
    SELECT entry_id as entryId, embedding_json as embeddingJson FROM rule_entry_embeddings
  `).all() as Array<{ entryId: string; embeddingJson: string }>;
  const embeddingByEntry = new Map(embeddingRows.map((row) => {
    try {
      return [row.entryId, JSON.parse(row.embeddingJson) as number[]] as const;
    } catch {
      return [row.entryId, []] as const;
    }
  }));
  const normalizedQuery = query.toLocaleLowerCase();

  return approvedRuleRows(db)
    .map((row) => {
      const keys = parseKeys(row.keysJson);
      const keywordHits = keys.filter((key) => key && normalizedQuery.includes(key.toLocaleLowerCase()));
      const semantic = cosineSimilarity(queryEmbedding, embeddingByEntry.get(row.id) ?? []);
      const keywordScore = keywordHits.length > 0 ? 1 + keywordHits.length * 0.25 : 0;
      const score = keywordScore + Math.max(0, semantic) + row.priority / 10000;
      const reasons: RuleRetrievalMatch['reasons'] = [];
      if (keywordHits.length > 0) reasons.push('keyword');
      if (semantic > 0.1) reasons.push('semantic');
      return { row, score, reasons };
    })
    .filter((item) => item.score > 0 && item.reasons.length > 0)
    .sort((left, right) => right.score - left.score || left.row.title.localeCompare(right.row.title))
    .slice(0, limit)
    .map((item) => mapRowToMatch(item.row, item.score, item.reasons));
}

export function storeRuleContextHits(db: AppDatabase, input: { roomId: string; turnId: string | null; matches: RuleRetrievalMatch[] }): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const match of input.matches) {
      db.prepare(`
        INSERT INTO rule_context_hits (id, room_id, turn_id, entry_id, title, summary, reason, score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nanoid(), input.roomId, input.turnId, match.entryId, match.title, match.summary, `参考规则：${match.title}`, match.score, now);
    }
  });
  tx();
}

export function listRuleSummariesForRoom(db: AppDatabase, roomId: string, limit = 5): RuleSummary[] {
  return (db.prepare(`
    SELECT entry_id as entryId, title, summary, reason, created_at as createdAt
    FROM rule_context_hits
    WHERE room_id = ?
    ORDER BY created_at DESC, score DESC
    LIMIT ?
  `).all(roomId, limit) as RuleSummary[]);
}
```

- [x] **Step 4: Run retrieval tests**

Run:

```bash
rtk npm test -- server/src/tests/ruleRetrievalService.test.ts
```

Expected: PASS.

---

## Task 4: Admin indexing and retrieval APIs

**Files:**
- Modify: `server/src/routes/adminRoutes.ts`
- Modify: `server/src/tests/integration.test.ts`

- [x] **Step 1: Write failing integration test for indexing and retrieval preview**

Append to `server/src/tests/integration.test.ts`:

```ts
  it('indexes approved PHB rules and previews rule retrieval matches', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const importRes = await fetch(`${base}/api/admin/resources/phb-extractions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'PHB 规则检索 API 样例',
          drafts: [{ kind: 'rule_entry', title: '攻击检定', category: 'combat', summary: '攻击时掷 d20 对抗 AC。', content: '攻击检定用于判断是否命中。', keys: ['攻击检定', 'AC'], sourceRef: 'PHB p.194' }]
        })
      });
      const imported = await importRes.json() as { drafts: Array<{ id: string }> };
      await fetch(`${base}/api/admin/resources/phb-extraction-drafts/${imported.drafts[0].id}/review`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' })
      });

      const indexRes = await fetch(`${base}/api/admin/rules/embeddings/reindex`, { method: 'POST' });
      expect(indexRes.status).toBe(200);
      expect(await indexRes.json()).toEqual({ indexed: 1, skipped: 0 });

      const previewRes = await fetch(`${base}/api/admin/rules/retrieval-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '我攻击强盗，看是否命中 AC。' })
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { matches: Array<{ title: string; reasons: string[] }> };
      expect(preview.matches[0].title).toBe('攻击检定');
      expect(preview.matches[0].reasons).toContain('keyword');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "indexes approved PHB rules"
```

Expected: FAIL with 404 for `/api/admin/rules/embeddings/reindex`.

- [x] **Step 3: Add admin routes**

In `server/src/routes/adminRoutes.ts`, import:

```ts
import { createEmbeddingProviderFromConfig, testEmbeddingProviderConfig } from '../services/embeddingService.js';
import { indexApprovedRuleEntries, retrieveRuleMatches } from '../services/ruleRetrievalService.js';
```

Add schema near other schemas:

```ts
const ruleRetrievalPreviewSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(10).default(5)
}).strict();
```

Add routes after embedding config routes:

```ts
  router.post('/rules/embeddings/reindex', async (_req, res) => {
    try {
      const provider = createEmbeddingProviderFromConfig(getGlobalEmbeddingProviderConfig(db));
      res.json(await indexApprovedRuleEntries(db, provider));
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/rules/retrieval-preview', async (req, res) => {
    try {
      const input = ruleRetrievalPreviewSchema.parse(req.body);
      const provider = createEmbeddingProviderFromConfig(getGlobalEmbeddingProviderConfig(db));
      const matches = await retrieveRuleMatches(db, provider, input.query, { limit: input.limit });
      res.json({ matches });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid retrieval preview payload', issues: error.issues });
        return;
      }
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
```

- [x] **Step 4: Run focused integration test**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "indexes approved PHB rules"
```

Expected: PASS.

---

## Task 5: Silent rule injection into AI prompt and prompt preview

**Files:**
- Modify: `server/src/services/aiContextBuilder.ts`
- Modify: `server/src/routes/adminRoutes.ts`
- Modify: `server/src/tests/integration.test.ts`

- [x] **Step 1: Write failing prompt preview integration test**

Append to `server/src/tests/integration.test.ts`:

```ts
  it('injects retrieved PHB rules into native prompt preview silently', async () => {
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
        body: JSON.stringify({ name: '规则注入房间' })
      });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '艾拉' })
      });
      await playerRes.json();

      const importRes = await fetch(`${base}/api/admin/resources/phb-extractions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'PHB Prompt 规则样例',
          drafts: [{ kind: 'rule_entry', title: '攻击检定', category: 'combat', summary: '攻击时掷 d20 对抗 AC。', content: '攻击检定用于判断攻击是否命中目标 AC。', keys: ['攻击', 'AC'], sourceRef: 'PHB p.194' }]
        })
      });
      const imported = await importRes.json() as { drafts: Array<{ id: string }> };
      await fetch(`${base}/api/admin/resources/phb-extraction-drafts/${imported.drafts[0].id}/review`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' })
      });
      await fetch(`${base}/api/admin/rules/embeddings/reindex`, { method: 'POST' });

      const tokenRows = db.prepare('SELECT token FROM players').all() as Array<{ token: string }>;
      await fetch(`${base}/api/player/${tokenRows[0].token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '我攻击穿着皮甲的强盗，看看能不能命中 AC。' })
      });

      const previewRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/ai-prompt-preview`);
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { prompt: string; ruleMatches: Array<{ title: string; summary: string }> };
      expect(preview.prompt).toContain('# 5e 规则检索命中');
      expect(preview.prompt).toContain('攻击检定');
      expect(preview.ruleMatches).toEqual([expect.objectContaining({ title: '攻击检定', summary: '攻击时掷 d20 对抗 AC。' })]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "injects retrieved PHB rules"
```

Expected: FAIL because prompt preview has no rule matches.

- [x] **Step 3: Extend prompt builder**

In `server/src/services/aiContextBuilder.ts`, import `RuleRetrievalMatch` and change `buildTurnPrompt` input to include:

```ts
  ruleMatches?: RuleRetrievalMatch[];
```

Add helper:

```ts
function renderRuleMatches(matches: RuleRetrievalMatch[]): string {
  if (!matches.length) return '- No 5e rule matches.';
  return matches.map((match) => [
    `## ${match.title}`,
    `分类：${match.category}`,
    `摘要：${match.summary}`,
    `来源：${match.sourceRef || '未记录'}`,
    match.content
  ].filter(Boolean).join('\n')).join('\n\n');
}
```

In `buildTurnPrompt`, after world book section and before public logs, add:

```ts
    '# 5e 规则检索命中',
    renderRuleMatches(input.ruleMatches ?? []),
```

- [x] **Step 4: Load rule matches for prompt preview**

In `server/src/routes/adminRoutes.ts`, import `RuleRetrievalMatch` type if needed. Extend `RoomPromptPreviewContext` with:

```ts
  ruleMatches: RuleRetrievalMatch[];
```

In `loadRoomPromptPreviewContext`, after `scanText`, add:

```ts
  const embeddingProvider = createEmbeddingProviderFromConfig(getGlobalEmbeddingProviderConfig(db));
  const ruleMatches = await retrieveRuleMatches(db, embeddingProvider, scanText, { limit: 5 });
```

Because `retrieveRuleMatches` is async, convert `loadRoomPromptPreviewContext`, `buildRoomPromptPreview`, and the `/ai-prompt-preview` route to async. Also pass `ruleMatches` into `buildTurnPrompt` and include preview field:

```ts
      ruleMatches: context.ruleMatches.map((match) => ({
        entryId: match.entryId,
        title: match.title,
        category: match.category,
        score: match.score,
        reasons: match.reasons,
        summary: match.summary
      })),
```

For SillyTavern-compatible preview, keep the existing prompt path but still include `ruleMatches` in the JSON response. If injecting into ST-compatible prompt is too invasive for this task, set a warning: `5e rule matches are shown but not injected in SillyTavern-compatible preview mode.`

- [x] **Step 5: Run focused test**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "injects retrieved PHB rules"
```

Expected: PASS.

---

## Task 6: Process-turn rule summaries and player-visible state

**Files:**
- Modify: `server/src/routes/adminRoutes.ts`
- Modify: `server/src/routes/playerRoutes.ts`
- Modify: `server/src/services/visibilityService.ts`
- Modify: `server/src/tests/integration.test.ts`

- [x] **Step 1: Write failing integration test for player rule summaries**

Append to `server/src/tests/integration.test.ts`:

```ts
  it('stores short rule summaries for players after process-turn retrieval', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '规则摘要房间' }) });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '洛林' }) });
      const player = await playerRes.json() as { token: string };

      const importRes = await fetch(`${base}/api/admin/resources/phb-extractions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          name: 'PHB 玩家摘要样例',
          drafts: [{ kind: 'rule_entry', title: '攻击检定', category: 'combat', summary: '攻击时掷 d20 对抗 AC。', content: '攻击检定用于判断是否命中。', keys: ['攻击', 'AC'], sourceRef: 'PHB p.194' }]
        })
      });
      const imported = await importRes.json() as { drafts: Array<{ id: string }> };
      await fetch(`${base}/api/admin/resources/phb-extraction-drafts/${imported.drafts[0].id}/review`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'approved' }) });
      await fetch(`${base}/api/admin/rules/embeddings/reindex`, { method: 'POST' });

      await fetch(`${base}/api/player/${player.token}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '我攻击强盗。' }) });
      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, { method: 'POST' });
      expect(processRes.status).toBe(200);

      const stateRes = await fetch(`${base}/api/player/${player.token}/state`);
      expect(stateRes.status).toBe(200);
      const state = await stateRes.json() as { ruleSummaries: Array<{ title: string; summary: string; reason: string }> };
      expect(state.ruleSummaries[0]).toMatchObject({ title: '攻击检定', summary: '攻击时掷 d20 对抗 AC。' });
      expect(state.ruleSummaries[0].reason).toContain('参考规则');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "stores short rule summaries"
```

Expected: FAIL because `ruleSummaries` is missing or empty.

- [x] **Step 3: Store hits during process-turn**

In `server/src/routes/adminRoutes.ts`, ensure process-turn uses the same async prompt-preview context or retrieval helper. After retrieving `ruleMatches` and before/inside the transaction that writes logs, call:

```ts
storeRuleContextHits(db, { roomId: req.params.roomId, turnId: turn.id, matches: ruleMatches });
```

If transaction already exists, call inside it by making `storeRuleContextHits` not start its own transaction when called from transaction. Simpler change for this plan: call `storeRuleContextHits` before the process-turn transaction; because it only stores retrieval metadata and does not mutate gameplay state, this is acceptable.

Pass `ruleMatches` to `processTurnActions` prompt building through `buildTurnPrompt` by adding it to the existing call chain.

- [x] **Step 4: Add player state summaries**

In `server/src/services/visibilityService.ts`, update input interface:

```ts
  ruleSummaries?: RuleSummary[];
```

Import `RuleSummary` and return:

```ts
    ruleSummaries: input.ruleSummaries ?? []
```

In `server/src/routes/playerRoutes.ts`, import `listRuleSummariesForRoom` and load before `buildPlayerVisibleState`:

```ts
    const ruleSummaries = listRuleSummariesForRoom(db, player.roomId, 5);
```

Pass `ruleSummaries` into `buildPlayerVisibleState`.

- [x] **Step 5: Run focused test**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "stores short rule summaries"
```

Expected: PASS.

---

## Task 7: Client API and UI for embedding config and rule matches

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/api.ts`
- Modify: `client/src/pages/AdminPage.tsx`
- Modify: `client/src/components/PromptPreviewPanel.tsx`
- Modify: `client/src/pages/PlayerPage.tsx`
- Modify: `client/src/api.test.tsx`
- Modify: `client/src/ui-copy.test.tsx`

- [x] **Step 1: Write failing client API test**

Append to `client/src/api.test.tsx`:

```ts
  it('saves, tests, indexes, and previews embedding rule retrieval APIs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'mock', baseUrl: '', apiKey: '', model: '', dimensions: 8 }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'mock', baseUrl: '', apiKey: '', model: '', dimensions: 8 }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ indexed: 1, skipped: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ matches: [{ entryId: 'rule-1', title: '攻击检定' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await getGlobalEmbeddingProviderConfig();
    await saveGlobalEmbeddingProviderConfig({ provider: 'mock', baseUrl: '', apiKey: '', model: '', dimensions: 8 });
    await testGlobalEmbeddingProviderConfig({ provider: 'mock', baseUrl: '', apiKey: '', model: '', dimensions: 8 });
    await reindexRuleEmbeddings();
    await previewRuleRetrieval('攻击 AC');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/config/embedding-provider', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/config/embedding-provider', expect.objectContaining({ method: 'PUT' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/config/embedding-provider/test', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/rules/embeddings/reindex', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/admin/rules/retrieval-preview', expect.objectContaining({ method: 'POST' }));

    fetchMock.mockRestore();
  });
```

- [x] **Step 2: Run failing client API test**

Run:

```bash
rtk npm test -- client/src/api.test.tsx -t "saves, tests, indexes"
```

Expected: FAIL because functions do not exist.

- [x] **Step 3: Add client types and API functions**

In `client/src/types.ts`, add:

```ts
export interface EmbeddingProviderConfig {
  provider: 'mock' | 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

export interface RuleRetrievalMatch {
  entryId: string;
  title: string;
  category: string;
  summary: string;
  content: string;
  keys: string[];
  sourceRef: string;
  score: number;
  reasons: Array<'keyword' | 'semantic'>;
}

export interface RuleSummary {
  entryId: string;
  title: string;
  summary: string;
  reason: string;
  createdAt: string;
}
```

Add `embeddingProviderConfig` to `GlobalConfigSnapshot`, `ruleMatches` to `PromptPreviewResponse`, and `ruleSummaries` to `PlayerVisibleState`.

In `client/src/api.ts`, import the new types and add:

```ts
export function getGlobalEmbeddingProviderConfig() {
  return jsonRequest<EmbeddingProviderConfig>('/api/admin/config/embedding-provider');
}

export function saveGlobalEmbeddingProviderConfig(config: EmbeddingProviderConfig) {
  return jsonRequest<EmbeddingProviderConfig>('/api/admin/config/embedding-provider', { method: 'PUT', body: JSON.stringify(config) });
}

export function testGlobalEmbeddingProviderConfig(config?: EmbeddingProviderConfig) {
  return jsonRequest<{ ok: true }>('/api/admin/config/embedding-provider/test', { method: 'POST', ...(config ? { body: JSON.stringify(config) } : {}) });
}

export function reindexRuleEmbeddings() {
  return jsonRequest<{ indexed: number; skipped: number }>('/api/admin/rules/embeddings/reindex', { method: 'POST' });
}

export function previewRuleRetrieval(query: string, limit = 5) {
  return jsonRequest<{ matches: RuleRetrievalMatch[] }>('/api/admin/rules/retrieval-preview', { method: 'POST', body: JSON.stringify({ query, limit }) });
}
```

- [x] **Step 4: Add admin embedding controls**

In `client/src/pages/AdminPage.tsx`, import the embedding API functions and `EmbeddingProviderConfig`. Add state:

```ts
  const [embeddingProviderConfig, setEmbeddingProviderConfig] = useState<EmbeddingProviderConfig | null>(null);
  const [embeddingMessage, setEmbeddingMessage] = useState('');
  const [embeddingTesting, setEmbeddingTesting] = useState(false);
```

In `refresh()`, fetch `getGlobalEmbeddingProviderConfig()` alongside state/chat provider config and set it if not dirty. For this first UI slice, no dirty ref is required if using simple state.

Add functions:

```ts
  function updateEmbeddingProviderConfig(key: keyof EmbeddingProviderConfig, value: string | number) {
    setEmbeddingMessage('');
    setEmbeddingProviderConfig((current) => current ? { ...current, [key]: value } : current);
  }

  async function persistEmbeddingProviderConfig() {
    if (!embeddingProviderConfig) return;
    setError('');
    setEmbeddingMessage('');
    try {
      const saved = await saveGlobalEmbeddingProviderConfig(embeddingProviderConfig);
      setEmbeddingProviderConfig(saved);
      setEmbeddingMessage('Embedding 接口已保存。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function testEmbeddingProvider() {
    if (!embeddingProviderConfig || embeddingTesting) return;
    setError('');
    setEmbeddingMessage('正在测试 Embedding 连接...');
    setEmbeddingTesting(true);
    try {
      await testGlobalEmbeddingProviderConfig(embeddingProviderConfig);
      setEmbeddingMessage('Embedding 连接测试成功。');
    } catch (err) {
      setEmbeddingMessage('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEmbeddingTesting(false);
    }
  }

  async function rebuildRuleEmbeddings() {
    setError('');
    try {
      const result = await reindexRuleEmbeddings();
      setEmbeddingMessage(`规则向量索引完成：新增/更新 ${result.indexed} 条，跳过 ${result.skipped} 条。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
```

In AI interface tab after chat provider controls, render:

```tsx
            {embeddingProviderConfig ? (
              <div className="subcard">
                <h3>Embedding 接口</h3>
                <p className="muted">用于 5e 规则语义检索，独立于聊天模型。</p>
                <label>Provider
                  <select value={embeddingProviderConfig.provider} onChange={(event) => updateEmbeddingProviderConfig('provider', event.target.value)}>
                    <option value="mock">mock</option>
                    <option value="openai-compatible">openai-compatible</option>
                  </select>
                </label>
                <label>API Base URL<input value={embeddingProviderConfig.baseUrl} onChange={(event) => updateEmbeddingProviderConfig('baseUrl', event.target.value)} /></label>
                <label>API Key<input type="password" value={embeddingProviderConfig.apiKey} onChange={(event) => updateEmbeddingProviderConfig('apiKey', event.target.value)} /></label>
                <label>Model<input value={embeddingProviderConfig.model} onChange={(event) => updateEmbeddingProviderConfig('model', event.target.value)} /></label>
                <label>Dimensions<input type="number" value={embeddingProviderConfig.dimensions} onChange={(event) => updateEmbeddingProviderConfig('dimensions', Number(event.target.value))} /></label>
                <div className="button-row">
                  <button onClick={persistEmbeddingProviderConfig}>保存 Embedding 接口</button>
                  <button onClick={testEmbeddingProvider} disabled={embeddingTesting}>{embeddingTesting ? '测试中...' : '测试 Embedding'}</button>
                  <button onClick={rebuildRuleEmbeddings}>重建规则向量索引</button>
                </div>
                {embeddingMessage ? <p>{embeddingMessage}</p> : null}
              </div>
            ) : null}
```

- [x] **Step 5: Show rule matches and summaries**

In `client/src/components/PromptPreviewPanel.tsx`, render after world-book matches:

```tsx
      {preview.ruleMatches.length ? (
        <section className="subcard">
          <h3>5e 规则命中</h3>
          {preview.ruleMatches.map((match) => (
            <p key={match.entryId}>{match.title} · {match.category} · {match.reasons.join(', ')} · {match.summary}</p>
          ))}
        </section>
      ) : null}
```

In `client/src/pages/PlayerPage.tsx`, render near character/status area:

```tsx
        {state.ruleSummaries.length ? (
          <section className="card">
            <h2>本轮规则摘要</h2>
            {state.ruleSummaries.map((summary) => (
              <p key={`${summary.entryId}-${summary.createdAt}`}><strong>{summary.title}</strong>：{summary.summary}</p>
            ))}
          </section>
        ) : null}
```

- [x] **Step 6: Update UI tests**

In `client/src/ui-copy.test.tsx`, add API mocks:

```ts
  getGlobalEmbeddingProviderConfig: vi.fn(async () => ({ provider: 'mock', baseUrl: '', apiKey: '', model: '', dimensions: 8 })),
  saveGlobalEmbeddingProviderConfig: vi.fn(async (config) => config),
  testGlobalEmbeddingProviderConfig: vi.fn(async () => ({ ok: true })),
  reindexRuleEmbeddings: vi.fn(async () => ({ indexed: 1, skipped: 0 })),
  previewRuleRetrieval: vi.fn(async () => ({ matches: [] })),
```

Add test:

```tsx
it('AI 接口页展示 Embedding 配置和规则向量索引操作', async () => {
  const user = userEvent.setup();
  render(<AdminPage roomId="room-1" />);

  await user.click(await screen.findByRole('button', { name: 'AI 接口' }));

  expect(await screen.findByText('Embedding 接口')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '测试 Embedding' }));
  expect(await screen.findByText('Embedding 连接测试成功。')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '重建规则向量索引' }));
  expect(await screen.findByText('规则向量索引完成：新增/更新 1 条，跳过 0 条。')).toBeInTheDocument();
});
```

Add prompt preview test by mocking `previewAiPrompt` with `ruleMatches: [{ entryId:'rule-1', title:'攻击检定', category:'combat', score:1, reasons:['keyword'], summary:'攻击时掷 d20 对抗 AC。' }]` and asserting `5e 规则命中` appears.

- [x] **Step 7: Run client tests**

Run:

```bash
rtk npm test -- client/src/api.test.tsx client/src/ui-copy.test.tsx
```

Expected: PASS.

---

## Task 8: Full verification and cleanup

**Files:**
- No source files changed in this task unless verification reveals a compile error.

- [x] **Step 1: Run focused server tests**

Run:

```bash
rtk npm test -- server/src/tests/embeddingService.test.ts server/src/tests/ruleRetrievalService.test.ts server/src/tests/integration.test.ts
```

Expected: PASS.

- [x] **Step 2: Run focused client tests**

Run:

```bash
rtk npm test -- client/src/api.test.tsx client/src/ui-copy.test.tsx
```

Expected: PASS.

- [x] **Step 3: Run full test suite**

Run:

```bash
rtk npm test
```

Expected: PASS.

- [x] **Step 4: Run typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Run production build**

Run:

```bash
rtk npm run build
```

Expected: PASS.

- [x] **Step 6: Check git status and local private files**

Run:

```bash
rtk git status --short
rtk git check-ignore -v -- "dnd相关/5eDnD_玩家手册PHB_中译v1.72版.pdf" "dnd相关/5eDnD_失落矿坑_新手套组_模组_中译(2校）.pdf"
```

Expected:
- Only intentional project files are listed as changed/untracked.
- The local private PDFs are still ignored by exact `.gitignore` entries.
- No generated PHB extraction JSON, temporary scripts, or PDF copies are newly introduced.

- [x] **Step 7: Do not commit unless explicitly requested**

Because the user’s global rule forbids automatic commits, stop after reporting verification results. If the user explicitly asks to commit this feature, use this command shape and include the required co-author trailer:

```bash
rtk git add server/src/domain/types.ts server/src/db/schema.ts server/src/services/embeddingService.ts server/src/services/ruleRetrievalService.ts server/src/services/globalConfigService.ts server/src/services/aiContextBuilder.ts server/src/services/visibilityService.ts server/src/routes/adminRoutes.ts server/src/routes/playerRoutes.ts server/src/tests/embeddingService.test.ts server/src/tests/ruleRetrievalService.test.ts server/src/tests/integration.test.ts client/src/types.ts client/src/api.ts client/src/pages/AdminPage.tsx client/src/components/PromptPreviewPanel.tsx client/src/pages/PlayerPage.tsx client/src/api.test.tsx client/src/ui-copy.test.tsx docs/superpowers/plans/2026-05-30-5e-embedding-rule-injection.md && rtk git commit -m "feat: add 5e rule embedding retrieval" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Follow-up Plan Boundaries

After this plan is implemented and verified, create separate plans for:

1. **Player 1级 character builder**
   - Uses approved `character_options` as the only selectable source.
   - Adds player-side wizard, AI review, and final confirmation.
2. **Structured character resources**
   - Expands sheet JSON and adds HP/temp HP/hit dice/spell slots/ammo/consumables/currency/conditions.
3. **AI-DM resource changes and rollback**
   - Extends AI output contract, validates resource patches, writes audit rows, and supports rollback.
4. **Database management center URL imports**
   - Adds URL import, source records, hashes, versioning, update preview, and JS sandbox boundaries.

These follow-up plans continue the current `/goal`: a standalone多人 DND AI 跑团系统 with structured rules, multiplayer campaign state, AI-DM rule grounding, resource imports, and long-term memory.

## Self-Review

- Spec coverage for this plan: covers global Embedding config, provider test, rule entry vector indexing, hybrid retrieval, prompt injection, prompt preview, and player short summaries.
- Explicitly not covered by this plan: player character builder, complete resource maintenance, AI resource patches, rollback, URL database subscriptions.
- Placeholder scan: no unfinished marker terms remain, no unfinished step labels remain, and each code-changing task includes concrete code snippets and commands.
- Type consistency: server/client names match: `EmbeddingProviderConfig`, `RuleRetrievalMatch`, `RuleSummary`, `getGlobalEmbeddingProviderConfig`, `saveGlobalEmbeddingProviderConfig`, `testGlobalEmbeddingProviderConfig`, `reindexRuleEmbeddings`, `previewRuleRetrieval`.
