import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import { createAiProviderFromConfig, requestOpenAiCompatibleMessage, testAiProviderConfig } from '../services/aiProvider.js';
import { buildCampaignContext, createSessionSummary, listSessionSummaries, listCampaignQuests, listCampaignNpcs, listCampaignLocations, upsertCampaignQuest, upsertCampaignNpc, upsertCampaignLocation } from '../services/campaignMemoryService.js';
import { createEmbeddingProviderFromConfig, testEmbeddingProviderConfig } from '../services/embeddingService.js';
import { createStarterCharacter, createEmptyCharacterBuilderSheet } from '../services/characterService.js';
import { getCharacterResources, applyResourcePatch, shortRest, longRest } from '../services/characterResourceService.js';
import { listCharacterResourceChanges, rollbackResourceChange } from '../services/characterAuditService.js';
import { importRuleSource, listRuleSources } from '../services/rulesService.js';
import { allPlayersSubmitted, processTurnActions } from '../services/turnEngine.js';
import { publishRoomUpdate } from '../services/eventBus.js';
import { buildTurnPrompt, defaultAiConfig, normalizeAiConfig, parseAiConfigJson, renderDndOutputContract } from '../services/aiContextBuilder.js';
import { buildWorldBookScanText, matchWorldBookEntries } from '../services/worldBookService.js';
import { indexApprovedRuleEntries, retrieveRuleMatches, storeRuleContextHits } from '../services/ruleRetrievalService.js';
import { buildSillyTavernPromptPreview } from '../services/sillyTavernPromptBuilder.js';
import { applyPresetTemplate, getActivePresetType, listPresetTemplates } from '../services/dmPresetService.js';
import {
  activateGlobalPreset,
  clearGlobalPresetPackage,
  clearGlobalScriptCard,
  createDefaultGlobalPreset,
  createGlobalWorldBook,
  createGlobalWorldBookEntry,
  getActiveGlobalPresetPackage,
  getActiveGlobalPromptBlocks,
  getActiveGlobalResourceWorldBookEntries,
  getActiveGlobalScriptCard,
  getGlobalAiProviderConfig,
  getGlobalEmbeddingProviderConfig,
  getGlobalConfigSnapshot,
  getGlobalWorldBookEntries,
  getPromptGlobalWorldBookEntries,
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
import { registerAdminResourceRoutes } from './adminResourceRoutes.js';
import { registerAdminDbRoutes } from './adminDbRoutes.js';
import { abilityCheck, abilityModifier, attackRoll, damageRoll, rollDice } from '../services/diceService.js';
import { createCombat, rollInitiative, nextTurn, processAttack } from '../services/combatService.js';
import type { AiConfig, DiceLog, InteractionRequest, LogEntry, Player, PlayerAction, PromptBlock, PromptBlockPosition, PromptPreviewResponse, PromptPreset, Room, RuleRetrievalMatch, ScriptCard, Turn, WorldBook, WorldBookEntry, WorldBookMatch, WorldBookPosition } from '../domain/types.js';

const createRoomSchema = z.object({
  name: z.string().min(1)
}).strict();

const addPlayerSchema = z.object({ name: z.string().min(1) });
const submitRuleSchema = z.object({ name: z.string().min(1), content: z.unknown() });
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

const diceRollSchema = z.object({
  diceType: z.string().min(1),
  modifier: z.number().int().default(0),
  reason: z.string().min(1),
  dc: z.number().int().optional(),
}).strict();

const combatStartSchema = z.object({
  combatants: z.array(z.object({
    characterId: z.string().nullable().default(null),
    npcId: z.string().nullable().default(null),
    name: z.string().min(1),
    hp: z.number().int().positive().default(1),
    ac: z.number().int().positive().default(10),
    dexMod: z.number().int().default(0)
  })).min(1)
}).strict();

const combatActionSchema = z.object({
  combatId: z.string().min(1)
}).strict();

const combatAttackSchema = z.object({
  combatId: z.string().min(1),
  attackerIndex: z.number().int().min(0),
  targetIndex: z.number().int().min(0),
  weaponDie: z.string().default('d8')
}).strict();

const restSchema = z.object({
  action: z.enum(['short', 'long']),
  actorType: z.string().default('player'),
  actorId: z.string().default(''),
  hitDiceSpent: z.number().int().positive().optional()
}).strict();

const rollbackSchema = z.object({
  revertedBy: z.string().min(1)
}).strict();

const globalScriptConfigSchema = z.object({ scriptCardId: z.string().min(1) });
const globalResourceWorldBookConfigSchema = z.object({
  bindings: z.array(z.object({
    worldBookId: z.string().min(1),
    enabled: z.boolean(),
    orderIndex: z.number().int()
  }))
});
const globalPresetPackageConfigSchema = z.object({ presetPackageId: z.string().min(1) });

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

function mapRoomRow(row: any): Room {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.systemPrompt,
    worldInfo: row.worldInfo,
    currentTurn: row.currentTurn,
    status: row.status,
    aiConfig: parseAiConfigJson(row.aiConfigJson),
    createdAt: row.createdAt
  };
}

function getRoom(db: AppDatabase, roomId: string): Room | null {
  const row = db.prepare('SELECT id, name, system_prompt as systemPrompt, world_info as worldInfo, current_turn as currentTurn, status, ai_config_json as aiConfigJson, created_at as createdAt FROM rooms WHERE id = ?').get(roomId) as any;
  return row ? mapRoomRow(row) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function parseJsonArray(json: string): string[] {
  try {
    const value = JSON.parse(json);
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
    content: row.content,
    category: (row.category as PromptBlock['category']) ?? undefined,
    sceneType: (row.sceneType as PromptBlock['sceneType']) ?? undefined
  };
}

function getPresets(db: AppDatabase, roomId: string): PromptPreset[] {
  const presetRows = db.prepare('SELECT id, room_id as roomId, name, description, is_active as isActive, preset_type as presetType, is_template as isTemplate, created_at as createdAt, updated_at as updatedAt FROM prompt_presets WHERE room_id = ? ORDER BY is_active DESC, updated_at DESC').all(roomId) as any[];
  const blockRows = db.prepare('SELECT id, preset_id as presetId, name, role, position, enabled, order_index as orderIndex, content, category, scene_type as sceneType FROM prompt_blocks WHERE preset_id IN (SELECT id FROM prompt_presets WHERE room_id = ?) ORDER BY order_index ASC').all(roomId) as any[];
  const blocksByPreset = new Map<string, PromptBlock[]>();
  for (const row of blockRows) {
    const blocks = blocksByPreset.get(row.presetId) ?? [];
    blocks.push(mapPromptBlockRow(row));
    blocksByPreset.set(row.presetId, blocks);
  }
  return presetRows.map((row) => ({
    id: row.id,
    roomId: row.roomId,
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

function getActivePromptBlocks(db: AppDatabase, roomId: string): PromptBlock[] {
  const active = getPresets(db, roomId).find((preset) => preset.isActive);
  return active?.blocks ?? [];
}

function mapWorldBookRow(row: any): WorldBook {
  return {
    id: row.id,
    roomId: row.roomId,
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

function getWorldBooks(db: AppDatabase, roomId: string): WorldBook[] {
  return (db.prepare('SELECT id, room_id as roomId, name, description, enabled, created_at as createdAt, updated_at as updatedAt FROM world_books WHERE room_id = ? ORDER BY updated_at DESC').all(roomId) as any[]).map(mapWorldBookRow);
}

function getWorldBookEntries(db: AppDatabase, roomId: string): WorldBookEntry[] {
  return (db.prepare('SELECT entry.id, entry.world_book_id as worldBookId, entry.title, entry.keys_json as keysJson, entry.secondary_keys_json as secondaryKeysJson, entry.content, entry.enabled, entry.constant, entry.selective, entry.priority, entry.position, entry.created_at as createdAt, entry.updated_at as updatedAt FROM world_book_entries entry JOIN world_books book ON book.id = entry.world_book_id WHERE book.room_id = ? AND book.enabled = 1 ORDER BY entry.priority DESC, entry.updated_at DESC').all(roomId) as any[]).map(mapWorldBookEntryRow);
}

interface RoomPromptPreviewContext {
  turn: Turn | null;
  players: Player[];
  actions: PlayerAction[];
  publicLogs: LogEntry[];
  interactions: InteractionRequest[];
  promptBlocks: PromptBlock[];
  worldBookMatches: WorldBookMatch[];
  ruleMatches: RuleRetrievalMatch[];
  campaignContext: string;
  sceneType: import('../domain/types.js').SceneType;
}

async function loadRoomPromptPreviewContext(db: AppDatabase, room: Room): Promise<RoomPromptPreviewContext> {
  const turn = db.prepare('SELECT id, room_id as roomId, number, status, started_at as startedAt, ended_at as endedAt FROM turns WHERE room_id = ? AND number = ?').get(room.id, room.currentTurn) as Turn | undefined;
  const players = db.prepare('SELECT id, room_id as roomId, name, token, is_connected as isConnected, created_at as createdAt FROM players WHERE room_id = ? ORDER BY created_at ASC').all(room.id) as Player[];
  const actions = turn ? db.prepare('SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text, submitted_at as submittedAt, status, action_type as actionType, is_hidden_roll as isHiddenRoll FROM actions WHERE turn_id = ? ORDER BY submitted_at ASC').all(turn.id) as PlayerAction[] : [];
  const publicLogs = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at ASC').all(room.id, 'public') as LogEntry[];
  const interactions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, source_player_id as sourcePlayerId, target_player_id as targetPlayerId, type, prompt, target_response as targetResponse, status, created_at as createdAt FROM interaction_requests WHERE room_id = ? AND status != ? ORDER BY created_at ASC').all(room.id, 'resolved') as InteractionRequest[];
  const scanText = buildWorldBookScanText({ roomWorldInfo: room.worldInfo, publicLogs, actions, players });
  const worldBookMatches = matchWorldBookEntries(getPromptGlobalWorldBookEntries(db), scanText);
  const provider = createEmbeddingProviderFromConfig(getGlobalEmbeddingProviderConfig(db));
  const ruleMatches = await retrieveRuleMatches(db, provider, scanText, { limit: 5 });
  const campaignContext = buildCampaignContext(db, room.id);
  const combatRow = db.prepare('SELECT state_json FROM combat_state WHERE room_id = ? AND state_json LIKE ? ORDER BY updated_at DESC LIMIT 1').get(room.id, '%"status":"active"%') as { state_json: string } | undefined;
  const sceneType: import('../domain/types.js').SceneType = combatRow ? 'combat' : 'all';
  return { turn: turn ?? null, players, actions, publicLogs, interactions, promptBlocks: getActiveGlobalPromptBlocks(db), worldBookMatches, ruleMatches, campaignContext, sceneType };
}

function mapNativeWorldBookMatches(matches: WorldBookMatch[]): PromptPreviewResponse['worldBookMatches'] {
  return matches.map((match) => ({
    worldBookId: match.entry.worldBookId,
    entryId: match.entry.id,
    keys: match.matchedKeys,
    reason: match.entry.constant ? 'constant' : match.matchedKeys.length > 1 ? 'primary-and-secondary-key' : 'primary-key',
    position: match.entry.position === 'before_world' ? 'before' : 'after',
    content: match.entry.content
  }));
}

function mapRuleMatches(matches: RuleRetrievalMatch[]): PromptPreviewResponse['ruleMatches'] {
  return matches.map(({ entryId, title, category, score, reasons, summary }) => ({
    entryId,
    title,
    category,
    score,
    reasons,
    summary
  }));
}

function buildNativePromptPreview(room: Room, context: RoomPromptPreviewContext, scriptCard: ScriptCard | null): PromptPreviewResponse {
  const prompt = buildTurnPrompt({
    room,
    players: context.players,
    publicLogs: context.publicLogs,
    actions: context.actions,
    interactions: context.interactions,
    scriptCard,
    promptBlocks: context.promptBlocks,
    worldBookMatches: context.worldBookMatches,
    ruleMatches: context.ruleMatches,
    campaignContext: context.campaignContext,
    sceneType: context.sceneType
  });
  const dndOutputContract = renderDndOutputContract();
  const nativePromptBlocks = context.promptBlocks
    .filter((block) => block.enabled && block.content.trim() !== dndOutputContract)
    .map((block) => ({ identifier: block.id, source: 'native-preset' as const, role: block.role, content: block.content }));
  return {
    mode: 'native',
    prompt,
    messages: [{ role: 'system', content: prompt }],
    slots: [{ key: 'dndOutputContract', source: 'dnd-contract', content: dndOutputContract }],
    worldBookMatches: mapNativeWorldBookMatches(context.worldBookMatches),
    ruleMatches: mapRuleMatches(context.ruleMatches),
    promptBlocks: [
      ...nativePromptBlocks,
      { identifier: 'dndOutputContract', source: 'dnd-contract', role: 'system', content: dndOutputContract }
    ],
    warnings: []
  };
}

async function buildRoomPromptPreview(db: AppDatabase, room: Room): Promise<{ preview: PromptPreviewResponse; context: RoomPromptPreviewContext }> {
  const context = await loadRoomPromptPreviewContext(db, room);
  const presetPackage = getActiveGlobalPresetPackage(db);
  const scriptCard = getActiveGlobalScriptCard(db);
  if (!presetPackage) return { preview: buildNativePromptPreview(room, context, scriptCard), context };

  const preview = buildSillyTavernPromptPreview({
    room,
    players: context.players,
    publicLogs: context.publicLogs,
    actions: context.actions,
    interactions: context.interactions,
    scriptCard,
    presetPackage,
    worldBookEntries: getActiveGlobalResourceWorldBookEntries(db)
  });
  return {
    preview: {
      ...preview,
      ruleMatches: mapRuleMatches(context.ruleMatches),
      warnings: context.ruleMatches.length > 0
        ? [...preview.warnings, '5e rule matches are shown but not injected in SillyTavern-compatible preview mode.']
        : preview.warnings
    },
    context
  };
}

function claimRoomTurnForProcessing(db: AppDatabase, roomId: string, turnId: string): boolean {
  return db.transaction(() => {
    const roomClaim = db.prepare('UPDATE rooms SET status = ? WHERE id = ? AND status = ?').run('processing', roomId, 'waiting_for_actions');
    if (roomClaim.changes !== 1) return false;

    const turnClaim = db.prepare('UPDATE turns SET status = ? WHERE id = ? AND status = ?').run('processing', turnId, 'open');
    if (turnClaim.changes !== 1) {
      db.prepare('UPDATE rooms SET status = ? WHERE id = ? AND status = ?').run('waiting_for_actions', roomId, 'processing');
      return false;
    }

    return true;
  })();
}

function createDefaultPreset(db: AppDatabase, roomId: string, aiConfig: AiConfig, now: string): void {
  const presetId = nanoid();
  const blocks = [
    { name: '核心规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 10, content: aiConfig.coreRules },
    { name: '玩家自主权规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 20, content: aiConfig.playerAgencyRules },
    { name: '信息隔离规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 30, content: aiConfig.visibilityRules },
    { name: '玩家互动规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 40, content: aiConfig.interactionRules },
    { name: '叙事风格规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 50, content: aiConfig.styleRules },
    { name: '输出格式规则', role: 'system', position: 'final', enabled: true, orderIndex: 900, content: aiConfig.outputFormatRules }
  ];
  db.prepare('INSERT INTO prompt_presets (id, room_id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(presetId, roomId, '默认强约束预设', '从 MVP AI 约束迁移而来的 SillyTavern 风格提示词块。', 1, now, now);
  for (const block of blocks) {
    db.prepare('INSERT INTO prompt_blocks (id, preset_id, name, role, position, enabled, order_index, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(nanoid(), presetId, block.name, block.role, block.position, block.enabled ? 1 : 0, block.orderIndex, block.content);
  }
}

function ensureGlobalStartupState(db: AppDatabase): void {
  createDefaultGlobalPreset(db);
}

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

function globalOpeningScene(db: AppDatabase): string {
  const scriptCard = getActiveGlobalScriptCard(db);
  return scriptCard?.firstMes || scriptCard?.scenario || '此房间已创建。请在全局配置中选择主剧本卡后开始游戏。';
}

interface ProcessedDiceResult {
  diceLog: DiceLog;
  summary: string;
  request: NonNullable<import('../domain/types.js').AiTurnResult['diceRequests']>[number];
}

function processAiDiceRequests(
  db: AppDatabase,
  diceRequests: NonNullable<import('../domain/types.js').AiTurnResult['diceRequests']>,
  roomId: string,
  turnId: string
): ProcessedDiceResult[] {
  const results: ProcessedDiceResult[] = [];
  const now = new Date().toISOString();

  for (const request of diceRequests) {
    let characterSheet: import('../domain/types.js').CharacterSheet | null = null;
    if (request.characterId) {
      const charRow = db.prepare(
        'SELECT sheet_json FROM characters WHERE id = ?'
      ).get(request.characterId) as { sheet_json: string } | undefined;
      if (charRow) {
        try {
          characterSheet = JSON.parse(charRow.sheet_json) as import('../domain/types.js').CharacterSheet;
        } catch { /* ignore invalid sheet JSON */ }
      }
    }

    let diceLog: DiceLog | null = null;
    let summary: string = '';

    switch (request.type) {
      case 'abilityCheck': {
        const ability = request.ability ?? 'str';
        const score = characterSheet?.abilityScores?.[ability] ?? 10;
        const proficiency = 0; // Raw ability checks don't add proficiency
        const dc = request.dc ?? 15;
        const result = abilityCheck(score, dc, proficiency, request.advantage ?? null);
        const totalMod = result.modifier + result.proficiency;
        summary = `${request.reason} — 掷出 ${result.roll} + ${totalMod} = ${result.total}，DC ${dc}，${result.success ? '成功' : '失败'}。`;
        diceLog = {
          id: nanoid(),
          roomId,
          turnId,
          combatId: null,
          characterId: request.characterId ?? null,
          diceType: request.type,
          values: [result.natural],
          modifier: totalMod,
          total: result.total,
          dc,
          success: result.success,
          isPublic: !request.isHidden,
          reason: request.reason,
          timestamp: now
        };
        break;
      }
      case 'savingThrow': {
        const ability = request.ability ?? 'str';
        const score = characterSheet?.abilityScores?.[ability] ?? 10;
        const proficiency = characterSheet?.proficiencyBonus ?? 0;
        const dc = request.dc ?? 15;
        const result = abilityCheck(score, dc, proficiency, request.advantage ?? null);
        const totalMod = result.modifier + result.proficiency;
        summary = `${request.reason}（${ability.toUpperCase()}豁免）— 掷出 ${result.roll} + ${totalMod} = ${result.total}，DC ${dc}，${result.success ? '成功' : '失败'}。`;
        diceLog = {
          id: nanoid(),
          roomId,
          turnId,
          combatId: null,
          characterId: request.characterId ?? null,
          diceType: request.type,
          values: [result.natural],
          modifier: totalMod,
          total: result.total,
          dc,
          success: result.success,
          isPublic: !request.isHidden,
          reason: request.reason,
          timestamp: now
        };
        break;
      }
      case 'skillCheck': {
        const ability = request.ability ?? 'str';
        const score = characterSheet?.abilityScores?.[ability] ?? 10;
        const skill = request.skill;
        const skills = characterSheet?.skills ?? [];
        const proficiency = skill && skills.includes(skill) ? (characterSheet?.proficiencyBonus ?? 0) : 0;
        const dc = request.dc ?? 15;
        const result = abilityCheck(score, dc, proficiency, request.advantage ?? null);
        const totalMod = result.modifier + result.proficiency;
        const skillLabel = skill ? `（${skill}）` : '';
        summary = `${request.reason}${skillLabel} — 掷出 ${result.roll} + ${totalMod} = ${result.total}，DC ${dc}，${result.success ? '成功' : '失败'}。`;
        diceLog = {
          id: nanoid(),
          roomId,
          turnId,
          combatId: null,
          characterId: request.characterId ?? null,
          diceType: request.type,
          values: [result.natural],
          modifier: totalMod,
          total: result.total,
          dc,
          success: result.success,
          isPublic: !request.isHidden,
          reason: request.reason,
          timestamp: now
        };
        break;
      }
      case 'attackRoll': {
        const ability = request.ability ?? 'str';
        const score = characterSheet?.abilityScores?.[ability] ?? 10;
        const mod = request.modifier ?? abilityModifier(score);
        const proficiency = characterSheet?.proficiencyBonus ?? 0;
        const ac = request.dc ?? 10;
        const result = attackRoll(mod, proficiency, ac, request.advantage ?? null);
        const totalMod = result.modifier + result.proficiency;
        summary = `${request.reason} — 掷出 ${result.roll} + ${totalMod} = ${result.total}，AC ${ac}，${result.hit ? (result.criticalHit ? '重击命中！' : '命中') : (result.criticalMiss ? '大失败！' : '未命中')}。`;
        diceLog = {
          id: nanoid(),
          roomId,
          turnId,
          combatId: null,
          characterId: request.characterId ?? null,
          diceType: request.type,
          values: [result.natural],
          modifier: totalMod,
          total: result.total,
          dc: ac,
          success: result.hit,
          isPublic: !request.isHidden,
          reason: request.reason,
          timestamp: now
        };
        break;
      }
      case 'damage': {
        const die = request.die ?? 'd6';
        const count = request.count ?? 1;
        const mod = request.modifier ?? 0;
        const result = damageRoll(die, count, mod);
        const valuesStr = result.values.join(', ');
        summary = `${request.reason} — 掷出 ${valuesStr} + ${mod} = ${result.total}。`;
        diceLog = {
          id: nanoid(),
          roomId,
          turnId,
          combatId: null,
          characterId: request.characterId ?? null,
          diceType: request.type,
          values: result.values,
          modifier: mod,
          total: result.total,
          dc: null,
          success: null,
          isPublic: !request.isHidden,
          reason: request.reason,
          timestamp: now
        };
        break;
      }
      case 'healing': {
        const die = request.die ?? 'd8';
        const count = request.count ?? 1;
        const mod = request.modifier ?? 0;
        const { values, total } = rollDice(die, count);
        const valuesStr = values.join(', ');
        summary = `${request.reason} — 掷出 ${valuesStr} + ${mod} = ${total + mod}`;
        diceLog = {
          id: nanoid(),
          roomId,
          turnId,
          combatId: null,
          characterId: request.characterId ?? null,
          diceType: request.type,
          values,
          modifier: mod,
          total: total + mod,
          dc: null,
          success: null,
          isPublic: !request.isHidden,
          reason: request.reason,
          timestamp: now
        };
        break;
      }
    }

    if (diceLog) {
      results.push({ diceLog, summary, request });
    }
  }

  return results;
}

export function createAdminRouter(db: AppDatabase): Router {
  const router = Router();
  registerAdminResourceRoutes(router, db);
  registerAdminDbRoutes(router, db);
  ensureGlobalStartupState(db);

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
      const usesSavedConfig = body === undefined || (isPlainObject(body) && Object.keys(body).length === 0);
      if (!usesSavedConfig && !isPlainObject(body)) {
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
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid retrieval preview payload', issues: error.issues });
        return;
      }
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/config/ai-provider/test', async (req, res) => {
    try {
      const body = req.body;
      const usesSavedConfig = body === undefined || (isPlainObject(body) && Object.keys(body).length === 0);
      if (!usesSavedConfig && !isPlainObject(body)) {
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
      const input = presetSchema.parse(req.body);
      res.json({ preset: saveGlobalPreset(db, input), presets: getGlobalConfigSnapshot(db).presets });
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
      res.json({ preset: activateGlobalPreset(db, req.params.presetId), presets: getGlobalConfigSnapshot(db).presets });
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  // --- Preset Template Routes ---
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
      const preset = applyPresetTemplate(db, presetType as import('../domain/types.js').PresetType);
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
      const input = worldBookSchema.parse(req.body);
      res.json({ worldBook: createGlobalWorldBook(db, input), worldBooks: getGlobalConfigSnapshot(db).worldBooks });
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.post('/config/world-books/:worldBookId/entries', (req, res) => {
    try {
      const input = worldBookEntrySchema.parse(req.body);
      res.json({ entry: createGlobalWorldBookEntry(db, req.params.worldBookId, input), entries: getGlobalConfigSnapshot(db).worldBookEntries });
    } catch (error) {
      handleGlobalConfigResourceError(error, res);
    }
  });

  router.put('/config/world-books/:worldBookId/entries/:entryId', (req, res) => {
    try {
      const input = worldBookEntrySchema.parse(req.body);
      const entry = db.prepare('SELECT id FROM global_world_book_entries WHERE id = ? AND world_book_id = ?').get(req.params.entryId, req.params.worldBookId);
      if (!entry) throw new GlobalConfigResourceError('World book entry not found', 404);
      res.json({ entry: updateGlobalWorldBookEntry(db, req.params.entryId, input), entries: getGlobalConfigSnapshot(db).worldBookEntries });
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

  router.post('/rooms', (req, res) => {
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid room creation payload' });
    const input = parsed.data;
    const roomId = nanoid();
    const turnId = nanoid();
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      db.prepare('INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, ai_config_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(roomId, input.name, '', '此房间实时使用当前全局配置。', 1, 'waiting_for_actions', JSON.stringify(defaultAiConfig), now);
      db.prepare('INSERT INTO turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(turnId, roomId, 1, 'open', now, null);
      db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nanoid(), roomId, turnId, 'public', null, 'Opening Scene', globalOpeningScene(db), now);
    });
    tx();

    res.json({ roomId, adminUrl: `/admin/${roomId}` });
  });

  router.post('/rooms/:roomId/players', (req, res) => {
    const input = addPlayerSchema.parse(req.body);
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const playerId = nanoid();
    const characterId = nanoid();
    const token = nanoid(48);
    const now = new Date().toISOString();
    const sheet = createEmptyCharacterBuilderSheet(input.name);

    const tx = db.transaction(() => {
      db.prepare('INSERT INTO players (id, room_id, name, token, is_connected, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(playerId, req.params.roomId, input.name, token, 0, now);
      db.prepare('INSERT INTO characters (id, player_id, sheet_json, draft_source, confirmed, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(characterId, playerId, JSON.stringify(sheet), 'manual', 0, now);
    });
    tx();
    publishRoomUpdate(req.params.roomId);

    res.json({ playerId, token, playerUrl: `/player/${token}` });
  });

  router.get('/rooms/:roomId', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const players = db.prepare('SELECT id, room_id as roomId, name, token, is_connected as isConnected, created_at as createdAt FROM players WHERE room_id = ? ORDER BY created_at ASC').all(req.params.roomId);
    const turns = db.prepare('SELECT id, room_id as roomId, number, status, started_at as startedAt, ended_at as endedAt FROM turns WHERE room_id = ? ORDER BY number ASC').all(req.params.roomId);
    const actions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text, submitted_at as submittedAt, status, action_type as actionType, is_hidden_roll as isHiddenRoll FROM actions WHERE room_id = ? ORDER BY submitted_at ASC').all(req.params.roomId);
    const interactions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, source_player_id as sourcePlayerId, target_player_id as targetPlayerId, type, prompt, target_response as targetResponse, status, created_at as createdAt FROM interaction_requests WHERE room_id = ? ORDER BY created_at ASC').all(req.params.roomId);
    const logs = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM log_entries WHERE room_id = ? ORDER BY created_at ASC').all(req.params.roomId);
    const aiGenerations = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, provider, input_summary as inputSummary, output, error, created_at as createdAt FROM ai_generations WHERE room_id = ? ORDER BY created_at ASC').all(req.params.roomId);
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
  });

  router.get('/rooms/:roomId/ai-config', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(room.aiConfig);
  });

  router.put('/rooms/:roomId/ai-config', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const aiConfig: AiConfig = normalizeAiConfig(aiConfigSchema.parse(req.body));
    db.prepare('UPDATE rooms SET ai_config_json = ? WHERE id = ?').run(JSON.stringify(aiConfig), req.params.roomId);
    publishRoomUpdate(req.params.roomId);
    res.json(aiConfig);
  });

  router.get('/rooms/:roomId/ai-prompt-preview', async (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const { preview } = await buildRoomPromptPreview(db, room);
    res.json(preview);
  });

  router.get('/rooms/:roomId/presets', (req, res) => {
    if (!getRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    res.json({ presets: getPresets(db, req.params.roomId) });
  });

  router.post('/rooms/:roomId/presets', (req, res) => {
    if (!getRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    const input = presetSchema.parse(req.body);
    const presetId = nanoid();
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      if (input.isActive) db.prepare('UPDATE prompt_presets SET is_active = 0 WHERE room_id = ?').run(req.params.roomId);
      db.prepare('INSERT INTO prompt_presets (id, room_id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(presetId, req.params.roomId, input.name, input.description, input.isActive ? 1 : 0, now, now);
      for (const block of input.blocks) {
        db.prepare('INSERT INTO prompt_blocks (id, preset_id, name, role, position, enabled, order_index, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(nanoid(), presetId, block.name, block.role, block.position, block.enabled ? 1 : 0, block.orderIndex, block.content);
      }
    });
    tx();
    publishRoomUpdate(req.params.roomId);
    res.json({ presets: getPresets(db, req.params.roomId) });
  });

  router.put('/rooms/:roomId/presets/:presetId', (req, res) => {
    if (!getRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    const existing = db.prepare('SELECT id FROM prompt_presets WHERE id = ? AND room_id = ?').get(req.params.presetId, req.params.roomId);
    if (!existing) return res.status(404).json({ error: 'Preset not found' });
    const input = presetSchema.parse(req.body);
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      if (input.isActive) db.prepare('UPDATE prompt_presets SET is_active = 0 WHERE room_id = ?').run(req.params.roomId);
      db.prepare('UPDATE prompt_presets SET name = ?, description = ?, is_active = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.description, input.isActive ? 1 : 0, now, req.params.presetId);
      db.prepare('DELETE FROM prompt_blocks WHERE preset_id = ?').run(req.params.presetId);
      for (const block of input.blocks) {
        db.prepare('INSERT INTO prompt_blocks (id, preset_id, name, role, position, enabled, order_index, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(block.id ?? nanoid(), req.params.presetId, block.name, block.role, block.position, block.enabled ? 1 : 0, block.orderIndex, block.content);
      }
    });
    tx();
    publishRoomUpdate(req.params.roomId);
    res.json({ presets: getPresets(db, req.params.roomId) });
  });

  router.post('/rooms/:roomId/presets/:presetId/activate', (req, res) => {
    const preset = db.prepare('SELECT id FROM prompt_presets WHERE id = ? AND room_id = ?').get(req.params.presetId, req.params.roomId);
    if (!preset) return res.status(404).json({ error: 'Preset not found' });
    const tx = db.transaction(() => {
      db.prepare('UPDATE prompt_presets SET is_active = 0 WHERE room_id = ?').run(req.params.roomId);
      db.prepare('UPDATE prompt_presets SET is_active = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), req.params.presetId);
    });
    tx();
    publishRoomUpdate(req.params.roomId);
    res.json({ presets: getPresets(db, req.params.roomId) });
  });

  router.get('/rooms/:roomId/world-books', (req, res) => {
    if (!getRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    res.json({ worldBooks: getWorldBooks(db, req.params.roomId), entries: getWorldBookEntries(db, req.params.roomId) });
  });

  router.post('/rooms/:roomId/world-books', (req, res) => {
    if (!getRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    const input = worldBookSchema.parse(req.body);
    const id = nanoid();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO world_books (id, room_id, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.params.roomId, input.name, input.description, input.enabled ? 1 : 0, now, now);
    publishRoomUpdate(req.params.roomId);
    res.json({ worldBooks: getWorldBooks(db, req.params.roomId), entries: getWorldBookEntries(db, req.params.roomId) });
  });

  router.post('/rooms/:roomId/world-books/:worldBookId/entries', (req, res) => {
    const book = db.prepare('SELECT id FROM world_books WHERE id = ? AND room_id = ?').get(req.params.worldBookId, req.params.roomId);
    if (!book) return res.status(404).json({ error: 'World book not found' });
    const input = worldBookEntrySchema.parse(req.body);
    const id = nanoid();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO world_book_entries (id, world_book_id, title, keys_json, secondary_keys_json, content, enabled, constant, selective, priority, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.params.worldBookId, input.title, JSON.stringify(input.keys), JSON.stringify(input.secondaryKeys), input.content, input.enabled ? 1 : 0, input.constant ? 1 : 0, input.selective ? 1 : 0, input.priority, input.position, now, now);
    publishRoomUpdate(req.params.roomId);
    res.json({ worldBooks: getWorldBooks(db, req.params.roomId), entries: getWorldBookEntries(db, req.params.roomId) });
  });

  router.put('/rooms/:roomId/world-books/:worldBookId/entries/:entryId', (req, res) => {
    const book = db.prepare('SELECT id FROM world_books WHERE id = ? AND room_id = ?').get(req.params.worldBookId, req.params.roomId);
    if (!book) return res.status(404).json({ error: 'World book not found' });
    const input = worldBookEntrySchema.parse(req.body);
    const result = db.prepare('UPDATE world_book_entries SET title = ?, keys_json = ?, secondary_keys_json = ?, content = ?, enabled = ?, constant = ?, selective = ?, priority = ?, position = ?, updated_at = ? WHERE id = ? AND world_book_id = ?')
      .run(input.title, JSON.stringify(input.keys), JSON.stringify(input.secondaryKeys), input.content, input.enabled ? 1 : 0, input.constant ? 1 : 0, input.selective ? 1 : 0, input.priority, input.position, new Date().toISOString(), req.params.entryId, req.params.worldBookId);
    if (result.changes === 0) return res.status(404).json({ error: 'World book entry not found' });
    publishRoomUpdate(req.params.roomId);
    res.json({ worldBooks: getWorldBooks(db, req.params.roomId), entries: getWorldBookEntries(db, req.params.roomId) });
  });

  router.post('/rooms/:roomId/rules', (req, res) => {
    const input = submitRuleSchema.parse(req.body);
    const id = importRuleSource(db, input.name, input.content);
    res.json({ id });
  });

  router.get('/rules', (_req, res) => {
    res.json({ rules: listRuleSources(db) });
  });

  router.post('/rooms/:roomId/process-turn', async (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const { preview, context } = await buildRoomPromptPreview(db, room);
    const { turn, players, actions, publicLogs, interactions, promptBlocks, worldBookMatches, ruleMatches } = context;
    if (!turn) return res.status(409).json({ error: 'Current turn not found' });

    if (!allPlayersSubmitted(players, actions)) return res.status(409).json({ error: 'Waiting for all players to submit actions' });

    if (!claimRoomTurnForProcessing(db, req.params.roomId, turn.id)) {
      return res.status(409).json({ error: 'Turn is already processing or no longer open' });
    }

    const providerConfig = getGlobalAiProviderConfig(db);
    let aiProviderName: string = providerConfig.provider;

    try {
      const aiProvider = createAiProviderFromConfig(providerConfig);
      aiProviderName = aiProvider.name;
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
        promptOverride: preview.prompt
      });

      // Process AI dice requests — execute system dice rolls and append results to publicLog
      if (result.diceRequests && result.diceRequests.length > 0) {
        const diceResults = processAiDiceRequests(db, result.diceRequests, req.params.roomId, turn.id);
        if (diceResults.length > 0) {
          // Separate public and hidden results
          const publicResults = diceResults.filter((dr) => dr.diceLog.isPublic);
          const hiddenResults = diceResults.filter((dr) => !dr.diceLog.isPublic);

          if (publicResults.length > 0) {
            const diceSummary = publicResults.map((dr) => dr.summary).join('\n');
            result.publicLog += `\n\n🎲 系统骰点：\n${diceSummary}`;
          }

          // Route hidden dice results to respective player's private updates
          for (const hidden of hiddenResults) {
            if (hidden.diceLog.characterId) {
              const playerRow = db.prepare(
                'SELECT p.id FROM players p JOIN characters c ON c.player_id = p.id WHERE c.id = ? AND p.room_id = ?'
              ).get(hidden.diceLog.characterId, req.params.roomId) as { id: string } | undefined;
              if (playerRow) {
                const existing = result.privateUpdatesByPlayer[playerRow.id] ?? '';
                result.privateUpdatesByPlayer[playerRow.id] = existing
                  ? `${existing}\n🎲 隐藏骰点：${hidden.summary}`
                  : `🎲 隐藏骰点：${hidden.summary}`;
              }
            }
          }

          result.diceResults = diceResults.map((dr) => dr.diceLog);
        }
      }

      const now = new Date().toISOString();
      const nextTurnId = nanoid();
      const resourceErrors: string[] = [];
      const tx = db.transaction(() => {
        storeRuleContextHits(db, { roomId: req.params.roomId, turnId: turn.id, matches: ruleMatches });

        // Insert dice logs
        if (result.diceResults && result.diceResults.length > 0) {
          for (const diceLog of result.diceResults) {
            db.prepare(
              'INSERT INTO dice_logs (id, room_id, turn_id, combat_id, character_id, dice_type, values_json, modifier, total, dc, success, is_public, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(
              diceLog.id, diceLog.roomId, diceLog.turnId, diceLog.combatId, diceLog.characterId,
              diceLog.diceType, JSON.stringify(diceLog.values), diceLog.modifier, diceLog.total,
              diceLog.dc, diceLog.success === null ? null : (diceLog.success ? 1 : 0),
              diceLog.isPublic ? 1 : 0, diceLog.reason, now
            );
          }
        }

        db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(nanoid(), req.params.roomId, turn.id, 'public', null, `Turn ${room.currentTurn}`, result.publicLog, now);
        for (const [playerId, content] of Object.entries(result.privateUpdatesByPlayer)) {
          db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(nanoid(), req.params.roomId, turn.id, 'private', playerId, `Private Turn ${room.currentTurn}`, content, now);
        }
        for (const interaction of result.interactionRequests) {
          db.prepare('INSERT INTO interaction_requests (id, room_id, turn_id, source_player_id, target_player_id, type, prompt, target_response, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(nanoid(), req.params.roomId, turn.id, interaction.sourcePlayerId, interaction.targetPlayerId, interaction.type, interaction.prompt, null, 'pending_target', now);
        }
        db.prepare('UPDATE turns SET status = ?, ended_at = ? WHERE id = ?').run('complete', now, turn.id);
        db.prepare('UPDATE actions SET status = ? WHERE turn_id = ?').run('complete', turn.id);
        db.prepare('INSERT INTO turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(nextTurnId, req.params.roomId, room.currentTurn + 1, 'open', now, null);
        db.prepare('UPDATE rooms SET current_turn = ?, status = ? WHERE id = ?').run(room.currentTurn + 1, 'waiting_for_actions', req.params.roomId);

        // Process AI-DM character resource changes
        if (result.characterResourceChanges && result.characterResourceChanges.length > 0) {
          for (const change of result.characterResourceChanges) {
            // Validate characterId belongs to a player in this room
            const charRow = db.prepare(
              'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE c.id = ? AND p.room_id = ?'
            ).get(change.characterId, req.params.roomId) as { id: string } | undefined;

            if (!charRow) {
              resourceErrors.push(`Invalid characterId '${change.characterId}': not found in room`);
              continue;
            }

            try {
              applyResourcePatch(db, req.params.roomId, {
                characterId: change.characterId,
                path: change.path,
                before: change.before as number | string | boolean,
                after: change.after as number | string | boolean,
                reason: change.reason,
                ruleRefs: change.ruleRefs,
              }, 'ai_dm', 'ai');
            } catch (err) {
              resourceErrors.push(
                `Failed to apply resource change for ${change.characterId}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        }

        const generationError = resourceErrors.length > 0 ? resourceErrors.join('\n') : null;
        db.prepare('INSERT INTO ai_generations (id, room_id, turn_id, provider, input_summary, output, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(nanoid(), req.params.roomId, turn.id, aiProviderName, `Processed ${actions.length} actions`, JSON.stringify(result), generationError, now);
      });
      tx();

      // Auto-generate campaign session summary every N turns
      if (room.currentTurn % 5 === 0 && providerConfig.provider !== 'mock') {
        try {
          const recentLogs = db.prepare(
            'SELECT content FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at DESC LIMIT 10'
          ).all(req.params.roomId, 'public') as Array<{ content: string }>;

          const prompt = `你是战役记录官。请根据以下回合日志，生成结构化战役摘要。返回严格JSON：{summary,questUpdates,npcUpdates,locationUpdates,characterUpdates}。\n日志：\n${recentLogs.map((l) => l.content).join('\n')}`;

          const summaryContent = await requestOpenAiCompatibleMessage(providerConfig as { provider: 'openai-compatible'; baseUrl: string; apiKey: string; model: string }, [
            { role: 'system', content: '你是战役记录官。只返回严格JSON。' },
            { role: 'user', content: prompt }
          ]);

          const summaryData = JSON.parse(summaryContent) as {
            summary?: string;
            questUpdates?: Array<{ title: string; status: string; description: string }>;
            npcUpdates?: Array<{ name: string; role: string; attitude: string; notes: string; location: string }>;
            locationUpdates?: Array<{ name: string; description: string }>;
            characterUpdates?: Array<{ characterId: string; update: string }>;
          };

          const turnEnd = room.currentTurn;
          const turnStart = Math.max(1, turnEnd - 4);

          createSessionSummary(db, req.params.roomId, {
            turnStart,
            turnEnd,
            summary: summaryData.summary ?? '',
            questUpdates: (summaryData.questUpdates ?? []) as Array<{ title: string; status: import('../domain/types.js').CampaignQuest['status']; description: string }>,
            npcUpdates: (summaryData.npcUpdates ?? []) as Array<{ name: string; role: string; attitude: import('../domain/types.js').CampaignNpc['attitude']; notes: string; location: string }>,
            locationUpdates: summaryData.locationUpdates ?? [],
            characterUpdates: summaryData.characterUpdates ?? [],
          });

          db.prepare('INSERT INTO ai_generations (id, room_id, turn_id, provider, input_summary, output, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(nanoid(), req.params.roomId, turn.id, providerConfig.provider, `Campaign session summary (turns ${turnStart}-${turnEnd})`, JSON.stringify(summaryData), null, now);
        } catch (summaryError) {
          db.prepare('INSERT INTO ai_generations (id, room_id, turn_id, provider, input_summary, output, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(nanoid(), req.params.roomId, turn.id, providerConfig.provider, 'Campaign session summary failed', '', summaryError instanceof Error ? summaryError.message : String(summaryError), now);
        }
      }

      publishRoomUpdate(req.params.roomId);
      res.json({ result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('needs_admin_attention', req.params.roomId);
        db.prepare('UPDATE turns SET status = ? WHERE id = ?').run('needs_admin_attention', turn.id);
        db.prepare('INSERT INTO ai_generations (id, room_id, turn_id, provider, input_summary, output, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(nanoid(), req.params.roomId, turn.id, aiProviderName, `Failed processing ${actions.length} actions`, '', message, now);
      });
      tx();
      publishRoomUpdate(req.params.roomId);
      res.status(500).json({ error: message });
    }
  });

  // --- Character Resource Rest API ---

  router.post('/rooms/:roomId/characters/:charId/rest', (req, res) => {
    try {
      const input = restSchema.parse(req.body);

      // Validate character belongs to room
      const char = db.prepare(
        'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE c.id = ? AND p.room_id = ?'
      ).get(req.params.charId, req.params.roomId);
      if (!char) return res.status(404).json({ error: 'Character not found in room' });

      if (input.action === 'short') {
        const resources = shortRest(db, req.params.charId, {
          roomId: req.params.roomId,
          actorType: input.actorType,
          actorId: input.actorId,
          hitDiceSpent: input.hitDiceSpent,
        });
        res.json({ resources });
      } else {
        const resources = longRest(db, req.params.charId, {
          roomId: req.params.roomId,
          actorType: input.actorType,
          actorId: input.actorId,
        });
        res.json({ resources });
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid rest payload', issues: error.issues });
        return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/rooms/:roomId/character-resource-changes', (req, res) => {
    try {
      const characterId = typeof req.query.characterId === 'string' ? req.query.characterId : undefined;
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) || 20 : 20;
      const changes = listCharacterResourceChanges(db, req.params.roomId, { characterId, limit });
      res.json({ changes });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/rooms/:roomId/character-resource-changes/:changeId/rollback', (req, res) => {
    try {
      const input = rollbackSchema.parse(req.body);
      const change = rollbackResourceChange(db, req.params.changeId, input.revertedBy);
      res.json({ restored: true, change });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid rollback payload', issues: error.issues });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message.includes('not found') ? 404 : message.includes('already reverted') ? 409 : 400;
      res.status(statusCode).json({ error: message });
    }
  });

  // --- Dice / Combat Admin APIs ---

  function insertDiceLog(
    log: Omit<DiceLog, 'id' | 'timestamp'>
  ): string {
    const id = nanoid();
    const timestamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO dice_logs (id, room_id, turn_id, combat_id, character_id, dice_type, values_json, modifier, total, dc, success, is_public, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      log.roomId,
      log.turnId ?? null,
      log.combatId ?? null,
      log.characterId ?? null,
      log.diceType,
      JSON.stringify(log.values),
      log.modifier,
      log.total,
      log.dc ?? null,
      log.success === null ? null : (log.success ? 1 : 0),
      log.isPublic ? 1 : 0,
      log.reason,
      timestamp
    );
    return id;
  }

  router.post('/rooms/:roomId/dice/roll', (req, res) => {
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const input = diceRollSchema.parse(req.body);
    const { values, total: baseTotal } = rollDice(input.diceType, 1);
    const total = baseTotal + input.modifier;
    const success = input.dc !== undefined ? total >= input.dc : null;

    const diceLog: Omit<DiceLog, 'id' | 'timestamp'> = {
      roomId: req.params.roomId,
      turnId: null,
      combatId: null,
      characterId: null,
      diceType: input.diceType,
      values,
      modifier: input.modifier,
      total,
      dc: input.dc ?? null,
      success,
      isPublic: true,
      reason: input.reason,
    };
    const diceLogId = insertDiceLog(diceLog);

    res.json({
      values,
      modifier: input.modifier,
      total,
      success,
      diceLog: { id: diceLogId }
    });
  });

  router.post('/rooms/:roomId/combat/start', (req, res) => {
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const input = combatStartSchema.parse(req.body);

    // Create NPC records for combatants without characterId but with hp/ac
    const now = new Date().toISOString();
    const combatantSpecs: Array<{
      characterId?: string;
      npcId?: string;
      name: string;
      hp: number;
      ac: number;
      isPlayer: boolean;
    }> = input.combatants.map((spec) => {
      let npcId: string | undefined = spec.npcId ?? undefined;

      if (!spec.characterId && !spec.npcId) {
        // Create NPC record for this combatant
        npcId = nanoid();
        const dexScore = spec.dexMod !== undefined && spec.dexMod !== 0
          ? 10 + spec.dexMod * 2 + 1  // Convert modifier to score: mod 2 → score 15
          : 10;
        db.prepare(
          'INSERT INTO npcs (id, room_id, name, hp_max, hp_current, ac, str, dex, con, int, wis, cha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(npcId, req.params.roomId, spec.name, spec.hp, spec.hp, spec.ac, 10, dexScore, 10, 10, 10, 10, now);
      }

      return {
        characterId: spec.characterId ?? undefined,
        npcId,
        name: spec.name,
        hp: spec.hp ?? 1,
        ac: spec.ac ?? 10,
        isPlayer: !!spec.characterId,
      };
    });

    const combatState = createCombat(db, req.params.roomId, combatantSpecs);
    res.json({ combatState });
  });

  router.post('/rooms/:roomId/combat/roll-initiative', (req, res) => {
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const input = combatActionSchema.parse(req.body);
    try {
      const combatState = rollInitiative(db, input.combatId);
      res.json({ combatState });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('not found') ? 404 : 400).json({ error: message });
    }
  });

  router.post('/rooms/:roomId/combat/attack', (req, res) => {
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const input = combatAttackSchema.parse(req.body);
    try {
      const result = processAttack(db, {
        roomId: req.params.roomId,
        combatId: input.combatId,
        attackerIndex: input.attackerIndex,
        targetIndex: input.targetIndex,
      });
      res.json({
        combatState: result.state,
        hit: result.attackResult.hit,
        criticalHit: result.attackResult.criticalHit,
        criticalMiss: result.attackResult.criticalMiss,
        attackRoll: result.attackResult.roll,
        attackTotal: result.attackResult.total,
        damageTotal: result.damageResult?.total,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('not found') ? 404 : 400).json({ error: message });
    }
  });

  router.post('/rooms/:roomId/combat/next-turn', (req, res) => {
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const input = combatActionSchema.parse(req.body);
    try {
      const combatState = nextTurn(db, input.combatId);
      res.json({ combatState });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('not found') ? 404 : 400).json({ error: message });
    }
  });

  router.get('/rooms/:roomId/combat', (req, res) => {
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const combatRows = db.prepare(
      'SELECT state_json FROM combat_state WHERE room_id = ? AND state_json LIKE ? ORDER BY updated_at DESC LIMIT 1'
    ).all(req.params.roomId, '%"status":"active"%') as Array<{ state_json: string }>;
    if (combatRows.length === 0) return res.status(404).json({ error: 'No active combat found' });

    res.json({ combatState: JSON.parse(combatRows[0].state_json) });
  });

  router.get('/rooms/:roomId/dice-logs', (req, res) => {
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) || 50 : 50;
    const rows = db.prepare(
      'SELECT id, room_id as roomId, turn_id as turnId, combat_id as combatId, character_id as characterId, dice_type as diceType, values_json as valuesJson, modifier, total, dc, success, is_public as isPublic, reason, created_at as createdAt FROM dice_logs WHERE room_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(req.params.roomId, limit) as Array<{
      id: string; roomId: string; turnId: string | null; combatId: string | null;
      characterId: string | null; diceType: string; valuesJson: string;
      modifier: number; total: number; dc: number | null; success: number | null;
      isPublic: number; reason: string; createdAt: string;
    }>;
    const logs = rows.map((row) => ({
      id: row.id,
      roomId: row.roomId,
      turnId: row.turnId,
      combatId: row.combatId,
      characterId: row.characterId,
      diceType: row.diceType,
      values: JSON.parse(row.valuesJson) as number[],
      modifier: row.modifier,
      total: row.total,
      dc: row.dc,
      success: row.success === null ? null : Boolean(row.success),
      isPublic: Boolean(row.isPublic),
      reason: row.reason,
      timestamp: row.createdAt,
    }));
    res.json({ logs });
  });

  // --- Campaign Memory APIs ---

  const questUpdateSchema = z.object({
    title: z.string().min(1),
    status: z.enum(['active', 'in_progress', 'completed', 'failed']),
    description: z.string().default(''),
  }).strict();

  const npcUpdateSchema = z.object({
    name: z.string().min(1),
    role: z.string().default(''),
    attitude: z.enum(['friendly', 'neutral', 'hostile', 'unknown']).default('unknown'),
    notes: z.string().default(''),
    location: z.string().default(''),
  }).strict();

  const locationUpdateSchema = z.object({
    name: z.string().min(1),
    description: z.string().default(''),
  }).strict();

  router.get('/rooms/:roomId/summaries', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const summaries = listSessionSummaries(db, req.params.roomId);
    res.json({ summaries });
  });

  router.post('/rooms/:roomId/summaries', async (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const providerConfig = getGlobalAiProviderConfig(db);
    if (providerConfig.provider === 'mock') {
      return res.status(400).json({ error: 'Manual summary generation requires a real AI provider (not mock).' });
    }
    try {
      const recentLogs = db.prepare(
        'SELECT content FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at DESC LIMIT 10'
      ).all(req.params.roomId, 'public') as Array<{ content: string }>;

      const prompt = `你是战役记录官。请根据以下回合日志，生成结构化战役摘要。返回严格JSON：{summary,questUpdates,npcUpdates,locationUpdates,characterUpdates}。\n日志：\n${recentLogs.map((l) => l.content).join('\n')}`;

      const { requestOpenAiCompatibleMessage } = await import('../services/aiProvider.js');
      const summaryContent = await requestOpenAiCompatibleMessage(providerConfig as { provider: 'openai-compatible'; baseUrl: string; apiKey: string; model: string }, [
        { role: 'system', content: '你是战役记录官。只返回严格JSON。' },
        { role: 'user', content: prompt }
      ]);

      const summaryData = JSON.parse(summaryContent) as {
        summary?: string;
        questUpdates?: Array<{ title: string; status: string; description: string }>;
        npcUpdates?: Array<{ name: string; role: string; attitude: string; notes: string; location: string }>;
        locationUpdates?: Array<{ name: string; description: string }>;
        characterUpdates?: Array<{ characterId: string; update: string }>;
      };

      const turnEnd = room.currentTurn;
      const turnStart = Math.max(1, turnEnd - 4);

      const summary = createSessionSummary(db, req.params.roomId, {
        turnStart,
        turnEnd,
        summary: summaryData.summary ?? '',
        questUpdates: (summaryData.questUpdates ?? []) as Array<{ title: string; status: import('../domain/types.js').CampaignQuest['status']; description: string }>,
        npcUpdates: (summaryData.npcUpdates ?? []) as Array<{ name: string; role: string; attitude: import('../domain/types.js').CampaignNpc['attitude']; notes: string; location: string }>,
        locationUpdates: summaryData.locationUpdates ?? [],
        characterUpdates: summaryData.characterUpdates ?? [],
      });

      res.json({ summary });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/rooms/:roomId/quests', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const quests = listCampaignQuests(db, req.params.roomId);
    res.json({ quests });
  });

  router.put('/rooms/:roomId/quests', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const input = questUpdateSchema.parse(req.body);
    const quest = upsertCampaignQuest(db, req.params.roomId, input);
    res.json({ quest });
  });

  router.get('/rooms/:roomId/npcs', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const npcs = listCampaignNpcs(db, req.params.roomId);
    res.json({ npcs });
  });

  router.put('/rooms/:roomId/npcs', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const input = npcUpdateSchema.parse(req.body);
    const npc = upsertCampaignNpc(db, req.params.roomId, input);
    res.json({ npc });
  });

  router.get('/rooms/:roomId/locations', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const locations = listCampaignLocations(db, req.params.roomId);
    res.json({ locations });
  });

  router.put('/rooms/:roomId/locations', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const input = locationUpdateSchema.parse(req.body);
    const location = upsertCampaignLocation(db, req.params.roomId, input);
    res.json({ location });
  });

  return router;
}
