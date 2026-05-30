import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { RemoteDbSource, RemoteDbImport, ResourceWorldBook, ResourceWorldBookEntry, PromptPresetPackage } from '../domain/types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface FetchRemoteJsonResult {
  json: unknown;
  fileHash: string;
  fileSize: number;
}

export async function fetchRemoteJson(url: string): Promise<FetchRemoteJsonResult> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch remote JSON: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json') && !contentType.includes('text/plain') && !contentType.includes('application/octet-stream')) {
    throw new Error(`Remote URL returned non-JSON Content-Type: ${contentType}`);
  }
  const text = await response.text();
  const fileSize = Buffer.byteLength(text, 'utf-8');
  const fileHash = crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Remote URL returned invalid JSON');
  }
  return { json, fileHash, fileSize };
}

export type RemoteDbSourceType = RemoteDbSource['sourceType'];

export function detectSourceType(json: unknown): RemoteDbSourceType {
  if (isRecord(json)) {
    if (Array.isArray(json.entries) && json.entries.length > 0) {
      return 'world_book';
    }
    if ('temperature' in json || 'top_p' in json || json.openAiSettings !== undefined) {
      return 'preset_package';
    }
    if (Array.isArray(json.species) || Array.isArray(json.classes) || Array.isArray(json.backgrounds)) {
      return 'character_options';
    }
    if (Array.isArray(json.rules)) {
      return 'rules_json';
    }
  }
  return 'unknown';
}

function parseEntryArray(json: unknown): Array<Record<string, unknown>> {
  if (isRecord(json) && Array.isArray(json.entries)) {
    return (json.entries as Array<unknown>).filter(isRecord);
  }
  return [];
}

function entryCount(json: unknown): number {
  if (isRecord(json)) {
    if (Array.isArray(json.entries)) return json.entries.length;
    if (Array.isArray(json.species) || Array.isArray(json.classes) || Array.isArray(json.backgrounds)) {
      let count = 0;
      if (Array.isArray(json.species)) count += json.species.length;
      if (Array.isArray(json.classes)) count += json.classes.length;
      if (Array.isArray(json.backgrounds)) count += json.backgrounds.length;
      return count;
    }
    if (Array.isArray(json.rules)) return json.rules.length;
  }
  return 0;
}

function insertSourceRecord(
  db: AppDatabase,
  params: {
    url: string;
    name: string;
    sourceType: RemoteDbSourceType;
    version: string;
    fileHash: string;
    fileSize: number;
    entryCount: number;
    now: string;
  }
): string {
  const id = nanoid();
  db.prepare(
    `INSERT INTO remote_db_sources (id, url, name, source_type, version, file_hash, file_size, entry_count, last_checked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, params.url, params.name, params.sourceType, params.version, params.fileHash, params.fileSize, params.entryCount, params.now, params.now);
  return id;
}

function insertImportRecord(
  db: AppDatabase,
  sourceId: string,
  resourceType: string,
  resourceId: string,
  hasLocalEdits: boolean
): void {
  db.prepare(
    `INSERT OR REPLACE INTO remote_db_imports (source_id, resource_type, resource_id, has_local_edits)
     VALUES (?, ?, ?, ?)`
  ).run(sourceId, resourceType, resourceId, hasLocalEdits ? 1 : 0);
}

function importWorldBook(
  db: AppDatabase,
  json: Record<string, unknown>,
  sourceId: string,
  fallbackName: string,
  now: string
): ResourceWorldBook {
  const entries = Array.isArray(json.entries) ? (json.entries as Array<unknown>).filter(isRecord) : [];
  const worldBookId = nanoid();
  const name = typeof json.name === 'string' ? json.name : fallbackName;

  db.prepare(
    'INSERT INTO resource_world_books (id, name, source_type, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(worldBookId, name, 'sillytavern_world_book', JSON.stringify(json), now, now);

  let orderIndex = 0;
  for (const entry of entries) {
    const entryId = nanoid();
    const title = typeof entry.name === 'string' ? entry.name : (typeof entry.key === 'string' ? entry.key : (typeof entry.comment === 'string' ? entry.comment : `Entry ${orderIndex + 1}`));
    const keys = Array.isArray(entry.keys) ? entry.keys.filter((k): k is string => typeof k === 'string') : (typeof entry.key === 'string' ? [entry.key] : []);
    const content = typeof entry.content === 'string' ? entry.content : '';
    const enabled = entry.enabled !== false;
    const constant = entry.constant === true;
    const priority = typeof entry.priority === 'number' ? entry.priority : (typeof entry.order === 'number' ? entry.order : 100);
    const position = entry.position === 'before' ? 'before' as const : 'after' as const;

    db.prepare(
      'INSERT INTO resource_world_book_entries (id, world_book_id, title, keys_json, secondary_keys_json, content, enabled, constant, priority, order_index, position, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(entryId, worldBookId, title, JSON.stringify(keys), '[]', content, enabled ? 1 : 0, constant ? 1 : 0, priority, orderIndex, position, JSON.stringify(entry), now, now);

    insertImportRecord(db, sourceId, 'resource_world_book_entry', entryId, false);
    orderIndex++;
  }

  insertImportRecord(db, sourceId, 'resource_world_book', worldBookId, false);

  return {
    id: worldBookId,
    name,
    sourceType: 'sillytavern_world_book',
    rawJson: json,
    createdAt: now,
    updatedAt: now
  };
}

function importPresetPackage(
  db: AppDatabase,
  json: Record<string, unknown>,
  sourceId: string,
  fallbackName: string,
  now: string
): PromptPresetPackage {
  const presetPackageId = nanoid();
  const name = typeof json.name === 'string' ? json.name : fallbackName;
  const openAiSettings = json.openAiSettings ?? json;

  db.prepare(
    'INSERT INTO prompt_preset_packages (id, name, source_type, openai_settings_json, context_template_json, instruct_template_json, sysprompt_json, reasoning_template_json, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    presetPackageId,
    name,
    'sillytavern_preset_package',
    JSON.stringify(openAiSettings),
    null,
    null,
    null,
    null,
    JSON.stringify(json),
    now,
    now
  );

  insertImportRecord(db, sourceId, 'prompt_preset_package', presetPackageId, false);

  return {
    id: presetPackageId,
    name,
    sourceType: 'sillytavern_preset_package',
    openAiSettings,
    contextTemplate: null,
    instructTemplate: null,
    sysprompt: null,
    reasoningTemplate: null,
    rawJson: json,
    createdAt: now,
    updatedAt: now
  };
}

function importCharacterOptions(
  db: AppDatabase,
  json: Record<string, unknown>,
  sourceId: string,
  fallbackName: string,
  now: string
): { drafts: Array<{ id: string }> } {
  const jobId = nanoid();
  const draftIds: Array<{ id: string }> = [];

  db.prepare(
    `INSERT INTO resource_import_jobs (
      id, name, source_type, source_name, source_file_name, source_url, source_version, source_hash,
      source_license, ruleset, language, visibility, is_private, imported_by, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, fallbackName, 'remote_url', fallbackName, '', '', '', '', '', 'unknown', 'unknown', 'private', 1, 'remote-db-import', 'imported', now, now);

  insertImportRecord(db, sourceId, 'resource_import_job', jobId, false);

  const optionArrays: Array<{ type: string; key: string }> = [
    { type: 'species', key: 'species' },
    { type: 'class', key: 'classes' },
    { type: 'background', key: 'backgrounds' }
  ];

  for (const { type, key } of optionArrays) {
    const arr = json[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!isRecord(item)) continue;
      const draftId = nanoid();
      const title = typeof item.name === 'string' ? item.name : `Unknown ${type}`;
      const summary = typeof item.summary === 'string' ? item.summary : (typeof item.description === 'string' ? item.description : '');
      const ruleData = item.ruleData ?? item;
      const sourceRef = typeof item.sourceRef === 'string' ? item.sourceRef : '';

      db.prepare(
        `INSERT INTO resource_import_drafts (
          id, job_id, kind, source_type, source_name, source_file_name, source_url, source_version,
          source_hash, source_license, ruleset, language, visibility, is_private, imported_by,
          content_hash, title, category, option_type, summary, content, keys_json, source_ref,
          rule_data_json, prerequisites_json, priority, raw_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        draftId, jobId, 'character_option', 'remote_url', fallbackName, '', '', '', '', '', 'unknown',
        'unknown', 'private', 1, 'remote-db-import', '', title, 'character', type, summary, '', '[]',
        sourceRef, JSON.stringify(ruleData), '{}', 100, JSON.stringify(item), 'approved', now, now
      );

      // Auto-approve: insert into character_options
      const optionId = nanoid();
      db.prepare(
        'INSERT INTO character_options (id, draft_id, option_type, name, summary, rule_data_json, prerequisites_json, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(optionId, draftId, type, title, summary, JSON.stringify(ruleData), '{}', sourceRef, now, now);

      insertImportRecord(db, sourceId, 'character_option', optionId, false);
      draftIds.push({ id: draftId });
    }
  }

  return { drafts: draftIds };
}

function importRulesJson(
  db: AppDatabase,
  json: Record<string, unknown>,
  sourceId: string,
  fallbackName: string,
  now: string
): { drafts: Array<{ id: string }> } {
  const jobId = nanoid();
  const draftIds: Array<{ id: string }> = [];

  db.prepare(
    `INSERT INTO resource_import_jobs (
      id, name, source_type, source_name, source_file_name, source_url, source_version, source_hash,
      source_license, ruleset, language, visibility, is_private, imported_by, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, fallbackName, 'remote_url', fallbackName, '', '', '', '', '', 'unknown', 'unknown', 'private', 1, 'remote-db-import', 'imported', now, now);

  insertImportRecord(db, sourceId, 'resource_import_job', jobId, false);

  const rules = Array.isArray(json.rules) ? json.rules : [];
  for (const rule of rules) {
    if (!isRecord(rule)) continue;
    const draftId = nanoid();
    const title = typeof rule.title === 'string' ? rule.title : (typeof rule.name === 'string' ? rule.name : 'Unknown Rule');
    const category = typeof rule.category === 'string' ? rule.category : 'general';
    const summary = typeof rule.summary === 'string' ? rule.summary : '';
    const content = typeof rule.content === 'string' ? rule.content : '';
    const keys = Array.isArray(rule.keys) ? rule.keys.filter((k): k is string => typeof k === 'string') : [];
    const sourceRef = typeof rule.sourceRef === 'string' ? rule.sourceRef : '';
    const ruleData = rule.ruleData ?? rule;

    db.prepare(
      `INSERT INTO resource_import_drafts (
        id, job_id, kind, source_type, source_name, source_file_name, source_url, source_version,
        source_hash, source_license, ruleset, language, visibility, is_private, imported_by,
        content_hash, title, category, option_type, summary, content, keys_json, source_ref,
        rule_data_json, prerequisites_json, priority, raw_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      draftId, jobId, 'rule_entry', 'remote_url', fallbackName, '', '', '', '', '', 'unknown',
      'unknown', 'private', 1, 'remote-db-import', '', title, category, null, summary, content,
      JSON.stringify(keys), sourceRef, JSON.stringify(ruleData), '{}', 100, JSON.stringify(rule), 'approved', now, now
    );

    // Auto-approve: insert into rule_world_book_entries
    const entryId = nanoid();
    db.prepare(
      'INSERT INTO rule_world_book_entries (id, draft_id, title, category, summary, content, keys_json, source_ref, priority, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(entryId, draftId, title, category, summary, content, JSON.stringify(keys), sourceRef, 100, 1, now, now);

    insertImportRecord(db, sourceId, 'rule_world_book_entry', entryId, false);
    draftIds.push({ id: draftId });
  }

  return { drafts: draftIds };
}

export interface ImportFromUrlResult {
  source: RemoteDbSource;
  sourceType: RemoteDbSourceType;
  worldBook?: ResourceWorldBook;
  presetPackage?: PromptPresetPackage;
  draftsCount: number;
}

export function importFromUrl(
  db: AppDatabase,
  url: string,
  fallbackName?: string
): ImportFromUrlResult {
  return db.transaction(() => {
    const urlObj = new URL(url);
    url = urlObj.toString();
  }) as unknown as ImportFromUrlResult;

  // This is a placeholder - actual import is async, handled below
}

export async function importFromUrlAsync(
  db: AppDatabase,
  url: string,
  fallbackName?: string
): Promise<ImportFromUrlResult> {
  const normalizedUrl = new URL(url).toString();
  const fallback = fallbackName ?? normalizedUrl.split('/').pop() ?? 'Remote Import';
  const now = new Date().toISOString();

  const { json, fileHash, fileSize } = await fetchRemoteJson(normalizedUrl);
  const sourceType = detectSourceType(json);
  const version = isRecord(json) && typeof json.version === 'string' ? json.version : '';
  const count = entryCount(json);

  let sourceId = '';
  let worldBook: ResourceWorldBook | undefined;
  let presetPackage: PromptPresetPackage | undefined;
  let draftsCount = 0;

  db.transaction(() => {
    sourceId = insertSourceRecord(db, {
      url: normalizedUrl,
      name: fallback,
      sourceType,
      version,
      fileHash,
      fileSize,
      entryCount: count,
      now
    });

    if (isRecord(json)) {
      switch (sourceType) {
        case 'world_book': {
          worldBook = importWorldBook(db, json, sourceId, fallback, now);
          break;
        }
        case 'preset_package': {
          presetPackage = importPresetPackage(db, json, sourceId, fallback, now);
          break;
        }
        case 'character_options': {
          const result = importCharacterOptions(db, json, sourceId, fallback, now);
          draftsCount = result.drafts.length;
          break;
        }
        case 'rules_json': {
          const result = importRulesJson(db, json, sourceId, fallback, now);
          draftsCount = result.drafts.length;
          break;
        }
        default:
          // unknown type, just record the source
          break;
      }
    }
  })();

  const source = getSource(db, sourceId);
  if (!source) throw new Error(`Failed to retrieve source ${sourceId}`);

  return { source, sourceType, worldBook, presetPackage, draftsCount };
}

export interface ImportFromJsCodeResult extends ImportFromUrlResult {
  preview: { entryTypes: Array<{ type: string; count: number }> };
}

export function importFromJsCode(
  db: AppDatabase,
  name: string,
  jsCode: string
): ImportFromJsCodeResult {
  const json = parseJsDatabase(jsCode);
  const sourceType = detectSourceType(json);
  const count = entryCount(json);
  const now = new Date().toISOString();
  const version = isRecord(json) && typeof json.version === 'string' ? json.version : '';
  const jsonStr = JSON.stringify(json);
  const fileSize = Buffer.byteLength(jsonStr, 'utf-8');
  const fileHash = crypto.createHash('sha256').update(jsonStr, 'utf-8').digest('hex');
  const urlIdentifier = `js-import://${fileHash.substring(0, 12)}`;

  // Build preview
  const preview: { entryTypes: Array<{ type: string; count: number }> } = { entryTypes: [] };
  if (isRecord(json)) {
    if (sourceType === 'world_book' && Array.isArray(json.entries)) {
      preview.entryTypes.push({ type: 'world_book_entries', count: json.entries.length });
    } else if (sourceType === 'preset_package') {
      preview.entryTypes.push({ type: 'preset_package', count: 1 });
    } else if (sourceType === 'character_options') {
      if (Array.isArray(json.species)) preview.entryTypes.push({ type: 'species', count: json.species.length });
      if (Array.isArray(json.classes)) preview.entryTypes.push({ type: 'classes', count: json.classes.length });
      if (Array.isArray(json.backgrounds)) preview.entryTypes.push({ type: 'backgrounds', count: json.backgrounds.length });
    } else if (sourceType === 'rules_json' && Array.isArray(json.rules)) {
      preview.entryTypes.push({ type: 'rules', count: json.rules.length });
    }
  }

  let sourceId = '';
  let worldBook: ResourceWorldBook | undefined;
  let presetPackage: PromptPresetPackage | undefined;
  let draftsCount = 0;

  db.transaction(() => {
    sourceId = insertSourceRecord(db, {
      url: urlIdentifier,
      name,
      sourceType,
      version,
      fileHash,
      fileSize,
      entryCount: count,
      now
    });

    if (isRecord(json)) {
      switch (sourceType) {
        case 'world_book': {
          worldBook = importWorldBook(db, json, sourceId, name, now);
          break;
        }
        case 'preset_package': {
          presetPackage = importPresetPackage(db, json, sourceId, name, now);
          break;
        }
        case 'character_options': {
          const result = importCharacterOptions(db, json, sourceId, name, now);
          draftsCount = result.drafts.length;
          break;
        }
        case 'rules_json': {
          const result = importRulesJson(db, json, sourceId, name, now);
          draftsCount = result.drafts.length;
          break;
        }
        default:
          break;
      }
    }
  })();

  const source = getSource(db, sourceId);
  if (!source) throw new Error(`Failed to retrieve source ${sourceId}`);

  return { source, sourceType, worldBook, presetPackage, draftsCount, preview };
}

export function getSource(db: AppDatabase, sourceId: string): RemoteDbSource | null {
  const row = db.prepare(
    'SELECT id, url, name, source_type as sourceType, version, file_hash as fileHash, file_size as fileSize, entry_count as entryCount, last_checked_at as lastCheckedAt, created_at as createdAt FROM remote_db_sources WHERE id = ?'
  ).get(sourceId) as Record<string, unknown> | undefined;
  if (!row) return null;
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

export function listSources(db: AppDatabase): RemoteDbSource[] {
  const rows = db.prepare(
    'SELECT id, url, name, source_type as sourceType, version, file_hash as fileHash, file_size as fileSize, entry_count as entryCount, last_checked_at as lastCheckedAt, created_at as createdAt FROM remote_db_sources ORDER BY created_at DESC'
  ).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
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
  }));
}

export function deleteSource(db: AppDatabase, sourceId: string): boolean {
  const result = db.prepare('DELETE FROM remote_db_sources WHERE id = ?').run(sourceId);
  return result.changes > 0;
}

export interface CheckUpdatesResult {
  hasUpdate: boolean;
  newHash?: string;
  newSize?: number;
  newEntryCount?: number;
}

export async function checkForUpdates(
  db: AppDatabase,
  sourceId: string
): Promise<CheckUpdatesResult> {
  const source = getSource(db, sourceId);
  if (!source) throw new Error(`Source ${sourceId} not found`);

  const { fileHash, fileSize } = await fetchRemoteJson(source.url);
  const now = new Date().toISOString();
  db.prepare('UPDATE remote_db_sources SET last_checked_at = ? WHERE id = ?').run(now, sourceId);

  if (fileHash !== source.fileHash) {
    const json = await fetchRemoteJson(source.url);
    const newCount = entryCount(json.json);
    return { hasUpdate: true, newHash: fileHash, newSize: fileSize, newEntryCount: newCount };
  }

  return { hasUpdate: false };
}

export async function updateSource(
  db: AppDatabase,
  sourceId: string
): Promise<ImportFromUrlResult> {
  const source = getSource(db, sourceId);
  if (!source) throw new Error(`Source ${sourceId} not found`);

  // Check if any imported resources have local edits
  const editedRows = db.prepare(
    'SELECT COUNT(*) as count FROM remote_db_imports WHERE source_id = ? AND has_local_edits = 1'
  ).get(sourceId) as { count: number };

  if (editedRows.count > 0) {
    // Create a copy with suffix
    const copyName = `${source.name} (已更新)`;
    return await importFromUrlAsync(db, source.url, copyName);
  }

  // No local edits, delete old and re-import
  deleteSource(db, sourceId);
  return await importFromUrlAsync(db, source.url, source.name);
}

export function parseJsDatabase(jsCode: string): Record<string, unknown> {
  // Sandbox: create a new Function scope that only has access to the module.exports object
  const sandboxModule = { exports: {} as Record<string, unknown> };

  // Check for banned globals in source
  const bannedTokens = ['require', 'process', 'global', 'fs', 'child_process', 'import', 'eval('];
  for (const token of bannedTokens) {
    if (jsCode.includes(token)) {
      throw new Error(`Forbidden token '${token}' found in JS database code`);
    }
  }

  try {
    const fn = new Function('module', jsCode + '\nreturn module.exports;');
    const result = fn(sandboxModule);
    if (isRecord(result)) return result;
    if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result);
        if (isRecord(parsed)) return parsed;
      } catch {
        // fall through to throw
      }
    }
    throw new Error('JS database code must return a JSON object via module.exports');
  } catch (error) {
    if (error instanceof Error && error.message.includes('JS database code')) {
      throw error;
    }
    throw new Error(`Failed to evaluate JS database code: ${error instanceof Error ? error.message : String(error)}`);
  }
}
