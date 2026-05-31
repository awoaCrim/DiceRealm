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

  router.get('/:token/state', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });

    const room = db.prepare('SELECT id, name, system_prompt as systemPrompt, world_info as worldInfo, current_turn as currentTurn, status, created_at as createdAt FROM rooms WHERE id = ?').get(player.roomId) as any;
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

    res.json(buildPlayerVisibleState({ room, player, players, character, logs, actions, interactions, ruleSummaries, resources, recentChanges, combatState, recentDiceLogs: diceLogs, campaignSummary, quests, npcs }));
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
    const audit = auditCharacterBuilderDraft(draft);
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

  router.post('/:token/character-builder/confirm', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });

    const characterRow = getCharacterByPlayerId(db, player.id);
    if (!characterRow) return res.status(404).json({ error: 'Character not found' });
    const currentSheet = JSON.parse(characterRow.sheetJson);

    const input = optionalBuilderDraftSchema.parse(req.body ?? {});
    const rawDraft = input.draft ?? currentSheet.builderDraft ?? currentSheet;
    const draft = normalizeCharacterBuilderDraft(rawDraft);
    const audit = auditCharacterBuilderDraft(draft);

    if (!audit.valid) {
      return res.status(400).json({ error: 'Character builder draft is incomplete', audit });
    }

    const builtSheet = buildCharacterSheetFromDraft(draft);

    const now = new Date().toISOString();
    db.prepare('UPDATE characters SET sheet_json = ?, confirmed = ?, updated_at = ? WHERE player_id = ?')
      .run(JSON.stringify(builtSheet), 1, now, player.id);
    publishRoomUpdate(player.roomId);

    const refreshed = getCharacterByPlayerId(db, player.id);
    const character = refreshed ? mapCharacterRow(refreshed) : null;
    res.json({ character });
  });

  router.post('/:token/actions', (req, res) => {
    const input = actionSchema.parse(req.body);
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });
    const room = db.prepare('SELECT id, current_turn as currentTurn, status FROM rooms WHERE id = ?').get(player.roomId) as { id: string; currentTurn: number; status: Room['status'] } | undefined;
    if (!room) return res.status(404).json({ error: 'Room not found' });
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

  return router;
}
