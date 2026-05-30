import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import type {
  CharacterOption,
  CharacterOptionType,
  ResourceImportDraft,
  ResourceImportDraftKind,
  ResourceImportDraftStatus,
  ResourceImportJob,
  ResourceRule,
  RuleWorldBookEntry
} from '../domain/types.js';

const resourceImportDraftKinds = [
  'rule_entry',
  'character_option',
  'resource_rule',
  'worldbook_entry',
  'spell',
  'monster',
  'item',
  'npc',
  'campaign_entry',
  'preset_module'
] as const;
const supportedImportDraftKinds = new Set<ResourceImportDraftKind>(['rule_entry', 'character_option', 'resource_rule']);
const draftKindSchema = z.enum(resourceImportDraftKinds).refine((kind) => supportedImportDraftKinds.has(kind), {
  message: 'Unsupported resource draft kind for this import phase'
});
const sourceTypeSchema = z.enum(['local_json', 'phb_extraction', 'sillytavern_worldbook', 'sillytavern_preset', 'remote_url', 'manual']);
const rulesetSchema = z.enum(['5e-2014', '5e-2024', 'homebrew', 'unknown']);
const visibilitySchema = z.enum(['private', 'campaign', 'workspace', 'public']);
const characterOptionTypeSchema = z.enum(['species', 'class', 'background', 'skill', 'equipment', 'spell', 'language', 'proficiency']);

const draftInputSchema = z.object({
  kind: draftKindSchema,
  title: z.string().trim().min(1),
  category: z.string().trim().default('general'),
  optionType: characterOptionTypeSchema.optional(),
  summary: z.string().trim().min(1),
  content: z.string().trim().default(''),
  keys: z.array(z.string().trim().min(1)).default([]),
  sourceRef: z.string().trim().default(''),
  ruleData: z.unknown().default({}),
  prerequisites: z.unknown().default({}),
  priority: z.number().int().default(100),
  status: z.literal('pending').default('pending')
}).strict();

const extractionPayloadSchema = z.object({
  name: z.string().trim().min(1),
  sourceType: sourceTypeSchema.default('local_json'),
  sourceName: z.string().trim().default(''),
  sourceFileName: z.string().trim().default(''),
  sourceUrl: z.string().trim().default(''),
  sourceVersion: z.string().trim().default(''),
  sourceHash: z.string().trim().default(''),
  sourceLicense: z.string().trim().default(''),
  ruleset: rulesetSchema.default('unknown'),
  language: z.string().trim().default('unknown'),
  visibility: visibilitySchema.default('private'),
  isPrivate: z.boolean().default(true),
  importedBy: z.string().trim().default('admin'),
  drafts: z.array(draftInputSchema).min(1)
}).strict();

const draftReviewInputSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().trim().optional()
}).strict();

export type ResourceImportDraftInput = z.infer<typeof draftInputSchema>;
export type ResourceImportPayload = z.infer<typeof extractionPayloadSchema>;
export type ResourceDraftReviewInput = z.infer<typeof draftReviewInputSchema>;

export interface ResourceImportDraftFilters {
  status?: ResourceImportDraftStatus;
  kind?: ResourceImportDraftKind;
  sourceType?: ResourceImportJob['sourceType'];
  ruleset?: ResourceImportJob['ruleset'];
  language?: string;
  jobId?: string;
}

type ResourceImportDraftWithPriority = ResourceImportDraft & { priority: number };

export class ResourceReviewError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'ResourceReviewError';
  }
}

function parseJsonValue(json: string, context: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new ResourceReviewError(
      `Invalid stored resource import JSON in ${context}`,
      500
    );
  }
}

function parseStringArray(json: string, context: string): string[] {
  const value = parseJsonValue(json, context);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function normalizeResourceImportPayload(input: unknown): ResourceImportPayload {
  const payload = extractionPayloadSchema.parse(input);
  for (const draft of payload.drafts) {
    if (draft.kind === 'character_option' && !draft.optionType) {
      throw new ResourceReviewError('character_option drafts require optionType', 400);
    }
  }
  return payload;
}

function mapJobRow(row: any): ResourceImportJob {
  return {
    id: row.id,
    name: row.name,
    sourceName: row.sourceName,
    sourceFileName: row.sourceFileName,
    sourceUrl: row.sourceUrl,
    sourceType: row.sourceType,
    sourceVersion: row.sourceVersion,
    sourceHash: row.sourceHash,
    sourceLicense: row.sourceLicense,
    ruleset: row.ruleset,
    language: row.language,
    visibility: row.visibility,
    isPrivate: row.isPrivate === 1,
    importedBy: row.importedBy,
    status: row.status,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapDraftRow(row: any): ResourceImportDraft {
  return {
    id: row.id,
    jobId: row.jobId,
    kind: row.kind,
    sourceType: row.sourceType,
    sourceName: row.sourceName,
    sourceFileName: row.sourceFileName,
    sourceUrl: row.sourceUrl,
    sourceVersion: row.sourceVersion,
    sourceHash: row.sourceHash,
    sourceLicense: row.sourceLicense,
    ruleset: row.ruleset,
    language: row.language,
    visibility: row.visibility,
    isPrivate: row.isPrivate === 1,
    importedBy: row.importedBy,
    contentHash: row.contentHash,
    title: row.title,
    category: row.category,
    optionType: row.optionType,
    summary: row.summary,
    content: row.content,
    keys: parseStringArray(row.keysJson, `keysJson for draft ${row.id}`),
    sourceRef: row.sourceRef,
    ruleData: parseJsonValue(row.ruleDataJson, `ruleDataJson for draft ${row.id}`),
    prerequisites: parseJsonValue(row.prerequisitesJson, `prerequisitesJson for draft ${row.id}`),
    raw: parseJsonValue(row.rawJson, `rawJson for draft ${row.id}`),
    status: row.status,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapCharacterOptionRow(row: any): CharacterOption {
  return {
    id: row.id,
    draftId: row.draftId,
    optionType: row.optionType,
    name: row.name,
    summary: row.summary,
    ruleData: parseJsonValue(row.ruleDataJson, `ruleDataJson for character option ${row.id}`),
    prerequisites: parseJsonValue(row.prerequisitesJson, `prerequisitesJson for character option ${row.id}`),
    sourceRef: row.sourceRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapRuleEntryRow(row: any): RuleWorldBookEntry {
  return {
    id: row.id,
    draftId: row.draftId,
    title: row.title,
    category: row.category,
    summary: row.summary,
    content: row.content,
    keys: parseStringArray(row.keysJson, `keysJson for rule entry ${row.id}`),
    sourceRef: row.sourceRef,
    priority: row.priority,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapResourceRuleRow(row: any): ResourceRule {
  return {
    id: row.id,
    draftId: row.draftId,
    name: row.name,
    category: row.category,
    summary: row.summary,
    ruleData: parseJsonValue(row.ruleDataJson, `ruleDataJson for resource rule ${row.id}`),
    sourceRef: row.sourceRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function getDraftOrThrow(db: AppDatabase, draftId: string): ResourceImportDraftWithPriority {
  const row = db.prepare(`
    SELECT id, job_id as jobId, kind, title, category, option_type as optionType, summary, content,
      source_type as sourceType, source_name as sourceName, source_file_name as sourceFileName,
      source_url as sourceUrl, source_version as sourceVersion, source_hash as sourceHash,
      source_license as sourceLicense, ruleset, language, visibility, is_private as isPrivate,
      imported_by as importedBy, content_hash as contentHash,
      keys_json as keysJson, source_ref as sourceRef, rule_data_json as ruleDataJson,
      prerequisites_json as prerequisitesJson, priority, raw_json as rawJson, status,
      rejection_reason as rejectionReason, created_at as createdAt, updated_at as updatedAt
    FROM resource_import_drafts
    WHERE id = ?
  `).get(draftId) as any;

  if (!row) {
    throw new ResourceReviewError(`resource import draft not found: ${draftId}`, 404);
  }

  return { ...mapDraftRow(row), priority: row.priority };
}

export function createResourceImportJob(db: AppDatabase, input: unknown): { job: ResourceImportJob; drafts: ResourceImportDraft[] } {
  const payload = normalizeResourceImportPayload(input);
  const jobId = nanoid();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO resource_import_jobs (
        id, name, source_type, source_name, source_file_name, source_url, source_version, source_hash,
        source_license, ruleset, language, visibility, is_private, imported_by, status, error_message,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobId,
      payload.name,
      payload.sourceType,
      payload.sourceName || payload.name,
      payload.sourceFileName,
      payload.sourceUrl,
      payload.sourceVersion,
      payload.sourceHash || hashJson(payload),
      payload.sourceLicense,
      payload.ruleset,
      payload.language,
      payload.visibility,
      payload.isPrivate ? 1 : 0,
      payload.importedBy,
      'imported',
      null,
      now,
      now
    );

    for (const draft of payload.drafts) {
      db.prepare(`
        INSERT INTO resource_import_drafts (
          id, job_id, kind, source_type, source_name, source_file_name, source_url, source_version,
          source_hash, source_license, ruleset, language, visibility, is_private, imported_by,
          content_hash, title, category, option_type, summary, content, keys_json,
          source_ref, rule_data_json, prerequisites_json, priority, raw_json, status,
          rejection_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        nanoid(),
        jobId,
        draft.kind,
        payload.sourceType,
        payload.sourceName || payload.name,
        payload.sourceFileName,
        payload.sourceUrl,
        payload.sourceVersion,
        payload.sourceHash || hashJson(payload),
        payload.sourceLicense,
        payload.ruleset,
        payload.language,
        payload.visibility,
        payload.isPrivate ? 1 : 0,
        payload.importedBy,
        hashJson(draft),
        draft.title,
        draft.category,
        draft.optionType ?? null,
        draft.summary,
        draft.content,
        JSON.stringify(draft.keys),
        draft.sourceRef,
        stringify(draft.ruleData),
        stringify(draft.prerequisites),
        draft.priority,
        stringify(draft),
        'pending',
        null,
        now,
        now
      );
    }
  })();

  const job = db.prepare(`
    SELECT id, name, source_type as sourceType, source_name as sourceName,
      source_file_name as sourceFileName, source_url as sourceUrl, source_version as sourceVersion,
      source_hash as sourceHash, source_license as sourceLicense, ruleset, language, visibility,
      is_private as isPrivate, imported_by as importedBy, status,
      error_message as errorMessage, created_at as createdAt, updated_at as updatedAt
    FROM resource_import_jobs WHERE id = ?
  `).get(jobId) as any;

  return { job: mapJobRow(job), drafts: listResourceImportDrafts(db, { jobId }) };
}

export function listResourceImportJobs(db: AppDatabase): ResourceImportJob[] {
  return (db.prepare(`
    SELECT id, name, source_type as sourceType, source_name as sourceName,
      source_file_name as sourceFileName, source_url as sourceUrl, source_version as sourceVersion,
      source_hash as sourceHash, source_license as sourceLicense, ruleset, language, visibility,
      is_private as isPrivate, imported_by as importedBy, status,
      error_message as errorMessage, created_at as createdAt, updated_at as updatedAt
    FROM resource_import_jobs
    ORDER BY created_at DESC
  `).all() as any[]).map(mapJobRow);
}

export function listResourceImportDrafts(db: AppDatabase, filters: ResourceImportDraftFilters): ResourceImportDraft[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters.kind) {
    clauses.push('kind = ?');
    params.push(filters.kind);
  }
  if (filters.sourceType) {
    clauses.push('source_type = ?');
    params.push(filters.sourceType);
  }
  if (filters.ruleset) {
    clauses.push('ruleset = ?');
    params.push(filters.ruleset);
  }
  if (filters.language) {
    clauses.push('language = ?');
    params.push(filters.language);
  }
  if (filters.jobId) {
    clauses.push('job_id = ?');
    params.push(filters.jobId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return (db.prepare(`
    SELECT id, job_id as jobId, kind, title, category, option_type as optionType, summary, content,
      source_type as sourceType, source_name as sourceName, source_file_name as sourceFileName,
      source_url as sourceUrl, source_version as sourceVersion, source_hash as sourceHash,
      source_license as sourceLicense, ruleset, language, visibility, is_private as isPrivate,
      imported_by as importedBy, content_hash as contentHash,
      keys_json as keysJson, source_ref as sourceRef, rule_data_json as ruleDataJson,
      prerequisites_json as prerequisitesJson, raw_json as rawJson, status,
      rejection_reason as rejectionReason, created_at as createdAt, updated_at as updatedAt
    FROM resource_import_drafts
    ${where}
    ORDER BY created_at ASC, title ASC
  `).all(...params) as any[]).map(mapDraftRow);
}

function materializeApprovedDraft(db: AppDatabase, draft: ResourceImportDraftWithPriority, now: string): void {
  if (draft.kind === 'rule_entry') {
    db.prepare(`
      INSERT INTO rule_world_book_entries (
        id, draft_id, title, category, summary, content, keys_json, source_ref, priority, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nanoid(),
      draft.id,
      draft.title,
      draft.category,
      draft.summary,
      draft.content || draft.summary,
      JSON.stringify(draft.keys),
      draft.sourceRef,
      draft.priority,
      1,
      now,
      now
    );
    return;
  }

  if (draft.kind === 'character_option') {
    if (!draft.optionType) {
      throw new ResourceReviewError('character_option drafts require optionType', 500);
    }

    db.prepare(`
      INSERT INTO character_options (
        id, draft_id, option_type, name, summary, rule_data_json, prerequisites_json, source_ref, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nanoid(),
      draft.id,
      draft.optionType,
      draft.title,
      draft.summary,
      stringify(draft.ruleData),
      stringify(draft.prerequisites),
      draft.sourceRef,
      now,
      now
    );
    return;
  }

  db.prepare(`
    INSERT INTO resource_rules (id, draft_id, name, category, summary, rule_data_json, source_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(),
    draft.id,
    draft.title,
    draft.category,
    draft.summary,
    stringify(draft.ruleData),
    draft.sourceRef,
    now,
    now
  );
}

export function reviewResourceImportDraft(db: AppDatabase, draftId: string, input: unknown): ResourceImportDraft {
  const review = draftReviewInputSchema.parse(input);
  const draft = getDraftOrThrow(db, draftId);

  if (draft.status !== 'pending') {
    throw new ResourceReviewError('Only pending resource import drafts can be reviewed', 409);
  }

  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      UPDATE resource_import_drafts
      SET status = ?, rejection_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(
      review.status,
      review.status === 'rejected' ? review.rejectionReason ?? null : null,
      now,
      draftId
    );

    if (review.status === 'approved') {
      materializeApprovedDraft(db, { ...draft, status: 'approved', rejectionReason: null, updatedAt: now }, now);
    }
  })();

  return getDraftOrThrow(db, draftId);
}

export function listApprovedCharacterOptions(db: AppDatabase, optionType?: CharacterOptionType): CharacterOption[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (optionType) {
    clauses.push('option_type = ?');
    params.push(optionType);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  return (db.prepare(`
    SELECT id, draft_id as draftId, option_type as optionType, name, summary,
      rule_data_json as ruleDataJson, prerequisites_json as prerequisitesJson,
      source_ref as sourceRef, created_at as createdAt, updated_at as updatedAt
    FROM character_options
    ${where}
    ORDER BY option_type ASC, name ASC
  `).all(...params) as any[]).map(mapCharacterOptionRow);
}

export function listApprovedRuleEntries(db: AppDatabase): RuleWorldBookEntry[] {
  return (db.prepare(`
    SELECT id, draft_id as draftId, title, category, summary, content, keys_json as keysJson,
      source_ref as sourceRef, priority, enabled, created_at as createdAt, updated_at as updatedAt
    FROM rule_world_book_entries
    WHERE enabled = 1
    ORDER BY priority DESC, title ASC
  `).all() as any[]).map(mapRuleEntryRow);
}

export function listApprovedResourceRules(db: AppDatabase): ResourceRule[] {
  return (db.prepare(`
    SELECT id, draft_id as draftId, name, category, summary, rule_data_json as ruleDataJson,
      source_ref as sourceRef, created_at as createdAt, updated_at as updatedAt
    FROM resource_rules
    ORDER BY category ASC, name ASC
  `).all() as any[]).map(mapResourceRuleRow);
}
