import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { AiTurnResult, GameEvent, Player, PlayerAction, Room, RuleRetrievalMatch, Turn, TurnResolutionRun } from '../domain/types.js';
import { validateAiTurnResultLengthWarnings } from './aiProvider.js';
import type { NarrativeLengthLimits } from './aiContextBuilder.js';
import { applyResourcePatch, validateResourcePatch } from './characterResourceService.js';
import { applyPluginDatabaseChange } from './remoteDbRuntimeService.js';
import { storeRuleContextHits } from './ruleRetrievalService.js';
import {
  applyResolutionRunToAiTurnResult,
  collectDiceRequestRoutingWarnings,
  createInteractionCreatedEvent,
  createPluginDbChangeAppliedEvent,
  createResourcePatchEvent,
  createTurnLogMaterializedEvent,
  markTurnResolutionRunApplied
} from './turnResolutionService.js';
import { persistGameEvents } from './gameEventService.js';
import { syncCombatStateFromAiTurnResult } from './combatStateSyncService.js';

export interface MaterializeAiTurnInput {
  room: Room;
  turn: Turn;
  players: Player[];
  actions: PlayerAction[];
  result: AiTurnResult;
  resolutionRun: TurnResolutionRun;
  providerName: string;
  inputSummary: string;
  ruleMatches: RuleRetrievalMatch[];
  narrativeLengthLimits?: NarrativeLengthLimits;
}

export function normalizeSuggestedStateChanges(result: AiTurnResult): unknown[] {
  return [
    ...(result.suggestedStateChanges ?? []).map((change) => ({ type: 'suggested_state_change', ...change })),
    ...(result.characterResourceChanges ?? []).map((change) => ({ type: 'character_resource_change', ...change })),
    ...(result.diceRequests ?? []).map((request) => {
      const { type, ...rest } = request;
      return { type: 'dice_request', requestType: type, ...rest };
    }),
    ...(result.interactionRequests ?? []).map((request) => {
      const { type, ...rest } = request;
      return { type: 'interaction_request', interactionType: type, ...rest };
    })
  ];
}

export function collectPrivateUpdateRoutingWarnings(players: Player[], updates: Record<string, string>): string[] {
  const playerIds = new Set(players.map((player) => player.id));
  return Object.keys(updates)
    .filter((key) => key.trim() && !playerIds.has(key.trim()))
    .map((key) => `privateUpdatesByPlayer.${key} 未使用有效 playerId，已忽略。`);
}

function normalizePrivateUpdatesByPlayer(players: Player[], updates: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  const playerIds = new Set(players.map((player) => player.id));
  for (const [rawPlayerRef, content] of Object.entries(updates)) {
    const playerId = rawPlayerRef.trim();
    if (!playerIds.has(playerId) || !content.trim()) continue;
    normalized[playerId] = normalized[playerId] ? `${normalized[playerId]}\n${content}` : content;
  }
  return normalized;
}

export function collectInteractionRoutingWarnings(players: Player[], interactions: AiTurnResult['interactionRequests']): string[] {
  const playerIds = new Set(players.map((player) => player.id));
  const warnings: string[] = [];
  interactions.forEach((interaction, index) => {
    const source = interaction.sourcePlayerId.trim();
    const target = interaction.targetPlayerId.trim();
    if (!playerIds.has(source)) warnings.push(`interactionRequests[${index}].sourcePlayerId 未使用有效 playerId，已忽略该互动请求。`);
    if (!playerIds.has(target)) warnings.push(`interactionRequests[${index}].targetPlayerId 未使用有效 playerId，已忽略该互动请求。`);
  });
  return warnings;
}

export function collectResourcePatchPreflightErrors(
  db: AppDatabase,
  roomId: string,
  changes: AiTurnResult['characterResourceChanges'] = []
): string[] {
  const errors: string[] = [];
  for (const [index, change] of changes.entries()) {
    const charRow = db.prepare(
      'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE c.id = ? AND p.room_id = ?'
    ).get(change.characterId, roomId) as { id: string } | undefined;

    if (!charRow) {
      errors.push(`characterResourceChanges[${index}] invalid characterId '${change.characterId}': not found in room`);
      continue;
    }

    try {
      validateResourcePatch(db, change);
    } catch (err) {
      errors.push(`characterResourceChanges[${index}] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return errors;
}

function normalizeInteractionRequests(players: Player[], interactions: AiTurnResult['interactionRequests']): AiTurnResult['interactionRequests'] {
  const playerIds = new Set(players.map((player) => player.id));
  return interactions
    .map((interaction) => ({
      ...interaction,
      sourcePlayerId: interaction.sourcePlayerId.trim(),
      targetPlayerId: interaction.targetPlayerId.trim(),
      prompt: interaction.prompt.trim()
    }))
    .filter((interaction) => (
      playerIds.has(interaction.sourcePlayerId)
      && playerIds.has(interaction.targetPlayerId)
      && interaction.prompt.length > 0
    ));
}

function ensureObjectiveLog(result: AiTurnResult): void {
  if (!result.objectiveLog || !result.objectiveLog.trim()) {
    result.objectiveLog = result.publicLog;
  }
}

export function isNativeCombatStatePluginDatabaseChange(change: unknown): boolean {
  if (!change || typeof change !== 'object' || Array.isArray(change)) return false;
  const record = change as Record<string, unknown>;
  const changeType = String(record.changeType ?? record.type ?? '');
  if (changeType !== 'database_row_upsert' && changeType !== 'database_row_delete') return false;

  const targetId = [
    record.targetId,
    record.target,
    record.sheetId
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim().toLowerCase() ?? '';

  return targetId === 'combat_state'
    || targetId === 'sheet:combat_state'
    || targetId.endsWith('/combat_state')
    || targetId.includes('sheet:combat_state/');
}

function applyPluginDatabaseChangesFromAiResult(
  db: AppDatabase,
  roomId: string,
  turnId: string,
  result: AiTurnResult,
  errors: string[],
  createdAt: string
): GameEvent[] {
  const events: GameEvent[] = [];
  for (const change of result.suggestedStateChanges ?? []) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) continue;
    if (isNativeCombatStatePluginDatabaseChange(change)) continue;
    try {
      const outcome = applyPluginDatabaseChange(db, roomId, change);
      if (!outcome.applied && outcome.message) errors.push(outcome.message);
      if (outcome.applied) {
        events.push(createPluginDbChangeAppliedEvent(roomId, turnId, { change }, createdAt));
      }
    } catch (err) {
      errors.push(`Failed to apply plugin database change: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return events;
}

export function materializeAiTurnResult(db: AppDatabase, input: MaterializeAiTurnInput): { nextTurnId: string; resourceErrors: string[]; warnings: string[] } {
  const { room, turn, players, actions, result, resolutionRun, providerName, inputSummary, ruleMatches, narrativeLengthLimits } = input;
  ensureObjectiveLog(result);
  applyResolutionRunToAiTurnResult(db, result, resolutionRun);
  const resourcePreflightErrors = collectResourcePatchPreflightErrors(db, room.id, result.characterResourceChanges);
  if (resourcePreflightErrors.length > 0) {
    throw new Error(resourcePreflightErrors.join('\n'));
  }
  const privateUpdateRoutingWarnings = collectPrivateUpdateRoutingWarnings(players, result.privateUpdatesByPlayer);
  const interactionRoutingWarnings = collectInteractionRoutingWarnings(players, result.interactionRequests);
  const diceRequestRoutingWarnings = collectDiceRequestRoutingWarnings(db, room.id, result.diceRequests ?? []);
  result.privateUpdatesByPlayer = normalizePrivateUpdatesByPlayer(players, result.privateUpdatesByPlayer);
  result.interactionRequests = normalizeInteractionRequests(players, result.interactionRequests);
  const warnings = [
    ...validateAiTurnResultLengthWarnings(result, narrativeLengthLimits),
    ...privateUpdateRoutingWarnings,
    ...interactionRoutingWarnings,
    ...diceRequestRoutingWarnings
  ];

  const now = new Date().toISOString();
  const hasPendingInteractions = (result.interactionRequests ?? []).length > 0;
  const nextTurnId = hasPendingInteractions ? turn.id : nanoid();
  const resourceErrors: string[] = [];
  const appliedEvents: GameEvent[] = [...resolutionRun.events];
  const tx = db.transaction(() => {
    storeRuleContextHits(db, { roomId: room.id, turnId: turn.id, matches: ruleMatches });

    if (result.diceResults && result.diceResults.length > 0) {
      for (const diceLog of result.diceResults) {
        db.prepare(
          'INSERT INTO dice_logs (id, room_id, turn_id, combat_id, character_id, dice_type, values_json, modifier, total, dc, success, is_public, reason, public_reason, objective_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          diceLog.id, diceLog.roomId, diceLog.turnId, diceLog.combatId, diceLog.characterId,
          diceLog.diceType, JSON.stringify(diceLog.values), diceLog.modifier, diceLog.total,
          diceLog.dc, diceLog.success === null ? null : (diceLog.success ? 1 : 0),
          diceLog.isPublic ? 1 : 0, diceLog.reason, diceLog.publicReason ?? diceLog.reason, diceLog.objectiveReason ?? diceLog.reason, diceLog.timestamp
        );
      }
    }

    db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(nanoid(), room.id, turn.id, 'objective', null, `客观回合 ${room.currentTurn}`, result.objectiveLog ?? result.publicLog, now);
    db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(nanoid(), room.id, turn.id, 'public', null, `第 ${room.currentTurn} 回合`, result.publicLog, now);
    appliedEvents.push(createTurnLogMaterializedEvent(room.id, turn.id, {
      objectiveLog: result.objectiveLog ?? result.publicLog,
      publicLog: result.publicLog,
      privateUpdatePlayerIds: Object.keys(result.privateUpdatesByPlayer)
    }, now));
    for (const [playerId, content] of Object.entries(result.privateUpdatesByPlayer)) {
      db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nanoid(), room.id, turn.id, 'private', playerId, `私人回合 ${room.currentTurn}`, content, now);
    }
    for (const interaction of result.interactionRequests) {
      const interactionId = nanoid();
      db.prepare('INSERT INTO interaction_requests (id, room_id, turn_id, source_player_id, target_player_id, type, prompt, target_response, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(interactionId, room.id, turn.id, interaction.sourcePlayerId, interaction.targetPlayerId, interaction.type, interaction.prompt, null, 'pending_target', now);
      appliedEvents.push(createInteractionCreatedEvent(room.id, turn.id, interaction.targetPlayerId, {
        interactionId,
        sourcePlayerId: interaction.sourcePlayerId,
        targetPlayerId: interaction.targetPlayerId,
        type: interaction.type,
        prompt: interaction.prompt
      }, now));
    }
    db.prepare('UPDATE interaction_requests SET status = ? WHERE room_id = ? AND turn_id = ? AND status = ?')
      .run('resolved', room.id, turn.id, 'ready_for_ai');
    if (hasPendingInteractions) {
      db.prepare('UPDATE turns SET status = ?, ended_at = ? WHERE id = ?').run('waiting_for_interaction', null, turn.id);
      db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('waiting_for_interaction', room.id);
    } else {
      db.prepare('UPDATE turns SET status = ?, ended_at = ? WHERE id = ?').run('complete', now, turn.id);
      db.prepare('UPDATE actions SET status = ? WHERE turn_id = ?').run('complete', turn.id);
      db.prepare('INSERT INTO turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)').run(nextTurnId, room.id, room.currentTurn + 1, 'open', now, null);
      db.prepare('UPDATE rooms SET current_turn = ?, status = ? WHERE id = ?').run(room.currentTurn + 1, 'waiting_for_actions', room.id);
    }

    if (result.characterResourceChanges && result.characterResourceChanges.length > 0) {
      for (const change of result.characterResourceChanges) {
        const charRow = db.prepare(
          'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE c.id = ? AND p.room_id = ?'
        ).get(change.characterId, room.id) as { id: string } | undefined;

        if (!charRow) {
          const message = `Invalid characterId '${change.characterId}': not found in room`;
          resourceErrors.push(message);
          appliedEvents.push(createResourcePatchEvent(room.id, turn.id, false, { change, error: message }, now));
          continue;
        }

        try {
          applyResourcePatch(db, room.id, {
            characterId: change.characterId,
            path: change.path,
            before: change.before,
            after: change.after,
            reason: change.reason,
            ruleRefs: change.ruleRefs,
          }, 'ai_dm', 'ai');
          appliedEvents.push(createResourcePatchEvent(room.id, turn.id, true, { change }, now));
        } catch (err) {
          const message = `Failed to apply resource change for ${change.characterId}: ${err instanceof Error ? err.message : String(err)}`;
          resourceErrors.push(message);
          appliedEvents.push(createResourcePatchEvent(room.id, turn.id, false, { change, error: message }, now));
        }
      }
    }

    appliedEvents.push(...applyPluginDatabaseChangesFromAiResult(db, room.id, turn.id, result, resourceErrors, now));
    if (resourceErrors.length > 0) {
      throw new Error(resourceErrors.join('\n'));
    }
    appliedEvents.push(...syncCombatStateFromAiTurnResult(db, { room, turn, players, result, resolutionRun, createdAt: now }));
    persistGameEvents(db, appliedEvents);
    markTurnResolutionRunApplied(db, resolutionRun.id, now);

    const generationIssues = [...warnings, ...resourceErrors];
    const generationError = generationIssues.length > 0 ? generationIssues.join('\n') : null;
    db.prepare('INSERT INTO ai_generations (id, room_id, turn_id, provider, input_summary, output, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(nanoid(), room.id, turn.id, providerName, inputSummary, JSON.stringify(result), generationError, now);
  });
  tx();

  return { nextTurnId, resourceErrors, warnings };
}
