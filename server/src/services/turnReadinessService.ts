import type { AppDatabase } from '../db/connection.js';
import type { Player, PlayerAction, Room, Turn } from '../domain/types.js';

export interface TurnReadiness {
  turnId: string | null;
  status: Turn['status'] | null;
  requiredActorIds: string[];
  submittedActorIds: string[];
  skippedActorIds: string[];
  excludedActorIds: string[];
  completedActorIds: string[];
  missingActorIds: string[];
  ready: boolean;
}

export class TurnNotReadyError extends Error {
  constructor(readonly readiness: TurnReadiness) {
    super('TURN_NOT_READY');
  }
}

export class StaleTurnPreviewError extends Error {
  constructor(readonly currentTurnId: string | null) {
    super('STALE_PROMPT_PREVIEW');
  }
}

function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function currentTurn(db: AppDatabase, room: Pick<Room, 'id' | 'currentTurn'>): Turn | null {
  return db.prepare('SELECT id, room_id as roomId, number, status, started_at as startedAt, ended_at as endedAt FROM turns WHERE room_id = ? AND number = ?')
    .get(room.id, room.currentTurn) as Turn | undefined ?? null;
}

function requiredActorsForCurrentScene(db: AppDatabase, roomId: string): string[] {
  const players = db.prepare('SELECT id FROM players WHERE room_id = ? ORDER BY created_at ASC').all(roomId) as Array<{ id: string }>;
  return players.map((player) => player.id);
}

function submittedActorsForTurn(db: AppDatabase, turnId: string): string[] {
  const actions = db.prepare('SELECT player_id as playerId FROM actions WHERE turn_id = ? AND status = ?').all(turnId, 'submitted') as Pick<PlayerAction, 'playerId'>[];
  return actions.map((action) => action.playerId);
}

function buildReadiness(turn: Turn | null, requiredActorIds: string[], submittedActorIds: string[], skippedActorIds: string[], excludedActorIds: string[]): TurnReadiness {
  const required = unique(requiredActorIds);
  const submitted = unique(submittedActorIds);
  const skipped = unique(skippedActorIds);
  const excluded = unique(excludedActorIds);
  const completed = unique([...submitted, ...skipped, ...excluded]);
  const completedSet = new Set(completed);
  const missing = required.filter((id) => !completedSet.has(id));
  return {
    turnId: turn?.id ?? null,
    status: turn?.status ?? null,
    requiredActorIds: required,
    submittedActorIds: submitted,
    skippedActorIds: skipped,
    excludedActorIds: excluded,
    completedActorIds: completed,
    missingActorIds: missing,
    ready: required.length > 0 && missing.length === 0 && turn?.status === 'ready_to_resolve'
  };
}

export function getTurnReadiness(db: AppDatabase, room: Pick<Room, 'id' | 'currentTurn'>): TurnReadiness {
  const turn = currentTurn(db, room);
  if (!turn) return buildReadiness(null, [], [], [], []);

  const row = db.prepare(`
    SELECT required_actor_ids_json as requiredActorIdsJson,
      skipped_actor_ids_json as skippedActorIdsJson,
      excluded_actor_ids_json as excludedActorIdsJson
    FROM turns
    WHERE id = ?
  `).get(turn.id) as { requiredActorIdsJson?: string; skippedActorIdsJson?: string; excludedActorIdsJson?: string } | undefined;

  const required = requiredActorsForCurrentScene(db, room.id);
  const submitted = submittedActorsForTurn(db, turn.id);
  const skipped = parseStringArray(row?.skippedActorIdsJson);
  const excluded = parseStringArray(row?.excludedActorIdsJson);
  const completedSet = new Set(unique([...submitted, ...skipped, ...excluded]));
  const readyByActors = required.length > 0 && required.every((id) => completedSet.has(id));

  if (turn.status === 'open' || turn.status === 'waiting_for_actions' || turn.status === 'ready_to_resolve') {
    const nextStatus = readyByActors ? 'ready_to_resolve' : 'open';
    if (turn.status !== nextStatus || JSON.stringify(required) !== row?.requiredActorIdsJson) {
      db.prepare(`
        UPDATE turns
        SET required_actor_ids_json = ?, submitted_actor_ids_json = ?, skipped_actor_ids_json = ?, excluded_actor_ids_json = ?, status = ?
        WHERE id = ?
      `).run(JSON.stringify(required), JSON.stringify(unique(submitted)), JSON.stringify(skipped), JSON.stringify(excluded), nextStatus, turn.id);
      turn.status = nextStatus as Turn['status'];
    }
  }

  return buildReadiness(turn, required, submitted, skipped, excluded);
}

export function assertTurnReadyForAi(db: AppDatabase, room: Pick<Room, 'id' | 'currentTurn'>): TurnReadiness {
  const readiness = getTurnReadiness(db, room);
  if (!readiness.ready) {
    throw new TurnNotReadyError(readiness);
  }
  return readiness;
}

export function assertPreviewMatchesCurrentReadyTurn(db: AppDatabase, room: Pick<Room, 'id' | 'currentTurn'>, previewTurnId: string | null): TurnReadiness {
  const readiness = assertTurnReadyForAi(db, room);
  if (!readiness.turnId || readiness.turnId !== previewTurnId) {
    throw new StaleTurnPreviewError(readiness.turnId);
  }
  return readiness;
}

export function turnNotReadyPayload(readiness: TurnReadiness) {
  return {
    error: 'TURN_NOT_READY',
    message: '还有玩家未提交行动，不能生成 AI 提示词。',
    requiredActorIds: readiness.requiredActorIds,
    completedActorIds: readiness.completedActorIds,
    missingActorIds: readiness.missingActorIds
  };
}

export function playerNamesById(players: Player[]): Map<string, string> {
  return new Map(players.map((player) => [player.id, player.name]));
}
