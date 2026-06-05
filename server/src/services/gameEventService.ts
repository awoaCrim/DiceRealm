import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { GameEvent } from '../domain/types.js';

export function persistGameEvents(db: AppDatabase, events: GameEvent[]): GameEvent[] {
  if (events.length === 0) return [];

  const persisted: GameEvent[] = [];
  const sequenceByKey = new Map<string, number>();
  const nextSequence = (roomId: string, turnId: string | null): number => {
    const key = `${roomId}:${turnId ?? ''}`;
    const cached = sequenceByKey.get(key);
    if (cached !== undefined) {
      const next = cached + 1;
      sequenceByKey.set(key, next);
      return next;
    }
    const row = db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) as maxSequence
      FROM game_events
      WHERE room_id = ? AND ((turn_id IS NULL AND ? IS NULL) OR turn_id = ?)
    `).get(roomId, turnId, turnId) as { maxSequence: number };
    const next = row.maxSequence + 1;
    sequenceByKey.set(key, next);
    return next;
  };

  for (const event of events) {
    const sequence = event.sequence ?? nextSequence(event.roomId, event.turnId);
    const persistedEvent = { ...event, id: event.id || nanoid(), sequence };
    db.prepare(`
      INSERT INTO game_events (
        id, room_id, turn_id, sequence, event_type, visibility_scope, player_id,
        actor_id, payload_json, causality_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      persistedEvent.id,
      persistedEvent.roomId,
      persistedEvent.turnId,
      sequence,
      persistedEvent.eventType,
      persistedEvent.visibilityScope,
      persistedEvent.playerId,
      persistedEvent.actorId,
      JSON.stringify(persistedEvent.payload),
      persistedEvent.causalityId,
      persistedEvent.createdAt
    );
    persisted.push(persistedEvent);
  }

  return persisted;
}
