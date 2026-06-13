import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type {
  AiConfig,
  AiProviderConfig,
  EmbeddingProviderConfig,
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
import { defaultAiConfig, defaultNarrativeLengthRules, normalizeAiConfig, parseAiConfigJson } from './aiContextBuilder.js';
import { getPresetPackage, getResourceWorldBook, getResourceWorldBookEntries, getScriptCard, listResourceLibrary } from './resourceLibrary.js';

export const GLOBAL_CONFIG_ID = 'default';
export const DEFAULT_GLOBAL_PRESET_ID = 'default-global-preset';
export const DEFAULT_GLOBAL_PRESET_NAME = '默认强约束预设';

export const defaultAiProviderConfig: AiProviderConfig = {
  provider: 'mock',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini'
};

export const defaultEmbeddingProviderConfig: EmbeddingProviderConfig = {
  provider: 'mock',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'text-embedding-3-small',
  dimensions: 8
};

export class GlobalConfigResourceError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'GlobalConfigResourceError';
  }
}

interface GlobalConfigRow {
  id: string;
  ai_config_json: string;
  ai_provider_config_json: string;
  embedding_provider_config_json: string;
  active_script_card_id: string | null;
  active_preset_package_id: string | null;
  created_at: string;
  updated_at: string;
}

interface GlobalPromptPresetRow {
  id: string;
  name: string;
  description: string;
  isActive: number;
  presetType: string | null;
  isTemplate: number;
  createdAt: string;
  updatedAt: string;
}

interface GlobalPromptBlockRow {
  id: string;
  presetId: string;
  name: string;
  role: PromptBlock['role'];
  position: PromptBlockPosition;
  enabled: number;
  orderIndex: number;
  content: string;
  category: string | null;
  sceneType: string | null;
}

interface GlobalWorldBookRow {
  id: string;
  name: string;
  description: string;
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

interface GlobalWorldBookEntryRow {
  id: string;
  worldBookId: string;
  title: string;
  keysJson: string;
  secondaryKeysJson: string;
  content: string;
  enabled: number;
  constant: number;
  selective: number;
  priority: number;
  position: WorldBookPosition;
  createdAt: string;
  updatedAt: string;
}

interface GlobalResourceWorldBookBindingRow {
  worldBookId: string;
  enabled: number;
  orderIndex: number;
  createdAt: string;
}

function parseJsonArray(json: string): string[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mapPromptBlockRow(row: GlobalPromptBlockRow): PromptBlock {
  return {
    id: row.id,
    presetId: row.presetId,
    name: row.name,
    role: row.role,
    position: row.position,
    enabled: Boolean(row.enabled),
    orderIndex: row.orderIndex,
    content: row.content,
    category: (row.category as PromptBlock['category']) ?? undefined,
    sceneType: (row.sceneType as PromptBlock['sceneType']) ?? undefined
  };
}

function mapGlobalWorldBookRow(row: GlobalWorldBookRow): WorldBook {
  return {
    id: row.id,
    roomId: '',
    name: row.name,
    description: row.description,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapGlobalWorldBookEntryRow(row: GlobalWorldBookEntryRow): WorldBookEntry {
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
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapGlobalResourceWorldBookBindingRow(row: GlobalResourceWorldBookBindingRow): GlobalResourceWorldBookBinding {
  return {
    worldBookId: row.worldBookId,
    enabled: Boolean(row.enabled),
    orderIndex: row.orderIndex,
    createdAt: row.createdAt
  };
}

function defaultGlobalPresetBlocks(aiConfig: AiConfig): Array<Omit<PromptBlock, 'id' | 'presetId'>> {
  return [
    { name: '核心规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 10, content: aiConfig.coreRules },
    { name: '玩家自主权规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 20, content: aiConfig.playerAgencyRules },
    { name: '信息隔离规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 30, content: aiConfig.visibilityRules },
    { name: '玩家互动规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 40, content: aiConfig.interactionRules },
    { name: '叙事风格规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 50, content: aiConfig.styleRules },
    { name: '剧情字数限制', role: 'system', position: 'final', enabled: true, orderIndex: 850, content: defaultNarrativeLengthRules },
    { name: '输出格式规则', role: 'system', position: 'final', enabled: true, orderIndex: 900, content: aiConfig.outputFormatRules }
  ];
}

function ensureDefaultGlobalPresetRow(db: AppDatabase): { id: string; created: boolean } {
  const existing = db.prepare('SELECT id FROM global_prompt_presets WHERE id = ?').get(DEFAULT_GLOBAL_PRESET_ID) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };

  const hasActivePreset = Boolean(db.prepare('SELECT id FROM global_prompt_presets WHERE is_active = 1 LIMIT 1').get());
  const now = new Date().toISOString();
  db.prepare('INSERT INTO global_prompt_presets (id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(DEFAULT_GLOBAL_PRESET_ID, DEFAULT_GLOBAL_PRESET_NAME, '从全局 AI 约束生成的默认提示词块。', hasActivePreset ? 0 : 1, now, now);
  return { id: DEFAULT_GLOBAL_PRESET_ID, created: true };
}

function insertDefaultGlobalPresetBlocks(db: AppDatabase, aiConfig: AiConfig): void {
  for (const block of defaultGlobalPresetBlocks(aiConfig)) {
    db.prepare('INSERT INTO global_prompt_blocks (id, preset_id, name, role, position, enabled, order_index, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(nanoid(), DEFAULT_GLOBAL_PRESET_ID, block.name, block.role, block.position, block.enabled ? 1 : 0, block.orderIndex, block.content);
  }
}

function isLegacyDefaultNarrativeLengthRules(content: string): boolean {
  if (!content.includes('剧情字数硬上限') || !content.includes('objectiveLog：最多 300')) return false;
  const earliestDefault = content.includes('publicLog：最多 300')
    && content.includes('privateUpdatesByPlayer：每名玩家最多 150');
  const previousDefault = content.includes('publicLog：最多 600')
    && content.includes('privateUpdatesByPlayer：每名玩家最多 300');
  const currentBeforeExpansion = content.includes('publicLog：最多 1000')
    && content.includes('privateUpdatesByPlayer：每名玩家最多 300');
  const currentBeforeMinimumGuidance = content.includes('publicLog：最多 1500')
    && content.includes('通常写 500-900 个中文字符')
    && content.includes('privateUpdatesByPlayer：每名玩家最多 300');
  return earliestDefault || previousDefault || currentBeforeExpansion || currentBeforeMinimumGuidance;
}

function isLegacyBuiltinNarrativeLengthRules(content: string): boolean {
  if (isLegacyDefaultNarrativeLengthRules(content)) return true;
  return content.includes('剧情字数限制：控制 AI 本回合输出的三层剧情长度')
    && content.includes('objectiveLog：建议 500-1000')
    && content.includes('publicLog：建议 500-1500')
    && content.includes('privateUpdatesByPlayer：每名玩家建议 300-800');
}

function upgradeLegacyBuiltinNarrativeLengthBlocks(db: AppDatabase): void {
  const rows = db.prepare('SELECT id, content FROM global_prompt_blocks WHERE name = ?')
    .all('剧情字数限制') as Array<{ id: string; content: string }>;
  for (const row of rows) {
    if (row.content !== defaultNarrativeLengthRules && isLegacyBuiltinNarrativeLengthRules(row.content)) {
      db.prepare('UPDATE global_prompt_blocks SET content = ?, position = ?, role = ?, order_index = ?, enabled = ? WHERE id = ?')
        .run(defaultNarrativeLengthRules, 'final', 'system', 850, 1, row.id);
    }
  }
}

function ensureNarrativeLengthBlockForBuiltinDefaultPreset(db: AppDatabase): void {
  const rows = db.prepare('SELECT id, name, content FROM global_prompt_blocks WHERE preset_id = ? ORDER BY order_index ASC').all(DEFAULT_GLOBAL_PRESET_ID) as Array<{ id: string; name: string; content: string }>;
  const existing = rows.find((row) => row.name === '剧情字数限制');
  if (existing) {
    if (existing.content !== defaultNarrativeLengthRules && isLegacyDefaultNarrativeLengthRules(existing.content)) {
      db.prepare('UPDATE global_prompt_blocks SET content = ?, position = ?, role = ?, order_index = ?, enabled = ? WHERE id = ?')
        .run(defaultNarrativeLengthRules, 'final', 'system', 850, 1, existing.id);
    }
    return;
  }

  const builtinNames = new Set(defaultGlobalPresetBlocks(defaultAiConfig).filter((block) => block.name !== '剧情字数限制').map((block) => block.name));
  const looksLikeOldBuiltinDefault = rows.length === builtinNames.size && rows.every((row) => builtinNames.has(row.name));
  if (!looksLikeOldBuiltinDefault) return;

  db.prepare('INSERT INTO global_prompt_blocks (id, preset_id, name, role, position, enabled, order_index, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(nanoid(), DEFAULT_GLOBAL_PRESET_ID, '剧情字数限制', 'system', 'final', 1, 850, defaultNarrativeLengthRules);
}

function repairGlobalActivePresetUniqueness(db: AppDatabase): void {
  db.prepare(`
    UPDATE global_prompt_presets
    SET is_active = 0
    WHERE is_active = 1
      AND id NOT IN (
        SELECT id FROM global_prompt_presets
        WHERE is_active = 1
        ORDER BY updated_at DESC, created_at DESC, id ASC
        LIMIT 1
      )
  `).run();
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS global_prompt_presets_one_active_idx ON global_prompt_presets(is_active) WHERE is_active = 1').run();
}

function ensureDefaultGlobalPresetInitialized(db: AppDatabase): void {
  const tx = db.transaction(() => {
    repairGlobalActivePresetUniqueness(db);
    const preset = ensureDefaultGlobalPresetRow(db);
    if (preset.created) {
      insertDefaultGlobalPresetBlocks(db, defaultAiConfig);
    } else {
      ensureNarrativeLengthBlockForBuiltinDefaultPreset(db);
    }
    upgradeLegacyBuiltinNarrativeLengthBlocks(db);
  });
  tx();
}

export function ensureGlobalConfig(db: AppDatabase): GlobalConfigRow {
  const existing = db.prepare('SELECT * FROM global_config WHERE id = ?').get(GLOBAL_CONFIG_ID) as GlobalConfigRow | undefined;
  if (existing) return existing;

  const now = new Date().toISOString();
  db.prepare('INSERT INTO global_config (id, ai_config_json, ai_provider_config_json, embedding_provider_config_json, active_script_card_id, active_preset_package_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(GLOBAL_CONFIG_ID, JSON.stringify(defaultAiConfig), JSON.stringify(defaultAiProviderConfig), JSON.stringify(defaultEmbeddingProviderConfig), null, null, now, now);
  return db.prepare('SELECT * FROM global_config WHERE id = ?').get(GLOBAL_CONFIG_ID) as GlobalConfigRow;
}

export function normalizeAiProviderConfig(input: unknown): AiProviderConfig {
  if (!input || typeof input !== 'object') return defaultAiProviderConfig;
  const value = input as Partial<Record<keyof AiProviderConfig, unknown>>;
  if (value.provider !== undefined && value.provider !== 'mock' && value.provider !== 'openai-compatible') {
    throw new GlobalConfigResourceError('AI provider must be mock or openai-compatible', 400);
  }
  const provider = value.provider ?? 'mock';
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';

  if (provider === 'mock') {
    return { provider, baseUrl, apiKey, model };
  }

  if (!baseUrl || !apiKey || !model) {
    throw new GlobalConfigResourceError('OpenAI-compatible provider requires baseUrl, apiKey, and model', 400);
  }
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new GlobalConfigResourceError('OpenAI-compatible provider baseUrl must use http or https', 400);
    }
  } catch (error) {
    if (error instanceof GlobalConfigResourceError) throw error;
    throw new GlobalConfigResourceError('OpenAI-compatible provider baseUrl must be a valid URL', 400);
  }
  return { provider, baseUrl, apiKey, model };
}

export function parseAiProviderConfigJson(json: string | null | undefined): AiProviderConfig {
  if (!json) return defaultAiProviderConfig;
  try {
    return normalizeAiProviderConfig(JSON.parse(json));
  } catch (error) {
    if (error instanceof GlobalConfigResourceError) return defaultAiProviderConfig;
    return defaultAiProviderConfig;
  }
}

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

  if (provider === 'mock') {
    return { provider, baseUrl, apiKey, model, dimensions };
  }

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
  } catch (error) {
    if (error instanceof GlobalConfigResourceError) return defaultEmbeddingProviderConfig;
    return defaultEmbeddingProviderConfig;
  }
}

export function getGlobalEmbeddingProviderConfig(db: AppDatabase): EmbeddingProviderConfig {
  return parseEmbeddingProviderConfigJson(ensureGlobalConfig(db).embedding_provider_config_json);
}

export function updateGlobalEmbeddingProviderConfig(db: AppDatabase, input: unknown): EmbeddingProviderConfig {
  const normalized = normalizeEmbeddingProviderConfig(input);
  ensureGlobalConfig(db);
  db.prepare('UPDATE global_config SET embedding_provider_config_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(normalized), new Date().toISOString(), GLOBAL_CONFIG_ID);
  return normalized;
}

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

export function getGlobalAiConfig(db: AppDatabase): AiConfig {
  return parseAiConfigJson(ensureGlobalConfig(db).ai_config_json);
}

export function updateGlobalAiConfig(db: AppDatabase, aiConfig: AiConfig): AiConfig {
  const normalized = normalizeAiConfig(aiConfig);
  ensureGlobalConfig(db);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare('UPDATE global_config SET ai_config_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(normalized), now, GLOBAL_CONFIG_ID);
    const preset = ensureDefaultGlobalPresetRow(db);
    if (preset.created) {
      insertDefaultGlobalPresetBlocks(db, defaultAiConfig);
    }
  });
  tx();
  return normalized;
}

function mapGlobalPresetWithBlocks(presetRows: GlobalPromptPresetRow[], blockRows: GlobalPromptBlockRow[]): PromptPreset[] {
  const blocksByPreset = new Map<string, PromptBlock[]>();
  for (const row of blockRows) {
    const blocks = blocksByPreset.get(row.presetId) ?? [];
    blocks.push(mapPromptBlockRow(row));
    blocksByPreset.set(row.presetId, blocks);
  }
  return presetRows.map((row) => ({
    id: row.id,
    roomId: '',
    name: row.name,
    description: row.description,
    isActive: Boolean(row.isActive),
    blocks: blocksByPreset.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    presetType: (row.presetType as PromptPreset['presetType']) ?? undefined,
    isTemplate: Boolean(row.isTemplate)
  }));
}

function getGlobalPresetById(db: AppDatabase, presetId: string): PromptPreset | null {
  return getGlobalPresets(db).find((preset) => preset.id === presetId) ?? null;
}

export function saveGlobalPreset(db: AppDatabase, input: {
  id?: string;
  name: string;
  description: string;
  isActive?: boolean;
  blocks: Array<Omit<PromptBlock, 'id' | 'presetId'> & { id?: string }>;
}): PromptPreset {
  const existing = input.id ? db.prepare('SELECT id FROM global_prompt_presets WHERE id = ?').get(input.id) as { id: string } | undefined : undefined;
  if (input.id && !existing) throw new GlobalConfigResourceError('Preset not found', 404);
  const presetId = existing?.id ?? nanoid();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    if (input.isActive) db.prepare('UPDATE global_prompt_presets SET is_active = 0').run();
    if (existing) {
      db.prepare('UPDATE global_prompt_presets SET name = ?, description = ?, is_active = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.description, input.isActive ? 1 : 0, now, presetId);
      db.prepare('DELETE FROM global_prompt_blocks WHERE preset_id = ?').run(presetId);
    } else {
      const hasPreset = Boolean(db.prepare('SELECT id FROM global_prompt_presets LIMIT 1').get());
      const isActive = input.isActive ?? !hasPreset;
      if (isActive) db.prepare('UPDATE global_prompt_presets SET is_active = 0').run();
      db.prepare('INSERT INTO global_prompt_presets (id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(presetId, input.name, input.description, isActive ? 1 : 0, now, now);
    }
    for (const block of input.blocks) {
      db.prepare('INSERT INTO global_prompt_blocks (id, preset_id, name, role, position, enabled, order_index, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(block.id ?? nanoid(), presetId, block.name, block.role, block.position, block.enabled ? 1 : 0, block.orderIndex, block.content);
    }
    const active = db.prepare('SELECT id FROM global_prompt_presets WHERE is_active = 1 LIMIT 1').get();
    if (!active) db.prepare('UPDATE global_prompt_presets SET is_active = 1, updated_at = ? WHERE id = (SELECT id FROM global_prompt_presets ORDER BY updated_at DESC LIMIT 1)').run(now);
  });
  tx();
  const preset = getGlobalPresetById(db, presetId);
  if (!preset) throw new Error('Failed to save global preset.');
  return preset;
}

export function activateGlobalPreset(db: AppDatabase, presetId: string): PromptPreset {
  const existing = db.prepare('SELECT id FROM global_prompt_presets WHERE id = ?').get(presetId) as { id: string } | undefined;
  if (!existing) throw new GlobalConfigResourceError('Preset not found', 404);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    repairGlobalActivePresetUniqueness(db);
    db.prepare('UPDATE global_prompt_presets SET is_active = 0').run();
    db.prepare('UPDATE global_prompt_presets SET is_active = 1, updated_at = ? WHERE id = ?').run(now, presetId);
  });
  tx();
  const preset = getGlobalPresetById(db, presetId);
  if (!preset) throw new Error('Failed to activate global preset.');
  return preset;
}

export function createGlobalWorldBook(db: AppDatabase, input: { name: string; description: string; enabled: boolean }): WorldBook {
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO global_world_books (id, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, input.name, input.description, input.enabled ? 1 : 0, now, now);
  const book = getGlobalWorldBooks(db).find((item) => item.id === id);
  if (!book) throw new Error('Failed to create global world book.');
  return book;
}

export function createGlobalWorldBookEntry(db: AppDatabase, worldBookId: string, input: Omit<WorldBookEntry, 'id' | 'worldBookId' | 'createdAt' | 'updatedAt'>): WorldBookEntry {
  const book = db.prepare('SELECT id FROM global_world_books WHERE id = ?').get(worldBookId) as { id: string } | undefined;
  if (!book) throw new GlobalConfigResourceError('World book not found', 404);
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO global_world_book_entries (id, world_book_id, title, keys_json, secondary_keys_json, content, enabled, constant, selective, priority, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, worldBookId, input.title, JSON.stringify(input.keys), JSON.stringify(input.secondaryKeys), input.content, input.enabled ? 1 : 0, input.constant ? 1 : 0, input.selective ? 1 : 0, input.priority, input.position, now, now);
  const entry = getGlobalWorldBookEntries(db).find((item) => item.id === id);
  if (!entry) throw new Error('Failed to create global world book entry.');
  return entry;
}

export function updateGlobalWorldBookEntry(db: AppDatabase, entryId: string, input: Omit<WorldBookEntry, 'id' | 'worldBookId' | 'createdAt' | 'updatedAt'>): WorldBookEntry {
  const existing = db.prepare('SELECT id FROM global_world_book_entries WHERE id = ?').get(entryId) as { id: string } | undefined;
  if (!existing) throw new GlobalConfigResourceError('World book entry not found', 404);
  db.prepare('UPDATE global_world_book_entries SET title = ?, keys_json = ?, secondary_keys_json = ?, content = ?, enabled = ?, constant = ?, selective = ?, priority = ?, position = ?, updated_at = ? WHERE id = ?')
    .run(input.title, JSON.stringify(input.keys), JSON.stringify(input.secondaryKeys), input.content, input.enabled ? 1 : 0, input.constant ? 1 : 0, input.selective ? 1 : 0, input.priority, input.position, new Date().toISOString(), entryId);
  const entry = getGlobalWorldBookEntries(db).find((item) => item.id === entryId);
  if (!entry) throw new Error('Failed to update global world book entry.');
  return entry;
}

export function getGlobalPresets(db: AppDatabase): PromptPreset[] {
  const presetRows = db.prepare('SELECT id, name, description, is_active as isActive, preset_type as presetType, is_template as isTemplate, created_at as createdAt, updated_at as updatedAt FROM global_prompt_presets ORDER BY is_active DESC, updated_at DESC').all() as GlobalPromptPresetRow[];
  const blockRows = db.prepare('SELECT id, preset_id as presetId, name, role, position, enabled, order_index as orderIndex, content, category, scene_type as sceneType FROM global_prompt_blocks ORDER BY order_index ASC').all() as GlobalPromptBlockRow[];
  return mapGlobalPresetWithBlocks(presetRows, blockRows);
}

export function getActiveGlobalPromptBlocks(db: AppDatabase): PromptBlock[] {
  const active = getGlobalPresets(db).find((preset) => preset.isActive);
  return active?.blocks ?? [];
}

export function getGlobalWorldBooks(db: AppDatabase): WorldBook[] {
  return (db.prepare('SELECT id, name, description, enabled, created_at as createdAt, updated_at as updatedAt FROM global_world_books ORDER BY updated_at DESC').all() as GlobalWorldBookRow[]).map(mapGlobalWorldBookRow);
}

export function getGlobalWorldBookEntries(db: AppDatabase): WorldBookEntry[] {
  return (db.prepare('SELECT entry.id, entry.world_book_id as worldBookId, entry.title, entry.keys_json as keysJson, entry.secondary_keys_json as secondaryKeysJson, entry.content, entry.enabled, entry.constant, entry.selective, entry.priority, entry.position, entry.created_at as createdAt, entry.updated_at as updatedAt FROM global_world_book_entries entry ORDER BY entry.priority DESC, entry.updated_at DESC').all() as GlobalWorldBookEntryRow[]).map(mapGlobalWorldBookEntryRow);
}

export function getPromptGlobalWorldBookEntries(db: AppDatabase): WorldBookEntry[] {
  return (db.prepare('SELECT entry.id, entry.world_book_id as worldBookId, entry.title, entry.keys_json as keysJson, entry.secondary_keys_json as secondaryKeysJson, entry.content, entry.enabled, entry.constant, entry.selective, entry.priority, entry.position, entry.created_at as createdAt, entry.updated_at as updatedAt FROM global_world_book_entries entry JOIN global_world_books book ON book.id = entry.world_book_id WHERE book.enabled = 1 AND entry.enabled = 1 ORDER BY entry.priority DESC, entry.updated_at DESC').all() as GlobalWorldBookEntryRow[]).map(mapGlobalWorldBookEntryRow);
}

export function getGlobalResourceWorldBookBindings(db: AppDatabase): GlobalResourceWorldBookBinding[] {
  return (db.prepare('SELECT world_book_id as worldBookId, enabled, order_index as orderIndex, created_at as createdAt FROM global_world_book_bindings ORDER BY order_index ASC, created_at ASC').all() as GlobalResourceWorldBookBindingRow[]).map(mapGlobalResourceWorldBookBindingRow);
}

export function setGlobalScriptCard(db: AppDatabase, scriptCardId: string): void {
  if (!getScriptCard(db, scriptCardId)) throw new GlobalConfigResourceError('Script card not found', 404);
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
  if (!getPresetPackage(db, presetPackageId)) throw new GlobalConfigResourceError('Preset package not found', 404);
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
  const seenWorldBookIds = new Set<string>();
  for (const binding of bindings) {
    if (seenWorldBookIds.has(binding.worldBookId)) throw new GlobalConfigResourceError('Duplicate world book binding', 400);
    seenWorldBookIds.add(binding.worldBookId);
    if (!getResourceWorldBook(db, binding.worldBookId)) throw new GlobalConfigResourceError('World book not found', 404);
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

export function getGlobalConfigSnapshot(db: AppDatabase): GlobalConfigSnapshot {
  const config = ensureGlobalConfig(db);
  const resourceLibrary = listResourceLibrary(db);
  return {
    aiConfig: parseAiConfigJson(config.ai_config_json),
    aiProviderConfig: parseAiProviderConfigJson(config.ai_provider_config_json),
    embeddingProviderConfig: parseEmbeddingProviderConfigJson(config.embedding_provider_config_json),
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
}

export function createDefaultGlobalPreset(db: AppDatabase): PromptPreset {
  ensureGlobalConfig(db);
  ensureDefaultGlobalPresetInitialized(db);

  const preset = getGlobalPresets(db).find((item) => item.id === DEFAULT_GLOBAL_PRESET_ID);
  if (!preset) throw new Error('Failed to create default global preset.');
  return preset;
}
