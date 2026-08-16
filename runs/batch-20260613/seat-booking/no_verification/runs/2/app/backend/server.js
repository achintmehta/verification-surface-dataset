import express from 'express';
import cors from 'cors';
import { initDb, getDb } from './db.js';
import { expireStaleHolds } from './expiry.js';
import { broadcast } from './sse.js';
import seatsRouter from './routes/seats.js';
import holdsRouter from './routes/holds.js';
import streamRouter from './routes/stream.js';

const PORT = process.env.PORT || 3001;

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/seats', seatsRouter);
app.use('/api/holds', holdsRouter);
app.use('/api/stream', streamRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ── Background expiry sweep ───────────────────────────────────────────────────
async function runExpirySweep() {
  try {
    const db = await getDb();
    await db.exec('BEGIN');
    const freed = await expireStaleHolds(db);
    await db.exec('COMMIT');
    if (freed.length > 0) {
      console.log(`[sweep] Released ${freed.length} seat(s) from expired holds`);
      broadcast('seats:released', { seats: freed });
    }
  } catch (err) {
    console.error('[sweep] Error during expiry sweep:', err);
    try { const db = await getDb(); await db.exec('ROLLBACK'); } catch {}
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main() {
  await initDb();

  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });

  // Run expiry sweep every 10 seconds
  setInterval(runExpirySweep, 10_000);
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
