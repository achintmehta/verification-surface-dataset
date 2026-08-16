import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import { between, needsRenorm, renormalize } from '../ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  POST /api/cards                                                     */
/*  Create a new card at the end of a column.                          */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { columnId, text } = req.body;

  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and non-empty text are required.' });
  }

  try {
    const db = getDb();

    // Find the current maximum position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxRows[0].max_pos !== null ? Number(maxRows[0].max_pos) : 0;
    const newPosition = between(maxPos === 0 ? null : maxPos, null);

    const id = randomUUID();
    const now = new Date().toISOString();

    await db.query(
      `INSERT INTO cards (id, column_id, text, position, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, columnId, text.trim(), newPosition, now]
    );

    const card = { id, column_id: columnId, text: text.trim(), position: newPosition, created_at: now };

    broadcast('card:created', { card });

    res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /api/cards]', err);
    res.status(500).json({ error: 'Failed to create card.' });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                           */
/*  Move a card to a column, optionally between two other cards.       */
/*  Body: { columnId, beforeId?, afterId? }                            */
/*    beforeId = id of the card that will be immediately BEFORE ours   */
/*    afterId  = id of the card that will be immediately AFTER ours    */
/* ------------------------------------------------------------------ */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body;

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required.' });
  }

  try {
    const db = getDb();

    // Run everything in a single serialised transaction
    await db.query('BEGIN');

    try {
      // Lock the card row
      const { rows: cardRows } = await db.query(
        'SELECT id, column_id, position FROM cards WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (cardRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Card not found.' });
      }

      // Resolve neighbour positions
      let beforePos = null;
      let afterPos = null;

      if (beforeId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [beforeId, columnId]
        );
        if (rows.length) beforePos = Number(rows[0].position);
      }

      if (afterId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [afterId, columnId]
        );
        if (rows.length) afterPos = Number(rows[0].position);
      }

      // If neither neighbour found, place at end
      if (beforePos === null && afterPos === null && (beforeId || afterId)) {
        // Neighbours not in target column – fall back to end
        const { rows: maxRows } = await db.query(
          'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
          [columnId, id]
        );
        const maxPos = maxRows[0].max_pos !== null ? Number(maxRows[0].max_pos) : 0;
        beforePos = maxPos === 0 ? null : maxPos;
      }

      let newPosition = between(beforePos, afterPos);

      // Check for precision collision with neighbours
      const shouldRenorm =
        (beforePos !== null && needsRenorm(beforePos, newPosition)) ||
        (afterPos !== null && needsRenorm(newPosition, afterPos));

      // Update the card
      await db.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, id]
      );

      await db.query('COMMIT');

      // Renormalise if needed (outside the move transaction to keep it short)
      if (shouldRenorm) {
        await renormalizeColumn(db, columnId);
        // Re-fetch the card's new position after renorm
        const { rows: refreshed } = await db.query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
          [id]
        );
        if (refreshed.length) {
          newPosition = Number(refreshed[0].position);
        }
      }

      // Fetch the canonical card state
      const { rows: finalRows } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );
      const card = finalRows[0];

      // If we renormalised, broadcast the full column order
      if (shouldRenorm) {
        const { rows: colCards } = await db.query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
          [columnId]
        );
        broadcast('column:reordered', { columnId, cards: colCards });
      } else {
        broadcast('card:moved', { card });
      }

      res.json({ card });
    } catch (innerErr) {
      await db.query('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('[PATCH /api/cards/:id/move]', err);
    res.status(500).json({ error: 'Failed to move card.' });
  }
});

/* ------------------------------------------------------------------ */
/*  Internal: renormalise a column's card positions                    */
/* ------------------------------------------------------------------ */
async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  const normalized = renormalize(cards);

  await db.query('BEGIN');
  try {
    for (const { id, position } of normalized) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [position, id]);
    }
    await db.query('COMMIT');
    console.log(`[ordering] Renormalised column ${columnId} (${normalized.length} cards).`);
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('[ordering] Renormalisation failed:', err);
  }
}

export default router;
