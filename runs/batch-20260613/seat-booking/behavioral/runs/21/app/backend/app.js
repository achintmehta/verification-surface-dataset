import express from 'express';
import cors from 'cors';
import { createRouter } from './routes.js';

/**
 * Create an Express app with the given database instance.
 * Used for testing so we can create isolated app instances.
 */
export function createApp(db) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  const apiRouter = createRouter(db);
  app.use('/api', apiRouter);

  return app;
}
