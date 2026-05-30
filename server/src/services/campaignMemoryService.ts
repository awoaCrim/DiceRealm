import type { AppDatabase } from '../db/connection.js';
import type {
  SessionSummary,
  CampaignQuest,
  CampaignNpc,
  CampaignLocation,
} from '../domain/types.js';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// Session Summaries
// ---------------------------------------------------------------------------

interface CreateSessionSummaryInput {
  turnStart: number;
  turnEnd: number;
  summary: string;
  questUpdates?: Array<{
    title: string;
    status: CampaignQuest['status'];
    description: string;
  }>;
  npcUpdates?: Array<{
    name: string;
    role: string;
    attitude: CampaignNpc['attitude'];
    notes: string;
    location: string;
  }>;
  locationUpdates?: Array<{
    name: string;
    description: string;
  }>;
  characterUpdates?: Array<{
    characterId: string;
    update: string;
  }>;
}

export function createSessionSummary(
  db: AppDatabase,
  roomId: string,
  input: CreateSessionSummaryInput,
): SessionSummary {
  const id = nanoid();
  const now = new Date().toISOString();

  const questUpdatesJson = JSON.stringify(input.questUpdates ?? []);
  const npcUpdatesJson = JSON.stringify(input.npcUpdates ?? []);
  const locationUpdatesJson = JSON.stringify(input.locationUpdates ?? []);
  const characterUpdatesJson = JSON.stringify(input.characterUpdates ?? []);

  db.prepare(
    `INSERT INTO session_summaries
       (id, room_id, turn_start, turn_end, summary, quest_updates_json, npc_updates_json, location_updates_json, character_updates_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    roomId,
    input.turnStart,
    input.turnEnd,
    input.summary,
    questUpdatesJson,
    npcUpdatesJson,
    locationUpdatesJson,
    characterUpdatesJson,
    now,
  );

  // Upsert referenced quest/npc/location updates
  for (const qu of input.questUpdates ?? []) {
    upsertCampaignQuest(db, roomId, qu);
  }
  for (const nu of input.npcUpdates ?? []) {
    upsertCampaignNpc(db, roomId, nu);
  }
  for (const lu of input.locationUpdates ?? []) {
    upsertCampaignLocation(db, roomId, lu);
  }

  return {
    id,
    roomId,
    turnStart: input.turnStart,
    turnEnd: input.turnEnd,
    summary: input.summary,
    questUpdatesJson,
    npcUpdatesJson,
    locationUpdatesJson,
    characterUpdatesJson,
    createdAt: now,
  };
}

export function listSessionSummaries(
  db: AppDatabase,
  roomId: string,
  limit = 10,
): SessionSummary[] {
  const rows = db
    .prepare(
      `SELECT id, room_id, turn_start, turn_end, summary,
              quest_updates_json, npc_updates_json, location_updates_json,
              character_updates_json, created_at
       FROM session_summaries
       WHERE room_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(roomId, limit) as Array<{
    id: string;
    room_id: string;
    turn_start: number;
    turn_end: number;
    summary: string;
    quest_updates_json: string;
    npc_updates_json: string;
    location_updates_json: string;
    character_updates_json: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    roomId: row.room_id,
    turnStart: row.turn_start,
    turnEnd: row.turn_end,
    summary: row.summary,
    questUpdatesJson: row.quest_updates_json,
    npcUpdatesJson: row.npc_updates_json,
    locationUpdatesJson: row.location_updates_json,
    characterUpdatesJson: row.character_updates_json,
    createdAt: row.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Campaign Quests
// ---------------------------------------------------------------------------

interface UpsertCampaignQuestInput {
  title: string;
  status: CampaignQuest['status'];
  description: string;
}

export function upsertCampaignQuest(
  db: AppDatabase,
  roomId: string,
  input: UpsertCampaignQuestInput,
): CampaignQuest {
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT id FROM campaign_quests WHERE room_id = ? AND title = ?')
    .get(roomId, input.title) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE campaign_quests SET status = ?, description = ?, updated_at = ? WHERE id = ?`
    ).run(input.status, input.description, now, existing.id);
    return {
      id: existing.id,
      roomId,
      title: input.title,
      status: input.status,
      description: input.description,
      updatedAt: now,
    };
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO campaign_quests (id, room_id, title, status, description, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, roomId, input.title, input.status, input.description, now);
  return {
    id,
    roomId,
    title: input.title,
    status: input.status,
    description: input.description,
    updatedAt: now,
  };
}

export function listCampaignQuests(db: AppDatabase, roomId: string): CampaignQuest[] {
  const rows = db
    .prepare(
      `SELECT id, room_id, title, status, description, updated_at
       FROM campaign_quests
       WHERE room_id = ?
       ORDER BY updated_at DESC`
    )
    .all(roomId) as Array<{
    id: string;
    room_id: string;
    title: string;
    status: string;
    description: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    status: row.status as CampaignQuest['status'],
    description: row.description,
    updatedAt: row.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// Campaign NPCs
// ---------------------------------------------------------------------------

interface UpsertCampaignNpcInput {
  name: string;
  role: string;
  attitude: CampaignNpc['attitude'];
  notes: string;
  location: string;
}

export function upsertCampaignNpc(
  db: AppDatabase,
  roomId: string,
  input: UpsertCampaignNpcInput,
): CampaignNpc {
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT id FROM campaign_npcs WHERE room_id = ? AND name = ?')
    .get(roomId, input.name) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE campaign_npcs SET role = ?, attitude = ?, notes = ?, location = ?, updated_at = ? WHERE id = ?`
    ).run(input.role, input.attitude, input.notes, input.location, now, existing.id);
    return {
      id: existing.id,
      roomId,
      name: input.name,
      role: input.role,
      attitude: input.attitude,
      notes: input.notes,
      location: input.location,
      updatedAt: now,
    };
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO campaign_npcs (id, room_id, name, role, attitude, notes, location, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, roomId, input.name, input.role, input.attitude, input.notes, input.location, now);
  return {
    id,
    roomId,
    name: input.name,
    role: input.role,
    attitude: input.attitude,
    notes: input.notes,
    location: input.location,
    updatedAt: now,
  };
}

export function listCampaignNpcs(db: AppDatabase, roomId: string): CampaignNpc[] {
  const rows = db
    .prepare(
      `SELECT id, room_id, name, role, attitude, notes, location, updated_at
       FROM campaign_npcs
       WHERE room_id = ?
       ORDER BY updated_at DESC`
    )
    .all(roomId) as Array<{
    id: string;
    room_id: string;
    name: string;
    role: string;
    attitude: string;
    notes: string;
    location: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    roomId: row.room_id,
    name: row.name,
    role: row.role,
    attitude: row.attitude as CampaignNpc['attitude'],
    notes: row.notes,
    location: row.location,
    updatedAt: row.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// Campaign Locations
// ---------------------------------------------------------------------------

interface UpsertCampaignLocationInput {
  name: string;
  description: string;
}

export function upsertCampaignLocation(
  db: AppDatabase,
  roomId: string,
  input: UpsertCampaignLocationInput,
): CampaignLocation {
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT id FROM campaign_locations WHERE room_id = ? AND name = ?')
    .get(roomId, input.name) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE campaign_locations SET description = ?, updated_at = ? WHERE id = ?`
    ).run(input.description, now, existing.id);
    return {
      id: existing.id,
      roomId,
      name: input.name,
      description: input.description,
      notes: '',
      updatedAt: now,
    };
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO campaign_locations (id, room_id, name, description, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, roomId, input.name, input.description, '', now);
  return {
    id,
    roomId,
    name: input.name,
    description: input.description,
    notes: '',
    updatedAt: now,
  };
}

export function listCampaignLocations(db: AppDatabase, roomId: string): CampaignLocation[] {
  const rows = db
    .prepare(
      `SELECT id, room_id, name, description, notes, updated_at
       FROM campaign_locations
       WHERE room_id = ?
       ORDER BY updated_at DESC`
    )
    .all(roomId) as Array<{
    id: string;
    room_id: string;
    name: string;
    description: string;
    notes: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    roomId: row.room_id,
    name: row.name,
    description: row.description,
    notes: row.notes,
    updatedAt: row.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// Campaign Context
// ---------------------------------------------------------------------------

export function buildCampaignContext(db: AppDatabase, roomId: string): string {
  const summaries = listSessionSummaries(db, roomId, 1);
  const quests = listCampaignQuests(db, roomId);
  const npcs = listCampaignNpcs(db, roomId);
  const locations = listCampaignLocations(db, roomId);

  const parts: string[] = [];

  // Header
  parts.push('# 战役记忆');

  // Latest summary
  if (summaries.length > 0) {
    parts.push('## 最近事件');
    parts.push(summaries[0].summary);
  }

  // Active/in-progress quests
  const activeQuests = quests.filter(
    (q) => q.status === 'active' || q.status === 'in_progress'
  );
  if (activeQuests.length > 0) {
    parts.push('## 进行中任务');
    for (const q of activeQuests) {
      parts.push(`- ${q.title} [${q.status}]: ${q.description}`);
    }
  }

  // Known NPCs
  if (npcs.length > 0) {
    parts.push('## 已知 NPC');
    for (const n of npcs) {
      parts.push(`- ${n.name} (${n.role}, ${n.attitude}): ${n.notes} [${n.location}]`);
    }
  }

  // Explored locations
  if (locations.length > 0) {
    parts.push('## 已探索地点');
    for (const l of locations) {
      parts.push(`- ${l.name}: ${l.description}`);
    }
  }

  return parts.join('\n');
}
