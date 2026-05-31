# 5e Player Character Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a player-side level-1 5e character creation flow that uses approved PHB-extracted `character_options` as the only formal option source, saves drafts, validates required fields, and confirms a structured character sheet.

**Architecture:** The server adds a focused `characterBuilderService` that reads approved character options, stores one builder draft per player in the existing `characters` row, and turns a confirmed draft into a level-1 `CharacterSheet`. Player routes expose option catalog, draft save, audit, and confirm endpoints; the React player page shows a compact step-based builder until the character is confirmed, then falls back to the character card.

**Tech Stack:** TypeScript, Express, SQLite/better-sqlite3, Zod, React, Vite, Vitest, Testing Library.

---

## Scope Check

The approved 5e design includes player builder, full resources, AI review, automatic AI-DM resource writes, and rollback. This plan implements only the player-side level-1 builder foundation:

- Approved `character_options` are the only formal selectable source.
- A player can save a structured draft.
- A basic rules audit reports missing required choices.
- A player can confirm a draft into a structured level-1 character sheet.
- Admin state exposes character confirmation/draft state through existing `characters` data.

This plan does not implement full AI-assisted prose rewriting, class feature automation, leveling, spell preparation legality, resource rollback, or AI-DM resource patching.

## File Structure

### Server files

- Modify: `server/src/domain/types.ts`
  - Add `CharacterBuilderDraft`, `CharacterBuilderAudit`, `CharacterBuilderOptions`, and extend `CharacterSheet` with optional structured 5e fields while preserving current card compatibility.
- Create: `server/src/services/characterBuilderService.ts`
  - Reads approved options, normalizes drafts, audits required fields, converts a confirmed draft into a level-1 `CharacterSheet`.
- Modify: `server/src/services/characterService.ts`
  - Create unconfirmed starter builder character rows instead of immediately confirmed starter sheets when adding players.
- Modify: `server/src/routes/adminRoutes.ts`
  - Player creation should insert an unconfirmed builder placeholder; admin state already reads `characters` through player state indirectly only if future admin UI uses it.
- Modify: `server/src/routes/playerRoutes.ts`
  - Add player endpoints for builder options, draft save, audit, and confirm.
- Modify: `server/src/services/visibilityService.ts`
  - No logic change expected beyond type compatibility.
- Test: `server/src/tests/characterBuilderService.test.ts`
  - Unit tests for approved-only options, draft audit, and confirm conversion.
- Modify/Test: `server/src/tests/integration.test.ts`
  - Player API integration tests for options, draft save, audit, confirm, and player state.

### Client files

- Modify: `client/src/types.ts`
  - Mirror builder draft/options/audit types and structured sheet optional fields.
- Modify: `client/src/api.ts`
  - Add player builder API functions.
- Create: `client/src/components/CharacterBuilder.tsx`
  - Compact step-based form for basic info, class/species/background, abilities, skills, equipment, spells, audit, save, confirm.
- Modify: `client/src/pages/PlayerPage.tsx`
  - Show builder when `state.character` is missing or unconfirmed; show `CharacterCard` after confirmation.
- Modify: `client/src/components/CharacterCard.tsx`
  - Display confirmed structured sheet without breaking existing simple fields.
- Test: `client/src/character-builder.test.tsx`
  - Component tests for loading options, save/audit, and confirm.
- Modify/Test: `client/src/ui-copy.test.tsx`
  - Smoke test player page builder visibility.
- Modify/Test: `client/src/api.test.tsx`
  - API tests for builder endpoints.

### Documentation and verification

- Modify: `docs/superpowers/plans/2026-05-30-5e-player-character-builder.md`
  - Track execution with checkboxes.
- Do not commit automatically. If the user explicitly asks for a commit, use `rtk git add ... && rtk git commit ...` with the required Claude co-author trailer.

---

## Task 1: Server builder types and service

**Files:**
- Modify: `server/src/domain/types.ts`
- Create: `server/src/services/characterBuilderService.ts`
- Create: `server/src/tests/characterBuilderService.test.ts`

- [x] **Step 1: Write failing service tests**

Create `server/src/tests/characterBuilderService.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { createPhbExtractionJob, reviewPhbExtractionDraft } from '../services/phbExtractionService.js';
import {
  auditCharacterBuilderDraft,
  buildCharacterSheetFromDraft,
  listCharacterBuilderOptions,
  normalizeCharacterBuilderDraft
} from '../services/characterBuilderService.js';

function seedOptions(db: ReturnType<typeof createMemoryDb>) {
  const { drafts } = createPhbExtractionJob(db, {
    name: 'PHB 角色选项样例',
    drafts: [
      { kind: 'character_option', optionType: 'species', title: '人类', summary: '适应力强的种族。', ruleData: { speed: 30 }, sourceRef: 'PHB p.29' },
      { kind: 'character_option', optionType: 'class', title: '战士', summary: '擅长武器和护甲。', ruleData: { hitDie: 'd10', hpAtLevel1: 10 }, sourceRef: 'PHB p.70' },
      { kind: 'character_option', optionType: 'background', title: '士兵', summary: '受过军事训练。', ruleData: { skillChoices: ['Athletics'] }, sourceRef: 'PHB p.140' },
      { kind: 'character_option', optionType: 'skill', title: 'Athletics', summary: '运动能力。', sourceRef: 'PHB p.175' },
      { kind: 'character_option', optionType: 'equipment', title: '长剑', summary: '一把军用近战武器。', sourceRef: 'PHB p.149' },
      { kind: 'rule_entry', title: '不应出现在角色选项', summary: '规则条目。', content: '规则正文。' }
    ]
  });
  for (const draft of drafts.filter((item) => item.kind === 'character_option')) {
    reviewPhbExtractionDraft(db, draft.id, { status: 'approved' });
  }
}

describe('characterBuilderService', () => {
  it('lists only approved PHB character options grouped by option type', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedOptions(db);
      const options = listCharacterBuilderOptions(db);

      expect(options.species.map((item) => item.name)).toEqual(['人类']);
      expect(options.classes.map((item) => item.name)).toEqual(['战士']);
      expect(options.backgrounds.map((item) => item.name)).toEqual(['士兵']);
      expect(options.skills.map((item) => item.name)).toEqual(['Athletics']);
      expect(options.equipment.map((item) => item.name)).toEqual(['长剑']);
    } finally {
      db.close();
    }
  });

  it('audits missing required level-1 builder fields', () => {
    const draft = normalizeCharacterBuilderDraft({ name: '洛林', concept: '前士兵' });
    const audit = auditCharacterBuilderDraft(draft);

    expect(audit.valid).toBe(false);
    expect(audit.issues.map((issue) => issue.field)).toEqual([
      'species', 'className', 'background', 'abilityScores', 'skills', 'equipment'
    ]);
  });

  it('builds a confirmed level-1 character sheet from a valid draft', () => {
    const draft = normalizeCharacterBuilderDraft({
      name: '洛林',
      concept: '守护村庄的前士兵',
      species: '人类',
      className: '战士',
      background: '士兵',
      abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
      skills: ['Athletics'],
      equipment: ['长剑'],
      spells: [],
      personality: '沉稳',
      ideal: '守护弱者',
      bond: '家乡',
      flaw: '过度自责'
    });

    expect(auditCharacterBuilderDraft(draft).valid).toBe(true);
    expect(buildCharacterSheetFromDraft(draft)).toMatchObject({
      name: '洛林',
      species: '人类',
      className: '战士',
      level: 1,
      background: '士兵',
      hitPoints: { current: 12, max: 12 },
      armorClass: 10,
      proficiencyBonus: 2,
      skills: ['Athletics'],
      equipment: ['长剑'],
      spells: []
    });
  });
});
```

- [x] **Step 2: Run failing test**

Run:

```bash
rtk npm test -- server/src/tests/characterBuilderService.test.ts
```

Expected: FAIL because `characterBuilderService.ts` does not exist.

- [x] **Step 3: Add server types**

In `server/src/domain/types.ts`, add after `CharacterOption`:

```ts
export interface CharacterBuilderOption {
  id: string;
  optionType: CharacterOptionType;
  name: string;
  summary: string;
  ruleData: unknown;
  prerequisites: unknown;
  sourceRef: string;
}

export interface CharacterBuilderOptions {
  species: CharacterBuilderOption[];
  classes: CharacterBuilderOption[];
  backgrounds: CharacterBuilderOption[];
  skills: CharacterBuilderOption[];
  equipment: CharacterBuilderOption[];
  spells: CharacterBuilderOption[];
  languages: CharacterBuilderOption[];
  proficiencies: CharacterBuilderOption[];
}

export interface CharacterBuilderDraft {
  name: string;
  concept: string;
  species: string;
  className: string;
  background: string;
  abilityScores: Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', number>;
  skills: string[];
  equipment: string[];
  spells: string[];
  personality: string;
  ideal: string;
  bond: string;
  flaw: string;
  notes: string;
}

export interface CharacterBuilderAuditIssue {
  field: string;
  message: string;
}

export interface CharacterBuilderAudit {
  valid: boolean;
  issues: CharacterBuilderAuditIssue[];
}
```

Extend `CharacterSheet` with optional structured fields while preserving existing fields:

```ts
  background?: string;
  concept?: string;
  personality?: string;
  ideal?: string;
  bond?: string;
  flaw?: string;
  builderDraft?: CharacterBuilderDraft;
```

- [x] **Step 4: Implement service**

Create `server/src/services/characterBuilderService.ts`:

```ts
import type { AppDatabase } from '../db/connection.js';
import type { CharacterBuilderAudit, CharacterBuilderDraft, CharacterBuilderOption, CharacterBuilderOptions, CharacterOptionType, CharacterSheet } from '../domain/types.js';

const defaultAbilityScores = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {};
  }
}

function mapOption(row: any): CharacterBuilderOption {
  return {
    id: row.id,
    optionType: row.optionType,
    name: row.name,
    summary: row.summary,
    ruleData: parseJson(row.ruleDataJson),
    prerequisites: parseJson(row.prerequisitesJson),
    sourceRef: row.sourceRef
  };
}

function optionsByType(options: CharacterBuilderOption[], optionType: CharacterOptionType): CharacterBuilderOption[] {
  return options.filter((option) => option.optionType === optionType);
}

export function listCharacterBuilderOptions(db: AppDatabase): CharacterBuilderOptions {
  const options = (db.prepare(`
    SELECT id, option_type as optionType, name, summary, rule_data_json as ruleDataJson,
      prerequisites_json as prerequisitesJson, source_ref as sourceRef
    FROM character_options
    ORDER BY option_type ASC, name ASC
  `).all() as any[]).map(mapOption);

  return {
    species: optionsByType(options, 'species'),
    classes: optionsByType(options, 'class'),
    backgrounds: optionsByType(options, 'background'),
    skills: optionsByType(options, 'skill'),
    equipment: optionsByType(options, 'equipment'),
    spells: optionsByType(options, 'spell'),
    languages: optionsByType(options, 'language'),
    proficiencies: optionsByType(options, 'proficiency')
  };
}

export function normalizeCharacterBuilderDraft(input: unknown): CharacterBuilderDraft {
  const value = input && typeof input === 'object' ? input as Partial<CharacterBuilderDraft> : {};
  return {
    name: typeof value.name === 'string' ? value.name.trim() : '',
    concept: typeof value.concept === 'string' ? value.concept.trim() : '',
    species: typeof value.species === 'string' ? value.species.trim() : '',
    className: typeof value.className === 'string' ? value.className.trim() : '',
    background: typeof value.background === 'string' ? value.background.trim() : '',
    abilityScores: { ...defaultAbilityScores, ...(value.abilityScores ?? {}) },
    skills: Array.isArray(value.skills) ? value.skills.filter((item): item is string => typeof item === 'string') : [],
    equipment: Array.isArray(value.equipment) ? value.equipment.filter((item): item is string => typeof item === 'string') : [],
    spells: Array.isArray(value.spells) ? value.spells.filter((item): item is string => typeof item === 'string') : [],
    personality: typeof value.personality === 'string' ? value.personality.trim() : '',
    ideal: typeof value.ideal === 'string' ? value.ideal.trim() : '',
    bond: typeof value.bond === 'string' ? value.bond.trim() : '',
    flaw: typeof value.flaw === 'string' ? value.flaw.trim() : '',
    notes: typeof value.notes === 'string' ? value.notes.trim() : ''
  };
}

export function auditCharacterBuilderDraft(draft: CharacterBuilderDraft): CharacterBuilderAudit {
  const issues: CharacterBuilderAudit['issues'] = [];
  if (!draft.species) issues.push({ field: 'species', message: '请选择种族。' });
  if (!draft.className) issues.push({ field: 'className', message: '请选择职业。' });
  if (!draft.background) issues.push({ field: 'background', message: '请选择背景。' });
  if (Object.values(draft.abilityScores).some((score) => !Number.isInteger(score) || score < 1 || score > 30)) {
    issues.push({ field: 'abilityScores', message: '属性值必须是 1 到 30 的整数。' });
  }
  if (Object.values(draft.abilityScores).every((score) => score === 10)) {
    issues.push({ field: 'abilityScores', message: '请填写角色属性值。' });
  }
  if (draft.skills.length === 0) issues.push({ field: 'skills', message: '请选择至少一个技能熟练。' });
  if (draft.equipment.length === 0) issues.push({ field: 'equipment', message: '请选择至少一件装备。' });
  return { valid: issues.length === 0, issues };
}

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function buildCharacterSheetFromDraft(draft: CharacterBuilderDraft): CharacterSheet {
  const conMod = abilityModifier(draft.abilityScores.con);
  const baseHp = draft.className === '战士' || draft.className.toLowerCase() === 'fighter' ? 10 : 8;
  const maxHp = Math.max(1, baseHp + conMod);
  return {
    name: draft.name,
    species: draft.species,
    className: draft.className,
    level: 1,
    abilityScores: draft.abilityScores,
    hitPoints: { current: maxHp, max: maxHp },
    armorClass: 10 + abilityModifier(draft.abilityScores.dex),
    proficiencyBonus: 2,
    skills: draft.skills,
    equipment: draft.equipment,
    spells: draft.spells,
    privateNotes: draft.notes,
    background: draft.background,
    concept: draft.concept,
    personality: draft.personality,
    ideal: draft.ideal,
    bond: draft.bond,
    flaw: draft.flaw,
    builderDraft: draft
  };
}
```

- [x] **Step 5: Run service tests**

Run:

```bash
rtk npm test -- server/src/tests/characterBuilderService.test.ts
```

Expected: PASS.

---

## Task 2: Player builder APIs

**Files:**
- Modify: `server/src/services/characterService.ts`
- Modify: `server/src/routes/adminRoutes.ts`
- Modify: `server/src/routes/playerRoutes.ts`
- Modify: `server/src/tests/integration.test.ts`

- [x] **Step 1: Write failing integration test**

Append this test in `server/src/tests/integration.test.ts`:

```ts
  it('lets a player save, audit, and confirm a level-1 character builder draft', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const { drafts } = createPhbExtractionJob(db, {
        name: 'PHB 建卡选项',
        drafts: [
          { kind: 'character_option', optionType: 'species', title: '人类', summary: '适应力强。' },
          { kind: 'character_option', optionType: 'class', title: '战士', summary: '武技专家。', ruleData: { hpAtLevel1: 10 } },
          { kind: 'character_option', optionType: 'background', title: '士兵', summary: '军旅背景。' },
          { kind: 'character_option', optionType: 'skill', title: 'Athletics', summary: '运动。' },
          { kind: 'character_option', optionType: 'equipment', title: '长剑', summary: '武器。' }
        ]
      });
      for (const draft of drafts) reviewPhbExtractionDraft(db, draft.id, { status: 'approved' });

      const roomRes = await fetch(`${base}/api/admin/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '建卡房间' }) });
      const room = await roomRes.json() as { roomId: string };
      const playerRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '洛林玩家' }) });
      const player = await playerRes.json() as { token: string };

      const optionsRes = await fetch(`${base}/api/player/${player.token}/character-builder/options`);
      expect(optionsRes.status).toBe(200);
      const options = await optionsRes.json() as { options: { classes: Array<{ name: string }> } };
      expect(options.options.classes.map((item) => item.name)).toEqual(['战士']);

      const invalidAuditRes = await fetch(`${base}/api/player/${player.token}/character-builder/audit`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: { name: '洛林' } })
      });
      expect(invalidAuditRes.status).toBe(200);
      const invalidAudit = await invalidAuditRes.json() as { audit: { valid: boolean; issues: Array<{ field: string }> } };
      expect(invalidAudit.audit.valid).toBe(false);
      expect(invalidAudit.audit.issues.map((issue) => issue.field)).toContain('className');

      const draft = {
        name: '洛林', concept: '守护村庄的前士兵', species: '人类', className: '战士', background: '士兵',
        abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
        skills: ['Athletics'], equipment: ['长剑'], spells: [], personality: '沉稳', ideal: '守护弱者', bond: '家乡', flaw: '自责', notes: ''
      };
      const saveRes = await fetch(`${base}/api/player/${player.token}/character-builder/draft`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft })
      });
      expect(saveRes.status).toBe(200);
      expect((await saveRes.json() as { character: { confirmed: boolean } }).character.confirmed).toBe(false);

      const confirmRes = await fetch(`${base}/api/player/${player.token}/character-builder/confirm`, { method: 'POST' });
      expect(confirmRes.status).toBe(200);
      const confirmed = await confirmRes.json() as { character: { confirmed: boolean; sheet: { name: string; className: string; background?: string } } };
      expect(confirmed.character.confirmed).toBe(true);
      expect(confirmed.character.sheet).toMatchObject({ name: '洛林', className: '战士', background: '士兵' });

      const stateRes = await fetch(`${base}/api/player/${player.token}/state`);
      const state = await stateRes.json() as { character: { confirmed: boolean; sheet: { name: string } } };
      expect(state.character.confirmed).toBe(true);
      expect(state.character.sheet.name).toBe('洛林');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
```

Import `createPhbExtractionJob` and `reviewPhbExtractionDraft` if not already imported in this test file.

- [x] **Step 2: Run failing integration test**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "lets a player save, audit, and confirm"
```

Expected: FAIL because builder endpoints do not exist.

- [x] **Step 3: Change player creation to unconfirmed builder placeholder**

In `server/src/services/characterService.ts`, add:

```ts
export function createEmptyCharacterBuilderSheet(name: string): CharacterSheet {
  return {
    name,
    species: '',
    className: '',
    level: 1,
    abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    hitPoints: { current: 1, max: 1 },
    armorClass: 10,
    proficiencyBonus: 2,
    skills: [],
    equipment: [],
    spells: [],
    privateNotes: '',
    builderDraft: {
      name,
      concept: '',
      species: '',
      className: '',
      background: '',
      abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      skills: [],
      equipment: [],
      spells: [],
      personality: '',
      ideal: '',
      bond: '',
      flaw: '',
      notes: ''
    }
  };
}
```

In `server/src/routes/adminRoutes.ts`, change player creation import and use:

```ts
import { createEmptyCharacterBuilderSheet } from '../services/characterService.js';
```

Replace `createStarterCharacter(input.name)` with `createEmptyCharacterBuilderSheet(input.name)` and insert `confirmed` as `0` instead of `1`.

- [x] **Step 4: Add player builder routes**

In `server/src/routes/playerRoutes.ts`, import:

```ts
import { auditCharacterBuilderDraft, buildCharacterSheetFromDraft, listCharacterBuilderOptions, normalizeCharacterBuilderDraft } from '../services/characterBuilderService.js';
```

Add schemas:

```ts
const builderDraftSchema = z.object({ draft: z.unknown() }).strict();
```

Add helper inside file:

```ts
function getCharacterByPlayerId(db: AppDatabase, playerId: string): any | null {
  return db.prepare('SELECT id, player_id as playerId, sheet_json as sheetJson, draft_source as draftSource, confirmed, updated_at as updatedAt FROM characters WHERE player_id = ?').get(playerId) as any | null;
}

function mapCharacterRow(row: any) {
  return { id: row.id, playerId: row.playerId, sheet: JSON.parse(row.sheetJson), draftSource: row.draftSource, confirmed: Boolean(row.confirmed), updatedAt: row.updatedAt };
}
```

Replace repeated character mapping in state route with these helpers.

Add routes before actions route:

```ts
  router.get('/:token/character-builder/options', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });
    res.json({ options: listCharacterBuilderOptions(db) });
  });

  router.post('/:token/character-builder/audit', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });
    const input = builderDraftSchema.parse(req.body);
    const draft = normalizeCharacterBuilderDraft(input.draft);
    res.json({ draft, audit: auditCharacterBuilderDraft(draft) });
  });

  router.put('/:token/character-builder/draft', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });
    const row = getCharacterByPlayerId(db, player.id);
    if (!row) return res.status(404).json({ error: 'Character not found' });
    const input = builderDraftSchema.parse(req.body);
    const draft = normalizeCharacterBuilderDraft(input.draft);
    const sheet = { ...JSON.parse(row.sheetJson), ...buildCharacterSheetFromDraft(draft), builderDraft: draft };
    const now = new Date().toISOString();
    db.prepare('UPDATE characters SET sheet_json = ?, draft_source = ?, confirmed = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(sheet), 'manual', 0, now, row.id);
    publishRoomUpdate(player.roomId);
    res.json({ character: mapCharacterRow(getCharacterByPlayerId(db, player.id)) });
  });

  router.post('/:token/character-builder/confirm', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });
    const row = getCharacterByPlayerId(db, player.id);
    if (!row) return res.status(404).json({ error: 'Character not found' });
    const currentSheet = JSON.parse(row.sheetJson);
    const draft = normalizeCharacterBuilderDraft(currentSheet.builderDraft ?? currentSheet);
    const audit = auditCharacterBuilderDraft(draft);
    if (!audit.valid) return res.status(400).json({ error: 'Character builder draft is incomplete', audit });
    const sheet = buildCharacterSheetFromDraft(draft);
    const now = new Date().toISOString();
    db.prepare('UPDATE characters SET sheet_json = ?, draft_source = ?, confirmed = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(sheet), 'manual', 1, now, row.id);
    publishRoomUpdate(player.roomId);
    res.json({ character: mapCharacterRow(getCharacterByPlayerId(db, player.id)) });
  });
```

- [x] **Step 5: Run integration test**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts -t "lets a player save, audit, and confirm"
```

Expected: PASS.

---

## Task 3: Client builder API types

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/api.ts`
- Modify: `client/src/api.test.tsx`

- [x] **Step 1: Write failing API test**

Append to `client/src/api.test.tsx`:

```ts
  it('calls player character builder APIs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ options: { classes: [] } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ draft: { name: '洛林' }, audit: { valid: false, issues: [] } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ character: { id: 'char-1', confirmed: false } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ character: { id: 'char-1', confirmed: true } }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const draft = { name: '洛林', concept: '', species: '', className: '', background: '', abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, skills: [], equipment: [], spells: [], personality: '', ideal: '', bond: '', flaw: '', notes: '' };

    await getCharacterBuilderOptions('token-1');
    await auditCharacterBuilderDraft('token-1', draft);
    await saveCharacterBuilderDraft('token-1', draft);
    await confirmCharacterBuilderDraft('token-1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/player/token-1/character-builder/options', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/player/token-1/character-builder/audit', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/player/token-1/character-builder/draft', expect.objectContaining({ method: 'PUT' }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/player/token-1/character-builder/confirm', expect.objectContaining({ method: 'POST' }));
    fetchMock.mockRestore();
  });
```

Import the four functions from `./api`.

- [x] **Step 2: Run failing API test**

Run:

```bash
rtk npm test -- client/src/api.test.tsx -t "player character builder APIs"
```

Expected: FAIL because functions do not exist.

- [x] **Step 3: Add client types**

In `client/src/types.ts`, mirror server builder types:

```ts
export interface CharacterBuilderOption {
  id: string;
  optionType: CharacterOptionType;
  name: string;
  summary: string;
  ruleData: JsonValue;
  prerequisites: JsonValue;
  sourceRef: string;
}

export interface CharacterBuilderOptions {
  species: CharacterBuilderOption[];
  classes: CharacterBuilderOption[];
  backgrounds: CharacterBuilderOption[];
  skills: CharacterBuilderOption[];
  equipment: CharacterBuilderOption[];
  spells: CharacterBuilderOption[];
  languages: CharacterBuilderOption[];
  proficiencies: CharacterBuilderOption[];
}

export interface CharacterBuilderDraft {
  name: string;
  concept: string;
  species: string;
  className: string;
  background: string;
  abilityScores: Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', number>;
  skills: string[];
  equipment: string[];
  spells: string[];
  personality: string;
  ideal: string;
  bond: string;
  flaw: string;
  notes: string;
}

export interface CharacterBuilderAuditIssue {
  field: string;
  message: string;
}

export interface CharacterBuilderAudit {
  valid: boolean;
  issues: CharacterBuilderAuditIssue[];
}
```

Extend `CharacterSheet` with optional builder fields just like server.

- [x] **Step 4: Add API functions**

In `client/src/api.ts`, import builder types and add after player state functions:

```ts
export function getCharacterBuilderOptions(token: string) {
  return jsonRequest<{ options: CharacterBuilderOptions }>(`/api/player/${token}/character-builder/options`);
}

export function auditCharacterBuilderDraft(token: string, draft: CharacterBuilderDraft) {
  return jsonRequest<{ draft: CharacterBuilderDraft; audit: CharacterBuilderAudit }>(`/api/player/${token}/character-builder/audit`, { method: 'POST', body: JSON.stringify({ draft }) });
}

export function saveCharacterBuilderDraft(token: string, draft: CharacterBuilderDraft) {
  return jsonRequest<{ character: CharacterRecord }>(`/api/player/${token}/character-builder/draft`, { method: 'PUT', body: JSON.stringify({ draft }) });
}

export function confirmCharacterBuilderDraft(token: string) {
  return jsonRequest<{ character: CharacterRecord }>(`/api/player/${token}/character-builder/confirm`, { method: 'POST' });
}
```

- [x] **Step 5: Run API test**

Run:

```bash
rtk npm test -- client/src/api.test.tsx -t "player character builder APIs"
```

Expected: PASS.

---

## Task 4: CharacterBuilder React component

**Files:**
- Create: `client/src/components/CharacterBuilder.tsx`
- Create: `client/src/character-builder.test.tsx`

- [x] **Step 1: Write failing component tests**

Create `client/src/character-builder.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CharacterBuilder } from './components/CharacterBuilder';
import * as api from './api';

vi.mock('./api', () => ({
  auditCharacterBuilderDraft: vi.fn(async (_token, draft) => ({ draft, audit: { valid: true, issues: [] } })),
  confirmCharacterBuilderDraft: vi.fn(async () => ({ character: { id: 'char-1', confirmed: true, sheet: { name: '洛林' } } })),
  getCharacterBuilderOptions: vi.fn(async () => ({
    options: {
      species: [{ id: 'species-1', optionType: 'species', name: '人类', summary: '适应力强。', ruleData: {}, prerequisites: {}, sourceRef: 'PHB' }],
      classes: [{ id: 'class-1', optionType: 'class', name: '战士', summary: '武技专家。', ruleData: {}, prerequisites: {}, sourceRef: 'PHB' }],
      backgrounds: [{ id: 'bg-1', optionType: 'background', name: '士兵', summary: '军旅背景。', ruleData: {}, prerequisites: {}, sourceRef: 'PHB' }],
      skills: [{ id: 'skill-1', optionType: 'skill', name: 'Athletics', summary: '运动。', ruleData: {}, prerequisites: {}, sourceRef: 'PHB' }],
      equipment: [{ id: 'equip-1', optionType: 'equipment', name: '长剑', summary: '武器。', ruleData: {}, prerequisites: {}, sourceRef: 'PHB' }],
      spells: [], languages: [], proficiencies: []
    }
  })),
  saveCharacterBuilderDraft: vi.fn(async (_token, draft) => ({ character: { id: 'char-1', confirmed: false, sheet: { name: draft.name, builderDraft: draft } } }))
}));

describe('CharacterBuilder', () => {
  it('loads approved PHB options and saves a builder draft', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const setError = vi.fn();
    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={onChanged} setError={setError} />);

    expect(await screen.findByText('角色创建向导')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('角色姓名'));
    await user.type(screen.getByLabelText('角色姓名'), '洛林');
    await user.selectOptions(screen.getByLabelText('种族'), '人类');
    await user.selectOptions(screen.getByLabelText('职业'), '战士');
    await user.selectOptions(screen.getByLabelText('背景'), '士兵');
    await user.click(screen.getByLabelText('Athletics'));
    await user.click(screen.getByLabelText('长剑'));
    await user.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() => expect(api.saveCharacterBuilderDraft).toHaveBeenCalled());
    expect(setError).toHaveBeenCalledWith('');
    expect(onChanged).toHaveBeenCalled();
  });

  it('audits and confirms a valid draft', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(<CharacterBuilder token="token-1" initialDraft={null} onChanged={onChanged} setError={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '审核角色' }));
    expect(await screen.findByText('审核通过，可以确认角色。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认角色' }));

    await waitFor(() => expect(api.confirmCharacterBuilderDraft).toHaveBeenCalledWith('token-1'));
    expect(onChanged).toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run failing component test**

Run:

```bash
rtk npm test -- client/src/character-builder.test.tsx
```

Expected: FAIL because component does not exist.

- [x] **Step 3: Implement component**

Create `client/src/components/CharacterBuilder.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { auditCharacterBuilderDraft, confirmCharacterBuilderDraft, getCharacterBuilderOptions, saveCharacterBuilderDraft } from '../api';
import type { CharacterBuilderAudit, CharacterBuilderDraft, CharacterBuilderOptions } from '../types';

const defaultDraft: CharacterBuilderDraft = {
  name: '新英雄', concept: '', species: '', className: '', background: '',
  abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
  skills: [], equipment: [], spells: [], personality: '', ideal: '', bond: '', flaw: '', notes: ''
};

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function CharacterBuilder({ token, initialDraft, onChanged, setError }: {
  token: string;
  initialDraft: CharacterBuilderDraft | null;
  onChanged: () => Promise<void> | void;
  setError: (message: string) => void;
}) {
  const [options, setOptions] = useState<CharacterBuilderOptions | null>(null);
  const [draft, setDraft] = useState<CharacterBuilderDraft>(initialDraft ?? defaultDraft);
  const [audit, setAudit] = useState<CharacterBuilderAudit | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void getCharacterBuilderOptions(token)
      .then((result) => setOptions(result.options))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [token]);

  function update<K extends keyof CharacterBuilderDraft>(key: K, value: CharacterBuilderDraft[K]) {
    setMessage('');
    setAudit(null);
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function saveDraft() {
    setError('');
    await saveCharacterBuilderDraft(token, draft);
    setMessage('角色草稿已保存。');
    await onChanged();
  }

  async function auditDraft() {
    setError('');
    const result = await auditCharacterBuilderDraft(token, draft);
    setAudit(result.audit);
    setMessage(result.audit.valid ? '审核通过，可以确认角色。' : '角色草稿还有需要补充的项目。');
  }

  async function confirmDraft() {
    setError('');
    await confirmCharacterBuilderDraft(token);
    setMessage('角色已确认。');
    await onChanged();
  }

  if (!options) return <section className="card"><h2>角色创建向导</h2><p>加载角色选项...</p></section>;

  return (
    <section className="card">
      <h2>角色创建向导</h2>
      <p className="muted">正式选项只来自已审核的 PHB 抽取结果。</p>
      <label>角色姓名<input aria-label="角色姓名" value={draft.name} onChange={(event) => update('name', event.target.value)} /></label>
      <label>角色概念<textarea value={draft.concept} onChange={(event) => update('concept', event.target.value)} /></label>
      <label>种族<select aria-label="种族" value={draft.species} onChange={(event) => update('species', event.target.value)}><option value="">请选择</option>{options.species.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></label>
      <label>职业<select aria-label="职业" value={draft.className} onChange={(event) => update('className', event.target.value)}><option value="">请选择</option>{options.classes.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></label>
      <label>背景<select aria-label="背景" value={draft.background} onChange={(event) => update('background', event.target.value)}><option value="">请选择</option>{options.backgrounds.map((option) => <option key={option.id} value={option.name}>{option.name}</option>)}</select></label>
      <div className="subcard"><h3>属性值</h3>{(['str','dex','con','int','wis','cha'] as const).map((ability) => <label key={ability}>{ability.toUpperCase()}<input type="number" value={draft.abilityScores[ability]} onChange={(event) => update('abilityScores', { ...draft.abilityScores, [ability]: Number(event.target.value) })} /></label>)}</div>
      <div className="subcard"><h3>技能</h3>{options.skills.map((option) => <label className="check-row" key={option.id}><input aria-label={option.name} type="checkbox" checked={draft.skills.includes(option.name)} onChange={() => update('skills', toggle(draft.skills, option.name))} /> {option.name}</label>)}</div>
      <div className="subcard"><h3>装备</h3>{options.equipment.map((option) => <label className="check-row" key={option.id}><input aria-label={option.name} type="checkbox" checked={draft.equipment.includes(option.name)} onChange={() => update('equipment', toggle(draft.equipment, option.name))} /> {option.name}</label>)}</div>
      <label>性格<textarea value={draft.personality} onChange={(event) => update('personality', event.target.value)} /></label>
      <label>理想<textarea value={draft.ideal} onChange={(event) => update('ideal', event.target.value)} /></label>
      <label>牵绊<textarea value={draft.bond} onChange={(event) => update('bond', event.target.value)} /></label>
      <label>缺点<textarea value={draft.flaw} onChange={(event) => update('flaw', event.target.value)} /></label>
      <div className="button-row"><button onClick={() => void saveDraft()}>保存草稿</button><button onClick={() => void auditDraft()}>审核角色</button><button onClick={() => void confirmDraft()}>确认角色</button></div>
      {message ? <p>{message}</p> : null}
      {audit && !audit.valid ? <ul>{audit.issues.map((issue) => <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>)}</ul> : null}
    </section>
  );
}
```

- [x] **Step 4: Run component tests**

Run:

```bash
rtk npm test -- client/src/character-builder.test.tsx
```

Expected: PASS.

---

## Task 5: Player page integration

**Files:**
- Modify: `client/src/pages/PlayerPage.tsx`
- Modify: `client/src/components/CharacterCard.tsx`
- Modify: `client/src/ui-copy.test.tsx`

- [x] **Step 1: Write failing UI smoke test**

In `client/src/ui-copy.test.tsx`, add API mocks for builder endpoints if missing:

```ts
  getCharacterBuilderOptions: vi.fn(async () => ({ options: { species: [], classes: [], backgrounds: [], skills: [], equipment: [], spells: [], languages: [], proficiencies: [] } })),
  auditCharacterBuilderDraft: vi.fn(async (_token, draft) => ({ draft, audit: { valid: false, issues: [] } })),
  saveCharacterBuilderDraft: vi.fn(async () => ({ character: null })),
  confirmCharacterBuilderDraft: vi.fn(async () => ({ character: null })),
```

Add test:

```tsx
it('玩家没有确认角色时展示角色创建向导', async () => {
  vi.mocked(api.getPlayerState).mockResolvedValueOnce({
    room: { id: 'room-1', name: '测试房间', worldInfo: '世界', currentTurn: 1, status: 'waiting_for_actions' },
    player: { id: 'player-1', name: '玩家一' },
    character: { id: 'char-1', playerId: 'player-1', confirmed: false, draftSource: 'manual', updatedAt: '2026-05-30T00:00:00.000Z', sheet: { name: '新英雄', species: '', className: '', level: 1, abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, hitPoints: { current: 1, max: 1 }, armorClass: 10, proficiencyBonus: 2, skills: [], equipment: [], spells: [], privateNotes: '' } },
    publicLogs: [], privateLogs: [], pendingInteractions: [], submittedPlayers: [], waitingPlayers: [], ruleSummaries: []
  });

  render(<PlayerPage token="token-1" />);

  expect(await screen.findByText('角色创建向导')).toBeInTheDocument();
  expect(screen.queryByText('暂无角色。')).not.toBeInTheDocument();
});
```

- [x] **Step 2: Run failing UI test**

Run:

```bash
rtk npm test -- client/src/ui-copy.test.tsx -t "玩家没有确认角色"
```

Expected: FAIL because PlayerPage still always renders `CharacterCard`.

- [x] **Step 3: Integrate builder into PlayerPage**

In `client/src/pages/PlayerPage.tsx`, import `CharacterBuilder`:

```ts
import { CharacterBuilder } from '../components/CharacterBuilder';
```

Replace `<CharacterCard character={state.character} />` with:

```tsx
          {state.character?.confirmed ? (
            <CharacterCard character={state.character} />
          ) : (
            <CharacterBuilder
              token={token}
              initialDraft={state.character?.sheet.builderDraft ?? null}
              onChanged={refresh}
              setError={setError}
            />
          )}
```

- [x] **Step 4: Update CharacterCard structured display**

In `client/src/components/CharacterCard.tsx`, after class/level paragraph add:

```tsx
      {sheet.background ? <p className="muted">背景：{sheet.background}</p> : null}
      {sheet.concept ? <p>{sheet.concept}</p> : null}
```

After equipment section add:

```tsx
      {sheet.personality || sheet.ideal || sheet.bond || sheet.flaw ? (
        <>
          <h3>扮演提示</h3>
          {sheet.personality ? <p>性格：{sheet.personality}</p> : null}
          {sheet.ideal ? <p>理想：{sheet.ideal}</p> : null}
          {sheet.bond ? <p>牵绊：{sheet.bond}</p> : null}
          {sheet.flaw ? <p>缺点：{sheet.flaw}</p> : null}
        </>
      ) : null}
```

- [x] **Step 5: Run UI test**

Run:

```bash
rtk npm test -- client/src/ui-copy.test.tsx -t "玩家没有确认角色"
```

Expected: PASS.

---

## Task 6: Full verification and cleanup

**Files:**
- No source files changed in this task unless verification reveals a compile error.

- [x] **Step 1: Run focused server tests**

Run:

```bash
rtk npm test -- server/src/tests/characterBuilderService.test.ts server/src/tests/integration.test.ts
```

Expected: PASS.

- [x] **Step 2: Run focused client tests**

Run:

```bash
rtk npm test -- client/src/api.test.tsx client/src/character-builder.test.tsx client/src/ui-copy.test.tsx
```

Expected: PASS.

- [x] **Step 3: Run full test suite**

Run:

```bash
rtk npm test
```

Expected: PASS.

- [x] **Step 4: Run typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Run production build**

Run:

```bash
rtk npm run build
```

Expected: PASS.

- [x] **Step 6: Check git status and local private files**

Run:

```bash
rtk git status --short
rtk git check-ignore -v -- "dnd相关/5eDnD_玩家手册PHB_中译v1.72版.pdf" "dnd相关/5eDnD_失落矿坑_新手套组_模组_中译(2校）.pdf"
```

Expected:
- Only intentional project files are listed as changed/untracked.
- The local private PDFs remain ignored by exact `.gitignore` entries.
- No generated PHB extraction JSON, temporary scripts, or PDF copies are newly introduced.

- [x] **Step 7: Do not commit unless explicitly requested**

Because the user’s global rule forbids automatic commits, stop after reporting verification results. If the user explicitly asks to commit this feature, use this command shape and include the required co-author trailer:

```bash
rtk git add server/src/domain/types.ts server/src/services/characterBuilderService.ts server/src/services/characterService.ts server/src/routes/adminRoutes.ts server/src/routes/playerRoutes.ts server/src/tests/characterBuilderService.test.ts server/src/tests/integration.test.ts client/src/types.ts client/src/api.ts client/src/components/CharacterBuilder.tsx client/src/components/CharacterCard.tsx client/src/pages/PlayerPage.tsx client/src/api.test.tsx client/src/character-builder.test.tsx client/src/ui-copy.test.tsx docs/superpowers/plans/2026-05-30-5e-player-character-builder.md && rtk git commit -m "feat: add player character builder" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Follow-up Plan Boundaries

After this plan is implemented and verified, create separate plans for:

1. **Structured character resources**
   - Expands confirmed sheet resource model for HP/temp HP/hit dice/spell slots/ammo/consumables/currency/conditions.
2. **AI-DM resource changes and rollback**
   - Extends AI output contract, validates resource patches, writes audit rows, and supports rollback.
3. **AI-assisted character prose review**
   - Uses chat provider to generate richer roleplay summary and conflict suggestions without overriding player choices.
4. **Database management center URL imports**
   - Adds URL import, source records, hashes, versioning, update preview, and JS sandbox boundaries.

## Self-Review

- Spec coverage for this plan: covers approved-option-only player builder, draft save, basic audit, confirmation into structured level-1 sheet, player UI, and admin-visible confirmed state through existing character data.
- Explicitly not covered by this plan: full AI prose review, complete resource automation, leveling, rollback, URL database import.
- Placeholder scan: no unfinished marker terms remain, no unfinished step labels remain, and each code-changing task includes concrete code snippets and commands.
- Type consistency: server/client names match: `CharacterBuilderDraft`, `CharacterBuilderOptions`, `CharacterBuilderAudit`, `getCharacterBuilderOptions`, `auditCharacterBuilderDraft`, `saveCharacterBuilderDraft`, `confirmCharacterBuilderDraft`.
