import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import { computePosition, renormalizeColumnFull } from './ordering.js';

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

    const board = columns.map(col => ({
      ...col,
      cards: cardsByColumn[col.id] ?? [],
    }));

    res.json(board);
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

  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and non-empty text are required' });
  }

  try {
    const db = getDb();

    // Find the current maximum position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxRows[0].maxpos ?? 0;
    const position = maxPos + 1000;

    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, columnId, text.trim(), position]
    );

    const card = rows[0];
    broadcast('card:created', card);
    res.status(201).json(card);
  } catch (err) {
    console.error('[POST /cards]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                           */
/*  Body: { columnId, beforeId?, afterId? }                            */
/*    beforeId = id of the card that will be BEFORE the moved card     */
/*    afterId  = id of the card that will be AFTER  the moved card     */
/* ------------------------------------------------------------------ */
router.patch('/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = getDb();

    // Compute canonical position (may renormalise the column first if gap is too small)
    const { position, renormalized, allCards } = await computePosition(
      db, columnId, beforeId, afterId, id
    );

    // Perform the move atomically
    await db.exec('BEGIN');
    let card;
    try {
      const { rows } = await db.query(
        `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING *`,
        [columnId, position, id]
      );
      if (!rows.length) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Card not found' });
      }
      card = rows[0];
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }

    // Broadcast
    if (renormalized) {
      // Re-normalise the full column (now including the moved card) and broadcast
      const finalCards = await renormalizeColumnFull(db, columnId);
      broadcast('column:reordered', { columnId, cards: finalCards });
      card = finalCards.find(c => c.id === id) ?? card;
    } else {
      broadcast('card:moved', card);
    }

    res.json(card);
  } catch (err) {
    console.error('[PATCH /cards/:id/move]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/stream  – SSE endpoint                                     */
/* ------------------------------------------------------------------ */
router.get('/stream', (req, res) => {
  addClient(req, res);
});

export default router;
