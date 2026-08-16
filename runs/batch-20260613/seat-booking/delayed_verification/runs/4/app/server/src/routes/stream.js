/**
 * GET /api/stream
 *
 * Server-Sent Events endpoint.  Each connecting client receives:
 *   1. An immediate `connected` event with the current seat map snapshot.
 *   2. Subsequent `seatUpdate` events whenever any seat changes status.
 *
 * The connection is kept alive with a comment ping every 15 seconds so
 * proxies and browsers don't time it out.
 */

import { Router } from 'express';
import { getDb, withLock } from '../db.js';
import { expireStaleHoldsUnsafe } from '../expiry.js';
import { addClient, removeClient, broadcast, clientCount } from '../sse.js';

const router = Router();

router.get('/', async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Register this client.
  addClient(res);
  console.log(`[sse] Client connected. Total: ${clientCount()}`);

  // Send initial snapshot.
  try {
    const db = await getDb();
    const seats = await withLock(async () => {
      const released = await expireStaleHoldsUnsafe(db);
      if (released.length > 0) broadcast(released);

      const { rows } = await db.query(`
        SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
        FROM   seats
        ORDER BY row_label, seat_number
      `);
      return rows;
    });

    res.write(`event: connected\ndata: ${JSON.stringify(seats)}\n\n`);
  } catch (err) {
    console.error('[sse] Error sending initial snapshot:', err);
  }

  // Keep-alive ping every 15 seconds.
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 15_000);

  // Clean up on disconnect.
  req.on('close', () => {
    clearInterval(ping);
    removeClient(res);
    console.log('[sse] Client disconnected.');
  });
});

export default router;
