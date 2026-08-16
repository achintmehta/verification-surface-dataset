/**
 * server.js – Express entry point.
 *
 * Startup sequence:
 *  1. Initialise PGLite (creates schema + seeds seats if needed).
 *  2. Mount routes.
 *  3. Start the background expiry sweep.
 *  4. Listen on PORT (default 3001).
 */

import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { sseRouter } from './sse.js';
import { seatsRouter } from './routes/seats.js';
import { holdsRouter } from './routes/holds.js';
import { startExpirySweep } from './expiry.js';

const PORT = process.env.PORT || 3001;

async function main() {
  // ── 1. Initialise database ───────────────────────────────────────────────
  console.log('[server] Initialising database…');
  await getDb();
  console.log('[server] Database ready.');

  // ── 2. Create Express app ────────────────────────────────────────────────
  const app = express();

  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
    })
  );

  app.use(express.json());

  // ── 3. Mount routes ──────────────────────────────────────────────────────
  app.use(sseRouter);
  app.use(seatsRouter);
  app.use(holdsRouter);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // ── Test-only: expire a hold immediately (dev/test only) ─────────────────
  if (process.env.NODE_ENV !== 'production') {
    app.post('/api/test/expire-hold/:holdId', async (req, res) => {
      try {
        const db = await getDb();
        await db.query(
          `UPDATE holds SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
          [req.params.holdId]
        );
        await db.query(
          `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second'
           WHERE hold_id = $1 AND status = 'held'`,
          [req.params.holdId]
        );
        res.json({ expired: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  // ── 4. Start expiry sweep ────────────────────────────────────────────────
  startExpirySweep();

  // ── 5. Listen ────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
