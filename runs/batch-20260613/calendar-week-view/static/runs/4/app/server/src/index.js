/**
 * Entry point for the Express server.
 * Starts on PORT (default 3001).
 */

import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import eventsRouter from './routes/events.js';

const PORT = process.env.PORT ?? 3001;

const app = express();

// Allow the Vite dev server (port 5173) and any other origin in development.
app.use(cors());

// Parse JSON request bodies.
app.use(express.json());

// Mount the events API.
app.use('/api/events', eventsRouter);

// Health-check endpoint.
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Initialise the database before accepting connections.
getDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Calendar API server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
