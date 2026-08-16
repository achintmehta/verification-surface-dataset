import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createDb } from './db.js';
import { createApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'pgdata');
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 2 * 60 * 1000);

async function main() {
  const db = await createDb(DATA_DIR);
  const { app, stopSweep } = createApp(db, { holdTtlMs: HOLD_TTL_MS });

  // Serve built frontend if present.
  const distDir = path.join(__dirname, '..', 'dist');
  app.use(express.static(distDir));

  const server = app.listen(PORT, () => {
    console.log(`Seat booking server listening on http://localhost:${PORT}`);
    console.log(`PGLite data dir: ${DATA_DIR}`);
  });

  const shutdown = () => {
    stopSweep();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
