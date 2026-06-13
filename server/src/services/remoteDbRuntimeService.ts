import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { RemoteDbRow, RemoteDbSheet, RemoteDbSource, RoomDbSourceBinding, RoomPluginDatabaseSnapshot } from '../domain/types.js';

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function mapSourceRow(row: Record<string, unknown>): RemoteDbSource {
  return {
    id: row.id as string,
    url: row.url as string,
    name: row.name as string,
    sourceType: row.sourceType as RemoteDbSource['sourceType'],
    version: row.version as string,
    fileHash: row.fileHash as string,
    fileSize: row.fileSize as number,
    entryCount: row.entryCount as number,
    lastCheckedAt: row.lastCheckedAt as string,
    createdAt: row.createdAt as string
  };
}

function mapSheetRow(row: Record<string, unknown>): RemoteDbSheet {
  return {
    id: row.id as string,
    sourceId: row.sourceId as string,
    uid: row.uid as string,
    name: row.name as string,
    tableName: row.tableName as string,
    note: row.note as string,
    initNode: row.initNode as string,
    updateNode: row.updateNode as string,
    insertNode: row.insertNode as string,
    deleteNode: row.deleteNode as string,
    ddl: row.ddl as string,
    exportEnabled: Boolean(row.exportEnabled),
    orderIndex: row.orderIndex as number,
    rawJson: parseJsonObject((row.rawJson as string | undefined) ?? '{}'),
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string
  };
}

function mapRowRecord(row: Record<string, unknown>): RemoteDbRow {
  return {
    id: row.id as string,
    roomId: row.roomId as string,
    sheetId: row.sheetId as string,
    rowKey: row.rowKey as string,
    data: parseJsonObject((row.dataJson as string | undefined) ?? '{}'),
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string
  };
}

function sourceSelectSql(): string {
  return `s.id, s.url, s.name, s.source_type as sourceType, s.version, s.file_hash as fileHash,
    s.file_size as fileSize, s.entry_count as entryCount, s.last_checked_at as lastCheckedAt, s.created_at as createdAt`;
}

function sheetSelectSql(prefix = 'sheet'): string {
  return `${prefix}.id, ${prefix}.source_id as sourceId, ${prefix}.uid, ${prefix}.name,
    ${prefix}.table_name as tableName, ${prefix}.note, ${prefix}.init_node as initNode,
    ${prefix}.update_node as updateNode, ${prefix}.insert_node as insertNode,
    ${prefix}.delete_node as deleteNode, ${prefix}.ddl, ${prefix}.export_enabled as exportEnabled,
    ${prefix}.order_index as orderIndex, ${prefix}.raw_json as rawJson,
    ${prefix}.created_at as createdAt, ${prefix}.updated_at as updatedAt`;
}

export function listRoomDbSourceBindings(db: AppDatabase, roomId: string): RoomDbSourceBinding[] {
  const rows = db.prepare(
    `SELECT b.room_id as roomId, b.source_id as sourceId, b.enabled, b.order_index as orderIndex,
      b.created_at as bindingCreatedAt, ${sourceSelectSql()}
     FROM room_db_source_bindings b
     JOIN remote_db_sources s ON s.id = b.source_id
     WHERE b.room_id = ?
     ORDER BY b.order_index ASC, s.name ASC`
  ).all(roomId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    roomId: row.roomId as string,
    sourceId: row.sourceId as string,
    enabled: Boolean(row.enabled),
    orderIndex: row.orderIndex as number,
    createdAt: row.bindingCreatedAt as string,
    source: mapSourceRow(row)
  }));
}

export function replaceRoomDbSourceBindings(
  db: AppDatabase,
  roomId: string,
  bindings: Array<{ sourceId: string; enabled: boolean; orderIndex: number }>
): RoomDbSourceBinding[] {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM room_db_source_bindings WHERE room_id = ?').run(roomId);
    for (const binding of bindings) {
      const source = db.prepare('SELECT id, source_type as sourceType FROM remote_db_sources WHERE id = ?')
        .get(binding.sourceId) as { id: string; sourceType: string } | undefined;
      if (!source) throw new Error(`Remote DB source not found: ${binding.sourceId}`);
      if (source.sourceType !== 'table_plugin') throw new Error(`Remote DB source is not a table plugin: ${binding.sourceId}`);
      db.prepare(
        'INSERT INTO room_db_source_bindings (room_id, source_id, enabled, order_index, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(roomId, binding.sourceId, binding.enabled ? 1 : 0, binding.orderIndex, now);
    }
  })();
  return listRoomDbSourceBindings(db, roomId);
}

export function listRoomDbSheets(db: AppDatabase, roomId: string): RemoteDbSheet[] {
  const rows = db.prepare(
    `SELECT ${sheetSelectSql('sheet')}
     FROM remote_db_sheets sheet
     JOIN room_db_source_bindings binding ON binding.source_id = sheet.source_id
     WHERE binding.room_id = ? AND binding.enabled = 1
     ORDER BY binding.order_index ASC, sheet.order_index ASC, sheet.name ASC`
  ).all(roomId) as Array<Record<string, unknown>>;
  return rows.map(mapSheetRow);
}

export function listRoomDbRows(db: AppDatabase, roomId: string, sheetId: string): RemoteDbRow[] {
  const rows = db.prepare(
    `SELECT id, room_id as roomId, sheet_id as sheetId, row_key as rowKey, data_json as dataJson,
      created_at as createdAt, updated_at as updatedAt
     FROM remote_db_rows
     WHERE room_id = ? AND sheet_id = ?
     ORDER BY updated_at DESC, row_key ASC`
  ).all(roomId, sheetId) as Array<Record<string, unknown>>;
  return rows.map(mapRowRecord);
}

export function upsertRoomDbRow(
  db: AppDatabase,
  roomId: string,
  sheetId: string,
  rowKey: string,
  data: Record<string, unknown>
): RemoteDbRow {
  const sheet = db.prepare(
    `SELECT sheet.id FROM remote_db_sheets sheet
     JOIN room_db_source_bindings binding ON binding.source_id = sheet.source_id
     WHERE sheet.id = ? AND binding.room_id = ? AND binding.enabled = 1`
  ).get(sheetId, roomId) as { id: string } | undefined;
  if (!sheet) throw new Error(`Sheet ${sheetId} is not enabled for room ${roomId}`);

  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM remote_db_rows WHERE room_id = ? AND sheet_id = ? AND row_key = ?')
    .get(roomId, sheetId, rowKey) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE remote_db_rows SET data_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(data), now, existing.id);
  } else {
    db.prepare(
      'INSERT INTO remote_db_rows (id, room_id, sheet_id, row_key, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(nanoid(), roomId, sheetId, rowKey, JSON.stringify(data), now, now);
  }
  const row = db.prepare(
    `SELECT id, room_id as roomId, sheet_id as sheetId, row_key as rowKey, data_json as dataJson,
      created_at as createdAt, updated_at as updatedAt
     FROM remote_db_rows WHERE room_id = ? AND sheet_id = ? AND row_key = ?`
  ).get(roomId, sheetId, rowKey) as Record<string, unknown>;
  return mapRowRecord(row);
}

export function deleteRoomDbRow(db: AppDatabase, roomId: string, sheetId: string, rowKey: string): boolean {
  const result = db.prepare('DELETE FROM remote_db_rows WHERE room_id = ? AND sheet_id = ? AND row_key = ?')
    .run(roomId, sheetId, rowKey);
  return result.changes > 0;
}

export function getRoomPluginDatabaseSnapshot(db: AppDatabase, roomId: string): RoomPluginDatabaseSnapshot[] {
  const sources = listRoomDbSourceBindings(db, roomId)
    .filter((binding) => binding.enabled)
    .map((binding) => binding.source);
  return sources.map((source) => {
    const sheets = db.prepare(
      `SELECT ${sheetSelectSql('sheet')}
       FROM remote_db_sheets sheet
       WHERE sheet.source_id = ?
       ORDER BY sheet.order_index ASC, sheet.name ASC`
    ).all(source.id) as Array<Record<string, unknown>>;
    return {
      source,
      sheets: sheets.map((sheetRow) => {
        const sheet = mapSheetRow(sheetRow);
        return { ...sheet, rows: listRoomDbRows(db, roomId, sheet.id) };
      })
    };
  });
}

export function renderRoomPluginDatabaseContext(db: AppDatabase, roomId: string): string {
  const snapshots = getRoomPluginDatabaseSnapshot(db, roomId);
  if (snapshots.length === 0) return '';

  const lines = [
    '# 插件数据库',
    '以下是当前房间启用的结构化数据库表。AI-DM 可以读取这些表作为战役事实来源。',
    '如需修改数据库，只能在 suggestedStateChanges 中提出 database_row_upsert 或 database_row_delete；这些变更默认进入管理员审核，不会自动改写 NPC、任务、隐藏线索、世界事件或永久战役事实。'
  ];

  for (const snapshot of snapshots) {
    lines.push(`\n## 数据源：${snapshot.source.name}`);
    for (const sheet of snapshot.sheets) {
      lines.push(`\n### ${sheet.name} (${sheet.tableName || sheet.uid})`);
      if (sheet.note) lines.push(`说明：${sheet.note}`);
      if (sheet.updateNode || sheet.insertNode || sheet.deleteNode) {
        lines.push([
          sheet.insertNode ? `插入规则：${sheet.insertNode}` : '',
          sheet.updateNode ? `更新规则：${sheet.updateNode}` : '',
          sheet.deleteNode ? `删除规则：${sheet.deleteNode}` : ''
        ].filter(Boolean).join('\n'));
      }
      if (sheet.rows.length === 0) {
        lines.push('- 当前无数据行。');
      } else {
        for (const row of sheet.rows.slice(0, 20)) {
          lines.push(`- ${row.rowKey}: ${JSON.stringify(row.data)}`);
        }
      }
    }
  }

  return lines.join('\n');
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function resolveSheetId(db: AppDatabase, roomId: string, targetId: string): string | null {
  const normalized = targetId.startsWith('sheet:') ? targetId.slice('sheet:'.length) : targetId;
  const row = db.prepare(
    `SELECT sheet.id FROM remote_db_sheets sheet
     JOIN room_db_source_bindings binding ON binding.source_id = sheet.source_id
     WHERE binding.room_id = ? AND binding.enabled = 1
       AND (sheet.id = ? OR sheet.uid = ? OR sheet.table_name = ? OR sheet.name = ?)`
  ).get(roomId, normalized, normalized, normalized, normalized) as { id: string } | undefined;
  return row?.id ?? null;
}

function isVirtualNarrativeStateTarget(targetId: string): boolean {
  const normalized = (targetId.startsWith('sheet:') ? targetId.slice('sheet:'.length) : targetId)
    .trim()
    .toLowerCase();
  const pathParts = normalized.split('/').map((part) => part.trim()).filter(Boolean);
  const candidates = new Set([normalized, ...pathParts]);
  return candidates.has('campaign_state') || candidates.has('combat_state');
}

function pluginDatabaseAutoApplyWhitelist(): Set<string> {
  return new Set((process.env.PLUGIN_DB_AUTO_APPLY_WHITELIST ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean));
}

function hasKnownSheetSchema(db: AppDatabase, sheetId: string): boolean {
  const sheet = db.prepare('SELECT ddl, raw_json as rawJson FROM remote_db_sheets WHERE id = ?')
    .get(sheetId) as { ddl?: string; rawJson?: string } | undefined;
  if (!sheet) return false;
  if (sheet.ddl && sheet.ddl.trim()) return true;
  const raw = sheet.rawJson ? parseJsonObject(sheet.rawJson) : {};
  return Array.isArray(raw.columns) || Array.isArray(raw.fields) || typeof raw.schema === 'object';
}

export function applyPluginDatabaseChange(
  db: AppDatabase,
  roomId: string,
  change: Record<string, unknown>
): { applied: boolean; message?: string } {
  const changeType = String(change.changeType ?? change.type ?? '');
  if (changeType !== 'database_row_upsert' && changeType !== 'database_row_delete') {
    return { applied: false };
  }
  const targetId = typeof change.targetId === 'string' ? change.targetId : '';
  const sheetId = resolveSheetId(db, roomId, targetId);
  if (!sheetId && isVirtualNarrativeStateTarget(targetId)) return { applied: false };
  if (!sheetId) return { applied: false, message: `Pending admin review: plugin database sheet not found or not enabled: ${targetId}` };

  const whitelist = pluginDatabaseAutoApplyWhitelist();
  if (!whitelist.has(sheetId) && !whitelist.has(targetId)) {
    return { applied: false, message: `Pending admin review: plugin database auto-apply is not whitelisted for ${targetId || sheetId}` };
  }
  if (!hasKnownSheetSchema(db, sheetId)) {
    return { applied: false, message: `Pending admin review: plugin database schema is not known for ${targetId || sheetId}` };
  }

  const rowKey = typeof change.rowKey === 'string'
    ? change.rowKey
    : typeof change.path === 'string'
      ? change.path
      : '';
  if (!rowKey || rowKey.includes('..')) return { applied: false, message: 'Pending admin review: plugin database change requires a valid rowKey or path' };

  const existing = db.prepare('SELECT data_json as dataJson FROM remote_db_rows WHERE room_id = ? AND sheet_id = ? AND row_key = ?')
    .get(roomId, sheetId, rowKey) as { dataJson: string } | undefined;
  const before = existing ? parseJsonObject(existing.dataJson) : null;
  if ('before' in change && !deepEqualJson(change.before, before)) {
    throw new Error(`Plugin database before mismatch for ${rowKey}`);
  }

  if (changeType === 'database_row_delete') {
    deleteRoomDbRow(db, roomId, sheetId, rowKey);
    return { applied: true };
  }

  if (typeof change.after !== 'object' || change.after === null || Array.isArray(change.after)) {
    throw new Error('database_row_upsert requires after to be an object');
  }
  upsertRoomDbRow(db, roomId, sheetId, rowKey, change.after as Record<string, unknown>);
  return { applied: true };
}
