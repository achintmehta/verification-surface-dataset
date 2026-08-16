/**
 * GET /api/stream
 *
 * Server-Sent Events endpoint.
 * On connection:
 *   1. Registers the client with the SSE manager.
 *   2. Immediately sends the full board snapshot so the new client is in sync.
 */

import { Router } from 'express';
import { addClient } from '../sse.js';
import { query } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  // Register the SSE client first (sets headers, flushes)
  addClient(req, res);

  try {
    // Send the current board state as the first event so the client
    // doesn't need a separate HTTP round-trip after connecting.
    const { rows: columns } = await query(
      'SELECT id, title, position FROM columns ORDER BY position ASC',
    );
    const { rows: cards } = await query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id, position ASC',
    );

    const cardsByColumn = {};
    for (const card of cards) {
      if (!cardsByColumn[card.column_id]) cardsByColumn[card.column_id] = [];
      cardsByColumn[card.column_id].push(card);
    }

    const boardColumns = columns.map((col) => ({
      ...col,
      cards: cardsByColumn[col.id] ?? [],
    }));

    // Send only to this client (not broadcast) – write directly to res
    const payload = JSON.stringify({ columns: boardColumns });
    res.write(`event: board:state\ndata: ${payload}\n\n`);
  } catch (err) {
    console.error('[GET /api/stream] Failed to send initial board state:', err);
    // Client will still be registered; it will receive future events
  }
});

export default router;
