import { Router } from 'express';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import { testAiProviderConfig } from '../services/aiProvider.js';
import type { AiConfig, PresetType } from '../domain/types.js';
import { normalizeAiConfig } from '../services/aiContextBuilder.js';
import { createEmbeddingProviderFromConfig, testEmbeddingProviderConfig } from '../services/embeddingService.js';
import { indexApprovedRuleEntries, retrieveRuleMatches } from '../services/ruleRetrievalService.js';
import { applyPresetTemplate, getActivePresetType, listPresetTemplates } from '../services/dmPresetService.js';
import {
  activateGlobalPreset,
  clearGlobalPresetPackage,
  clearGlobalScriptCard,
  createGlobalWorldBook,
  createGlobalWorldBookEntry,
  getGlobalAiProviderConfig,
  getGlobalEmbeddingProviderConfig,
  getGlobalConfigSnapshot,
  getGlobalWorldBookEntries,
  GlobalConfigResourceError,
  normalizeAiProviderConfig,
  normalizeEmbeddingProviderConfig,
  replaceGlobalResourceWorldBookBindings,
  saveGlobalPreset,
  setGlobalPresetPackage,
  setGlobalScriptCard,
  updateGlobalAiConfig,
  updateGlobalAiProviderConfig,
  updateGlobalEmbeddingProviderConfig,
  updateGlobalWorldBookEntry
} from '../services/globalConfigService.js';

const aiConfigSchema = z.object({
  coreRules: z.string().min(1),
  playerAgencyRules: z.string().min(1),
  visibilityRules: z.string().min(1),
  interactionRules: z.string().min(1),
  outputFormatRules: z.string().min(1),
  styleRules: z.string().min(1)
});

const aiProviderConfigSchema = z.object({
  provider: z.enum(['mock', 'openai-compatible']),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default('')
});

const embeddingProviderConfigSchema = z.object({
  provider: z.enum(['mock', 'openai-compatible']),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  dimensions: z.number().int().positive().default(8)
});

const ruleRetrievalPreviewSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(10).default(5)
}).strict();

const promptBlockPositionSchema = z.enum(['before_world', 'after_world', 'before_actions', 'after_actions', 'final']);
const promptBlockSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  role: z.enum(['system', 'user', 'assistant']).default('system'),
  position: promptBlockPositionSchema.default('before_world'),
  enabled: z.boolean().default(true),
  orderIndex: z.number().int().default(100),
  content: z.string().min(1)
});
const presetSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  isActive: z.boolean().default(false),
  blocks: z.array(promptBlockSchema).min(1)
});

const worldBookPositionSchema = z.enum(['before_world', 'after_world', 'before_actions', 'after_actions']);
const worldBookSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  enabled: z.boolean().default(true)
});
const worldBookEntrySchema = z.object({
  title: z.string().min(1),
  keys: z.array(z.string()).default([]),
  secondaryKeys: z.array(z.string()).default([]),
  content: z.string().min(1),
  enabled: z.boolean().default(true),
  constant: z.boolean().default(false),
  selective: z.boolean().default(false),
  priority: z.number().int().default(100),
  position: worldBookPositionSchema.default('after_world')
});

const globalScriptConfigSchema = z.object({ scriptCardId: z.string().min(1) });
const globalResourceWorldBookConfigSchema = z.object({
  bindings: z.array(z.object({
    worldBookId: z.string().min(1),
    enabled: z.boolean(),
    orderIndex: z.number().int()
  }))
});
const globalPresetPackageConfigSchema = z.object({ presetPackageId: z.string().min(1) });

function handleGlobalConfigResourceError(error: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid request payload', issues: error.issues });
    return;
  }
  if (error instanceof GlobalConfigResourceError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

export function registerAdminConfigRoutes(router: Router, db: AppDatabase): void {
  router.get('/config', (_req, res) => {
    res.json(getGlobalConfigSnapshot(db));
  });

  router.get('/config/ai-provider', (_req, res) => {
    res.json(getGlobalAiProviderConfig(db));
  });

  router.put('/config/ai-provider', (req, res) => {
    try {
      const aiProviderConfig = normalizeAiProviderConfig(aiProviderConfigSchema.parse(req.body));
      res.json(updateGlobalAiProviderConfig(db, aiProviderConfig));
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.get('/config/embedding-provider', (_req, res) => {
    res.json(getGlobalEmbeddingProviderConfig(db));
  });

  router.put('/config/embedding-provider', (req, res) => {
    try {
      res.json(updateGlobalEmbeddingProviderConfig(db, embeddingProviderConfigSchema.parse(req.body)));
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.post('/config/embedding-provider/test', async (req, res) => {
    try {
      const body = req.body;
      const usesSavedConfig = body === undefined || (typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).length === 0);
      if (!usesSavedConfig && (typeof body !== 'object' || body === null || Array.isArray(body))) {
        throw new GlobalConfigResourceError('Embedding provider test payload must be an object', 400);
      }
      const embeddingProviderConfig = usesSavedConfig
        ? getGlobalEmbeddingProviderConfig(db)
        : normalizeEmbeddingProviderConfig(embeddingProviderConfigSchema.parse(body));
      await testEmbeddingProviderConfig(embeddingProviderConfig);
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof GlobalConfigResourceError) {
        handleGlobalConfigResourceError(error, res);
        return;
      }
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

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
      if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid retrieval preview payload', issues: error.issues });
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/config/ai-provider/test', async (req, res) => {
    try {
      const body = req.body;
      const usesSavedConfig = body === undefined || (typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).length === 0);
      if (!usesSavedConfig && (typeof body !== 'object' || body === null || Array.isArray(body))) {
        throw new GlobalConfigResourceError('AI provider test payload must be an object', 400);
      }
      const aiProviderConfig = usesSavedConfig
        ? getGlobalAiProviderConfig(db)
        : normalizeAiProviderConfig(aiProviderConfigSchema.parse(body));
      await testAiProviderConfig(aiProviderConfig);
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof GlobalConfigResourceError) {
        handleGlobalConfigResourceError(error, res);
        return;
      }
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/config/ai-config', (req, res) => {
    try {
      const aiConfig: AiConfig = normalizeAiConfig(aiConfigSchema.parse(req.body));
      res.json(updateGlobalAiConfig(db, aiConfig));
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.post('/config/presets', (req, res) => {
    try {
      const preset = saveGlobalPreset(db, presetSchema.parse(req.body));
      res.json({ preset, presets: getGlobalConfigSnapshot(db).presets });
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.put('/config/presets/:presetId', (req, res) => {
    try {
      const input = presetSchema.parse(req.body);
      const existing = db.prepare('SELECT id FROM global_prompt_presets WHERE id = ?').get(req.params.presetId);
      if (!existing) throw new GlobalConfigResourceError('Preset not found', 404);
      res.json({ preset: saveGlobalPreset(db, { ...input, id: req.params.presetId }), presets: getGlobalConfigSnapshot(db).presets });
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.post('/config/presets/:presetId/activate', (req, res) => {
    try {
      const preset = activateGlobalPreset(db, req.params.presetId);
      res.json({ preset, presets: getGlobalConfigSnapshot(db).presets });
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.get('/preset-templates', (_req, res) => {
    res.json({ templates: listPresetTemplates() });
  });

  router.post('/preset-templates/:presetType/apply', (req, res) => {
    try {
      const presetType = req.params.presetType;
      const validTypes = ['tutorial', 'rules_strict', 'story_first', 'combat_first', 'casual', 'dark_fantasy', 'sandbox', 'epic'];
      if (!validTypes.includes(presetType)) {
        res.status(400).json({ error: `Invalid preset type: ${presetType}. Valid types: ${validTypes.join(', ')}` });
        return;
      }
      const preset = applyPresetTemplate(db, presetType as PresetType);
      res.json({ preset, presets: getGlobalConfigSnapshot(db).presets });
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.get('/active-preset-type', (_req, res) => {
    res.json({ presetType: getActivePresetType(db) });
  });

  router.post('/config/world-books', (req, res) => {
    try {
      const worldBook = createGlobalWorldBook(db, worldBookSchema.parse(req.body));
      res.json({ worldBook, worldBooks: getGlobalConfigSnapshot(db).worldBooks });
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.post('/config/world-books/:worldBookId/entries', (req, res) => {
    try {
      const entry = createGlobalWorldBookEntry(db, req.params.worldBookId, worldBookEntrySchema.parse(req.body));
      res.json({ entry, entries: getGlobalConfigSnapshot(db).worldBookEntries });
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.put('/config/world-books/:worldBookId/entries/:entryId', (req, res) => {
    try {
      const input = worldBookEntrySchema.parse(req.body);
      const entry = db.prepare('SELECT id FROM global_world_book_entries WHERE id = ? AND world_book_id = ?').get(req.params.entryId, req.params.worldBookId);
      if (!entry) throw new GlobalConfigResourceError('World book entry not found', 404);
      res.json({ entry: updateGlobalWorldBookEntry(db, req.params.entryId, input), entries: getGlobalWorldBookEntries(db) });
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.put('/config/script-card', (req, res) => {
    try {
      const input = globalScriptConfigSchema.parse(req.body);
      setGlobalScriptCard(db, input.scriptCardId);
      res.json(getGlobalConfigSnapshot(db));
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.delete('/config/script-card', (_req, res) => {
    clearGlobalScriptCard(db);
    res.json(getGlobalConfigSnapshot(db));
  });

  router.put('/config/resource-world-books', (req, res) => {
    try {
      const input = globalResourceWorldBookConfigSchema.parse(req.body);
      const bindings = replaceGlobalResourceWorldBookBindings(db, input.bindings);
      res.json({ bindings });
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.put('/config/preset-package', (req, res) => {
    try {
      const input = globalPresetPackageConfigSchema.parse(req.body);
      setGlobalPresetPackage(db, input.presetPackageId);
      res.json(getGlobalConfigSnapshot(db));
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.delete('/config/preset-package', (_req, res) => {
    clearGlobalPresetPackage(db);
    res.json(getGlobalConfigSnapshot(db));
  });
}
