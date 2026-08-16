/**
 * GET /api/stream
 *
 * Server-Sent Events endpoint.  Each connecting client receives:
 *   1. An immediate `seats:snapshot` event with the full current seat list so
 *      it can initialise without a separate REST call.
 *   2. Subsequent `seats:held`, `seats:booked`, and `seats:released` events
 *      as other users interact with the system.
 */

import { Router } from 'express';
import { query } from '../db.js';
import { releaseExpiredHolds } from '../expiry.js';
import { addClient, removeClient } from '../sse.js';

const router = Router();

router.get('/', async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Register this client so it receives future broadcasts.
  addClient(res);

  // Send an initial snapshot so the client doesn't need a separate REST call.
  try {
    await releaseExpiredHolds();
    const { rows } = await query(`
      SELECT id, row_label, seat_number, status, hold_id, hold_expires_at, booked_by
      FROM   seats
      ORDER  BY row_label, seat_number
    `);
    res.write(`event: seats:snapshot\ndata: ${JSON.stringify({ seats: rows })}\n\n`);
  } catch (err) {
    console.error('[SSE] snapshot error:', err);
  }

  // Keep-alive ping every 20 seconds to prevent proxy timeouts.
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 20_000);

  // Clean up when the client disconnects.
  req.on('close', () => {
    clearInterval(keepAlive);
    removeClient(res);
  });
});

export default router;
