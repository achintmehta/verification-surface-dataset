/**
 * Card mutation routes:
 *   POST  /api/cards          – create a card at the end of a column
 *   PATCH /api/cards/:id/move – move/reorder a card
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import { computePosition, renormalizeColumn, STEP } from '../ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  POST /api/cards                                                     */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: 'columnId is required' });
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    const db = getDb();

    // Verify column exists
    const { rows: cols } = await db.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (cols.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Find the current max position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxRows[0].max_pos !== null ? Number(maxRows[0].max_pos) : 0;
    const position = maxPos + STEP;

    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );

    const card = rows[0];
    broadcast('card:created', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /api/cards]', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                           */
/* ------------------------------------------------------------------ */
/**
 * Body: { columnId, beforeId?, afterId? }
 *
 * Semantics (from the client's perspective):
 *   afterId  – the card that will be immediately ABOVE  the moved card (null = top)
 *   beforeId – the card that will be immediately BELOW  the moved card (null = bottom)
 *
 * The server:
 *   1. Reads the current positions of afterId / beforeId in the target column.
 *   2. Computes a new fractional position.
 *   3. Updates column_id + position atomically in a transaction.
 *   4. If the gap is too small, renormalizes the column.
 *   5. Broadcasts the canonical card (and renorm data if needed).
 */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = getDb();

    // ---- Run everything in a single serialized transaction ----
    await db.query('BEGIN');

    try {
      // 1. Verify card exists
      const { rows: cardRows } = await db.query(
        'SELECT id, column_id, position FROM cards WHERE id = $1',
        [id]
      );
      if (cardRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Card not found' });
      }

      // 2. Verify target column exists
      const { rows: colRows } = await db.query(
        'SELECT id FROM columns WHERE id = $1',
        [columnId]
      );
      if (colRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Column not found' });
      }

      // 3. Resolve neighbour positions (must belong to the target column)
      let afterPos = null;
      let beforePos = null;

      if (afterId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [afterId, columnId]
        );
        if (rows.length === 0) {
          await db.query('ROLLBACK');
          return res
            .status(400)
            .json({ error: 'afterId card not found in target column' });
        }
        afterPos = Number(rows[0].position);
      }

      if (beforeId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [beforeId, columnId]
        );
        if (rows.length === 0) {
          await db.query('ROLLBACK');
          return res
            .status(400)
            .json({ error: 'beforeId card not found in target column' });
        }
        beforePos = Number(rows[0].position);
      }

      // 4. Compute new position
      const { rows: maxRows } = await db.query(
        'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
        [columnId, id]
      );
      const maxPos =
        maxRows[0].max_pos !== null ? Number(maxRows[0].max_pos) : 0;

      const { position, needsRenorm } = computePosition(
        afterPos,
        beforePos,
        maxPos
      );

      // 5. Atomically update the card
      const { rows: updated } = await db.query(
        `UPDATE cards
            SET column_id = $1,
                position  = $2
          WHERE id = $3
          RETURNING id, column_id, text, position, created_at`,
        [columnId, position, id]
      );

      const card = updated[0];

      // 6. Renormalize if needed
      let renormedCards = null;
      if (needsRenorm) {
        renormedCards = await renormalizeColumn(db, columnId);
        // Re-fetch the moved card's canonical position after renorm
        const { rows: reread } = await db.query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
          [id]
        );
        Object.assign(card, reread[0]);
      }

      await db.query('COMMIT');

      // 7. Broadcast committed state
      broadcast('card:moved', {
        card,
        renormedCards, // null unless renorm happened
      });

      res.json({ card, renormedCards });
    } catch (innerErr) {
      await db.query('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('[PATCH /api/cards/:id/move]', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

export default router;
