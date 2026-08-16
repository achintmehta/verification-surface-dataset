import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, computePosition, maybeRenormalize, renormalizeColumn } from './db.js';
import { addClient, removeClient, broadcast } from './sse.js';

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
/*  POST /api/cards  – create a card at the end of a column            */
/* ------------------------------------------------------------------ */
router.post('/cards', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || !text?.trim()) {
    return res.status(400).json({ error: 'columnId and text are required' });
  }

  try {
    const db = getDb();

    // Find the current maximum position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxRows[0].maxpos != null ? parseFloat(maxRows[0].maxpos) : 0;
    const position = maxPos + 1000;

    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, columnId, text.trim(), position]
    );

    const card = rows[0];
    broadcast('card:created', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /cards]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                           */
/*  Body: { columnId, beforeId?, afterId? }                            */
/*    beforeId = the card that will be ABOVE the moved card (or null)  */
/*    afterId  = the card that will be BELOW the moved card (or null)  */
/* ------------------------------------------------------------------ */
router.patch('/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = getDb();

    // Verify the card exists
    const { rows: cardRows } = await db.query(
      'SELECT * FROM cards WHERE id = $1',
      [id]
    );
    if (cardRows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Verify the target column exists
    const { rows: colRows } = await db.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Resolve neighbour positions
    let beforePos = null;
    let afterPos = null;

    if (beforeId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [beforeId, columnId]
      );
      if (rows.length > 0) beforePos = parseFloat(rows[0].position);
    }

    if (afterId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [afterId, columnId]
      );
      if (rows.length > 0) afterPos = parseFloat(rows[0].position);
    }

    const newPosition = computePosition(beforePos, afterPos);

    // Atomic update: change column_id and position in one statement
    const { rows: updated } = await db.query(
      `UPDATE cards
          SET column_id = $1,
              position  = $2
        WHERE id = $3
        RETURNING *`,
      [columnId, newPosition, id]
    );

    const card = updated[0];

    // If the card moved from a different column, also renormalize the source column
    const sourceColumnId = cardRows[0].column_id;
    if (sourceColumnId !== columnId) {
      const { renormalized: srcRenorm, cards: srcCards } = await maybeRenormalize(sourceColumnId);
      if (srcRenorm) {
        broadcast('column:reordered', { columnId: sourceColumnId, cards: srcCards });
      }
    }

    // Check if renormalization is needed for the target column
    const { renormalized, cards: renormCards } = await maybeRenormalize(columnId);

    if (renormalized) {
      // Find the canonical position of our card after renorm
      const canonical = renormCards.find((c) => c.id === id);
      broadcast('column:reordered', { columnId, cards: renormCards });
      broadcast('card:moved', { card: canonical ?? card });
      return res.json({ card: canonical ?? card });
    } else {
      broadcast('card:moved', { card });
      return res.json({ card });
    }
  } catch (err) {
    console.error('[PATCH /cards/:id/move]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/stream  – SSE endpoint                                     */
/* ------------------------------------------------------------------ */
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send an initial heartbeat so the client knows the connection is live
  res.write('event: connected\ndata: {}\n\n');

  addClient(res);

  // Keep-alive ping every 25 s
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(ping);
    removeClient(res);
  });
});

export default router;
