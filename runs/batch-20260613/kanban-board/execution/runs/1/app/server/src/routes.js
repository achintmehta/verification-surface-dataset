/**
 * Express route handlers for the Kanban API.
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import { computePosition, maybeRenormalize } from './ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  GET /api/board  – full board state                                  */
/* ------------------------------------------------------------------ */
router.get('/board', async (_req, res) => {
  try {
    const db = getDb();

    const { rows: columns } = await db.query(
      'SELECT * FROM columns ORDER BY position ASC'
    );

    const { rows: cards } = await db.query(
      'SELECT * FROM cards ORDER BY column_id, position ASC'
    );

    // Group cards by column
    const cardsByColumn = {};
    for (const card of cards) {
      if (!cardsByColumn[card.column_id]) cardsByColumn[card.column_id] = [];
      cardsByColumn[card.column_id].push(card);
    }

    const board = columns.map((col) => ({
      ...col,
      cards: cardsByColumn[col.id] ?? [],
    }));

    res.json({ columns: board });
  } catch (err) {
    console.error('[GET /board]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  POST /api/cards  – create a new card                               */
/* ------------------------------------------------------------------ */
router.post('/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;

    if (!columnId || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }

    const db = getDb();

    // Verify column exists
    const { rows: cols } = await db.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (cols.length === 0) {
      return res.status(404).json({ error: `Column ${columnId} not found` });
    }

    // Find current max position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxRows[0].maxpos ?? 0;
    const position = computePosition(null, null, maxPos);

    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, columnId, text.trim(), position]
    );

    const card = rows[0];

    // Broadcast to all SSE clients
    broadcast('card:created', { card });

    // Check if renormalization is needed (unlikely on create, but be safe)
    await maybeRenormalize(columnId);

    res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /cards]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move  – move / reorder a card                 */
/* ------------------------------------------------------------------ */
router.patch('/cards/:id/move', async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId, beforeId, afterId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const db = getDb();

    // Verify card exists
    const { rows: cardRows } = await db.query(
      'SELECT * FROM cards WHERE id = $1',
      [id]
    );
    if (cardRows.length === 0) {
      return res.status(404).json({ error: `Card ${id} not found` });
    }

    // Verify target column exists
    const { rows: colRows } = await db.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      return res.status(404).json({ error: `Column ${columnId} not found` });
    }

    // Resolve neighbour positions
    let afterPos = null;
    let beforePos = null;

    if (afterId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [afterId, columnId]
      );
      if (rows.length > 0) afterPos = rows[0].position;
    }

    if (beforeId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [beforeId, columnId]
      );
      if (rows.length > 0) beforePos = rows[0].position;
    }

    // If neither neighbour resolved, append to end of target column
    if (afterPos === null && beforePos === null && !afterId && !beforeId) {
      const { rows: maxRows } = await db.query(
        'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1 AND id != $2',
        [columnId, id]
      );
      afterPos = maxRows[0].maxpos ?? null;
    }

    const newPosition = computePosition(afterPos, beforePos, afterPos);

    // Atomically update the card (handles cross-column moves safely)
    let updatedCard;
    await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE cards
         SET column_id = $1, position = $2
         WHERE id = $3
         RETURNING *`,
        [columnId, newPosition, id]
      );
      updatedCard = rows[0];
    });

    // Broadcast canonical state to all clients
    broadcast('card:moved', { card: updatedCard });

    // Check for position collisions / precision exhaustion
    const sourceColumnId = cardRows[0].column_id;
    await maybeRenormalize(columnId);
    if (sourceColumnId !== columnId) {
      await maybeRenormalize(sourceColumnId);
    }

    res.json({ card: updatedCard });
  } catch (err) {
    console.error('[PATCH /cards/:id/move]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/stream  – SSE endpoint                                    */
/* ------------------------------------------------------------------ */
router.get('/stream', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if present
  res.flushHeaders();

  // Send an initial "connected" event so the client knows the stream is live
  res.write('event: connected\ndata: {}\n\n');

  // Register this client for broadcasts
  addClient(res);

  // Keep-alive ping every 25 seconds to prevent proxy timeouts
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 25_000);

  req.on('close', () => clearInterval(keepAlive));
});

export default router;
