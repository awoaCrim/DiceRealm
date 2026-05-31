# 5e PHB Extraction Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first independently testable slice of the 5e PHB work: import PHB-derived extraction drafts, review them in the admin UI, and expose only approved rule entries, character options, and resource rules for future character-builder, embedding, and AI-DM plans.

**Architecture:** This plan creates a server-side PHB extraction service with clear boundaries: database schema owns persistence, `phbExtractionService` owns draft validation/review/materialization, admin resource routes expose HTTP APIs, and the client resource panel provides the first review UI. The approved spec spans several independent subsystems, so this plan intentionally covers Phase 1 only: extraction jobs, drafts, approval, and approved data catalogs. Embedding, player character builder, prompt injection, AI resource writes, and rollback are separate follow-up plans that consume the approved catalogs created here.

**Tech Stack:** TypeScript, Express, SQLite/better-sqlite3, Zod, React, Vite, Vitest, Testing Library.

---

## Scope Check

The approved spec covers five independent subsystems: PHB extraction/review, embedding/retrieval, player-side character builder, structured resource maintenance, and audit/rollback. Implementing all in one plan would be too large and hard to verify. This plan is the first sub-project and produces working software on its own:

- Admin can import a structured PHB extraction payload generated from a local private PHB PDF workflow.
- Imported rows are stored as reviewable drafts.
- Admin can approve or reject each draft.
- Approved drafts materialize into stable catalogs: rule entries, character options, and resource rules.
- Player/AI subsystems cannot use pending or rejected content because only approved catalog APIs are exposed.

Raw PDF parsing is not implemented in this plan because the current tool environment already failed to read the PHB PDF due missing `pdftoppm`; the first reliable implementation accepts structured extraction JSON produced from local PDF text extraction or AI-assisted offline parsing. A future extraction-plan can add native PDF parsing behind the same payload schema without changing the review/catalog APIs.

## File Structure

### Server files

- Modify: `server/src/db/schema.ts`
  - Add PHB extraction, draft, approved rule entry, approved character option, and approved resource rule tables.
  - Add indexes for status/kind/type review filters.
- Create: `server/src/services/phbExtractionService.ts`
  - Own Zod schemas, row mappers, import job creation, draft listing, review transitions, and approved catalog reads.
  - Materialize approved drafts into the correct approved table inside one transaction.
- Modify: `server/src/routes/adminResourceRoutes.ts`
  - Add admin resource endpoints under `/api/admin/resources/phb-*`.
- Modify: `server/src/domain/types.ts`
  - Add API-facing PHB extraction and approved catalog types.
- Test: `server/src/tests/phbExtractionService.test.ts`
  - Unit tests for validation, import, approval, rejection, and approved catalog isolation.
- Modify/Test: `server/src/tests/integration.test.ts`
  - API-level tests for import, list, approve/reject, and approved-only visibility.

### Client files

- Modify: `client/src/types.ts`
  - Mirror PHB extraction/catalog response types.
- Modify: `client/src/api.ts`
  - Add PHB extraction import/list/review/catalog calls.
- Create: `client/src/components/PhbExtractionPanel.tsx`
  - Admin UI for importing extraction JSON, listing jobs/drafts, approving/rejecting drafts, and viewing approved counts.
- Modify: `client/src/components/ResourceImportPanel.tsx`
  - Render `PhbExtractionPanel` in the global resource import area.
- Modify: `client/src/pages/AdminPage.tsx`
  - Pass PHB data refresh callbacks through existing resource panel flow only if needed by the final component API.
- Test: `client/src/phb-extraction-panel.test.tsx`
  - Component tests for import, approve, reject, and error display.
- Modify/Test: `client/src/ui-copy.test.tsx`
  - Add API mocks and one smoke assertion that the resource tab exposes PHB extraction UI.

### Documentation and verification

- Modify: `docs/superpowers/plans/2026-05-30-5e-phb-extraction-foundation.md`
  - Track execution with checkboxes.
- Do not commit automatically. If the user explicitly asks for a commit, use an `rtk git add ... && rtk git commit ...` command and include the required Claude co-author trailer.

---

## Task 1: Server PHB domain types and validation contract

**Files:**
- Modify: `server/src/domain/types.ts`
- Create: `server/src/tests/phbExtractionService.test.ts`
- Create: `server/src/services/phbExtractionService.ts`

- [x] **Step 1: Write failing service validation tests**

Create `server/src/tests/phbExtractionService.test.ts` with this initial content:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import {
  createPhbExtractionJob,
  listPhbExtractionDrafts,
  normalizePhbExtractionPayload
} from '../services/phbExtractionService.js';

describe('phbExtractionService', () => {
  it('normalizes a mixed PHB extraction payload into reviewable drafts', () => {
    const payload = normalizePhbExtractionPayload({
      name: 'PHB 1级角色核心抽取',
      sourceFileName: '5eDnD_玩家手册PHB_中译v1.72版.pdf',
      drafts: [
        {
          kind: 'rule_entry',
          title: '攻击检定',
          category: 'combat',
          summary: '进行攻击时掷 d20 并加上相关调整值与熟练加值。',
          content: '攻击检定用于判断攻击是否命中目标 AC。',
          keys: ['攻击检定', 'AC', '命中'],
          sourceRef: 'PHB p.194'
        },
        {
          kind: 'character_option',
          optionType: 'class',
          title: '战士',
          summary: '擅长武器与护甲的武技专家。',
          ruleData: { hitDie: 'd10', primaryAbilities: ['str', 'dex'] },
          prerequisites: {},
          sourceRef: 'PHB p.70'
        },
        {
          kind: 'resource_rule',
          title: '生命骰',
          category: 'rest',
          summary: '短休时可消耗生命骰恢复生命值。',
          ruleData: { resource: 'hit_dice', recovery: 'long_rest_half' },
          sourceRef: 'PHB p.186'
        }
      ]
    });

    expect(payload.name).toBe('PHB 1级角色核心抽取');
    expect(payload.sourceFileName).toBe('5eDnD_玩家手册PHB_中译v1.72版.pdf');
    expect(payload.drafts).toHaveLength(3);
    expect(payload.drafts[0]).toMatchObject({ kind: 'rule_entry', title: '攻击检定', status: 'pending' });
    expect(payload.drafts[1]).toMatchObject({ kind: 'character_option', optionType: 'class', title: '战士', status: 'pending' });
    expect(payload.drafts[2]).toMatchObject({ kind: 'resource_rule', title: '生命骰', status: 'pending' });
  });

  it('rejects character option drafts without optionType', () => {
    expect(() => normalizePhbExtractionPayload({
      name: '非法抽取',
      drafts: [{ kind: 'character_option', title: '缺类型', summary: '缺少 optionType。' }]
    })).toThrowError('character_option drafts require optionType');
  });

  it('creates a job and stores every draft as pending', () => {
    const db = createMemoryDb();
    migrate(db);

    try {
      const result = createPhbExtractionJob(db, {
        name: 'PHB 样例抽取',
        sourceFileName: 'phb.pdf',
        drafts: [
          { kind: 'rule_entry', title: '熟练加值', summary: '熟练时加入熟练加值。', keys: ['熟练'], sourceRef: 'PHB p.12' },
          { kind: 'character_option', optionType: 'skill', title: '察觉', summary: '感知相关技能。', sourceRef: 'PHB p.178' }
        ]
      });

      expect(result.job).toMatchObject({ name: 'PHB 样例抽取', sourceFileName: 'phb.pdf', status: 'imported' });
      expect(result.drafts).toHaveLength(2);
      expect(result.drafts.every((draft) => draft.status === 'pending')).toBe(true);
      expect(listPhbExtractionDrafts(db, {})).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
rtk npm test -- server/src/tests/phbExtractionService.test.ts
```

Expected: FAIL because `server/src/services/phbExtractionService.ts` does not exist.

- [x] **Step 3: Add server domain types**

Append these exports to `server/src/domain/types.ts` after the existing `RuleSource` interface and before `AiGeneration`:

```ts
export type PhbExtractionDraftKind = 'rule_entry' | 'character_option' | 'resource_rule';
export type PhbExtractionDraftStatus = 'pending' | 'approved' | 'rejected';
export type CharacterOptionType = 'species' | 'class' | 'background' | 'skill' | 'equipment' | 'spell' | 'language' | 'proficiency';
export type PhbExtractionJobStatus = 'imported' | 'failed';

export interface PhbExtractionJob {
  id: string;
  name: string;
  sourceFileName: string;
  sourceType: 'local_pdf_extraction';
  status: PhbExtractionJobStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PhbExtractionDraft {
  id: string;
  jobId: string;
  kind: PhbExtractionDraftKind;
  title: string;
  category: string;
  optionType: CharacterOptionType | null;
  summary: string;
  content: string;
  keys: string[];
  sourceRef: string;
  ruleData: unknown;
  prerequisites: unknown;
  raw: unknown;
  status: PhbExtractionDraftStatus;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterOption {
  id: string;
  draftId: string;
  optionType: CharacterOptionType;
  name: string;
  summary: string;
  ruleData: unknown;
  prerequisites: unknown;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuleWorldBookEntry {
  id: string;
  draftId: string;
  title: string;
  category: string;
  summary: string;
  content: string;
  keys: string[];
  sourceRef: string;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceRule {
  id: string;
  draftId: string;
  name: string;
  category: string;
  summary: string;
  ruleData: unknown;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
}
```

- [x] **Step 4: Create the minimal service contract**

Create `server/src/services/phbExtractionService.ts` with this content:

```ts
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import type {
  CharacterOption,
  CharacterOptionType,
  PhbExtractionDraft,
  PhbExtractionDraftKind,
  PhbExtractionDraftStatus,
  PhbExtractionJob,
  ResourceRule,
  RuleWorldBookEntry
} from '../domain/types.js';

const draftKindSchema = z.enum(['rule_entry', 'character_option', 'resource_rule']);
const characterOptionTypeSchema = z.enum(['species', 'class', 'background', 'skill', 'equipment', 'spell', 'language', 'proficiency']);
const draftStatusSchema = z.enum(['pending', 'approved', 'rejected']);

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
  status: draftStatusSchema.default('pending')
}).strict();

const extractionPayloadSchema = z.object({
  name: z.string().trim().min(1),
  sourceFileName: z.string().trim().default(''),
  drafts: z.array(draftInputSchema).min(1)
}).strict();

export type PhbExtractionDraftInput = z.infer<typeof draftInputSchema>;
export type PhbExtractionPayload = z.infer<typeof extractionPayloadSchema>;

export interface PhbExtractionDraftFilters {
  status?: PhbExtractionDraftStatus;
  kind?: PhbExtractionDraftKind;
}

export class PhbExtractionError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'PhbExtractionError';
  }
}

function parseJsonValue(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseStringArray(json: string): string[] {
  const value = parseJsonValue(json);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function normalizePhbExtractionPayload(input: unknown): PhbExtractionPayload {
  const payload = extractionPayloadSchema.parse(input);
  for (const draft of payload.drafts) {
    if (draft.kind === 'character_option' && !draft.optionType) {
      throw new PhbExtractionError('character_option drafts require optionType', 400);
    }
  }
  return payload;
}

function mapJobRow(row: any): PhbExtractionJob {
  return {
    id: row.id,
    name: row.name,
    sourceFileName: row.sourceFileName,
    sourceType: row.sourceType,
    status: row.status,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapDraftRow(row: any): PhbExtractionDraft {
  return {
    id: row.id,
    jobId: row.jobId,
    kind: row.kind,
    title: row.title,
    category: row.category,
    optionType: row.optionType,
    summary: row.summary,
    content: row.content,
    keys: parseStringArray(row.keysJson),
    sourceRef: row.sourceRef,
    ruleData: parseJsonValue(row.ruleDataJson),
    prerequisites: parseJsonValue(row.prerequisitesJson),
    raw: parseJsonValue(row.rawJson),
    status: row.status,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function createPhbExtractionJob(db: AppDatabase, input: unknown): { job: PhbExtractionJob; drafts: PhbExtractionDraft[] } {
  const payload = normalizePhbExtractionPayload(input);
  const jobId = nanoid();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO phb_extraction_jobs (id, name, source_file_name, source_type, status, error_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, payload.name, payload.sourceFileName, 'local_pdf_extraction', 'imported', null, now, now);

    for (const draft of payload.drafts) {
      db.prepare(`
        INSERT INTO phb_extraction_drafts (
          id, job_id, kind, title, category, option_type, summary, content, keys_json,
          source_ref, rule_data_json, prerequisites_json, priority, raw_json, status,
          rejection_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        nanoid(),
        jobId,
        draft.kind,
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
    SELECT id, name, source_file_name as sourceFileName, source_type as sourceType, status,
      error_message as errorMessage, created_at as createdAt, updated_at as updatedAt
    FROM phb_extraction_jobs WHERE id = ?
  `).get(jobId) as any;

  return { job: mapJobRow(job), drafts: listPhbExtractionDrafts(db, {}).filter((draft) => draft.jobId === jobId) };
}

export function listPhbExtractionJobs(db: AppDatabase): PhbExtractionJob[] {
  return (db.prepare(`
    SELECT id, name, source_file_name as sourceFileName, source_type as sourceType, status,
      error_message as errorMessage, created_at as createdAt, updated_at as updatedAt
    FROM phb_extraction_jobs
    ORDER BY created_at DESC
  `).all() as any[]).map(mapJobRow);
}

export function listPhbExtractionDrafts(db: AppDatabase, filters: PhbExtractionDraftFilters): PhbExtractionDraft[] {
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
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return (db.prepare(`
    SELECT id, job_id as jobId, kind, title, category, option_type as optionType, summary, content,
      keys_json as keysJson, source_ref as sourceRef, rule_data_json as ruleDataJson,
      prerequisites_json as prerequisitesJson, raw_json as rawJson, status,
      rejection_reason as rejectionReason, created_at as createdAt, updated_at as updatedAt
    FROM phb_extraction_drafts
    ${where}
    ORDER BY created_at ASC, title ASC
  `).all(...params) as any[]).map(mapDraftRow);
}

export function listApprovedCharacterOptions(_db: AppDatabase): CharacterOption[] {
  return [];
}

export function listApprovedRuleEntries(_db: AppDatabase): RuleWorldBookEntry[] {
  return [];
}

export function listApprovedResourceRules(_db: AppDatabase): ResourceRule[] {
  return [];
}
```

- [x] **Step 5: Run the test again**

Run:

```bash
rtk npm test -- server/src/tests/phbExtractionService.test.ts
```

Expected: FAIL because the database tables do not exist.

---

## Task 2: Database schema for PHB extraction and approved catalogs

**Files:**
- Modify: `server/src/db/schema.ts`
- Test: `server/src/tests/phbExtractionService.test.ts`

- [x] **Step 1: Add schema assertions to the existing service test file**

Append this test inside the existing `describe('phbExtractionService', () => { ... })` block in `server/src/tests/phbExtractionService.test.ts`:

```ts
  it('migrates PHB extraction and approved catalog tables', () => {
    const db = createMemoryDb();
    migrate(db);

    try {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'phb_extraction_jobs',
            'phb_extraction_drafts',
            'rule_world_book_entries',
            'character_options',
            'resource_rules'
          )
        ORDER BY name ASC
      `).all() as Array<{ name: string }>;

      expect(tables.map((row) => row.name)).toEqual([
        'character_options',
        'phb_extraction_drafts',
        'phb_extraction_jobs',
        'resource_rules',
        'rule_world_book_entries'
      ]);
    } finally {
      db.close();
    }
  });
```

- [x] **Step 2: Run test to verify schema failure**

Run:

```bash
rtk npm test -- server/src/tests/phbExtractionService.test.ts
```

Expected: FAIL because the new table list is empty or incomplete.

- [x] **Step 3: Add database tables and indexes**

In `server/src/db/schema.ts`, add this SQL block inside the existing `db.exec(` template, after the `rule_sources` table and before `turns`:

```sql
    CREATE TABLE IF NOT EXISTS phb_extraction_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_file_name TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS phb_extraction_drafts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES phb_extraction_jobs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      option_type TEXT,
      summary TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      keys_json TEXT NOT NULL DEFAULT '[]',
      source_ref TEXT NOT NULL DEFAULT '',
      rule_data_json TEXT NOT NULL DEFAULT '{}',
      prerequisites_json TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 100,
      raw_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      rejection_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rule_world_book_entries (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL UNIQUE REFERENCES phb_extraction_drafts(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      keys_json TEXT NOT NULL DEFAULT '[]',
      source_ref TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS character_options (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL UNIQUE REFERENCES phb_extraction_drafts(id) ON DELETE CASCADE,
      option_type TEXT NOT NULL,
      name TEXT NOT NULL,
      summary TEXT NOT NULL,
      rule_data_json TEXT NOT NULL DEFAULT '{}',
      prerequisites_json TEXT NOT NULL DEFAULT '{}',
      source_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_rules (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL UNIQUE REFERENCES phb_extraction_drafts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      summary TEXT NOT NULL,
      rule_data_json TEXT NOT NULL DEFAULT '{}',
      source_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
```

After the existing `db.exec(...)` call and before `repair`/`ALTER TABLE` logic, add these index statements:

```ts
  db.prepare('CREATE INDEX IF NOT EXISTS phb_extraction_drafts_status_idx ON phb_extraction_drafts(status)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS phb_extraction_drafts_kind_idx ON phb_extraction_drafts(kind)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS character_options_type_idx ON character_options(option_type)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS rule_world_book_entries_category_idx ON rule_world_book_entries(category)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS resource_rules_category_idx ON resource_rules(category)').run();
```

- [x] **Step 4: Run service tests**

Run:

```bash
rtk npm test -- server/src/tests/phbExtractionService.test.ts
```

Expected: PASS for the normalization/import/schema tests.

---

## Task 3: Draft review transitions and approved materialization

**Files:**
- Modify: `server/src/tests/phbExtractionService.test.ts`
- Modify: `server/src/services/phbExtractionService.ts`

- [x] **Step 1: Write failing approval and rejection tests**

Append these tests inside `server/src/tests/phbExtractionService.test.ts`:

```ts
  it('approves drafts into the correct approved catalogs', () => {
    const db = createMemoryDb();
    migrate(db);

    try {
      const { drafts } = createPhbExtractionJob(db, {
        name: 'PHB 审核样例',
        drafts: [
          { kind: 'rule_entry', title: '优势与劣势', category: 'checks', summary: '优势掷两个 d20 取高。', content: '优势和劣势改变 d20 检定取值。', keys: ['优势', '劣势'], sourceRef: 'PHB p.173' },
          { kind: 'character_option', optionType: 'class', title: '法师', summary: '通过研习法术施法。', ruleData: { hitDie: 'd6' }, prerequisites: {}, sourceRef: 'PHB p.112' },
          { kind: 'resource_rule', title: '法术位', category: 'spellcasting', summary: '施放法术会消耗对应环阶法术位。', ruleData: { resource: 'spell_slots' }, sourceRef: 'PHB p.201' }
        ]
      });

      reviewPhbExtractionDraft(db, drafts[0].id, { status: 'approved' });
      reviewPhbExtractionDraft(db, drafts[1].id, { status: 'approved' });
      reviewPhbExtractionDraft(db, drafts[2].id, { status: 'approved' });

      expect(listApprovedRuleEntries(db)).toEqual([expect.objectContaining({ title: '优势与劣势', keys: ['优势', '劣势'], enabled: true })]);
      expect(listApprovedCharacterOptions(db)).toEqual([expect.objectContaining({ optionType: 'class', name: '法师', ruleData: { hitDie: 'd6' } })]);
      expect(listApprovedResourceRules(db)).toEqual([expect.objectContaining({ name: '法术位', category: 'spellcasting', ruleData: { resource: 'spell_slots' } })]);
    } finally {
      db.close();
    }
  });

  it('rejects drafts without exposing them in approved catalogs', () => {
    const db = createMemoryDb();
    migrate(db);

    try {
      const { drafts } = createPhbExtractionJob(db, {
        name: 'PHB 拒绝样例',
        drafts: [{ kind: 'character_option', optionType: 'equipment', title: '错误装备', summary: '抽取错误。', sourceRef: 'PHB p.1' }]
      });

      const rejected = reviewPhbExtractionDraft(db, drafts[0].id, { status: 'rejected', rejectionReason: '页码匹配错误' });

      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectionReason).toBe('页码匹配错误');
      expect(listApprovedCharacterOptions(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('does not allow reviewing the same draft twice', () => {
    const db = createMemoryDb();
    migrate(db);

    try {
      const { drafts } = createPhbExtractionJob(db, {
        name: 'PHB 重复审核样例',
        drafts: [{ kind: 'rule_entry', title: 'DC', summary: '难度等级。', content: 'DM 设置 DC 表示任务难度。' }]
      });

      reviewPhbExtractionDraft(db, drafts[0].id, { status: 'approved' });
      expect(() => reviewPhbExtractionDraft(db, drafts[0].id, { status: 'rejected', rejectionReason: '重复' }))
        .toThrowError('Only pending PHB drafts can be reviewed');
    } finally {
      db.close();
    }
  });
```

Update the import list at the top of `server/src/tests/phbExtractionService.test.ts`:

```ts
import {
  createPhbExtractionJob,
  listApprovedCharacterOptions,
  listApprovedResourceRules,
  listApprovedRuleEntries,
  listPhbExtractionDrafts,
  normalizePhbExtractionPayload,
  reviewPhbExtractionDraft
} from '../services/phbExtractionService.js';
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
rtk npm test -- server/src/tests/phbExtractionService.test.ts
```

Expected: FAIL because `reviewPhbExtractionDraft` is not exported and approved catalog mappers return empty arrays.

- [x] **Step 3: Implement review and catalog mappers**

In `server/src/services/phbExtractionService.ts`, replace the three empty approved-list functions and add the review helpers before them:

```ts
export interface PhbDraftReviewInput {
  status: 'approved' | 'rejected';
  rejectionReason?: string;
}

function getDraftOrThrow(db: AppDatabase, draftId: string): PhbExtractionDraft {
  const draft = listPhbExtractionDrafts(db, {}).find((item) => item.id === draftId);
  if (!draft) throw new PhbExtractionError('PHB extraction draft not found', 404);
  return draft;
}

function materializeApprovedDraft(db: AppDatabase, draft: PhbExtractionDraft, now: string): void {
  if (draft.kind === 'rule_entry') {
    db.prepare(`
      INSERT INTO rule_world_book_entries (id, draft_id, title, category, summary, content, keys_json, source_ref, priority, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nanoid(), draft.id, draft.title, draft.category, draft.summary, draft.content || draft.summary, JSON.stringify(draft.keys), draft.sourceRef, 100, 1, now, now);
    return;
  }

  if (draft.kind === 'character_option') {
    if (!draft.optionType) throw new PhbExtractionError('Approved character option draft is missing optionType', 500);
    db.prepare(`
      INSERT INTO character_options (id, draft_id, option_type, name, summary, rule_data_json, prerequisites_json, source_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nanoid(), draft.id, draft.optionType, draft.title, draft.summary, stringify(draft.ruleData), stringify(draft.prerequisites), draft.sourceRef, now, now);
    return;
  }

  db.prepare(`
    INSERT INTO resource_rules (id, draft_id, name, category, summary, rule_data_json, source_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nanoid(), draft.id, draft.title, draft.category, draft.summary, stringify(draft.ruleData), draft.sourceRef, now, now);
}

export function reviewPhbExtractionDraft(db: AppDatabase, draftId: string, input: PhbDraftReviewInput): PhbExtractionDraft {
  const draft = getDraftOrThrow(db, draftId);
  if (draft.status !== 'pending') {
    throw new PhbExtractionError('Only pending PHB drafts can be reviewed', 409);
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE phb_extraction_drafts SET status = ?, rejection_reason = ?, updated_at = ? WHERE id = ?')
      .run(input.status, input.status === 'rejected' ? input.rejectionReason ?? '' : null, now, draftId);
    if (input.status === 'approved') {
      materializeApprovedDraft(db, draft, now);
    }
  })();

  return getDraftOrThrow(db, draftId);
}

function mapCharacterOptionRow(row: any): CharacterOption {
  return {
    id: row.id,
    draftId: row.draftId,
    optionType: row.optionType as CharacterOptionType,
    name: row.name,
    summary: row.summary,
    ruleData: parseJsonValue(row.ruleDataJson),
    prerequisites: parseJsonValue(row.prerequisitesJson),
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
    keys: parseStringArray(row.keysJson),
    sourceRef: row.sourceRef,
    priority: row.priority,
    enabled: Boolean(row.enabled),
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
    ruleData: parseJsonValue(row.ruleDataJson),
    sourceRef: row.sourceRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function listApprovedCharacterOptions(db: AppDatabase, optionType?: CharacterOptionType): CharacterOption[] {
  const rows = optionType
    ? db.prepare(`
        SELECT id, draft_id as draftId, option_type as optionType, name, summary,
          rule_data_json as ruleDataJson, prerequisites_json as prerequisitesJson,
          source_ref as sourceRef, created_at as createdAt, updated_at as updatedAt
        FROM character_options
        WHERE option_type = ?
        ORDER BY option_type ASC, name ASC
      `).all(optionType)
    : db.prepare(`
        SELECT id, draft_id as draftId, option_type as optionType, name, summary,
          rule_data_json as ruleDataJson, prerequisites_json as prerequisitesJson,
          source_ref as sourceRef, created_at as createdAt, updated_at as updatedAt
        FROM character_options
        ORDER BY option_type ASC, name ASC
      `).all();
  return (rows as any[]).map(mapCharacterOptionRow);
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
```

- [x] **Step 4: Run service tests**

Run:

```bash
rtk npm test -- server/src/tests/phbExtractionService.test.ts
```

Expected: PASS.

---

## Task 4: Admin API endpoints for PHB extraction and review

**Files:**
- Modify: `server/src/tests/integration.test.ts`
- Modify: `server/src/routes/adminResourceRoutes.ts`

- [x] **Step 1: Write failing integration test**

Append this test inside `describe('DND AI-DM integration', () => { ... })` in `server/src/tests/integration.test.ts`:

```ts
  it('imports, reviews, and exposes PHB extraction catalogs through admin resource APIs', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const importRes = await fetch(`${base}/api/admin/resources/phb-extractions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'PHB API 抽取',
          sourceFileName: 'phb.pdf',
          drafts: [
            { kind: 'rule_entry', title: '攻击检定', category: 'combat', summary: '攻击检定摘要。', content: '攻击检定正文。', keys: ['攻击检定'], sourceRef: 'PHB p.194' },
            { kind: 'character_option', optionType: 'class', title: '战士', summary: '战士摘要。', ruleData: { hitDie: 'd10' }, sourceRef: 'PHB p.70' },
            { kind: 'resource_rule', title: '生命骰', category: 'rest', summary: '生命骰摘要。', ruleData: { resource: 'hit_dice' }, sourceRef: 'PHB p.186' }
          ]
        })
      });
      expect(importRes.status).toBe(200);
      const imported = await importRes.json() as { drafts: Array<{ id: string; title: string; status: string }> };
      expect(imported.drafts.map((draft) => draft.status)).toEqual(['pending', 'pending', 'pending']);

      const pendingRes = await fetch(`${base}/api/admin/resources/phb-extraction-drafts?status=pending`);
      expect(pendingRes.status).toBe(200);
      const pending = await pendingRes.json() as { drafts: Array<{ id: string; title: string }> };
      expect(pending.drafts).toHaveLength(3);

      const approveRes = await fetch(`${base}/api/admin/resources/phb-extraction-drafts/${pending.drafts[0].id}/review`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' })
      });
      expect(approveRes.status).toBe(200);

      const rejectRes = await fetch(`${base}/api/admin/resources/phb-extraction-drafts/${pending.drafts[1].id}/review`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'rejected', rejectionReason: '先不开放该职业' })
      });
      expect(rejectRes.status).toBe(200);

      const catalogRes = await fetch(`${base}/api/admin/resources/phb-approved`);
      expect(catalogRes.status).toBe(200);
      const catalog = await catalogRes.json() as { ruleEntries: unknown[]; characterOptions: unknown[]; resourceRules: unknown[] };
      expect(catalog.ruleEntries).toHaveLength(1);
      expect(catalog.characterOptions).toHaveLength(0);
      expect(catalog.resourceRules).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

- [x] **Step 2: Run integration test to verify failure**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "imports, reviews, and exposes PHB extraction catalogs"
```

Expected: FAIL with a 404 for `/api/admin/resources/phb-extractions`.

- [x] **Step 3: Add route imports and schemas**

In `server/src/routes/adminResourceRoutes.ts`, add these imports after the existing service imports:

```ts
import {
  createPhbExtractionJob,
  listApprovedCharacterOptions,
  listApprovedResourceRules,
  listApprovedRuleEntries,
  listPhbExtractionDrafts,
  listPhbExtractionJobs,
  PhbExtractionError,
  reviewPhbExtractionDraft
} from '../services/phbExtractionService.js';
```

Add these schemas after `importPresetPackageSchema`:

```ts
const phbDraftKindSchema = z.enum(['rule_entry', 'character_option', 'resource_rule']);
const phbDraftStatusSchema = z.enum(['pending', 'approved', 'rejected']);
const phbImportSchema = z.object({
  name: z.string().min(1),
  sourceFileName: z.string().default(''),
  drafts: z.array(z.unknown()).min(1)
}).strict();
const phbReviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().default('')
}).strict();

function handlePhbResourceError(error: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid PHB extraction payload', issues: error.issues });
    return;
  }
  if (error instanceof PhbExtractionError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}
```

- [x] **Step 4: Add PHB admin resource routes**

Inside `registerAdminResourceRoutes(router, db)`, after the existing `/resources/world-books` routes and before `/resources/preset-packages`, add:

```ts
  router.get('/resources/phb-extractions', (_req, res) => {
    res.json({ jobs: listPhbExtractionJobs(db) });
  });

  router.post('/resources/phb-extractions', (req, res) => {
    try {
      const input = phbImportSchema.parse(req.body);
      res.json(createPhbExtractionJob(db, input));
    } catch (error) {
      handlePhbResourceError(error, res);
    }
  });

  router.get('/resources/phb-extraction-drafts', (req, res) => {
    try {
      const status = req.query.status ? phbDraftStatusSchema.parse(req.query.status) : undefined;
      const kind = req.query.kind ? phbDraftKindSchema.parse(req.query.kind) : undefined;
      res.json({ drafts: listPhbExtractionDrafts(db, { status, kind }) });
    } catch (error) {
      handlePhbResourceError(error, res);
    }
  });

  router.put('/resources/phb-extraction-drafts/:draftId/review', (req, res) => {
    try {
      const input = phbReviewSchema.parse(req.body);
      res.json({ draft: reviewPhbExtractionDraft(db, req.params.draftId, input) });
    } catch (error) {
      handlePhbResourceError(error, res);
    }
  });

  router.get('/resources/phb-approved', (_req, res) => {
    res.json({
      ruleEntries: listApprovedRuleEntries(db),
      characterOptions: listApprovedCharacterOptions(db),
      resourceRules: listApprovedResourceRules(db)
    });
  });
```

- [x] **Step 5: Run focused integration test**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "imports, reviews, and exposes PHB extraction catalogs"
```

Expected: PASS.

- [x] **Step 6: Run all server-side tests touched by this feature**

Run:

```bash
rtk npm test -- server/src/tests/phbExtractionService.test.ts server/src/tests/integration.test.ts
```

Expected: PASS.

---

## Task 5: Client API types and request functions

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/api.ts`
- Test: `client/src/api.test.tsx`

- [x] **Step 1: Write failing API test**

If `client/src/api.test.tsx` already exists, append this test to its current `describe` block. If the file structure differs, add this test near the other `jsonRequest` API tests:

```ts
  it('imports and reviews PHB extraction drafts through admin resource APIs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: { id: 'job-1' }, drafts: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ drafts: [{ id: 'draft-1', status: 'pending' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ draft: { id: 'draft-1', status: 'approved' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ruleEntries: [], characterOptions: [], resourceRules: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await importPhbExtraction({ name: 'PHB', sourceFileName: 'phb.pdf', drafts: [{ kind: 'rule_entry', title: '检定', summary: '摘要' }] });
    await listPhbExtractionDrafts({ status: 'pending' });
    await reviewPhbExtractionDraft('draft-1', { status: 'approved' });
    await getApprovedPhbCatalog();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/resources/phb-extractions', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/resources/phb-extraction-drafts?status=pending', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/resources/phb-extraction-drafts/draft-1/review', expect.objectContaining({ method: 'PUT' }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/admin/resources/phb-approved', expect.any(Object));

    fetchMock.mockRestore();
  });
```

Update the imports in `client/src/api.test.tsx` to include:

```ts
import {
  getApprovedPhbCatalog,
  importPhbExtraction,
  listPhbExtractionDrafts,
  reviewPhbExtractionDraft
} from './api';
```

- [x] **Step 2: Run test to verify missing exports**

Run:

```bash
rtk npm test -- client/src/api.test.tsx -t "imports and reviews PHB extraction drafts"
```

Expected: FAIL because the PHB API functions do not exist.

- [x] **Step 3: Add client types**

Append these types to `client/src/types.ts` after `RuleSource`-adjacent or resource-related types:

```ts
export type PhbExtractionDraftKind = 'rule_entry' | 'character_option' | 'resource_rule';
export type PhbExtractionDraftStatus = 'pending' | 'approved' | 'rejected';
export type CharacterOptionType = 'species' | 'class' | 'background' | 'skill' | 'equipment' | 'spell' | 'language' | 'proficiency';

export interface PhbExtractionJob {
  id: string;
  name: string;
  sourceFileName: string;
  sourceType: 'local_pdf_extraction';
  status: 'imported' | 'failed';
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PhbExtractionDraft {
  id: string;
  jobId: string;
  kind: PhbExtractionDraftKind;
  title: string;
  category: string;
  optionType: CharacterOptionType | null;
  summary: string;
  content: string;
  keys: string[];
  sourceRef: string;
  ruleData: JsonValue;
  prerequisites: JsonValue;
  raw: JsonValue;
  status: PhbExtractionDraftStatus;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterOption {
  id: string;
  draftId: string;
  optionType: CharacterOptionType;
  name: string;
  summary: string;
  ruleData: JsonValue;
  prerequisites: JsonValue;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuleWorldBookEntry {
  id: string;
  draftId: string;
  title: string;
  category: string;
  summary: string;
  content: string;
  keys: string[];
  sourceRef: string;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceRule {
  id: string;
  draftId: string;
  name: string;
  category: string;
  summary: string;
  ruleData: JsonValue;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface PhbExtractionImportInput {
  name: string;
  sourceFileName?: string;
  drafts: Array<{
    kind: PhbExtractionDraftKind;
    title: string;
    category?: string;
    optionType?: CharacterOptionType;
    summary: string;
    content?: string;
    keys?: string[];
    sourceRef?: string;
    ruleData?: JsonValue;
    prerequisites?: JsonValue;
    priority?: number;
  }>;
}
```

- [x] **Step 4: Add API functions**

In `client/src/api.ts`, add these imports to the existing type import list:

```ts
  CharacterOption,
  PhbExtractionDraft,
  PhbExtractionDraftKind,
  PhbExtractionDraftStatus,
  PhbExtractionImportInput,
  PhbExtractionJob,
  ResourceRule,
  RuleWorldBookEntry,
```

Add these functions after the existing resource world book API functions:

```ts
export function importPhbExtraction(input: PhbExtractionImportInput) {
  return jsonRequest<{ job: PhbExtractionJob; drafts: PhbExtractionDraft[] }>('/api/admin/resources/phb-extractions', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function listPhbExtractionJobs() {
  return jsonRequest<{ jobs: PhbExtractionJob[] }>('/api/admin/resources/phb-extractions');
}

export function listPhbExtractionDrafts(filters: { status?: PhbExtractionDraftStatus; kind?: PhbExtractionDraftKind } = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.kind) params.set('kind', filters.kind);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return jsonRequest<{ drafts: PhbExtractionDraft[] }>(`/api/admin/resources/phb-extraction-drafts${suffix}`);
}

export function reviewPhbExtractionDraft(draftId: string, input: { status: 'approved' | 'rejected'; rejectionReason?: string }) {
  return jsonRequest<{ draft: PhbExtractionDraft }>(`/api/admin/resources/phb-extraction-drafts/${draftId}/review`, {
    method: 'PUT',
    body: JSON.stringify(input)
  });
}

export function getApprovedPhbCatalog() {
  return jsonRequest<{ ruleEntries: RuleWorldBookEntry[]; characterOptions: CharacterOption[]; resourceRules: ResourceRule[] }>('/api/admin/resources/phb-approved');
}
```

- [x] **Step 5: Run client API test**

Run:

```bash
rtk npm test -- client/src/api.test.tsx -t "imports and reviews PHB extraction drafts"
```

Expected: PASS.

---

## Task 6: Admin PHB extraction panel UI

**Files:**
- Create: `client/src/components/PhbExtractionPanel.tsx`
- Create: `client/src/phb-extraction-panel.test.tsx`
- Modify: `client/src/components/ResourceImportPanel.tsx`
- Modify: `client/src/ui-copy.test.tsx`

- [x] **Step 1: Write failing component test**

Create `client/src/phb-extraction-panel.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PhbExtractionPanel } from './components/PhbExtractionPanel';
import * as api from './api';

vi.mock('./api', () => ({
  getApprovedPhbCatalog: vi.fn(async () => ({ ruleEntries: [], characterOptions: [], resourceRules: [] })),
  importPhbExtraction: vi.fn(async () => ({ job: { id: 'job-1', name: 'PHB', sourceFileName: 'phb.json' }, drafts: [] })),
  listPhbExtractionDrafts: vi.fn(async () => ({
    drafts: [{
      id: 'draft-1',
      jobId: 'job-1',
      kind: 'rule_entry',
      title: '攻击检定',
      category: 'combat',
      optionType: null,
      summary: '攻击检定摘要。',
      content: '攻击检定正文。',
      keys: ['攻击检定'],
      sourceRef: 'PHB p.194',
      ruleData: {},
      prerequisites: {},
      raw: {},
      status: 'pending',
      rejectionReason: null,
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z'
    }]
  })),
  listPhbExtractionJobs: vi.fn(async () => ({ jobs: [] })),
  reviewPhbExtractionDraft: vi.fn(async (_draftId: string, input: { status: 'approved' | 'rejected'; rejectionReason?: string }) => ({
    draft: { id: 'draft-1', status: input.status }
  }))
}));

describe('PhbExtractionPanel', () => {
  it('loads pending drafts and approves one draft', async () => {
    const user = userEvent.setup();
    const setError = vi.fn();
    render(<PhbExtractionPanel setError={setError} />);

    expect(await screen.findByText('PHB 抽取与审核')).toBeInTheDocument();
    expect(await screen.findByText('攻击检定')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '批准' }));

    await waitFor(() => expect(api.reviewPhbExtractionDraft).toHaveBeenCalledWith('draft-1', { status: 'approved' }));
    expect(setError).toHaveBeenCalledWith('');
  });

  it('imports structured extraction JSON from a local file', async () => {
    const user = userEvent.setup();
    const setError = vi.fn();
    render(<PhbExtractionPanel setError={setError} />);

    const file = new File([JSON.stringify({
      name: 'PHB 导入',
      sourceFileName: 'phb.pdf',
      drafts: [{ kind: 'rule_entry', title: '检定', summary: '检定摘要。' }]
    })], 'phb-extraction.json', { type: 'application/json' });

    await user.upload(await screen.findByLabelText('PHB 抽取 JSON'), file);

    await waitFor(() => expect(api.importPhbExtraction).toHaveBeenCalledWith({
      name: 'PHB 导入',
      sourceFileName: 'phb.pdf',
      drafts: [{ kind: 'rule_entry', title: '检定', summary: '检定摘要。' }]
    }));
  });
});
```

- [x] **Step 2: Run component test to verify failure**

Run:

```bash
rtk npm test -- client/src/phb-extraction-panel.test.tsx
```

Expected: FAIL because `PhbExtractionPanel` does not exist.

- [x] **Step 3: Create `PhbExtractionPanel`**

Create `client/src/components/PhbExtractionPanel.tsx`:

```tsx
import { useEffect, useState, type ChangeEvent } from 'react';
import {
  getApprovedPhbCatalog,
  importPhbExtraction,
  listPhbExtractionDrafts,
  listPhbExtractionJobs,
  reviewPhbExtractionDraft
} from '../api';
import type { PhbExtractionDraft, PhbExtractionImportInput, PhbExtractionJob } from '../types';

function isImportPayload(value: unknown): value is PhbExtractionImportInput {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { name?: unknown }).name === 'string'
    && Array.isArray((value as { drafts?: unknown }).drafts);
}

export function PhbExtractionPanel({ setError }: { setError: (message: string) => void }) {
  const [jobs, setJobs] = useState<PhbExtractionJob[]>([]);
  const [drafts, setDrafts] = useState<PhbExtractionDraft[]>([]);
  const [approvedCounts, setApprovedCounts] = useState({ ruleEntries: 0, characterOptions: 0, resourceRules: 0 });
  const [message, setMessage] = useState('');

  async function refresh() {
    const [jobsResult, draftsResult, approvedResult] = await Promise.all([
      listPhbExtractionJobs(),
      listPhbExtractionDrafts({ status: 'pending' }),
      getApprovedPhbCatalog()
    ]);
    setJobs(jobsResult.jobs);
    setDrafts(draftsResult.drafts);
    setApprovedCounts({
      ruleEntries: approvedResult.ruleEntries.length,
      characterOptions: approvedResult.characterOptions.length,
      resourceRules: approvedResult.resourceRules.length
    });
  }

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function importFile(file: File | undefined) {
    if (!file) return;
    setError('');
    setMessage('');
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isImportPayload(parsed)) throw new Error('PHB 抽取 JSON 必须包含 name 和 drafts。');
      const result = await importPhbExtraction(parsed);
      setMessage(`已导入 ${result.drafts.length} 条 PHB 草稿。`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    try {
      await importFile(file);
    } finally {
      input.value = '';
    }
  }

  async function approveDraft(draftId: string) {
    setError('');
    await reviewPhbExtractionDraft(draftId, { status: 'approved' });
    setMessage('草稿已批准。');
    await refresh();
  }

  async function rejectDraft(draftId: string) {
    setError('');
    await reviewPhbExtractionDraft(draftId, { status: 'rejected', rejectionReason: '管理员在审核列表中拒绝。' });
    setMessage('草稿已拒绝。');
    await refresh();
  }

  return (
    <section className="subcard">
      <h3>PHB 抽取与审核</h3>
      <p className="muted">导入本地 PHB PDF 抽取出来的结构化 JSON；未批准草稿不会进入角色构筑器或 AI-DM 规则注入。</p>
      <label>PHB 抽取 JSON<input aria-label="PHB 抽取 JSON" type="file" accept="application/json,.json" onChange={(event) => void handleFileChange(event)} /></label>
      {message ? <p>{message}</p> : null}
      <p>抽取任务：{jobs.length}</p>
      <p>已批准规则：{approvedCounts.ruleEntries} · 角色选项：{approvedCounts.characterOptions} · 资源规则：{approvedCounts.resourceRules}</p>
      <h4>待审核草稿</h4>
      {drafts.length === 0 ? <p className="muted">暂无待审核 PHB 草稿。</p> : null}
      {drafts.map((draft) => (
        <div className="log-entry" key={draft.id}>
          <strong>{draft.title}</strong>
          <p className="muted">{draft.kind}{draft.optionType ? ` · ${draft.optionType}` : ''} · {draft.category} · {draft.sourceRef || '未记录来源'}</p>
          <p>{draft.summary}</p>
          <div className="button-row">
            <button onClick={() => void approveDraft(draft.id)}>批准</button>
            <button onClick={() => void rejectDraft(draft.id)}>拒绝</button>
          </div>
        </div>
      ))}
    </section>
  );
}
```

- [x] **Step 4: Render the panel in resource import UI**

In `client/src/components/ResourceImportPanel.tsx`, add this import:

```ts
import { PhbExtractionPanel } from './PhbExtractionPanel';
```

Render the panel after the “导入 ST 世界书” subcard and before the “导入 ST 预设包” subcard:

```tsx
      <PhbExtractionPanel setError={setError} />
```

- [x] **Step 5: Update UI smoke test mocks**

In `client/src/ui-copy.test.tsx`, add these mocked API functions to the existing `vi.mock('./api', () => ({ ... }))` object:

```ts
  getApprovedPhbCatalog: vi.fn(async () => ({ ruleEntries: [], characterOptions: [], resourceRules: [] })),
  importPhbExtraction: vi.fn(),
  listPhbExtractionDrafts: vi.fn(async () => ({ drafts: [] })),
  listPhbExtractionJobs: vi.fn(async () => ({ jobs: [] })),
  reviewPhbExtractionDraft: vi.fn(),
```

Add this smoke test near the other admin resource UI tests:

```tsx
it('资源页展示 PHB 抽取与审核入口', async () => {
  const user = userEvent.setup();
  render(<AdminPage roomId="room-1" />);

  await user.click(await screen.findByRole('button', { name: '资源' }));

  expect(await screen.findByText('PHB 抽取与审核')).toBeInTheDocument();
  expect(screen.getByText('未批准草稿不会进入角色构筑器或 AI-DM 规则注入。')).toBeInTheDocument();
});
```

- [x] **Step 6: Run component tests**

Run:

```bash
rtk npm test -- client/src/phb-extraction-panel.test.tsx client/src/ui-copy.test.tsx
```

Expected: PASS.

---

## Task 7: Validation, typecheck, and build

**Files:**
- No source files changed in this task unless verification reveals a compile error.

- [x] **Step 1: Run focused tests**

Run:

```bash
rtk npm test -- server/src/tests/phbExtractionService.test.ts server/src/tests/integration.test.ts client/src/api.test.tsx client/src/phb-extraction-panel.test.tsx client/src/ui-copy.test.tsx
```

Expected: PASS.

- [x] **Step 2: Run full test suite**

Run:

```bash
rtk npm test
```

Expected: PASS.

- [x] **Step 3: Run typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: PASS.

- [x] **Step 4: Run production build**

Run:

```bash
rtk npm run build
```

Expected: PASS.

- [x] **Step 5: Check for temporary files**

Run:

```bash
rtk git status --short
```

Expected: only intentional project files are listed. No generated PHB extraction JSON, PDF copies, temp scripts, or local private PHB-derived content should appear.

- [x] **Step 6: Do not commit unless explicitly requested**

Because the user’s global rule forbids automatic commits, stop after reporting verification results. If the user explicitly asks to commit this feature, use this command shape and include the required co-author trailer:

```bash
rtk git add server/src/db/schema.ts server/src/domain/types.ts server/src/services/phbExtractionService.ts server/src/routes/adminResourceRoutes.ts server/src/tests/phbExtractionService.test.ts server/src/tests/integration.test.ts client/src/types.ts client/src/api.ts client/src/components/PhbExtractionPanel.tsx client/src/components/ResourceImportPanel.tsx client/src/phb-extraction-panel.test.tsx client/src/ui-copy.test.tsx docs/superpowers/plans/2026-05-30-5e-phb-extraction-foundation.md && rtk git commit -m "feat: add PHB extraction review foundation" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Follow-up Plan Boundaries

After this plan is implemented and verified, create separate plans for these approved-spec phases:

1. **Embedding and rule injection plan**
   - Add global embedding config, OpenAI-compatible embeddings provider, vector storage, hybrid keyword/semantic retrieval, and prompt-preview integration.
2. **Player 1级 character builder plan**
   - Use approved `character_options` as the only selectable source, add player-side wizard, AI review, and final confirmation.
3. **Structured character resources plan**
   - Expand sheet JSON, add HP/temp HP/hit dice/spell slots/ammo/consumables/currency/conditions, short-rest and long-rest resource operations.
4. **AI-DM resource changes and rollback plan**
   - Extend AI output contract, validate resource patches, write audit rows, show admin/player change logs, and support rollback.

These follow-up plans preserve the current `/goal` direction: a standalone多人 DND AI 跑团系统 with SillyTavern-inspired import, world-book, preset, structured character, rule, and long-term campaign foundations.

## Self-Review

- Spec coverage for this plan: covers PHB extraction jobs, draft storage, per-draft review, approved rule entries, approved character options, approved resource rules, local private data boundary, admin review UI, and approved-only catalog APIs.
- Explicitly not covered by this plan: embedding, semantic retrieval, player character builder, AI prompt injection, resource patching, audit rollback. These are independent follow-up plans because the spec is intentionally larger than one implementation slice.
- Placeholder scan: no unfinished marker terms were found, no unfinished step labels remain, and every code-changing task includes concrete code snippets and commands.
- Type consistency: server/client names match: `PhbExtractionJob`, `PhbExtractionDraft`, `CharacterOption`, `RuleWorldBookEntry`, `ResourceRule`, `importPhbExtraction`, `listPhbExtractionDrafts`, `reviewPhbExtractionDraft`, `getApprovedPhbCatalog`.
