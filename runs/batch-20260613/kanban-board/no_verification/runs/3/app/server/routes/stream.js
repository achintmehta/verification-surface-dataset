/**
 * GET /api/stream
 * Server-Sent Events endpoint.  Keeps the connection alive and pushes
 * board mutation events to the client.
 *
 * On connect the server immediately sends a `board:init` event containing
 * the full current board state so the client can bootstrap without a
 * separate GET /api/board round-trip (though the client may still use that
 * endpoint for the initial render before SSE is established).
 */

import { Router } from 'express';
import { db } from '../db.js';
import { addClient, broadcast } from '../sse.js';

const router = Router();

router.get('/', async (req, res) => {
  // Set SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if present.
  res.flushHeaders();

  // Register this response as an active SSE client.
  const remove = addClient(res);

  // Send a heartbeat comment every 25 s to keep the connection alive through
  // proxies that close idle connections.
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);

  // Send the current board state immediately so the client can reconcile.
  try {
    const colResult = await db.query(
      `SELECT id, title, position FROM columns ORDER BY position`
    );
    const cardResult = await db.query(
      `SELECT id, column_id, text, position, created_at
         FROM cards
        ORDER BY column_id, position`
    );

    const cardsByColumn = {};
    for (const card of cardResult.rows) {
      if (!cardsByColumn[card.column_id]) cardsByColumn[card.column_id] = [];
      cardsByColumn[card.column_id].push(card);
    }

    const columns = colResult.rows.map((col) => ({
      ...col,
      cards: cardsByColumn[col.id] ?? [],
    }));

    const initData = JSON.stringify({ type: 'board:init', payload: { columns } });
    res.write(`event: board:init\ndata: ${initData}\n\n`);
  } catch (err) {
    console.error('[stream] Failed to send board:init:', err);
  }

  // Clean up when the client disconnects.
  req.on('close', () => {
    clearInterval(heartbeat);
    remove();
  });
});

export default router;
