/**
 * Card mutation routes:
 *   POST  /api/cards          – create a card at the end of a column
 *   PATCH /api/cards/:id/move – move/reorder a card
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import { between, needsRenormalization, renormalizedPositions } from '../ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Renormalize all card positions in a column, persist them, and broadcast
 * a `column-reorder` event so every client can reconcile.
 *
 * Must be called inside an existing transaction context (the caller owns
 * the transaction).
 */
async function renormalizeColumn(db, columnId) {
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  const newPositions = renormalizedPositions(rows.length);
  for (let i = 0; i < rows.length; i++) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [
      newPositions[i],
      rows[i].id,
    ]);
  }

  // Fetch the updated cards to broadcast
  const { rows: updatedCards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  broadcast('column-reorder', { columnId, cards: updatedCards });
}

/* ------------------------------------------------------------------ */
/*  POST /api/cards                                                     */
/* ------------------------------------------------------------------ */

router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: '`columnId` and non-empty `text` are required' });
  }

  try {
    const db = getDb();

    // Verify column exists
    const { rows: cols } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (cols.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Find the current maximum position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxRows[0].max_pos ?? 0;
    const newPosition = maxPos + 1000;

    const id = randomUUID();
    const { rows: inserted } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), newPosition]
    );

    const card = inserted[0];
    broadcast('card-created', { card });
    res.status(201).json(card);
  } catch (err) {
    console.error('[POST /api/cards]', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                           */
/* ------------------------------------------------------------------ */

router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId, afterId } = req.body ?? {};

  if (!columnId) {
    return res.status(400).json({ error: '`columnId` is required' });
  }

  try {
    const db = getDb();

    // Verify target column exists
    const { rows: cols } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (cols.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Verify card exists
    const { rows: cardRows } = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    if (cardRows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Resolve neighbour positions
    let beforePos = null;
    let afterPos = null;

    if (beforeId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [beforeId, columnId]
      );
      if (rows.length > 0) beforePos = rows[0].position;
    }

    if (afterId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [afterId, columnId]
      );
      if (rows.length > 0) afterPos = rows[0].position;
    }

    // Compute new position
    // Convention: beforeId is the card immediately ABOVE (smaller position),
    //             afterId  is the card immediately BELOW (larger position).
    const newPosition = between(beforePos, afterPos);

    // Atomically update the card (single statement = implicit transaction in PGLite)
    const { rows: updated } = await db.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3
       RETURNING id, column_id, text, position, created_at`,
      [columnId, newPosition, id]
    );

    const card = updated[0];

    // Check if renormalization is needed
    if (needsRenormalization(newPosition, beforePos, afterPos)) {
      await renormalizeColumn(db, columnId);
      // The renormalize broadcast already sent the full column order;
      // we still return the card (its position may have changed, but the
      // client will reconcile from the column-reorder event).
      const { rows: fresh } = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
      return res.json(fresh[0]);
    }

    broadcast('card-moved', { card });
    res.json(card);
  } catch (err) {
    console.error('[PATCH /api/cards/:id/move]', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

export default router;
