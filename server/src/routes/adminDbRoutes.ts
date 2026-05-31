import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import {
  listSources,
  listSourceSheets,
  deleteSource,
  checkForUpdates,
  updateSource
} from '../services/remoteDbImportService.js';
import {
  deleteRoomDbRow,
  listRoomDbRows,
  listRoomDbSheets,
  listRoomDbSourceBindings,
  replaceRoomDbSourceBindings,
  upsertRoomDbRow
} from '../services/remoteDbRuntimeService.js';

const roomSourceBindingsSchema = z.object({
  bindings: z.array(z.object({
    sourceId: z.string().min(1),
    enabled: z.boolean(),
    orderIndex: z.number().int()
  }))
}).strict();

const rowDataSchema = z.object({
  data: z.record(z.string(), z.unknown())
}).strict();

export function registerAdminDbRoutes(router: Router, db: AppDatabase): void {
  router.get('/db/sources', (_req, res: Response) => {
    res.json({ sources: listSources(db) });
  });

  router.get('/db/sources/:id/sheets', (req, res: Response) => {
    res.json({ sheets: listSourceSheets(db, req.params.id) });
  });

  router.get('/rooms/:roomId/db/sources', (req, res: Response) => {
    res.json({ bindings: listRoomDbSourceBindings(db, req.params.roomId) });
  });

  router.put('/rooms/:roomId/db/sources', (req, res: Response) => {
    try {
      const input = roomSourceBindingsSchema.parse(req.body);
      const bindings = replaceRoomDbSourceBindings(db, req.params.roomId, input.bindings);
      res.json({ bindings });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid room DB bindings payload', issues: error.issues });
        return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/rooms/:roomId/db/sheets', (req, res: Response) => {
    res.json({ sheets: listRoomDbSheets(db, req.params.roomId) });
  });

  router.get('/rooms/:roomId/db/sheets/:sheetId/rows', (req, res: Response) => {
    res.json({ rows: listRoomDbRows(db, req.params.roomId, req.params.sheetId) });
  });

  router.put('/rooms/:roomId/db/sheets/:sheetId/rows/:rowKey', (req, res: Response) => {
    try {
      const input = rowDataSchema.parse(req.body);
      const row = upsertRoomDbRow(db, req.params.roomId, req.params.sheetId, req.params.rowKey, input.data);
      res.json({ row });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid row payload', issues: error.issues });
        return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/rooms/:roomId/db/sheets/:sheetId/rows/:rowKey', (req, res: Response) => {
    const deleted = deleteRoomDbRow(db, req.params.roomId, req.params.sheetId, req.params.rowKey);
    if (!deleted) {
      res.status(404).json({ error: 'Row not found' });
      return;
    }
    res.json({ ok: true });
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
}
