/**
 * GET /api/stream
 *
 * Server-Sent Events endpoint.  Each connecting client receives:
 *   - An immediate 'connected' event with the current seat snapshot.
 *   - Subsequent 'seat-update' events whenever any seat changes state.
 *
 * The connection is kept alive with a periodic comment ping so proxies and
 * load-balancers do not close idle connections.
 */

import { Router } from 'express';
import { getDb } from '../db.js';
import { addClient } from '../sse.js';
import { releaseExpiredHolds } from '../expiry.js';
import { broadcast } from '../sse.js';

const router = Router();
const PING_INTERVAL_MS = 25_000; // 25 seconds

router.get('/', async (req, res) => {
  // ── SSE headers ────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // ── Register this client ───────────────────────────────────────────────────
  const removeClient = addClient(res);

  // ── Keep-alive ping ────────────────────────────────────────────────────────
  const pingHandle = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // Client gone; cleanup will happen in the close handler.
    }
  }, PING_INTERVAL_MS);

  // ── Send initial seat snapshot ─────────────────────────────────────────────
  try {
    const db = await getDb();

    // Release expired holds so the snapshot is accurate.
    const released = await releaseExpiredHolds(db);
    if (released.length > 0) {
      broadcast('released', released);
    }

    const { rows } = await db.query(`
      SELECT
        id,
        row_label       AS "rowLabel",
        seat_number     AS "seatNumber",
        status,
        hold_id         AS "holdId",
        hold_expires_at AS "holdExpiresAt",
        booked_by       AS "bookedBy"
      FROM seats
      ORDER BY row_label, seat_number
    `);

    const snapshot = JSON.stringify({ type: 'snapshot', seats: rows, ts: Date.now() });
    res.write(`event: connected\ndata: ${snapshot}\n\n`);
  } catch (err) {
    console.error('[SSE] Failed to send initial snapshot:', err);
  }

  // ── Cleanup on disconnect ──────────────────────────────────────────────────
  req.on('close', () => {
    clearInterval(pingHandle);
    removeClient();
  });
});

export default router;
