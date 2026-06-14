import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import type { Room, Turn } from '../domain/types.js';
import { buildPlayerVisibleState } from '../services/visibilityService.js';
import { publishRoomUpdate } from '../services/eventBus.js';
import { listRuleSummariesForRoom } from '../services/ruleRetrievalService.js';
import {
  auditCharacterBuilderDraft,
  buildCharacterSheetFromDraft,
  listCharacterBuilderOptions,
  normalizeCharacterBuilderDraft,
} from '../services/characterBuilderService.js';
import { getCharacterResources } from '../services/characterResourceService.js';
import { listCharacterResourceChanges } from '../services/characterAuditService.js';
import { listSessionSummaries, listCampaignQuests, listCampaignNpcs } from '../services/campaignMemoryService.js';
import { getTurnReadiness } from '../services/turnReadinessService.js';
import { buildFiveERulesSummary } from '../services/fiveERulesService.js';
import { PersonalOpeningIntroError, preparePersonalOpeningIntrosForConfirmation, type PreparedPersonalOpeningIntro } from '../services/personalOpeningIntroService.js';
import {
  generateCurrentPlayerTurnSuggestions,
  loadCachedCurrentPlayerTurnSuggestions,
  PlayerTurnSuggestionError
} from '../services/playerTurnSuggestionService.js';
import { requestOpenAiCompatibleChatWithTools, type ChatTool, type ChatToolCall } from '../services/aiProvider.js';
import { getGlobalAiProviderConfig, getGlobalRuntimeSettings } from '../services/globalConfigService.js';

const actionSchema = z.object({
  text: z.string().min(1),
  actionType: z.enum(['narrative', 'exploration', 'social', 'combat', 'ooc', 'in_character_action', 'player_question', 'meta_question', 'observe', 'wait', 'skip', 'ready', 'follow', 'combat_action']).optional(),
  visibility: z.enum(['public', 'private', 'dm_only']).optional(),
  isHiddenRoll: z.boolean().optional()
});
const interactionResponseSchema = z.object({ response: z.string().min(1) });
const builderDraftSchema = z.object({ draft: z.unknown() }).strict();
const optionalBuilderDraftSchema = z.object({ draft: z.unknown().optional() }).strict();

function inferActionType(text: string, actionType: z.infer<typeof actionSchema>['actionType']): NonNullable<z.infer<typeof actionSchema>['actionType']> {
  if (actionType && actionType !== 'narrative') return actionType;
  const trimmed = text.trim();
  if (/^(我是谁|我现在是谁|我的角色是谁)[？?]?$/.test(trimmed)) return 'player_question';
  if (/[？?]$/.test(trimmed)) return 'player_question';
  if (/^(观察|查看|环顾|侦查|搜索)/.test(trimmed)) return 'observe';
  if (/^(等待|静观|观望|不行动)/.test(trimmed)) return 'wait';
  return actionType ?? 'in_character_action';
}

function inferActionVisibility(actionType: NonNullable<z.infer<typeof actionSchema>['actionType']>, visibility: z.infer<typeof actionSchema>['visibility']): NonNullable<z.infer<typeof actionSchema>['visibility']> {
  if (visibility) return visibility;
  return actionType === 'player_question' || actionType === 'meta_question' ? 'private' : 'public';
}

function getPlayerByToken(db: AppDatabase, token: string): any | null {
  return db.prepare('SELECT id, room_id as roomId, name, token, is_connected as isConnected, created_at as createdAt FROM players WHERE token = ?').get(token) as any | null;
}

function getCharacterByPlayerId(db: AppDatabase, playerId: string): any | null {
  return db.prepare('SELECT id, player_id as playerId, sheet_json as sheetJson, draft_source as draftSource, confirmed, updated_at as updatedAt FROM characters WHERE player_id = ?').get(playerId) as any | null;
}

function isRoomAtExpectedPlayerCount(db: AppDatabase, roomId: string, expectedPlayerCount: number | null | undefined): boolean {
  if (!expectedPlayerCount) return false;
  const row = db.prepare('SELECT COUNT(*) as count FROM players WHERE room_id = ?').get(roomId) as { count: number };
  return row.count >= expectedPlayerCount;
}

function mapCharacterRow(row: any): { id: string; playerId: string; sheet: any; draftSource: 'ai' | 'manual'; confirmed: boolean; updatedAt: string } {
  const draftSource = row.draftSource === 'ai' ? 'ai' as const : 'manual' as const;
  return {
    id: row.id,
    playerId: row.playerId,
    sheet: JSON.parse(row.sheetJson),
    draftSource,
    confirmed: Boolean(row.confirmed),
    updatedAt: row.updatedAt,
  };
}

export function createPlayerRouter(db: AppDatabase): Router {
  const router = Router();

  router.get('/public/runtime', (_req, res) => {
    const runtime = getGlobalRuntimeSettings(db);
    res.json({ timeoutMs: runtime.timeoutMs });
  });

  router.get('/:token/state', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });

    const room = db.prepare('SELECT id, name, system_prompt as systemPrompt, world_info as worldInfo, current_turn as currentTurn, status, expected_player_count as expectedPlayerCount, created_at as createdAt FROM rooms WHERE id = ?').get(player.roomId) as any;
    const players = db.prepare('SELECT id, room_id as roomId, name, token, is_connected as isConnected, created_at as createdAt FROM players WHERE room_id = ? ORDER BY created_at ASC').all(player.roomId) as any[];
    const characterRow = getCharacterByPlayerId(db, player.id);
    const character = characterRow ? mapCharacterRow(characterRow) : null;
    const logs = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM log_entries WHERE room_id = ? ORDER BY created_at ASC').all(player.roomId) as any[];
    const turn = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?').get(player.roomId, room.currentTurn) as any;
    const actions = turn ? db.prepare('SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text, submitted_at as submittedAt, status, action_type as actionType, visibility, is_hidden_roll as isHiddenRoll FROM actions WHERE turn_id = ? ORDER BY submitted_at ASC').all(turn.id) as any[] : [];
    const interactions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, source_player_id as sourcePlayerId, target_player_id as targetPlayerId, type, prompt, target_response as targetResponse, status, created_at as createdAt FROM interaction_requests WHERE room_id = ? ORDER BY created_at ASC').all(player.roomId) as any[];
    const ruleSummaries = listRuleSummariesForRoom(db, player.roomId, 5);

    // Load active combat state
    const combatRows = db.prepare('SELECT state_json FROM combat_state WHERE room_id = ? AND state_json LIKE ? ORDER BY updated_at DESC LIMIT 1')
      .all(player.roomId, '%"status":"active"%') as Array<{ state_json: string }>;
    const combatState = combatRows.length > 0 ? JSON.parse(combatRows[0].state_json) : undefined;

    // Load recent public dice logs (is_public=1 or target this player)
    const recentDiceLogs = db.prepare(
      `SELECT d.id, d.room_id as roomId, d.character_id as characterId, d.dice_type as diceType,
              d.values_json as valuesJson, d.modifier, d.total, d.success, d.is_public as isPublic,
              d.reason, d.public_reason as publicReason, d.created_at as createdAt,
              COALESCE(p.name, 'DM') as playerName
       FROM dice_logs d
       LEFT JOIN characters c ON c.id = d.character_id
       LEFT JOIN players p ON p.id = c.player_id
       WHERE d.room_id = ? AND (d.is_public = 1 OR d.character_id = (SELECT own.id FROM characters own WHERE own.player_id = ?))
       ORDER BY d.created_at DESC
       LIMIT 20`
    ).all(player.roomId, player.id) as Array<{
      id: string; roomId: string; characterId: string | null; diceType: string; valuesJson: string;
      modifier: number; total: number; success: number | null;
      isPublic: number; reason: string; publicReason: string; createdAt: string; playerName: string;
    }>;
    const diceLogs = recentDiceLogs.map((row) => ({
      id: row.id,
      roomId: row.roomId,
      playerName: row.playerName,
      die: row.diceType,
      values: JSON.parse(row.valuesJson) as number[],
      modifier: row.modifier,
      total: row.total,
      reason: row.publicReason || row.reason,
      success: row.success === null ? undefined : Boolean(row.success),
      createdAt: row.createdAt,
    }));

    // Load resources and recent changes
    let resources = undefined;
    let recentChanges = undefined;
    if (character) {
      try {
        resources = getCharacterResources(db, character.id);
      } catch {
        // Resources not initialized yet, skip
      }
      try {
        const rawChanges = listCharacterResourceChanges(db, player.roomId, { characterId: character.id, limit: 5 });
        recentChanges = rawChanges.map((c) => ({
          id: c.id,
          changeType: c.changeType,
          path: c.path,
          before: JSON.parse(c.beforeJson),
          after: JSON.parse(c.afterJson),
          reason: c.reason,
          createdAt: c.createdAt,
        }));
      } catch {
        // No changes yet, skip
      }
    }

    // Load campaign memory data
    const campaignSummaries = listSessionSummaries(db, player.roomId, 1);
    const campaignSummary = campaignSummaries.length > 0 ? campaignSummaries[0] : null;
    const quests = listCampaignQuests(db, player.roomId);
    const npcs = listCampaignNpcs(db, player.roomId);
    const rules = buildFiveERulesSummary(character);
    const turnSuggestions = loadCachedCurrentPlayerTurnSuggestions(db, { roomId: player.roomId, playerId: player.id });

    res.json(buildPlayerVisibleState({ room, player, players, character, logs, actions, interactions, ruleSummaries, resources, recentChanges, combatState, recentDiceLogs: diceLogs, campaignSummary, quests, npcs, rules, turnSuggestions }));
  });

  router.post('/:token/turn-suggestions', async (req, res, next) => {
    try {
      const player = getPlayerByToken(db, req.params.token);
      if (!player) return res.status(404).json({ error: 'Not found' });
      const turnSuggestions = await generateCurrentPlayerTurnSuggestions(db, {
        roomId: player.roomId,
        playerId: player.id
      });
      publishRoomUpdate(player.roomId);
      res.json({
        suggestions: turnSuggestions.options,
        status: turnSuggestions.status,
        error: turnSuggestions.error ?? undefined
      });
    } catch (error) {
      if (error instanceof PlayerTurnSuggestionError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.get('/:token/character-builder/options', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });
    res.json({ options: listCharacterBuilderOptions(db) });
  });

  router.post('/:token/character-builder/audit', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });
    const input = builderDraftSchema.parse(req.body);
    const draft = normalizeCharacterBuilderDraft(input.draft);
    const options = listCharacterBuilderOptions(db);
    const audit = auditCharacterBuilderDraft(draft, options);
    res.json({ draft, audit });
  });

  router.put('/:token/character-builder/draft', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });
    const input = builderDraftSchema.parse(req.body);
    const draft = normalizeCharacterBuilderDraft(input.draft);

    const characterRow = getCharacterByPlayerId(db, player.id);
    if (!characterRow) return res.status(404).json({ error: 'Character not found' });
    const currentSheet = JSON.parse(characterRow.sheetJson);

    const updatedSheet = {
      ...currentSheet,
      name: draft.name || currentSheet.name,
      species: draft.species || currentSheet.species,
      subSpecies: draft.subSpecies,
      className: draft.className || currentSheet.className,
      classDetail: draft.classDetail,
      background: draft.background,
      abilityScores: draft.abilityScores,
      skills: draft.skills,
      equipment: draft.equipment,
      spells: draft.spells,
      concept: draft.concept,
      personality: draft.personality,
      ideal: draft.ideal,
      bond: draft.bond,
      flaw: draft.flaw,
      privateNotes: draft.notes,
      builderDraft: draft,
    };

    const now = new Date().toISOString();
    db.prepare('UPDATE characters SET sheet_json = ?, draft_source = ?, confirmed = ?, updated_at = ? WHERE player_id = ?')
      .run(JSON.stringify(updatedSheet), 'manual', 0, now, player.id);
    publishRoomUpdate(player.roomId);

    const refreshed = getCharacterByPlayerId(db, player.id);
    const character = refreshed ? mapCharacterRow(refreshed) : null;
    res.json({ character });
  });

  router.post('/:token/character-builder/confirm', async (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });

    const characterRow = getCharacterByPlayerId(db, player.id);
    if (!characterRow) return res.status(404).json({ error: 'Character not found' });
    const currentSheet = JSON.parse(characterRow.sheetJson);

    const input = optionalBuilderDraftSchema.parse(req.body ?? {});
    const rawDraft = input.draft ?? currentSheet.builderDraft ?? currentSheet;
    const draft = normalizeCharacterBuilderDraft(rawDraft);
    const options = listCharacterBuilderOptions(db);
    const audit = auditCharacterBuilderDraft(draft, options);

    if (!audit.valid) {
      return res.status(400).json({ error: 'Character builder draft is incomplete', audit });
    }

    const builtSheet = buildCharacterSheetFromDraft(draft);
    let personalOpeningIntros: PreparedPersonalOpeningIntro[] = [];
    try {
      personalOpeningIntros = await preparePersonalOpeningIntrosForConfirmation(db, {
        roomId: player.roomId,
        playerId: player.id,
        builtSheet
      });
    } catch (err) {
      if (err instanceof PersonalOpeningIntroError) {
        return res.status(err.statusCode).json({ error: 'PERSONAL_OPENING_INTRO_FAILED', message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: 'PERSONAL_OPENING_INTRO_FAILED', message });
    }

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare('UPDATE characters SET sheet_json = ?, confirmed = ?, updated_at = ? WHERE player_id = ?')
        .run(JSON.stringify(builtSheet), 1, now, player.id);
      const existingIntro = db.prepare(`
        SELECT id FROM log_entries
        WHERE room_id = ? AND visibility_scope = 'private' AND player_id = ? AND title = ?
        LIMIT 1
      `);
      const insertIntro = db.prepare(`
        INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const intro of personalOpeningIntros) {
        const existing = existingIntro.get(intro.roomId, intro.playerId, intro.title);
        if (existing) continue;
        insertIntro.run(intro.id, intro.roomId, intro.turnId, 'private', intro.playerId, intro.title, intro.content, intro.createdAt);
      }
    });
    tx();
    publishRoomUpdate(player.roomId);

    const refreshed = getCharacterByPlayerId(db, player.id);
    const character = refreshed ? mapCharacterRow(refreshed) : null;
    res.json({ character });
  });

  router.post('/:token/actions', (req, res) => {
    const input = actionSchema.parse(req.body);
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });
    const room = db.prepare('SELECT id, current_turn as currentTurn, status, expected_player_count as expectedPlayerCount FROM rooms WHERE id = ?').get(player.roomId) as { id: string; currentTurn: number; status: Room['status']; expectedPlayerCount: number | null } | undefined;
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const characterRow = getCharacterByPlayerId(db, player.id);
    if (isRoomAtExpectedPlayerCount(db, player.roomId, room.expectedPlayerCount) && !characterRow?.confirmed) {
      return res.status(409).json({
        error: 'CHARACTER_NOT_CONFIRMED',
        message: '确认角色后才能提交本回合行动。'
      });
    }
    const turn = db.prepare('SELECT id, status FROM turns WHERE room_id = ? AND number = ?').get(player.roomId, room.currentTurn) as { id: string; status: Turn['status'] } | undefined;
    if (!turn) return res.status(409).json({ error: 'TURN_NOT_OPEN', message: '当前没有可提交行动的回合。' });
    if (room.status !== 'waiting_for_actions' || !['open', 'waiting_for_actions'].includes(turn.status)) {
      return res.status(409).json({
        error: 'ACTIONS_CLOSED',
        message: '当前回合已锁定或正在结算，不能再提交或修改行动。',
        roomStatus: room.status,
        turnStatus: turn.status
      });
    }
    const now = new Date().toISOString();

    const inferredActionType = inferActionType(input.text, input.actionType);
    const visibility = inferActionVisibility(inferredActionType, input.visibility);
    db.prepare('INSERT OR REPLACE INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status, action_type, visibility, is_hidden_roll) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(nanoid(), player.roomId, turn.id, player.id, input.text, now, 'submitted', inferredActionType, visibility, input.isHiddenRoll ? 1 : 0);
    getTurnReadiness(db, room);
    publishRoomUpdate(player.roomId);
    res.json({ ok: true });
  });

  router.post('/:token/interactions/:interactionId/respond', (req, res) => {
    const input = interactionResponseSchema.parse(req.body);
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });

    const interaction = db.prepare('SELECT id, room_id as roomId, turn_id as turnId FROM interaction_requests WHERE id = ? AND target_player_id = ?')
      .get(req.params.interactionId, player.id) as { id: string; roomId: string; turnId: string } | undefined;
    if (!interaction) return res.status(404).json({ error: 'Interaction not found' });

    const tx = db.transaction(() => {
      db.prepare('UPDATE interaction_requests SET target_response = ?, status = ? WHERE id = ? AND target_player_id = ?')
        .run(input.response, 'ready_for_ai', req.params.interactionId, player.id);

      const pending = db.prepare('SELECT COUNT(*) as count FROM interaction_requests WHERE room_id = ? AND turn_id = ? AND status = ?')
        .get(interaction.roomId, interaction.turnId, 'pending_target') as { count: number };
      if (pending.count === 0) {
        db.prepare('UPDATE turns SET status = ? WHERE id = ? AND status = ?')
          .run('ready_to_resolve', interaction.turnId, 'waiting_for_interaction');
        db.prepare('UPDATE rooms SET status = ? WHERE id = ? AND status = ?')
          .run('ready_to_resolve', interaction.roomId, 'waiting_for_interaction');
      }
    });
    tx();
    publishRoomUpdate(player.roomId);
    res.json({ ok: true });
  });

  router.get('/:token/dm-chat/history', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });
    const rows = db.prepare('SELECT role, content, created_at FROM dm_chat_messages WHERE room_id = ? AND player_id = ? ORDER BY id ASC')
      .all(player.roomId, player.id) as Array<{ role: string; content: string; created_at: string }>;
    res.json({ messages: rows.map(r => ({ role: r.role as 'user' | 'assistant', content: r.content, createdAt: r.created_at })) });
  });

  const dmChatSchema = z.object({
    message: z.string().min(1).max(2000),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).max(20).optional()
  });

  const dmTools: ChatTool[] = [
    {
      type: 'function',
      function: {
        name: 'get_character',
        description: '获取当前玩家的完整角色卡信息。返回角色名称、种族、职业、属性值、技能、装备、法术等所有字段。',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'update_character',
        description: '修改当前玩家的角色卡草稿。可以修改任意字段：name(名字)、species(种族)、subSpecies(亚种)、className(职业)、classDetail(职业细节)、background(背景)、abilityScores(属性值对象，键为str/dex/con/int/wis/cha)、skills(技能数组)、equipment(装备数组)、spells(法术数组)、concept(概念)、personality(人格)、ideal(理想)、bond(羁绊)、flaw(缺陷)。只需传要修改的字段，未传的字段保持不变。修改后角色变为未确认草稿状态。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '角色名称' },
            species: { type: 'string', description: '种族，可选：人类、矮人、精灵、半身人、龙裔、侏儒、半精灵、半兽人、提夫林' },
            subSpecies: { type: 'string', description: '亚种，如：标准人类、变体人类、丘陵矮人、山地矮人、高等精灵、木精灵、黑暗精灵等' },
            className: { type: 'string', description: '职业，可选：野蛮人、吟游诗人、牧师、德鲁伊、战士、武僧、圣武士、游侠、游荡者、术士、邪术师、法师' },
            classDetail: { type: 'string', description: '职业细节/子职' },
            background: { type: 'string', description: '背景，如：侍僧、罪犯、民间英雄、贵族、贤者、士兵等' },
            abilityScores: {
              type: 'object',
              description: '六项属性值，键为 str/dex/con/int/wis/cha，值为 1-30 整数',
              properties: {
                str: { type: 'number' }, dex: { type: 'number' }, con: { type: 'number' },
                int: { type: 'number' }, wis: { type: 'number' }, cha: { type: 'number' }
              }
            },
            skills: { type: 'array', items: { type: 'string' }, description: '熟练技能列表' },
            equipment: { type: 'array', items: { type: 'string' }, description: '装备列表' },
            spells: { type: 'array', items: { type: 'string' }, description: '法术列表' },
            concept: { type: 'string', description: '角色概念' },
            personality: { type: 'string', description: '人格特质' },
            ideal: { type: 'string', description: '理想' },
            bond: { type: 'string', description: '羁绊' },
            flaw: { type: 'string', description: '缺陷' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_builder_options',
        description: '列出所有可用的建卡选项，包括种族、亚种、职业、背景、技能、装备、法术、语言、熟练项。用于向玩家推荐选择。',
        parameters: {
          type: 'object',
          properties: {
            optionType: { type: 'string', enum: ['species', 'subspecies', 'class', 'background', 'skill', 'equipment', 'spell', 'language', 'proficiency'], description: '要查看的选项类型，不传则返回所有类型的名称概览' }
          }
        }
      }
    }
  ];

  function buildRulesReference(): string {
    try {
      const options = listCharacterBuilderOptions(db);
      const parts: string[] = ['=== 可用建卡选项 ==='];

      const speciesNames = options.species.map(o => o.name);
      parts.push(`种族：${speciesNames.join('、')}`);
      for (const s of options.species) parts.push(`  ${s.name}：${s.summary}`);

      const subNames = options.subSpecies.map(o => o.name);
      parts.push(`\n亚种：${subNames.join('、')}`);
      for (const s of options.subSpecies) {
        const prereq = (s.prerequisites as Record<string, unknown> | undefined)?.species as string[] | undefined;
        parts.push(`  ${s.name}（需${prereq?.join('/') ?? '无'}）：${s.summary}`);
      }

      parts.push(`\n职业：`);
      for (const c of options.classes) parts.push(`  ${c.name}：${c.summary}`);

      parts.push(`\n背景：${options.backgrounds.map(o => o.name).join('、')}`);
      for (const b of options.backgrounds) parts.push(`  ${b.name}：${b.summary}`);

      parts.push(`\n技能：${options.skills.map(o => o.name).join('、')}`);
      parts.push(`\n装备：${options.equipment.map(o => o.name).join('、')}`);
      for (const e of options.equipment) parts.push(`  ${e.name}：${e.summary}`);
      parts.push(`\n法术：${options.spells.map(o => o.name).join('、')}`);
      for (const sp of options.spells) parts.push(`  ${sp.name}：${sp.summary}`);
      parts.push(`\n语言：${options.languages.map(o => o.name).join('、')}`);
      parts.push(`\n熟练项：${options.proficiencies.map(o => o.name).join('、')}`);

      return parts.join('\n');
    } catch {
      return '（规则数据加载失败）';
    }
  }

  const rulesReference = buildRulesReference();

  router.post('/:token/dm-chat', async (req, res) => {
    const parsed = dmChatSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });

    const config = getGlobalAiProviderConfig(db);
    if (config.provider === 'mock') return res.json({ reply: '（DM 助手暂不可用）' });

    const systemPrompt = [
      '你是 D&D 5e 中文跑团的 DM 助手。你可以直接操作玩家的角色卡来帮助他们创建和调整角色。',
      '',
      '你的能力：',
      '- 使用 get_character 查看玩家当前完整角色信息',
      '- 使用 update_character 直接修改角色卡的任意字段（种族、职业、属性、技能、装备、法术等）',
      '- 使用 list_builder_options 查看所有可用的建卡选项及其规则说明',
      '- 解答 D&D 5e 规则问题——战斗流程、法术机制、技能检定、状态效果等',
      '- 提供角色扮演建议',
      '',
      '工作方式：',
      '- 玩家描述角色概念时，先用 update_character 设置基础信息，再逐步完善',
      '- 修改前先确认玩家意图；如果玩家说"帮我建一个战士"，直接设置并告知结果',
      '- 每次修改后用中文告诉玩家你改了什么、为什么这么改',
      '- 推荐选择时参考规则书中的选项描述和前置条件',
      '- 不要泄露 DM 的秘密或未公开的剧情信息',
      '- 用 Markdown 格式回复，简洁实用',
      '',
      '重要限制：',
      '- 角色确认后（游戏已开始），update_character 将被禁止，你只能读取角色信息、解答规则问题',
      '- 如果玩家在游戏开始后要求修改角色，告诉他们需要联系 DM 在管理端操作',
      '',
      '调用工具时严格遵守：',
      '- update_character 的参数必须完全匹配玩家的请求。如果玩家说"精灵游荡者"，species 必须设为"精灵"，className 必须设为"游荡者"，绝不能设成其他种族或职业。',
      '- 如果不确定某个字段的正确值，先调用 list_builder_options 或 get_character 查看可用选项或当前值，再调用 update_character。',
      '- 一次请求中，优先把所有要修改的字段放在一个 update_character 调用中，而不是分多次调用。',
      '',
      '---',
      '规则参考：',
      rulesReference
    ].join('\n');

    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `我的玩家名是：${player.name}` }
    ];

    if (parsed.data.history) {
      for (const msg of parsed.data.history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: 'user', content: parsed.data.message });

    // 保存用户消息
    db.prepare('INSERT INTO dm_chat_messages (room_id, player_id, role, content) VALUES (?, ?, ?, ?)')
      .run(player.roomId, player.id, 'user', parsed.data.message);

    function executeTool(call: ChatToolCall): string {
      const args = (() => { try { return JSON.parse(call.function.arguments); } catch { return {}; } })();

      if (call.function.name === 'get_character') {
        const characterRow = getCharacterByPlayerId(db, player.id);
        if (!characterRow) return JSON.stringify({ error: '角色不存在，请先用 update_character 创建' });
        const character = mapCharacterRow(characterRow);
        if (character.sheet.builderDraft) {
          return JSON.stringify({ status: character.confirmed ? '已确认' : '草稿', sheet: character.sheet, builderDraft: character.sheet.builderDraft }, null, 2);
        }
        return JSON.stringify({ status: character.confirmed ? '已确认' : '草稿', sheet: character.sheet }, null, 2);
      }

      if (call.function.name === 'update_character') {
        const characterRow = getCharacterByPlayerId(db, player.id);
        if (!characterRow) return JSON.stringify({ error: '角色行不存在' });
        if (characterRow.confirmed) return JSON.stringify({ error: '角色已确认，游戏已开始。DM 助手不再允许修改角色卡。如需修改请联系 DM 在管理端操作。' });
        const currentSheet = JSON.parse(characterRow.sheetJson);
        const currentDraft = currentSheet.builderDraft ?? {
          name: currentSheet.name ?? '', concept: '', species: currentSheet.species ?? '',
          subSpecies: currentSheet.subSpecies ?? '', className: currentSheet.className ?? '',
          classDetail: currentSheet.classDetail ?? '', background: currentSheet.background ?? '',
          abilityScores: currentSheet.abilityScores ?? { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
          skills: currentSheet.skills ?? [], equipment: currentSheet.equipment ?? [],
          spells: currentSheet.spells ?? [], languages: currentSheet.languages ?? [],
          proficiencies: currentSheet.proficiencies ?? [],
          personality: currentSheet.personality ?? '', ideal: currentSheet.ideal ?? '',
          bond: currentSheet.bond ?? '', flaw: currentSheet.flaw ?? '', notes: currentSheet.privateNotes ?? ''
        };

        const merged = { ...currentDraft };
        for (const [key, value] of Object.entries(args)) {
          if (value !== undefined && value !== null) (merged as any)[key] = value;
        }
        if (args.abilityScores) {
          merged.abilityScores = { ...currentDraft.abilityScores, ...args.abilityScores };
        }

        const normalized = normalizeCharacterBuilderDraft(merged);
        const updatedSheet = {
          ...currentSheet,
          name: normalized.name || currentSheet.name,
          species: normalized.species || currentSheet.species,
          subSpecies: normalized.subSpecies,
          className: normalized.className || currentSheet.className,
          classDetail: normalized.classDetail,
          background: normalized.background,
          abilityScores: normalized.abilityScores,
          skills: normalized.skills,
          equipment: normalized.equipment,
          spells: normalized.spells,
          concept: normalized.concept,
          personality: normalized.personality,
          ideal: normalized.ideal,
          bond: normalized.bond,
          flaw: normalized.flaw,
          privateNotes: normalized.notes,
          builderDraft: normalized,
        };

        const now = new Date().toISOString();
        db.prepare('UPDATE characters SET sheet_json = ?, draft_source = ?, confirmed = ?, updated_at = ? WHERE player_id = ?')
          .run(JSON.stringify(updatedSheet), 'manual', 0, now, player.id);
        publishRoomUpdate(player.roomId);

        const changedFields = Object.keys(args);
        return JSON.stringify({ success: true, changedFields, message: `已更新角色卡字段：${changedFields.join('、')}。角色现为草稿状态，玩家确认后生效。` });
      }

      if (call.function.name === 'list_builder_options') {
        const optionType = args.optionType as string | undefined;
        try {
          const options = listCharacterBuilderOptions(db);
          if (optionType) {
            const keyMap: Record<string, string> = { species: 'species', subspecies: 'subSpecies', class: 'classes', background: 'backgrounds', skill: 'skills', equipment: 'equipment', spell: 'spells', language: 'languages', proficiency: 'proficiencies' };
            const key = keyMap[optionType] as keyof typeof options;
            const list = options[key] ?? [];
            return JSON.stringify(list.map(o => ({ name: o.name, summary: o.summary, prerequisites: o.prerequisites })), null, 2);
          }
          return JSON.stringify({
            species: options.species.map(o => o.name),
            subSpecies: options.subSpecies.map(o => o.name),
            classes: options.classes.map(o => o.name),
            backgrounds: options.backgrounds.map(o => o.name),
            skills: options.skills.map(o => o.name),
            equipment: options.equipment.map(o => o.name),
            spells: options.spells.map(o => o.name),
            languages: options.languages.map(o => o.name),
            proficiencies: options.proficiencies.map(o => o.name),
          }, null, 2);
        } catch {
          return JSON.stringify({ error: '加载选项失败' });
        }
      }

      return JSON.stringify({ error: `未知工具：${call.function.name}` });
    }

    try {
      const runtime = getGlobalRuntimeSettings(db);
      const characterRow = getCharacterByPlayerId(db, player.id);
      const isConfirmed = characterRow ? Boolean(characterRow.confirmed) : false;
      const activeTools = isConfirmed ? dmTools.filter(t => t.function.name !== 'update_character') : dmTools;
      let finalReply = '';

      for (let round = 0; round < 8; round++) {
        const result = await requestOpenAiCompatibleChatWithTools(config, messages, activeTools, runtime);

        if (result.toolCalls && result.toolCalls.length > 0) {
          if (result.content) {
            messages.push({ role: 'assistant', content: result.content, tool_calls: result.toolCalls });
          } else {
            messages.push({ role: 'assistant', content: null, tool_calls: result.toolCalls });
          }

          for (const call of result.toolCalls) {
            const toolResult = executeTool(call);
            messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
          }
          continue;
        }

        finalReply = result.content?.trim() ?? '';
        break;
      }

      if (!finalReply) finalReply = '（DM 助手未能生成回复）';

      // 保存助手回复
      db.prepare('INSERT INTO dm_chat_messages (room_id, player_id, role, content) VALUES (?, ?, ?, ?)')
        .run(player.roomId, player.id, 'assistant', finalReply);

      res.json({ reply: finalReply });
    } catch (err: any) {
      console.error('DM chat error:', err.message);
      res.status(502).json({ error: 'AI request failed', detail: err.message?.slice(0, 200) });
    }
  });

  return router;
}
