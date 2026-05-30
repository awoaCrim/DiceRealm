import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import {
  importFromUrlAsync,
  importFromJsCode,
  listSources,
  deleteSource,
  checkForUpdates,
  updateSource
} from '../services/remoteDbImportService.js';

const importUrlSchema = z.object({
  url: z.string().url(),
  fallbackName: z.string().min(1).optional()
}).strict();

const importJsSchema = z.object({
  jsCode: z.string().min(1),
  name: z.string().min(1)
}).strict();

export function registerAdminDbRoutes(router: Router, db: AppDatabase): void {
  router.post('/db/import-from-url', async (req, res: Response) => {
    try {
      const input = importUrlSchema.parse(req.body);
      const result = await importFromUrlAsync(db, input.url, input.fallbackName);
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid import payload', issues: error.issues });
        return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/db/sources', (_req, res: Response) => {
    res.json({ sources: listSources(db) });
  });

  router.post('/db/sources/:id/check-updates', async (req, res: Response) => {
    try {
      const result = await checkForUpdates(db, req.params.id);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.post('/db/sources/:id/update', async (req, res: Response) => {
    try {
      const result = await updateSource(db, req.params.id);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.delete('/db/sources/:id', (req, res: Response) => {
    const deleted = deleteSource(db, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Source not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/db/import-js', (req, res: Response) => {
    try {
      const input = importJsSchema.parse(req.body);
      const result = importFromJsCode(db, input.name, input.jsCode);
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid JS import payload', issues: error.issues });
        return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
