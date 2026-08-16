import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { broadcast, addClient } from './sse.js';
import { computePosition, renormalizePositions } from './ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  GET /api/board  – full board state                                  */
/* ------------------------------------------------------------------ */
router.get('/board', async (_req, res) => {
  try {
    const db = getDb();

    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position'
    );
    const { rows: cards } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id, position'
    );

    // Group cards by column
    const cardsByColumn = {};
    for (const col of columns) cardsByColumn[col.id] = [];
    for (const card of cards) {
      if (cardsByColumn[card.column_id]) {
        cardsByColumn[card.column_id].push(card);
      }
    }

    const board = columns.map(col => ({
      ...col,
      cards: cardsByColumn[col.id],
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
  const { columnId, text } = req.body;
  if (!columnId || !text?.trim()) {
    return res.status(400).json({ error: 'columnId and text are required' });
  }

  try {
    const db = getDb();

    // Find the current max position in the column
    const { rows } = await db.query(
      'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = rows[0].maxpos !== null ? parseFloat(rows[0].maxpos) : 0;
    const position = maxPos + 1000;

    const id = randomUUID();
    const { rows: inserted } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );

    const card = inserted[0];
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
/*    afterId  = card that will be immediately ABOVE  the moved card   */
/*    beforeId = card that will be immediately BELOW  the moved card   */
/* ------------------------------------------------------------------ */
router.patch('/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body;

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = getDb();

    // ---- Run everything in a transaction ----
    await db.exec('BEGIN');

    try {
      // Verify card exists
      const { rows: cardRows } = await db.query(
        'SELECT id FROM cards WHERE id = $1',
        [id]
      );
      if (cardRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Card not found' });
      }

      // Verify target column exists
      const { rows: colRows } = await db.query(
        'SELECT id FROM columns WHERE id = $1',
        [columnId]
      );
      if (colRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Column not found' });
      }

      // Fetch neighbour positions
      let afterPos = null;
      let beforePos = null;

      if (afterId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1',
          [afterId]
        );
        if (rows.length) afterPos = parseFloat(rows[0].position);
      }
      if (beforeId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1',
          [beforeId]
        );
        if (rows.length) beforePos = parseFloat(rows[0].position);
      }

      // Compute new position (exclude the card being moved from existing positions)
      const { rows: existingRows } = await db.query(
        'SELECT position FROM cards WHERE column_id = $1 AND id != $2 ORDER BY position',
        [columnId, id]
      );
      const existing = existingRows.map(r => parseFloat(r.position));

      const { position, needsRenorm } = computePosition(afterPos, beforePos, existing);

      // Atomically update the card
      const { rows: updated } = await db.query(
        `UPDATE cards
         SET column_id = $1, position = $2
         WHERE id = $3
         RETURNING id, column_id, text, position, created_at`,
        [columnId, position, id]
      );

      await db.exec('COMMIT');

      const card = updated[0];

      if (needsRenorm) {
        // Renormalise the column and broadcast the corrected order
        await renormalizeColumn(db, columnId);
      } else {
        broadcast('card:moved', { card });
      }

      res.json({ card });
    } catch (innerErr) {
      await db.exec('ROLLBACK');
      throw innerErr;
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
  addClient(req, res);
});

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Renormalise all card positions in a column and broadcast the result.
 */
async function renormalizeColumn(db, columnId) {
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const updates = renormalizePositions(rows.map(r => r.id));

  await db.exec('BEGIN');
  try {
    for (const { id, position } of updates) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [position, id]);
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }

  // Fetch the full updated column cards and broadcast
  const { rows: cards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  broadcast('column:reordered', { columnId, cards });
}

export default router;
