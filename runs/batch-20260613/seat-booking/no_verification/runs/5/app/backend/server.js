import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from './db.js';
import { expireStaleHolds } from './expiry.js';
import { broadcast, clientCount } from './sse.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/seats',  seatsRouter);
app.use('/api/holds',  holdsRouter);
app.use('/api/stream', streamRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', sseClients: clientCount() });
});

// ── Static frontend (production build) ───────────────────────────────────────
const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

// ── Background expiry sweep ───────────────────────────────────────────────────
// Runs every 10 seconds to release stale holds even when no requests arrive.
async function runExpirySweep() {
  try {
    const db = await getDb();
    const freed = await expireStaleHolds(db);
    if (freed.length > 0) {
      console.log(`[sweep] Released ${freed.length} expired seat(s).`);
      broadcast('released', freed);
    }
  } catch (err) {
    console.error('[sweep] Error during expiry sweep:', err);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main() {
  try {
    await initDb();
    console.log('[server] Database ready.');

    app.listen(PORT, () => {
      console.log(`[server] Listening on http://localhost:${PORT}`);
    });

    // Start periodic sweep after server is up
    setInterval(runExpirySweep, 10_000);
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

main();
