import cors from 'cors';
import express from 'express';
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

  return app;
}
