import cors from 'cors';
import express from 'express';
import { ZodError } from 'zod';
import type { AppDatabase } from './db/connection.js';
import { createAdminRouter } from './routes/adminRoutes.js';
import { createPlayerRouter } from './routes/playerRoutes.js';
import { createSseRouter } from './routes/sseRoutes.js';

export function createApp(db: AppDatabase) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/admin', createAdminRouter(db));
  app.use('/api/player', createPlayerRouter(db));
  app.use('/events', createSseRouter(db));
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Invalid request body', issues: err.issues });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message || 'Internal server error' });
  });

  return app;
}
