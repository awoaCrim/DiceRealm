import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

/**
 * Legacy sentinel helper（Task 0 抽取）：在 enrollment/cutover temp copy 前后捕获
 * legacy DDL/rows 快照，验证 Phase 2 的 offline 流程绝不改动 legacy 数据。
 *
 * 与 legacy db/schema.ts 一致的 legacy 表 DDL 子集（sentinel 不 import legacy schema）。
 */
export const LEGACY_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    summary_json TEXT NOT NULL,
    completed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    world_info TEXT NOT NULL,
    current_turn INTEGER NOT NULL,
    status TEXT NOT NULL,
    expected_player_count INTEGER,
    ai_config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    is_connected INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
    sheet_json TEXT NOT NULL,
    draft_source TEXT NOT NULL,
    confirmed INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rule_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rooms_status_idx ON rooms(status);
  CREATE TRIGGER IF NOT EXISTS players_touch AFTER INSERT ON players BEGIN UPDATE rooms SET status = 'triggered' WHERE id = NEW.room_id; END;
`;

export const LEGACY_OBJECTS = ['schema_migrations', 'rooms', 'players', 'characters', 'rule_sources', 'rooms_status_idx', 'players_touch'];

export const LEGACY_TABLES = ['schema_migrations', 'rooms', 'players', 'characters', 'rule_sources'];

/** canonical DDL 快照：只比较 legacy objects，不比较整个 sqlite_master。 */
export function ddlSnapshot(raw: Database.Database): string {
  const rows = raw
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?)) ORDER BY type, name")
    .all(JSON.stringify(LEGACY_OBJECTS)) as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  return JSON.stringify(rows.map((row) => ({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql })));
}

/** row 快照：每表按主键排序的 JSON（BLOB 经 Buffer 序列化，值/类型/顺序稳定）。 */
export function rowsSnapshot(raw: Database.Database): string {
  const byTable: Record<string, unknown[]> = {};
  for (const table of LEGACY_TABLES) {
    const pk = 'id';
    byTable[table] = raw.prepare(`SELECT * FROM ${table} ORDER BY ${pk}`).all() as unknown[];
  }
  return JSON.stringify(byTable, (key, value) => (Buffer.isBuffer(value) ? { $blob: value.toString('hex') } : value));
}

/** 在既有 connection 上创建 legacy fixture 行（含 BLOB content_json）。 */
export function makeLegacyFixture(raw: Database.Database): void {
  raw.exec(LEGACY_DDL);
  raw.prepare('INSERT INTO schema_migrations (id, version, summary_json, completed_at) VALUES (?, ?, ?, ?)')
    .run('legacy-schema-init-v1', 0, '{"tables":["rooms","players","characters","rule_sources"]}', '2026-01-01T00:00:00.000Z');
  raw.prepare('INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, expected_player_count, ai_config_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('room-1', '烛堡·地窖', '你是 DM。', '{"secret":"世界信息"}', 3, 'active', null, '{}', '2026-01-01T00:00:00.000Z');
  raw.prepare('INSERT INTO players (id, room_id, name, token, is_connected, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('player-1', 'room-1', '薇拉', 'token-薇拉-αβγ', 1, '2026-01-01T00:00:00.000Z');
  raw.prepare('INSERT INTO characters (id, player_id, sheet_json, draft_source, confirmed, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('char-1', 'player-1', '{"hp":10,"name":"薇拉"}', 'native', 1, '2026-01-01T00:00:00.000Z');
  raw.prepare('INSERT INTO rule_sources (id, name, source_type, content_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('rule-1', 'D&D 5e PHB', 'pdf', randomBytes(4), '2026-01-01T00:00:00.000Z');
}

export interface LegacySnapshot {
  ddl: string;
  rows: string;
}

/** 捕获当前 legacy DDL+rows 快照（enrollment/cutover 前后调用并比较）。 */
export function captureLegacySnapshot(raw: Database.Database): LegacySnapshot {
  return { ddl: ddlSnapshot(raw), rows: rowsSnapshot(raw) };
}
