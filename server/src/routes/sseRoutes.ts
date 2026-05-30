import { Router } from 'express';
import type { AppDatabase } from '../db/connection.js';
import { subscribeRoomUpdate } from '../services/eventBus.js';

export function createSseRouter(_db: AppDatabase): Router {
  const router = Router();

  router.get('/rooms/:roomId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const unsubscribe = subscribeRoomUpdate(req.params.roomId, () => {
      res.write(`event: room-updated\ndata: ${JSON.stringify({ roomId: req.params.roomId })}\n\n`);
    });

    req.on('close', () => {
      unsubscribe();
      res.end();
    });
  });

  return router;
}
