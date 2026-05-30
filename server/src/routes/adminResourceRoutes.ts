import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import { publishRoomUpdate } from '../services/eventBus.js';
import {
  bindRoomPresetPackage,
  bindRoomScriptCard,
  getPresetPackage,
  getResourceWorldBook,
  getResourceWorldBookEntries,
  getRoomResourceBindings,
  getScriptCard,
  listPresetPackages,
  listResourceWorldBookEntries,
  listResourceWorldBooks,
  listScriptCards,
  replaceRoomWorldBookBindings,
  saveImportedPresetPackage,
  saveImportedScriptCard,
  saveImportedWorldBook,
  unbindRoomPresetPackage,
  unbindRoomScriptCard
} from '../services/resourceLibrary.js';
import {
  parseSillyTavernCharacterCard,
  parseSillyTavernPresetPackage,
  parseSillyTavernWorldBook
} from '../services/sillyTavernImport.js';
import { clearMissingGlobalResourceSelections } from '../services/globalConfigService.js';
import {
  createResourceImportJob,
  listApprovedCharacterOptions,
  listApprovedResourceRules,
  listApprovedRuleEntries,
  listResourceImportDrafts,
  listResourceImportJobs,
  ResourceReviewError,
  reviewResourceImportDraft
} from '../services/resourceReviewService.js';

const importScriptCardSchema = z.object({
  characterCard: z.unknown()
});

const importWorldBookSchema = z.object({
  worldBook: z.unknown(),
  fallbackName: z.string().min(1).optional()
});

const importPresetPackageSchema = z.object({
  openAiSettings: z.unknown(),
  contextTemplate: z.unknown().optional(),
  instructTemplate: z.unknown().optional(),
  sysprompt: z.unknown().optional(),
  reasoningTemplate: z.unknown().optional()
});

const resourceDraftKindSchema = z.enum([
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
]);
const resourceDraftStatusSchema = z.enum(['pending', 'approved', 'rejected']);
const resourceSourceTypeSchema = z.enum(['local_json', 'phb_extraction', 'sillytavern_worldbook', 'sillytavern_preset', 'remote_url', 'manual']);
const resourceRulesetSchema = z.enum(['5e-2014', '5e-2024', 'homebrew', 'unknown']);

const resourceImportSchema = z.object({
  name: z.string().min(1),
  sourceType: resourceSourceTypeSchema.default('local_json'),
  sourceName: z.string().default(''),
  sourceFileName: z.string().default(''),
  sourceUrl: z.string().default(''),
  sourceVersion: z.string().default(''),
  sourceHash: z.string().default(''),
  sourceLicense: z.string().default(''),
  ruleset: resourceRulesetSchema.default('unknown'),
  language: z.string().default('unknown'),
  visibility: z.enum(['private', 'campaign', 'workspace', 'public']).default('private'),
  isPrivate: z.boolean().default(true),
  importedBy: z.string().default('admin'),
  drafts: z.array(z.unknown()).min(1)
}).strict();

const resourceReviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().default('')
}).strict();

const scriptBindingSchema = z.object({
  scriptCardId: z.string().min(1)
});

const worldBookBindingSchema = z.object({
  bindings: z.array(z.object({
    worldBookId: z.string().min(1),
    enabled: z.boolean(),
    orderIndex: z.number().int()
  }))
});

const presetBindingSchema = z.object({
  presetPackageId: z.string().min(1)
});

function requireRoom(db: AppDatabase, roomId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId));
}

function handleResourceReviewError(error: unknown, res: Response): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: 'Invalid resource import payload',
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    });
    return;
  }
  if (error instanceof ResourceReviewError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: 'Resource import review error' });
}

export function registerAdminResourceRoutes(router: Router, db: AppDatabase): void {
  router.get('/resources/script-cards', (_req, res) => {
    res.json({ scriptCards: listScriptCards(db) });
  });

  router.post('/resources/script-cards/import/sillytavern', (req, res) => {
    const input = importScriptCardSchema.parse(req.body);
    const parsed = parseSillyTavernCharacterCard(input.characterCard);
    res.json(saveImportedScriptCard(db, parsed));
  });

  router.get('/resources/script-cards/:scriptCardId', (req, res) => {
    const scriptCard = getScriptCard(db, req.params.scriptCardId);
    if (!scriptCard) return res.status(404).json({ error: 'Script card not found' });
    res.json({ scriptCard });
  });

  router.delete('/resources/script-cards/:scriptCardId', (req, res) => {
    const scriptCard = getScriptCard(db, req.params.scriptCardId);
    if (!scriptCard) return res.status(404).json({ error: 'Script card not found' });
    db.prepare('DELETE FROM script_cards WHERE id = ?').run(req.params.scriptCardId);
    clearMissingGlobalResourceSelections(db);
    res.json({ ok: true });
  });

  router.get('/resources/world-books', (_req, res) => {
    res.json({ worldBooks: listResourceWorldBooks(db), entries: listResourceWorldBookEntries(db) });
  });

  router.post('/resources/world-books/import/sillytavern', (req, res) => {
    const input = importWorldBookSchema.parse(req.body);
    const parsed = parseSillyTavernWorldBook(input.worldBook, input.fallbackName);
    res.json(saveImportedWorldBook(db, parsed));
  });

  router.get('/resources/world-books/:worldBookId', (req, res) => {
    const worldBook = getResourceWorldBook(db, req.params.worldBookId);
    if (!worldBook) return res.status(404).json({ error: 'World book not found' });
    res.json({ worldBook, entries: getResourceWorldBookEntries(db, req.params.worldBookId) });
  });

  router.get('/resources/world-books/:worldBookId/entries', (req, res) => {
    const worldBook = getResourceWorldBook(db, req.params.worldBookId);
    if (!worldBook) return res.status(404).json({ error: 'World book not found' });
    res.json({ entries: getResourceWorldBookEntries(db, req.params.worldBookId) });
  });

  router.delete('/resources/world-books/:worldBookId', (req, res) => {
    const worldBook = getResourceWorldBook(db, req.params.worldBookId);
    if (!worldBook) return res.status(404).json({ error: 'World book not found' });
    db.prepare('DELETE FROM resource_world_books WHERE id = ?').run(req.params.worldBookId);
    clearMissingGlobalResourceSelections(db);
    res.json({ ok: true });
  });

  router.get('/resources/import-jobs', (_req, res) => {
    res.json({ jobs: listResourceImportJobs(db) });
  });

  router.post('/resources/import-jobs', (req, res) => {
    try {
      const input = resourceImportSchema.parse(req.body);
      res.json(createResourceImportJob(db, input));
    } catch (error) {
      handleResourceReviewError(error, res);
    }
  });

  router.get('/resources/import-drafts', (req, res) => {
    try {
      const status = req.query.status === undefined ? undefined : resourceDraftStatusSchema.parse(req.query.status);
      const kind = req.query.kind === undefined ? undefined : resourceDraftKindSchema.parse(req.query.kind);
      const sourceType = req.query.sourceType === undefined ? undefined : resourceSourceTypeSchema.parse(req.query.sourceType);
      const ruleset = req.query.ruleset === undefined ? undefined : resourceRulesetSchema.parse(req.query.ruleset);
      const language = req.query.language === undefined ? undefined : z.string().parse(req.query.language);
      res.json({ drafts: listResourceImportDrafts(db, { status, kind, sourceType, ruleset, language }) });
    } catch (error) {
      handleResourceReviewError(error, res);
    }
  });

  router.put('/resources/import-drafts/:draftId/review', (req, res) => {
    try {
      const input = resourceReviewSchema.parse(req.body);
      res.json({ draft: reviewResourceImportDraft(db, req.params.draftId, input) });
    } catch (error) {
      handleResourceReviewError(error, res);
    }
  });

  router.get('/resources/approved-catalogs', (_req, res) => {
    res.json({
      ruleEntries: listApprovedRuleEntries(db),
      characterOptions: listApprovedCharacterOptions(db),
      resourceRules: listApprovedResourceRules(db)
    });
  });

  router.get('/resources/preset-packages', (_req, res) => {
    res.json({ presetPackages: listPresetPackages(db) });
  });

  router.post('/resources/preset-packages/import/sillytavern', (req, res) => {
    const input = importPresetPackageSchema.parse(req.body);
    const parsed = parseSillyTavernPresetPackage(input);
    res.json(saveImportedPresetPackage(db, parsed));
  });

  router.get('/resources/preset-packages/:presetPackageId', (req, res) => {
    const presetPackage = getPresetPackage(db, req.params.presetPackageId);
    if (!presetPackage) return res.status(404).json({ error: 'Preset package not found' });
    res.json({ presetPackage });
  });

  router.delete('/resources/preset-packages/:presetPackageId', (req, res) => {
    const presetPackage = getPresetPackage(db, req.params.presetPackageId);
    if (!presetPackage) return res.status(404).json({ error: 'Preset package not found' });
    db.prepare('DELETE FROM prompt_preset_packages WHERE id = ?').run(req.params.presetPackageId);
    clearMissingGlobalResourceSelections(db);
    res.json({ ok: true });
  });

  router.get('/rooms/:roomId/resource-bindings/script', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    res.json({ binding: getRoomResourceBindings(db, req.params.roomId).scriptBinding });
  });

  router.put('/rooms/:roomId/resource-bindings/script', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    const input = scriptBindingSchema.parse(req.body);
    if (!getScriptCard(db, input.scriptCardId)) return res.status(404).json({ error: 'Script card not found' });
    const binding = bindRoomScriptCard(db, req.params.roomId, input.scriptCardId);
    publishRoomUpdate(req.params.roomId);
    res.json({ binding });
  });

  router.delete('/rooms/:roomId/resource-bindings/script', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    unbindRoomScriptCard(db, req.params.roomId);
    publishRoomUpdate(req.params.roomId);
    res.json({ ok: true });
  });

  router.get('/rooms/:roomId/resource-bindings/world-books', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    res.json({ bindings: getRoomResourceBindings(db, req.params.roomId).worldBookBindings });
  });

  router.put('/rooms/:roomId/resource-bindings/world-books', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    const input = worldBookBindingSchema.parse(req.body);
    for (const binding of input.bindings) {
      if (!getResourceWorldBook(db, binding.worldBookId)) return res.status(404).json({ error: 'World book not found' });
    }
    const bindings = replaceRoomWorldBookBindings(db, req.params.roomId, input.bindings);
    publishRoomUpdate(req.params.roomId);
    res.json({ bindings });
  });

  router.get('/rooms/:roomId/resource-bindings/preset-package', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    res.json({ binding: getRoomResourceBindings(db, req.params.roomId).presetBinding });
  });

  router.put('/rooms/:roomId/resource-bindings/preset-package', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    const input = presetBindingSchema.parse(req.body);
    if (!getPresetPackage(db, input.presetPackageId)) return res.status(404).json({ error: 'Preset package not found' });
    const binding = bindRoomPresetPackage(db, req.params.roomId, input.presetPackageId);
    publishRoomUpdate(req.params.roomId);
    res.json({ binding });
  });

  router.delete('/rooms/:roomId/resource-bindings/preset-package', (req, res) => {
    if (!requireRoom(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });
    unbindRoomPresetPackage(db, req.params.roomId);
    publishRoomUpdate(req.params.roomId);
    res.json({ ok: true });
  });
}
