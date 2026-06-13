import type { AppDatabase } from '../db/connection.js';
import type { Player, PlayerAction, Room, Turn } from '../domain/types.js';

export interface TurnReadiness {
  turnId: string | null;
  roomStatus: Room['status'] | null;
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

function roomRequiresConfirmedActors(db: AppDatabase, roomId: string): boolean {
  const room = db.prepare('SELECT expected_player_count as expectedPlayerCount FROM rooms WHERE id = ?')
    .get(roomId) as { expectedPlayerCount: number | null } | undefined;
  if (!room?.expectedPlayerCount) return false;
  const playerCount = db.prepare('SELECT COUNT(*) as count FROM players WHERE room_id = ?')
    .get(roomId) as { count: number };
  return playerCount.count >= room.expectedPlayerCount;
}

function requiredActorsForCurrentScene(db: AppDatabase, roomId: string): string[] {
  const players = db.prepare('SELECT id FROM players WHERE room_id = ? ORDER BY created_at ASC').all(roomId) as Array<{ id: string }>;
  return players.map((player) => player.id);
}

function submittedActorsForTurn(db: AppDatabase, turnId: string, requireConfirmedActors: boolean): string[] {
  const actions = requireConfirmedActors
    ? db.prepare(`
        SELECT a.player_id as playerId
        FROM actions a
        JOIN characters c ON c.player_id = a.player_id AND c.confirmed = 1
        WHERE a.turn_id = ?
          AND a.status = ?
          AND COALESCE(a.action_type, '') NOT IN ('skip')
      `).all(turnId, 'submitted') as Pick<PlayerAction, 'playerId'>[]
    : db.prepare(`
        SELECT player_id as playerId
        FROM actions
        WHERE turn_id = ?
          AND status = ?
          AND COALESCE(action_type, '') NOT IN ('skip')
      `).all(turnId, 'submitted') as Pick<PlayerAction, 'playerId'>[];
  return actions.map((action) => action.playerId);
}

function skippedActorsForTurn(db: AppDatabase, turnId: string, requireConfirmedActors: boolean): string[] {
  const actions = requireConfirmedActors
    ? db.prepare(`
        SELECT a.player_id as playerId
        FROM actions a
        JOIN characters c ON c.player_id = a.player_id AND c.confirmed = 1
        WHERE a.turn_id = ?
          AND a.status = ?
          AND a.action_type = 'skip'
      `).all(turnId, 'submitted') as Pick<PlayerAction, 'playerId'>[]
    : db.prepare(`
        SELECT player_id as playerId
        FROM actions
        WHERE turn_id = ?
          AND status = ?
          AND action_type = 'skip'
      `).all(turnId, 'submitted') as Pick<PlayerAction, 'playerId'>[];
  return actions.map((action) => action.playerId);
}

function confirmedActorIdsForRoom(db: AppDatabase, roomId: string): Set<string> {
  const rows = db.prepare(`
    SELECT p.id
    FROM players p
    JOIN characters c ON c.player_id = p.id AND c.confirmed = 1
    WHERE p.room_id = ?
  `).all(roomId) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function roomStatusForRoom(db: AppDatabase, roomId: string): Room['status'] | null {
  return (db.prepare('SELECT status FROM rooms WHERE id = ?').get(roomId) as { status: Room['status'] } | undefined)?.status ?? null;
}

function buildReadiness(roomStatus: Room['status'] | null, turn: Turn | null, requiredActorIds: string[], submittedActorIds: string[], skippedActorIds: string[], excludedActorIds: string[]): TurnReadiness {
  const required = unique(requiredActorIds);
  const submitted = unique(submittedActorIds);
  const skipped = unique(skippedActorIds);
  const excluded = unique(excludedActorIds);
  const completed = unique([...submitted, ...skipped, ...excluded]);
  const completedSet = new Set(completed);
  const missing = required.filter((id) => !completedSet.has(id));
  return {
    turnId: turn?.id ?? null,
    roomStatus,
    status: turn?.status ?? null,
    requiredActorIds: required,
    submittedActorIds: submitted,
    skippedActorIds: skipped,
    excludedActorIds: excluded,
    completedActorIds: completed,
    missingActorIds: missing,
    ready: required.length > 0 && missing.length === 0 && turn?.status === 'ready_to_resolve' && roomStatus === 'ready_to_resolve'
  };
}

export function getTurnReadiness(db: AppDatabase, room: Pick<Room, 'id' | 'currentTurn'> & Partial<Pick<Room, 'status'>>, options: { updateStatus?: boolean } = {}): TurnReadiness {
  const updateStatus = options.updateStatus ?? true;
  const turn = currentTurn(db, room);
  let roomStatus = room.status ?? roomStatusForRoom(db, room.id);
  if (!turn) return buildReadiness(roomStatus, null, [], [], [], []);

  const row = db.prepare(`
    SELECT required_actor_ids_json as requiredActorIdsJson,
      skipped_actor_ids_json as skippedActorIdsJson,
      excluded_actor_ids_json as excludedActorIdsJson
    FROM turns
    WHERE id = ?
  `).get(turn.id) as { requiredActorIdsJson?: string; skippedActorIdsJson?: string; excludedActorIdsJson?: string } | undefined;

  const configuredRequired = parseStringArray(row?.requiredActorIdsJson);
  const currentSceneRequired = requiredActorsForCurrentScene(db, room.id);
  const required = unique([...currentSceneRequired, ...configuredRequired]);
  const requireConfirmedActors = roomRequiresConfirmedActors(db, room.id);
  const submitted = submittedActorsForTurn(db, turn.id, requireConfirmedActors);
  const confirmedActorIds = requireConfirmedActors ? confirmedActorIdsForRoom(db, room.id) : null;
  const configuredSkipped = parseStringArray(row?.skippedActorIdsJson)
    .filter((id) => !confirmedActorIds || confirmedActorIds.has(id));
  const skipped = unique([...configuredSkipped, ...skippedActorsForTurn(db, turn.id, requireConfirmedActors)]);
  const excluded = parseStringArray(row?.excludedActorIdsJson);
  const completedSet = new Set(unique([...submitted, ...skipped, ...excluded]));
  const readyByActors = required.length > 0 && required.every((id) => completedSet.has(id));

  if (updateStatus && (turn.status === 'open' || turn.status === 'waiting_for_actions' || turn.status === 'ready_to_resolve')) {
    const nextStatus = readyByActors ? 'ready_to_resolve' : 'open';
    const nextRoomStatus: Room['status'] = readyByActors ? 'ready_to_resolve' : 'waiting_for_actions';
    if (turn.status !== nextStatus || JSON.stringify(required) !== row?.requiredActorIdsJson) {
      db.prepare(`
        UPDATE turns
        SET required_actor_ids_json = ?, submitted_actor_ids_json = ?, skipped_actor_ids_json = ?, excluded_actor_ids_json = ?, status = ?
        WHERE id = ?
      `).run(JSON.stringify(required), JSON.stringify(unique(submitted)), JSON.stringify(skipped), JSON.stringify(excluded), nextStatus, turn.id);
      turn.status = nextStatus as Turn['status'];
    }
    if (roomStatus !== nextRoomStatus) {
      db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run(nextRoomStatus, room.id);
      roomStatus = nextRoomStatus;
    }
  }

  return buildReadiness(roomStatus, turn, required, submitted, skipped, excluded);
}

export function assertTurnReadyForAi(db: AppDatabase, room: Pick<Room, 'id' | 'currentTurn'>): TurnReadiness {
  const currentRoomStatus = roomStatusForRoom(db, room.id);
  const readiness = getTurnReadiness(db, { ...room, status: currentRoomStatus ?? undefined }, { updateStatus: false });
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
