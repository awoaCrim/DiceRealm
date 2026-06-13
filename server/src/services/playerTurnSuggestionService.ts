import type { AppDatabase } from '../db/connection.js';
import type {
  CampaignNpc,
  CampaignQuest,
  CharacterSheet,
  PlayerAction,
  PlayerTurnSuggestion,
  PlayerTurnSuggestionsCache
} from '../domain/types.js';
import { requestOpenAiCompatibleMessage } from './aiProvider.js';
import { listCampaignNpcs, listCampaignQuests } from './campaignMemoryService.js';
import { getGlobalAiProviderConfig } from './globalConfigService.js';

type SuggestionActionType = NonNullable<PlayerAction['actionType']>;
type StoredSuggestionStatus = 'ready' | 'failed';

const allowedActionTypes: SuggestionActionType[] = [
  'narrative',
  'exploration',
  'social',
  'combat',
  'ooc',
  'in_character_action',
  'player_question',
  'meta_question',
  'observe',
  'wait',
  'skip',
  'ready',
  'follow',
  'combat_action'
];

const allowedActionTypeSet = new Set<string>(allowedActionTypes);

const actionTypeAliases: Record<string, SuggestionActionType> = {
  incharacteraction: 'in_character_action',
  in_character: 'in_character_action',
  character_action: 'in_character_action',
  action: 'in_character_action',
  question: 'player_question',
  ask: 'player_question',
  meta: 'meta_question',
  ooc_question: 'meta_question',
  look: 'observe',
  inspect: 'observe',
  search: 'observe',
  hold: 'wait',
  pass: 'wait',
  attack: 'combat_action',
  cast: 'combat_action',
  spell: 'combat_action'
};

interface TurnSuggestionRow {
  roomId: string;
  turnId: string;
  playerId: string;
  suggestionsJson: string;
  status: StoredSuggestionStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RoomRow {
  id: string;
  name: string;
  currentTurn: number;
  status: string;
}

interface TurnRow {
  id: string;
  number: number;
  status: string;
}

interface PlayerRow {
  id: string;
  name: string;
}

interface CharacterRow {
  sheetJson: string;
  confirmed: number;
}

interface LogRow {
  title: string;
  content: string;
  createdAt: string;
}

interface CombatantSnapshot {
  name: string;
  isPlayer: boolean;
  initiative: number | null;
  hp?: { current: number; max: number };
  ac?: number | null;
}

interface ActiveCombatSnapshot {
  round: number;
  currentTurn: number;
  combatants: CombatantSnapshot[];
}

interface SuggestionContext {
  room: RoomRow;
  turn: TurnRow;
  player: PlayerRow;
  character: { sheet: CharacterSheet; confirmed: boolean } | null;
  recentPublicLogs: LogRow[];
  privateLogs: LogRow[];
  currentAction: PlayerAction | null;
  submittedPlayerNames: string[];
  waitingPlayerNames: string[];
  pendingInteractionPrompts: string[];
  combat: ActiveCombatSnapshot | null;
  quests: CampaignQuest[];
  npcs: Array<Omit<CampaignNpc, 'notes'>>;
}

export class PlayerTurnSuggestionError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'PlayerTurnSuggestionError';
  }
}

function missingSuggestion(input: { roomId: string; turnId: string | null; playerId: string }): PlayerTurnSuggestionsCache {
  return {
    roomId: input.roomId,
    turnId: input.turnId,
    playerId: input.playerId,
    status: 'missing',
    options: [],
    error: null,
    createdAt: null,
    updatedAt: null
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function clip(value: string, max = 1200): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

function compact(value: string | undefined | null): string {
  return value?.trim() || '未填写';
}

function parseSheet(json: string): CharacterSheet | null {
  try {
    return JSON.parse(json) as CharacterSheet;
  } catch {
    return null;
  }
}

function mapTurnSuggestionRow(row: TurnSuggestionRow): PlayerTurnSuggestionsCache {
  if (row.status === 'ready') {
    try {
      return {
        roomId: row.roomId,
        turnId: row.turnId,
        playerId: row.playerId,
        status: 'ready',
        options: parseSuggestionEnvelope(row.suggestionsJson),
        error: null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      };
    } catch (error) {
      return {
        roomId: row.roomId,
        turnId: row.turnId,
        playerId: row.playerId,
        status: 'failed',
        options: [],
        error: `Cached turn suggestions are invalid: ${error instanceof Error ? error.message : String(error)}`,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      };
    }
  }

  return {
    roomId: row.roomId,
    turnId: row.turnId,
    playerId: row.playerId,
    status: 'failed',
    options: [],
    error: row.error ?? 'Turn suggestion generation failed.',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function getCurrentTurn(db: AppDatabase, roomId: string): { room: RoomRow; turn: TurnRow | null } | null {
  const room = db.prepare('SELECT id, name, current_turn as currentTurn, status FROM rooms WHERE id = ?')
    .get(roomId) as RoomRow | undefined;
  if (!room) return null;
  const turn = db.prepare('SELECT id, number, status FROM turns WHERE room_id = ? AND number = ?')
    .get(room.id, room.currentTurn) as TurnRow | undefined;
  return { room, turn: turn ?? null };
}

export function loadCachedPlayerTurnSuggestions(
  db: AppDatabase,
  input: { roomId: string; turnId: string | null; playerId: string }
): PlayerTurnSuggestionsCache {
  if (!input.turnId) return missingSuggestion(input);
  const row = db.prepare(`
    SELECT room_id as roomId, turn_id as turnId, player_id as playerId,
           suggestions_json as suggestionsJson, status, error,
           created_at as createdAt, updated_at as updatedAt
    FROM turn_suggestions
    WHERE room_id = ? AND turn_id = ? AND player_id = ?
  `).get(input.roomId, input.turnId, input.playerId) as TurnSuggestionRow | undefined;
  return row ? mapTurnSuggestionRow(row) : missingSuggestion(input);
}

export function loadCachedCurrentPlayerTurnSuggestions(
  db: AppDatabase,
  input: { roomId: string; playerId: string }
): PlayerTurnSuggestionsCache {
  const current = getCurrentTurn(db, input.roomId);
  return loadCachedPlayerTurnSuggestions(db, {
    roomId: input.roomId,
    turnId: current?.turn?.id ?? null,
    playerId: input.playerId
  });
}

function formatLog(row: LogRow): string {
  return `- [${row.title}] ${clip(row.content, 700)}`;
}

function renderCharacterSummary(character: SuggestionContext['character']): string {
  if (!character) return '该玩家还没有可用角色卡。建议应以探索、观察、提问、等待等低风险行动为主。';
  const sheet = character.sheet;
  return [
    `角色名: ${compact(sheet.name)}`,
    `确认状态: ${character.confirmed ? '已确认' : '草稿/未确认'}`,
    `种族/亚种: ${compact(sheet.species)} / ${compact(sheet.subSpecies)}`,
    `职业/细节: ${compact(sheet.className)} / ${compact(sheet.classDetail)}`,
    `等级: ${sheet.level ?? 1}`,
    `生命值/护甲: ${sheet.hitPoints?.current ?? '?'} / ${sheet.hitPoints?.max ?? '?'} HP, AC ${sheet.armorClass ?? '?'}`,
    `属性: 力量 ${sheet.abilityScores?.str ?? '?'}, 敏捷 ${sheet.abilityScores?.dex ?? '?'}, 体质 ${sheet.abilityScores?.con ?? '?'}, 智力 ${sheet.abilityScores?.int ?? '?'}, 感知 ${sheet.abilityScores?.wis ?? '?'}, 魅力 ${sheet.abilityScores?.cha ?? '?'}`,
    `技能: ${sheet.skills?.join('、') || '未填写'}`,
    `装备: ${sheet.equipment?.join('、') || '未填写'}`,
    `法术: ${sheet.spells?.join('、') || '无'}`,
    `背景/概念: ${compact(sheet.background)} / ${compact(sheet.concept)}`,
    `性格: ${compact(sheet.personality)}`,
    `理想/牵绊/缺点: ${compact(sheet.ideal)} / ${compact(sheet.bond)} / ${compact(sheet.flaw)}`,
    `该玩家自己的私密备注: ${compact(sheet.privateNotes)}`
  ].join('\n');
}

function healthLabel(current: number, max: number): string {
  if (!Number.isFinite(max) || max <= 0) return '未知';
  if (current <= 0) return '倒下';
  const ratio = current / max;
  if (ratio <= 0.5) return '重伤';
  if (ratio < 1) return '受伤';
  return '健康';
}

function renderCombat(combat: ActiveCombatSnapshot | null): string {
  if (!combat) return '当前没有公开的活跃战斗状态。';
  return [
    `战斗轮次: 第 ${combat.round} 轮，当前索引 ${combat.currentTurn}`,
    ...combat.combatants.map((combatant) => {
      if (combatant.isPlayer) {
        return `- ${combatant.name}: 玩家角色, 先攻 ${combatant.initiative ?? '未知'}, HP ${combatant.hp?.current ?? '?'}/${combatant.hp?.max ?? '?'}, AC ${combatant.ac ?? '?'}`;
      }
      const label = combatant.hp ? healthLabel(combatant.hp.current, combatant.hp.max) : '未知';
      return `- ${combatant.name}: NPC/敌对或中立单位, 先攻 ${combatant.initiative ?? '未知'}, 状态 ${label}`;
    })
  ].join('\n');
}

function renderQuests(quests: CampaignQuest[]): string {
  if (quests.length === 0) return '暂无已记录的任务摘要。';
  return quests.slice(0, 8).map((quest) => `- ${quest.title} (${quest.status}): ${clip(quest.description, 240)}`).join('\n');
}

function renderNpcs(npcs: SuggestionContext['npcs']): string {
  if (npcs.length === 0) return '暂无已公开的 NPC 摘要。';
  return npcs.slice(0, 8).map((npc) => `- ${npc.name}: ${compact(npc.role)}, 态度 ${npc.attitude}, 位置 ${compact(npc.location)}`).join('\n');
}

function buildSituation(context: SuggestionContext): string {
  const submitted = context.submittedPlayerNames.length > 0 ? context.submittedPlayerNames.join('、') : '暂无';
  const waiting = context.waitingPlayerNames.length > 0 ? context.waitingPlayerNames.join('、') : '暂无';
  const interactions = context.pendingInteractionPrompts.length > 0
    ? context.pendingInteractionPrompts.map((prompt) => `- ${clip(prompt, 240)}`).join('\n')
    : '暂无待回应互动。';
  return [
    `房间: ${context.room.name}`,
    `当前回合: ${context.turn.number} (${context.turn.status}); 房间状态: ${context.room.status}`,
    `已提交玩家: ${submitted}`,
    `尚待玩家: ${waiting}`,
    `你当前已提交的行动: ${context.currentAction ? clip(context.currentAction.text, 260) : '尚未提交'}`,
    `待你回应的互动:\n${interactions}`,
    `战斗态势:\n${renderCombat(context.combat)}`
  ].join('\n');
}

function buildPlayerTurnSuggestionPrompt(context: SuggestionContext): string {
  const publicLogs = context.recentPublicLogs.length > 0
    ? context.recentPublicLogs.map(formatLog).join('\n')
    : '暂无公开日志。';
  const privateLogs = context.privateLogs.length > 0
    ? context.privateLogs.map(formatLog).join('\n')
    : '暂无该玩家私人日志。';

  return [
    '你是 D&D 5e 中文跑团的玩家行动建议助手。',
    '请只为当前目标玩家生成本回合可以点击/参考的 4 个行动建议。建议必须尊重玩家自主权，不替玩家决定未来，只提供可选行动。',
    '',
    '严格输出 JSON，不能包含 Markdown、解释、代码块或额外文本。格式必须是：',
    '{ "options": [{ "title": "短标题", "actionText": "玩家可直接提交的第一人称行动文本", "actionType": "in_character_action", "hint": "为什么可行或会触发什么风险" }] }',
    '',
    '硬性要求：',
    '- options 必须正好 4 个。',
    `- actionType 只能从这些值中选择：${allowedActionTypes.join(', ')}。拿不准时用 in_character_action。`,
    '- 每个 actionText 应该是玩家本人可以提交的行动、问题或等待表达，不要写 DM 结算、骰点结果或世界真相。',
    '- 不要泄漏其他玩家私人信息；你只应使用下方公开日志和当前玩家私人日志。',
    '- 必须优先基于“最近公开日志”的最后一条和当前回合编号生成建议，延续最新地点、NPC、线索和已完成行动。',
    '- 不要建议重复上一回合已经完成的同一动作；如果继续追问、调查或分工，必须明确新的角度、目标或下一步。',
    '- 覆盖不同意图：推进场景、观察/确认信息、角色扮演互动、谨慎/等待或规则提问。',
    '',
    `目标玩家: ${context.player.name} (${context.player.id})`,
    '',
    '临场态势：',
    buildSituation(context),
    '',
    '角色摘要：',
    renderCharacterSummary(context.character),
    '',
    '最近公开日志：',
    publicLogs,
    '',
    '该玩家私人日志：',
    privateLogs,
    '',
    '任务摘要：',
    renderQuests(context.quests),
    '',
    'NPC摘要（不含 DM 私密备注）：',
    renderNpcs(context.npcs)
  ].join('\n');
}

function parseSuggestionEnvelope(json: string): PlayerTurnSuggestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.trim()) as unknown;
  } catch {
    throw new Error('AI turn suggestions must be strict JSON.');
  }

  if (!isPlainObject(parsed) || Object.keys(parsed).some((key) => key !== 'options')) {
    throw new Error('AI turn suggestions must be an object with only an options field.');
  }
  if (!Array.isArray(parsed.options)) {
    throw new Error('AI turn suggestions options must be an array.');
  }
  if (parsed.options.length !== 4) {
    throw new Error('AI turn suggestions must contain exactly 4 options.');
  }

  return parsed.options.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`options[${index}] must be an object.`);
    const requiredKeys = ['title', 'actionText', 'actionType', 'hint'];
    const allowedKeys = [...requiredKeys, 'id'];
    const keys = Object.keys(item);
    const extraKeys = keys.filter((key) => !allowedKeys.includes(key));
    if (extraKeys.length > 0) throw new Error(`options[${index}] has unsupported fields: ${extraKeys.join(', ')}.`);
    for (const key of requiredKeys) {
      if (!(key in item)) throw new Error(`options[${index}] is missing ${key}.`);
    }

    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `turn-suggestion-${index + 1}`;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const actionText = typeof item.actionText === 'string' ? item.actionText.trim() : '';
    const hint = typeof item.hint === 'string' ? item.hint.trim() : '';
    if (!title) throw new Error(`options[${index}].title must be a non-empty string.`);
    if (!actionText) throw new Error(`options[${index}].actionText must be a non-empty string.`);
    if (!hint) throw new Error(`options[${index}].hint must be a non-empty string.`);

    return {
      id,
      title,
      actionText,
      actionType: normalizeTurnSuggestionActionType(item.actionType),
      hint
    };
  });
}

export function parsePlayerTurnSuggestionResponse(raw: string): PlayerTurnSuggestion[] {
  return parseSuggestionEnvelope(raw);
}

export function normalizeTurnSuggestionActionType(value: unknown): SuggestionActionType {
  if (typeof value !== 'string') return 'in_character_action';
  const key = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
  if (allowedActionTypeSet.has(key)) return key as SuggestionActionType;
  return actionTypeAliases[key] ?? 'in_character_action';
}

function loadPlayer(db: AppDatabase, roomId: string, playerId: string): PlayerRow | null {
  const player = db.prepare('SELECT id, name FROM players WHERE id = ? AND room_id = ?')
    .get(playerId, roomId) as PlayerRow | undefined;
  return player ?? null;
}

function loadCharacter(db: AppDatabase, playerId: string): SuggestionContext['character'] {
  const row = db.prepare('SELECT sheet_json as sheetJson, confirmed FROM characters WHERE player_id = ?')
    .get(playerId) as CharacterRow | undefined;
  if (!row) return null;
  const sheet = parseSheet(row.sheetJson);
  return sheet ? { sheet, confirmed: Boolean(row.confirmed) } : null;
}

function loadRecentLogs(db: AppDatabase, roomId: string, visibilityScope: 'public' | 'private', playerId?: string): LogRow[] {
  const rows = visibilityScope === 'private'
    ? db.prepare(`
        SELECT title, content, created_at as createdAt
        FROM log_entries
        WHERE room_id = ? AND visibility_scope = 'private' AND player_id = ?
        ORDER BY created_at DESC
        LIMIT 10
      `).all(roomId, playerId) as LogRow[]
    : db.prepare(`
        SELECT title, content, created_at as createdAt
        FROM log_entries
        WHERE room_id = ? AND visibility_scope = 'public'
        ORDER BY created_at DESC
        LIMIT 12
      `).all(roomId) as LogRow[];
  return rows.reverse();
}

function loadCurrentAction(db: AppDatabase, turnId: string, playerId: string): PlayerAction | null {
  const row = db.prepare(`
    SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text,
           submitted_at as submittedAt, status, action_type as actionType,
           visibility, is_hidden_roll as isHiddenRoll
    FROM actions
    WHERE turn_id = ? AND player_id = ?
    ORDER BY submitted_at DESC
    LIMIT 1
  `).get(turnId, playerId) as PlayerAction | undefined;
  return row ?? null;
}

function loadSubmissionNames(db: AppDatabase, roomId: string, turnId: string): { submittedPlayerNames: string[]; waitingPlayerNames: string[] } {
  const players = db.prepare('SELECT id, name FROM players WHERE room_id = ? ORDER BY created_at ASC')
    .all(roomId) as PlayerRow[];
  const submittedRows = db.prepare('SELECT player_id as playerId FROM actions WHERE turn_id = ?')
    .all(turnId) as Array<{ playerId: string }>;
  const submittedIds = new Set(submittedRows.map((row) => row.playerId));
  return {
    submittedPlayerNames: players.filter((player) => submittedIds.has(player.id)).map((player) => player.name),
    waitingPlayerNames: players.filter((player) => !submittedIds.has(player.id)).map((player) => player.name)
  };
}

function loadPendingInteractionPrompts(db: AppDatabase, roomId: string, playerId: string): string[] {
  const rows = db.prepare(`
    SELECT prompt
    FROM interaction_requests
    WHERE room_id = ? AND target_player_id = ? AND status = 'pending_target'
    ORDER BY created_at ASC
  `).all(roomId, playerId) as Array<{ prompt: string }>;
  return rows.map((row) => row.prompt);
}

function loadActiveCombat(db: AppDatabase, roomId: string): ActiveCombatSnapshot | null {
  const row = db.prepare(`
    SELECT state_json as stateJson
    FROM combat_state
    WHERE room_id = ? AND state_json LIKE ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(roomId, '%"status":"active"%') as { stateJson: string } | undefined;
  if (!row) return null;
  try {
    const state = JSON.parse(row.stateJson) as {
      round?: number;
      currentTurn?: number;
      combatants?: Array<CombatantSnapshot>;
    };
    return {
      round: typeof state.round === 'number' ? state.round : 1,
      currentTurn: typeof state.currentTurn === 'number' ? state.currentTurn : 0,
      combatants: Array.isArray(state.combatants) ? state.combatants : []
    };
  } catch {
    return null;
  }
}

function loadSuggestionContext(db: AppDatabase, input: { roomId: string; playerId: string }): SuggestionContext {
  const current = getCurrentTurn(db, input.roomId);
  if (!current) throw new PlayerTurnSuggestionError(404, 'Room not found');
  if (!current.turn) throw new PlayerTurnSuggestionError(409, 'Current turn not found');

  const player = loadPlayer(db, input.roomId, input.playerId);
  if (!player) throw new PlayerTurnSuggestionError(404, 'Player not found');
  const character = loadCharacter(db, input.playerId);
  if (!character?.confirmed) {
    throw new PlayerTurnSuggestionError(409, '确认角色后才能生成本轮行动建议。');
  }

  const submissions = loadSubmissionNames(db, input.roomId, current.turn.id);
  const npcs = listCampaignNpcs(db, input.roomId).map(({ notes: _notes, ...npc }) => npc);

  return {
    room: current.room,
    turn: current.turn,
    player,
    character,
    recentPublicLogs: loadRecentLogs(db, input.roomId, 'public'),
    privateLogs: loadRecentLogs(db, input.roomId, 'private', input.playerId),
    currentAction: loadCurrentAction(db, current.turn.id, input.playerId),
    submittedPlayerNames: submissions.submittedPlayerNames,
    waitingPlayerNames: submissions.waitingPlayerNames,
    pendingInteractionPrompts: loadPendingInteractionPrompts(db, input.roomId, input.playerId),
    combat: loadActiveCombat(db, input.roomId),
    quests: listCampaignQuests(db, input.roomId),
    npcs
  };
}

function saveTurnSuggestion(
  db: AppDatabase,
  input: {
    roomId: string;
    turnId: string;
    playerId: string;
    status: StoredSuggestionStatus;
    options: PlayerTurnSuggestion[];
    error: string | null;
  }
): PlayerTurnSuggestionsCache {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO turn_suggestions (
      room_id, turn_id, player_id, suggestions_json, status, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, turn_id, player_id) DO UPDATE SET
      suggestions_json = excluded.suggestions_json,
      status = excluded.status,
      error = excluded.error,
      updated_at = excluded.updated_at
  `).run(
    input.roomId,
    input.turnId,
    input.playerId,
    JSON.stringify({ options: input.options }),
    input.status,
    input.error,
    now,
    now
  );

  return loadCachedPlayerTurnSuggestions(db, input);
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return clip(message || 'Turn suggestion generation failed.', 1000);
}

export async function generateCurrentPlayerTurnSuggestions(
  db: AppDatabase,
  input: { roomId: string; playerId: string }
): Promise<PlayerTurnSuggestionsCache> {
  const context = loadSuggestionContext(db, input);
  const cached = loadCachedPlayerTurnSuggestions(db, {
    roomId: input.roomId,
    turnId: context.turn.id,
    playerId: input.playerId
  });
  if (cached.status === 'ready') return cached;

  const providerConfig = getGlobalAiProviderConfig(db);
  if (providerConfig.provider === 'mock') {
    return saveTurnSuggestion(db, {
      roomId: input.roomId,
      turnId: context.turn.id,
      playerId: input.playerId,
      status: 'failed',
      options: [],
      error: 'Player turn suggestions require a real AI provider (openai-compatible), not mock.'
    });
  }

  try {
    const prompt = buildPlayerTurnSuggestionPrompt(context);
    const raw = await requestOpenAiCompatibleMessage(providerConfig, [
      { role: 'system', content: '你是玩家行动建议助手。只输出严格 JSON。' },
      { role: 'user', content: prompt }
    ]);
    const options = parsePlayerTurnSuggestionResponse(raw);
    return saveTurnSuggestion(db, {
      roomId: input.roomId,
      turnId: context.turn.id,
      playerId: input.playerId,
      status: 'ready',
      options,
      error: null
    });
  } catch (error) {
    return saveTurnSuggestion(db, {
      roomId: input.roomId,
      turnId: context.turn.id,
      playerId: input.playerId,
      status: 'failed',
      options: [],
      error: failureMessage(error)
    });
  }
}
