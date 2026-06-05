import { Router } from 'express';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import { listCharacterResourceChanges, rollbackResourceChange } from '../services/characterAuditService.js';
import { longRest, shortRest } from '../services/characterResourceService.js';

const restSchema = z.object({
  action: z.enum(['short', 'long']),
  actorType: z.string().default('player'),
  actorId: z.string().default(''),
  hitDiceSpent: z.number().int().positive().optional()
}).strict();

const rollbackSchema = z.object({
  revertedBy: z.string().min(1)
}).strict();

export function registerAdminCharacterResourceRoutes(router: Router, db: AppDatabase): void {
  router.post('/rooms/:roomId/characters/:charId/rest', (req, res) => {
    try {
      const input = restSchema.parse(req.body);

      const char = db.prepare(
        'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE c.id = ? AND p.room_id = ?'
      ).get(req.params.charId, req.params.roomId);
      if (!char) return res.status(404).json({ error: 'Character not found in room' });

      if (input.action === 'short') {
        const resources = shortRest(db, req.params.charId, {
          roomId: req.params.roomId,
          actorType: input.actorType,
          actorId: input.actorId,
          hitDiceSpent: input.hitDiceSpent,
        });
        res.json({ resources });
      } else {
        const resources = longRest(db, req.params.charId, {
          roomId: req.params.roomId,
          actorType: input.actorType,
          actorId: input.actorId,
        });
        res.json({ resources });
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid rest payload', issues: error.issues });
        return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/rooms/:roomId/character-resource-changes', (req, res) => {
    try {
      const characterId = typeof req.query.characterId === 'string' ? req.query.characterId : undefined;
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) || 20 : 20;
      const changes = listCharacterResourceChanges(db, req.params.roomId, { characterId, limit }).map((change) => ({
        ...change,
        before: JSON.parse(change.beforeJson),
        after: JSON.parse(change.afterJson)
      }));
      res.json({ changes });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/rooms/:roomId/character-resource-changes/:changeId/rollback', (req, res) => {
    try {
      const input = rollbackSchema.parse(req.body);
      const change = rollbackResourceChange(db, req.params.changeId, input.revertedBy);
      res.json({
        restored: true,
        change: {
          ...change,
          before: JSON.parse(change.beforeJson),
          after: JSON.parse(change.afterJson)
        }
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid rollback payload', issues: error.issues });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message.includes('not found') ? 404 : message.includes('already reverted') ? 409 : 400;
      res.status(statusCode).json({ error: message });
    }
  });
}
