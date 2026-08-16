/**
 * Express application factory.
 *
 * Separated from index.js so tests can import the app without starting the
 * HTTP server or the periodic sweep.
 */

import express from 'express';
import cors from 'cors';

import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Routes
  app.use('/api/seats', seatsRouter);
  app.use('/api/holds', holdsRouter);
  app.use('/api/stream', streamRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  return app;
}
