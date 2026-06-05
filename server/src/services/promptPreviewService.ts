import type { AppDatabase } from '../db/connection.js';
import type {
  AiTurnPromptContextSection,
  CharacterSheet,
  InteractionRequest,
  LogEntry,
  Player,
  PlayerAction,
  PromptBlock,
  PromptPreviewResponse,
  Room,
  RuleRetrievalMatch,
  SceneType,
  ScriptCard,
  Turn,
  WorldBookMatch
} from '../domain/types.js';
import { buildCampaignContext } from './campaignMemoryService.js';
import { actionTypeForPrompt, actionVisibilityForPrompt, buildTurnPrompt, parseNarrativeLengthLimitsFromPromptBlocks, renderDndOutputContract } from './aiContextBuilder.js';
import { createEmbeddingProviderFromConfig } from './embeddingService.js';
import {
  getActiveGlobalPresetPackage,
  getActiveGlobalPromptBlocks,
  getActiveGlobalResourceWorldBookEntries,
  getActiveGlobalScriptCard,
  getGlobalEmbeddingProviderConfig,
  getPromptGlobalWorldBookEntries
} from './globalConfigService.js';
import { retrieveRuleMatches } from './ruleRetrievalService.js';
import { renderRoomPluginDatabaseContext } from './remoteDbRuntimeService.js';
import { buildSillyTavernPromptPreview } from './sillyTavernPromptBuilder.js';
import { buildWorldBookScanText, matchWorldBookEntries } from './worldBookService.js';
import { playerNamesById } from './turnReadinessService.js';
import { renderActiveCombatContext } from './combatStateSyncService.js';

export interface RoomPromptPreviewContext {
  turn: Turn | null;
  players: Player[];
  actions: PlayerAction[];
  objectiveLogs: LogEntry[];
  publicLogs: LogEntry[];
  interactions: InteractionRequest[];
  promptBlocks: PromptBlock[];
  worldBookMatches: WorldBookMatch[];
  ruleMatches: RuleRetrievalMatch[];
  campaignContext: string;
  sceneType: SceneType;
}

export async function loadRoomPromptPreviewContext(db: AppDatabase, room: Room): Promise<RoomPromptPreviewContext> {
  const turn = db.prepare('SELECT id, room_id as roomId, number, status, started_at as startedAt, ended_at as endedAt FROM turns WHERE room_id = ? AND number = ?').get(room.id, room.currentTurn) as Turn | undefined;
  const players = db.prepare('SELECT id, room_id as roomId, name, token, is_connected as isConnected, created_at as createdAt FROM players WHERE room_id = ? ORDER BY created_at ASC').all(room.id) as Player[];
  const actions = turn ? db.prepare('SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text, submitted_at as submittedAt, status, action_type as actionType, visibility, is_hidden_roll as isHiddenRoll FROM actions WHERE turn_id = ? ORDER BY submitted_at ASC').all(turn.id) as PlayerAction[] : [];
  const publicLogs = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at ASC').all(room.id, 'public') as LogEntry[];
  const objectiveLogRows = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at ASC').all(room.id, 'objective') as LogEntry[];
  const objectiveLogs = objectiveLogRows.length > 0 ? objectiveLogRows : publicLogs;
  const interactions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, source_player_id as sourcePlayerId, target_player_id as targetPlayerId, type, prompt, target_response as targetResponse, status, created_at as createdAt FROM interaction_requests WHERE room_id = ? AND status != ? ORDER BY created_at ASC').all(room.id, 'resolved') as InteractionRequest[];
  const scanLogs = [...objectiveLogs.slice(-6), ...publicLogs.slice(-6)];
  const scanText = buildWorldBookScanText({ roomWorldInfo: room.worldInfo, publicLogs: scanLogs, actions, players });
  const worldBookMatches = matchWorldBookEntries(getPromptGlobalWorldBookEntries(db), scanText);
  const provider = createEmbeddingProviderFromConfig(getGlobalEmbeddingProviderConfig(db));
  const ruleMatches = await retrieveRuleMatches(db, provider, scanText, { limit: 5 });
  const campaignContext = [
    buildCampaignContext(db, room.id),
    renderActiveCombatContext(db, room.id),
    renderRoomPluginDatabaseContext(db, room.id)
  ].filter((section) => section.trim().length > 0).join('\n\n');
  const combatRow = db.prepare('SELECT state_json FROM combat_state WHERE room_id = ? AND state_json LIKE ? ORDER BY updated_at DESC LIMIT 1').get(room.id, '%"status":"active"%') as { state_json: string } | undefined;
  const sceneType: SceneType = combatRow ? 'combat' : 'all';
  return { turn: turn ?? null, players, actions, objectiveLogs, publicLogs, interactions, promptBlocks: getActiveGlobalPromptBlocks(db), worldBookMatches, ruleMatches, campaignContext, sceneType };
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
    objectiveLogs: context.objectiveLogs,
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
  const dndOutputContract = renderDndOutputContract(parseNarrativeLengthLimitsFromPromptBlocks(context.promptBlocks));
  const defaultOutputContract = renderDndOutputContract();
  const nativePromptBlocks = context.promptBlocks
    .filter((block) => block.enabled && block.content.trim() !== dndOutputContract && block.content.trim() !== defaultOutputContract)
    .map((block) => ({ identifier: block.id, displayName: block.name, source: 'native-preset' as const, role: block.role, content: block.content }));
  return {
    mode: 'native',
    prompt,
    messages: [{ role: 'system', content: prompt }],
    slots: [{ key: 'dndOutputContract', source: 'dnd-contract', content: dndOutputContract }],
    worldBookMatches: mapNativeWorldBookMatches(context.worldBookMatches),
    ruleMatches: mapRuleMatches(context.ruleMatches),
    promptBlocks: [
      ...nativePromptBlocks,
      { identifier: 'dndOutputContract', displayName: 'DND 输出契约', source: 'dnd-contract', role: 'system', content: dndOutputContract }
    ],
    warnings: []
  };
}

function applyNarrativeLengthBlockToPreview(preview: PromptPreviewResponse, promptBlocks: PromptBlock[]): PromptPreviewResponse {
  const dndOutputContract = renderDndOutputContract(parseNarrativeLengthLimitsFromPromptBlocks(promptBlocks));
  const previewWithRuntimeContract = {
    ...preview,
    slots: preview.slots.map((slot) => slot.key === 'dndOutputContract' ? { ...slot, content: dndOutputContract } : slot),
    promptBlocks: preview.promptBlocks.map((block) => block.identifier === 'dndOutputContract' ? { ...block, content: dndOutputContract } : block)
  };
  if (previewWithRuntimeContract.promptBlocks.some((block) => block.displayName === '剧情字数限制' || block.identifier === 'narrativeLengthLimits')) {
    return {
      ...previewWithRuntimeContract,
      prompt: previewWithRuntimeContract.promptBlocks.map((block) => block.content).join('\n\n'),
      messages: previewWithRuntimeContract.promptBlocks.map((block) => ({ role: block.role, content: block.content }))
    };
  }
  const narrativeLengthBlock = promptBlocks.find((block) => block.enabled && block.name === '剧情字数限制');
  if (!narrativeLengthBlock) return previewWithRuntimeContract;

  const runtimeBlock: PromptPreviewResponse['promptBlocks'][number] = {
    identifier: narrativeLengthBlock.id || 'narrativeLengthLimits',
    displayName: narrativeLengthBlock.name,
    source: 'native-preset',
    role: narrativeLengthBlock.role,
    content: narrativeLengthBlock.content
  };
  const nextBlocks = [...previewWithRuntimeContract.promptBlocks];
  const contractIndex = nextBlocks.findIndex((block) => block.identifier === 'dndOutputContract');
  nextBlocks.splice(contractIndex >= 0 ? contractIndex : nextBlocks.length, 0, runtimeBlock);
  return {
    ...preview,
    promptBlocks: nextBlocks,
    prompt: nextBlocks.map((block) => block.content).join('\n\n'),
    messages: nextBlocks.map((block) => ({ role: block.role, content: block.content }))
  };
}

export async function buildRoomPromptPreview(
  db: AppDatabase,
  room: Room,
  options: { includeCurrentTurnActions?: boolean } = {}
): Promise<{ preview: PromptPreviewResponse; context: RoomPromptPreviewContext }> {
  const loadedContext = await loadRoomPromptPreviewContext(db, room);
  const context = options.includeCurrentTurnActions === false
    ? { ...loadedContext, actions: [] }
    : loadedContext;
  const presetPackage = getActiveGlobalPresetPackage(db);
  const scriptCard = getActiveGlobalScriptCard(db);
  if (!presetPackage) return { preview: buildNativePromptPreview(room, context, scriptCard), context };

  const preview = applyNarrativeLengthBlockToPreview(buildSillyTavernPromptPreview({
    room,
    players: context.players,
    objectiveLogs: context.objectiveLogs,
    publicLogs: context.publicLogs,
    actions: context.actions,
    interactions: context.interactions,
    scriptCard,
    presetPackage,
    worldBookEntries: getActiveGlobalResourceWorldBookEntries(db)
  }), context.promptBlocks);
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

function formatStringList(values: unknown, empty = '无'): string {
  return Array.isArray(values) && values.length > 0
    ? values.map((item) => String(item)).join(', ')
    : empty;
}

const abilityLabels: Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', string> = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  wis: '感知',
  cha: '魅力',
};

function formatAbilityScores(sheet: CharacterSheet): string {
  const scores = sheet.abilityScores;
  return `力量 ${scores.str}, 敏捷 ${scores.dex}, 体质 ${scores.con}, 智力 ${scores.int}, 感知 ${scores.wis}, 魅力 ${scores.cha}`;
}

export function loadCharacterStatusSection(db: AppDatabase, roomId: string): AiTurnPromptContextSection {
  const rows = db.prepare(`
    SELECT c.id as characterId, c.sheet_json as sheetJson, c.confirmed, p.id as playerId, p.name as playerName
    FROM characters c
    JOIN players p ON p.id = c.player_id
    WHERE p.room_id = ?
    ORDER BY p.created_at ASC
  `).all(roomId) as Array<{ characterId: string; sheetJson: string; confirmed: number; playerId: string; playerName: string }>;

  if (rows.length === 0) {
    return {
      title: 'Character Status',
      content: 'No character sheets are confirmed yet. Ask for missing basics before resolving dangerous or resource-sensitive actions.'
    };
  }

  const parsedRows = rows.map((row) => {
    try {
      const sheet = JSON.parse(row.sheetJson) as CharacterSheet;
      return { ...row, sheet, displayName: sheet.name || row.playerName };
    } catch {
      return { ...row, sheet: null, displayName: row.playerName };
    }
  });
  const displayNameCounts = parsedRows.reduce((counts, row) => counts.set(row.displayName, (counts.get(row.displayName) ?? 0) + 1), new Map<string, number>());
  const aliasFor = (row: { displayName: string; playerName: string }) => (
    (displayNameCounts.get(row.displayName) ?? 0) > 1 ? `${row.displayName}〔${row.playerName}〕` : row.displayName
  );

  const formatRow = (row: typeof parsedRows[number]) => {
    if (!row.sheet) {
      return `- ${row.playerName}: character sheet is unreadable; avoid changing resources for characterId=${row.characterId}.`;
    }
    const sheet = row.sheet;
    return [
      `- ${aliasFor(row)} (playerId=${row.playerId}, playerName=${row.playerName}, characterId=${row.characterId}, confirmed=${Boolean(row.confirmed)})`,
      `  Species/Class/Level: ${sheet.species || 'unknown'} / ${sheet.className || 'unknown'} / ${sheet.level ?? 1}`,
      `  Background/Concept: ${sheet.background || 'unknown'} / ${sheet.concept || 'unknown'}`,
      `  HP/AC/Proficiency: ${sheet.hitPoints?.current ?? '?'} / ${sheet.hitPoints?.max ?? '?'} HP, AC ${sheet.armorClass ?? '?'}, PB +${sheet.proficiencyBonus ?? '?'}`,
      `  Abilities: ${formatAbilityScores(sheet)}`,
      `  Skills: ${formatStringList(sheet.skills)}`,
      `  Equipment: ${formatStringList(sheet.equipment)}`,
      `  Spells: ${formatStringList(sheet.spells)}`,
      `  Languages/Proficiencies: ${formatStringList(sheet.languages)} / ${formatStringList(sheet.proficiencies)}`
    ].join('\n');
  };

  const confirmed = parsedRows.filter((row) => Boolean(row.confirmed));
  const drafts = parsedRows.filter((row) => !Boolean(row.confirmed));
  const content = [
    'Structured fields must refer to characters by characterId. Narrative text may use display names; if names are duplicated, include the suffix shown here.',
    confirmed.length > 0
      ? `Confirmed Characters:\n${confirmed.map(formatRow).join('\n')}`
      : 'Confirmed Characters:\nNo confirmed character sheets yet.',
    drafts.length > 0
      ? `Draft Characters (do not resolve checks, damage, spell slots, or combat resources for these unless the admin explicitly says so):\n${drafts.map(formatRow).join('\n')}`
      : ''
  ].filter(Boolean).join('\n\n');

  return { title: 'Character Status', content };
}

function buildRecentActionsSection(context: RoomPromptPreviewContext): AiTurnPromptContextSection {
  if (context.actions.length === 0) {
    return { title: 'Current Turn Actions', content: 'No player actions have been submitted for the current turn.' };
  }
  const playerNames = new Map(context.players.map((player) => [player.id, player.name]));
  return {
    title: 'Current Turn Actions',
    content: [...context.actions].sort((left, right) => left.submittedAt.localeCompare(right.submittedAt)).map((action, index) => {
      const playerName = playerNames.get(action.playerId) ?? action.playerId;
      const displayActionType = actionTypeForPrompt(action);
      const displayVisibility = actionVisibilityForPrompt(action);
      const tags = [displayActionType, displayVisibility, action.isHiddenRoll ? 'hidden-roll' : null].filter(Boolean).join(', ');
      return `${index + 1}. ${playerName} [${displayActionType}, ${displayVisibility}] submittedAt=${action.submittedAt}: ${action.text}${tags ? ` (${tags})` : ''}`;
    }).join('\n')
  };
}

function buildRecentPublicLogSection(context: RoomPromptPreviewContext): AiTurnPromptContextSection {
  const recentLogs = context.publicLogs.slice(-8);
  if (recentLogs.length === 0) {
    return { title: 'Recent Public Logs', content: 'No public logs yet.' };
  }
  return {
    title: 'Recent Public Logs',
    content: recentLogs.map((log) => `- ${log.title}: ${log.content}`).join('\n')
  };
}

function buildInteractionRequestsSection(context: RoomPromptPreviewContext): AiTurnPromptContextSection {
  const activeInteractions = context.interactions.filter((interaction) => interaction.status !== 'resolved');
  if (activeInteractions.length === 0) {
    return { title: 'Interaction Requests', content: 'No pending interaction requests.' };
  }

  const playerNames = playerNamesById(context.players);
  return {
    title: 'Interaction Requests',
    content: activeInteractions.map((interaction, index) => {
      const sourceName = playerNames.get(interaction.sourcePlayerId) ?? interaction.sourcePlayerId;
      const targetName = playerNames.get(interaction.targetPlayerId) ?? interaction.targetPlayerId;
      return [
        `${index + 1}. ${interaction.type} status=${interaction.status}`,
        `source=${sourceName} (${interaction.sourcePlayerId})`,
        `target=${targetName} (${interaction.targetPlayerId})`,
        `prompt=${interaction.prompt}`,
        interaction.targetResponse ? `targetResponse=${interaction.targetResponse}` : null
      ].filter(Boolean).join('\n   ');
    }).join('\n')
  };
}

function buildWorldAndRulesSection(preview: PromptPreviewResponse): AiTurnPromptContextSection {
  const worldLines = preview.worldBookMatches.length > 0
    ? preview.worldBookMatches.map((match) => `- ${match.keys.join(', ') || match.entryId}: ${match.content}`)
    : ['- No matched worldbook entries.'];
  const ruleLines = preview.ruleMatches.length > 0
    ? preview.ruleMatches.map((match) => `- ${match.title} [${match.category}]: ${match.summary}`)
    : ['- No approved rule matches.'];
  return {
    title: 'Relevant Worldbook And Approved Rules',
    content: [...worldLines, ...ruleLines].join('\n')
  };
}

function titleFromPromptBlockContent(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean) ?? '';
  if (firstLine.includes('绝不代替玩家') || firstLine.includes('玩家自主权')) return '玩家自主权';
  if (firstLine.includes('先攻') || firstLine.includes('攻击检定') || firstLine.includes('AC') || firstLine.includes('DC')) return '战斗规则';
  if (firstLine.includes('NPC') || firstLine.includes('独立动机')) return 'NPC自主性';
  if (firstLine.includes('世界书') || firstLine.includes('检索并注入')) return '世界书注入';
  if (firstLine.includes('信息隔离') || firstLine.includes('私密')) return '信息隔离';
  if (firstLine.includes('JSON') || firstLine.includes('输出格式')) return '输出格式';
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}...` : firstLine;
}

function isCrypticPromptIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,}$/.test(value);
}

function promptBlockDisplayName(block: PromptPreviewResponse['promptBlocks'][number]): string {
  if (block.displayName && block.displayName !== block.identifier) return block.displayName;
  if (isCrypticPromptIdentifier(block.identifier)) {
    return titleFromPromptBlockContent(block.content) || '提示词块';
  }
  return block.displayName || block.identifier;
}

function stripDuplicatePromptHeading(content: string, identifier: string, displayName: string): string {
  const lines = content.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? '';
  const headingMatch = firstLine.match(/^#{1,6}\s+(.+)$/);
  if (!headingMatch) return content;

  const headingText = headingMatch[1].trim();
  if (headingText === identifier || headingText === displayName || isCrypticPromptIdentifier(headingText)) {
    return lines.slice(1).join('\n').trimStart();
  }
  return content;
}

function buildSystemRulesSection(preview: PromptPreviewResponse): AiTurnPromptContextSection {
  const blocks = preview.promptBlocks
    .filter((block) => block.source !== 'runtime-slot')
    .map((block) => {
      const displayName = promptBlockDisplayName(block);
      return `### ${displayName}\n${stripDuplicatePromptHeading(block.content, block.identifier, displayName)}`;
    });
  return {
    title: 'System Rules And Output Contract',
    content: blocks.length > 0 ? blocks.join('\n\n') : renderDndOutputContract()
  };
}

export function buildAiTurnDebugPrompt(room: Room, preview: PromptPreviewResponse, context: RoomPromptPreviewContext, characterStatus: AiTurnPromptContextSection): { flatPrompt: string; contextSections: AiTurnPromptContextSection[] } {
  const contextSections: AiTurnPromptContextSection[] = [
    {
      title: 'AI-DM Operating Boundary',
      content: [
        'Resolve the next playable beat for this DND 5e scene.',
        'Resolve only submitted actions. Do not invent missing player actions.',
        'Do not directly mutate campaign, character, inventory, HP, spell slots, conditions, or database state.',
        'Return narrative plus explicit structured changes; the system applies only validated character resource and plugin database row changes.',
        'Do not invent dice results. Use diceRequests only to ask the system to roll internally when a real random result is needed.',
        'For diceRequests with characterId and known ability/skill, set modifier to null and let the system compute it from character status.',
        'Use structured room, character, inventory, status, and plugin database state over worldbook text when they conflict.',
        '当前角色使用系统内置 MVP 轻量规则。以结构化角色状态为准，不要按完整 DND 5e 自行重算 HP、AC、熟练项、装备合法性或职业特性。若发现疑似不一致，只在 ruleResults 或 suggestedStateChanges 中提出审核建议，不直接修正。',
        'Resolve current submitted actions before long-term memory, historical summaries, or general worldbook assumptions.',
        'Player/meta questions may be answered without advancing the scene. Resolve only actionable submissions as scene actions.',
        'ruleResults must only describe rules that need no roll, or results already confirmed by system state or system dice.',
        'Preserve information isolation between public and private player knowledge.',
        'If Interaction Requests contains targetResponse values, resolve those responses for the current turn. Do not start a new unrelated turn until the interaction is resolved.',
        'privateUpdatesByPlayer is the information-isolation mechanism: player_question/meta_question, personal identity answers, private memory/background, individual perception results, private clues, whispers, non-public action results, and character-specific rules clarifications must be routed to the submitting playerId, not publicLog.',
        'interactionRequests sourcePlayerId and targetPlayerId must be real playerId values from Character Status; do not use player names, character names, aliases, or tokens.',
        'Action type routing: player_question/meta_question default to private reply without scene advancement; observe may be public as an action, but individual results can be private; wait/skip/ready should be short and must not invent posture, weapon stance, emotion, inner thoughts, or dialogue.',
        'Never leak or hint objectiveLog-only hidden facts in publicLog unless player action, public evidence, or system dice results justify it.',
        'Public dice reasons must be player-safe and must not reveal hidden enemy types, ambushers, traps, secret motives, or unrevealed objectives.',
        'Respect player agency: ask for clarification or a roll when an action needs player input.'
      ].join('\n')
    },
    {
      title: 'Campaign State',
      content: [
        `Room: ${room.name}`,
        `Turn: ${room.currentTurn}`,
        `Room status: ${room.status}`,
        `World info: ${room.worldInfo || 'None'}`
      ].join('\n')
    },
    characterStatus,
    buildRecentActionsSection(context),
    buildInteractionRequestsSection(context),
    buildRecentPublicLogSection(context),
    buildWorldAndRulesSection(preview),
    ...(context.campaignContext ? [{ title: 'Campaign Memory And Plugin Database', content: context.campaignContext }] : []),
    buildSystemRulesSection(preview)
  ];

  const flatPrompt = [
    ...contextSections.map((section) => `## ${section.title}\n${section.content}`)
  ].join('\n\n');

  return { flatPrompt, contextSections };
}
