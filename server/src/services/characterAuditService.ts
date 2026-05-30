import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';

// --- types ---

export interface CharacterResourceChangeRecord {
  id: string;
  roomId: string;
  characterId: string;
  actorType: string;
  actorId: string;
  changeType: string;
  path: string;
  beforeJson: string;
  afterJson: string;
  reason: string;
  ruleRefsJson: string;
  createdAt: string;
  revertedAt: string | null;
  revertedBy: string | null;
}

interface RecordChangeParams {
  roomId: string;
  characterId: string;
  actorType: string;
  actorId: string;
  changeType: string;
  path: string;
  before: unknown;
  after: unknown;
  reason: string;
  ruleRefs: string[];
}

interface ListOptions {
  characterId?: string;
  limit?: number;
}

// --- helpers ---

function dbRowToRecord(row: Record<string, unknown>): CharacterResourceChangeRecord {
  return {
    id: row.id as string,
    roomId: row.room_id as string,
    characterId: row.character_id as string,
    actorType: row.actor_type as string,
    actorId: row.actor_id as string,
    changeType: row.change_type as string,
    path: row.path as string,
    beforeJson: row.before_json as string,
    afterJson: row.after_json as string,
    reason: row.reason as string,
    ruleRefsJson: row.rule_refs_json as string,
    createdAt: row.created_at as string,
    revertedAt: (row.reverted_at as string) || null,
    revertedBy: (row.reverted_by as string) || null,
  };
}

function getAtPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      if (isNaN(idx)) return undefined;
      current = (current as Array<unknown>)[idx];
    } else {
      return undefined;
    }
  }
  return current;
}

function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    const nextIsIndex = /^\d+$/.test(nextPart);

    if (current[part] === undefined || current[part] === null) {
      current[part] = nextIsIndex ? [] : {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

// --- public API ---

export function recordResourceChange(db: AppDatabase, params: RecordChangeParams): string {
  const id = nanoid();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO character_resource_changes
     (id, room_id, character_id, actor_type, actor_id, change_type, path, before_json, after_json, reason, rule_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.roomId,
    params.characterId,
    params.actorType,
    params.actorId,
    params.changeType,
    params.path,
    JSON.stringify(params.before),
    JSON.stringify(params.after),
    params.reason || '',
    JSON.stringify(params.ruleRefs || []),
    now
  );

  return id;
}

export function listCharacterResourceChanges(
  db: AppDatabase,
  roomId: string,
  options: ListOptions = {}
): CharacterResourceChangeRecord[] {
  const limit = options.limit ?? 20;

  let sql: string;
  let rows: unknown[];

  if (options.characterId) {
    sql = `SELECT * FROM character_resource_changes
           WHERE room_id = ? AND character_id = ?
           ORDER BY created_at DESC
           LIMIT ?`;
    rows = db.prepare(sql).all(roomId, options.characterId, limit);
  } else {
    sql = `SELECT * FROM character_resource_changes
           WHERE room_id = ?
           ORDER BY created_at DESC
           LIMIT ?`;
    rows = db.prepare(sql).all(roomId, limit);
  }

  return (rows as Record<string, unknown>[]).map(dbRowToRecord);
}

export function rollbackResourceChange(
  db: AppDatabase,
  changeId: string,
  revertedBy: string
): CharacterResourceChangeRecord {
  // Verify change exists
  const changeRow = db.prepare(
    'SELECT * FROM character_resource_changes WHERE id = ?'
  ).get(changeId) as Record<string, unknown> | undefined;

  if (!changeRow) {
    throw new Error(`Change not found: ${changeId}`);
  }

  if (changeRow.reverted_at) {
    throw new Error(`Change already reverted: ${changeId}`);
  }

  // Load character sheet
  const charRow = db.prepare(
    'SELECT sheet_json FROM characters WHERE id = ?'
  ).get(changeRow.character_id as string) as { sheet_json: string } | undefined;

  if (!charRow) {
    throw new Error(`Character not found: ${changeRow.character_id}`);
  }

  const sheet = JSON.parse(charRow.sheet_json) as Record<string, unknown>;
  const resources = sheet.resources as Record<string, unknown> | undefined;

  if (!resources) {
    throw new Error(`Character has no resources: ${changeRow.character_id}`);
  }

  // Restore the before value
  const beforeValue = JSON.parse(changeRow.before_json as string);
  const path = changeRow.path as string;
  setAtPath(resources, path, beforeValue);

  const now = new Date().toISOString();

  // Execute in transaction
  const txn = db.transaction(() => {
    db.prepare(
      'UPDATE characters SET sheet_json = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(sheet), now, changeRow.character_id as string);

    db.prepare(
      'UPDATE character_resource_changes SET reverted_at = ?, reverted_by = ? WHERE id = ?'
    ).run(now, revertedBy, changeId);
  });

  txn();

  // Return updated change record
  const updated = db.prepare(
    'SELECT * FROM character_resource_changes WHERE id = ?'
  ).get(changeId) as Record<string, unknown>;

  return dbRowToRecord(updated);
}
