/**
 * Card mutation routes.
 *
 *   POST  /api/cards            – create a card at the end of a column
 *   PATCH /api/cards/:id/move   – move / reorder a card
 */

import { Router } from 'express';
import { getDb, newId, computePosition, renormalizeColumn } from '../db.js';
import { broadcast } from '../sse.js';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/cards
// ---------------------------------------------------------------------------

router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and text are required' });
  }

  try {
    const db = await getDb();

    // Find the current maximum position in the column so we can append.
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId],
    );
    const maxPos = maxRows[0].max_pos != null ? Number(maxRows[0].max_pos) : 0;

    const { position } = computePosition(maxPos === 0 ? null : maxPos, null);
    const id = newId('card');

    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, columnId, text.trim(), position],
    );

    const card = rows[0];

    broadcast('card:created', { card });

    return res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /api/cards]', err);
    return res.status(500).json({ error: 'Failed to create card' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/move
// ---------------------------------------------------------------------------

/**
 * Body: { columnId, beforeId?, afterId? }
 *
 * Semantics (matching the drag-and-drop model):
 *   - `columnId`  – target column (may be the same as the current column)
 *   - `beforeId`  – id of the card that will be immediately BEFORE the moved
 *                   card in the final order (i.e. the card with a lower
 *                   position), or null/omitted if the card is moved to the top
 *   - `afterId`   – id of the card that will be immediately AFTER the moved
 *                   card in the final order (i.e. the card with a higher
 *                   position), or null/omitted if the card is moved to the bottom
 *
 * The server resolves the actual position values from the database so that
 * the result is authoritative even when two clients race.
 */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = await getDb();

    // -----------------------------------------------------------------------
    // Run the whole operation inside a transaction so no client ever sees the
    // card in two columns simultaneously.
    //
    // PGLite is single-writer (one JS event-loop tick at a time) so there is
    // no true concurrent write contention, but wrapping in a transaction still
    // gives us atomicity guarantees and clean rollback on error.
    // -----------------------------------------------------------------------
    let card = null;
    let needsRenorm = false;

    await db.transaction(async (tx) => {
      // Verify the card exists.
      const { rows: cardRows } = await tx.query(
        'SELECT * FROM cards WHERE id = $1',
        [id],
      );
      if (cardRows.length === 0) {
        throw Object.assign(new Error('Card not found'), { status: 404 });
      }

      // Resolve neighbour positions from the DB (authoritative).
      let beforePos = null;
      let afterPos = null;

      if (beforeId) {
        const { rows } = await tx.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [beforeId, columnId],
        );
        if (rows.length > 0) beforePos = Number(rows[0].position);
      }

      if (afterId) {
        const { rows } = await tx.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [afterId, columnId],
        );
        if (rows.length > 0) afterPos = Number(rows[0].position);
      }

      // If neither neighbour was found in the target column (e.g. they were
      // moved concurrently), fall back to appending at the end.
      if (beforePos == null && afterPos == null && (beforeId || afterId)) {
        const { rows: maxRows } = await tx.query(
          'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
          [columnId, id],
        );
        beforePos =
          maxRows[0].max_pos != null ? Number(maxRows[0].max_pos) : null;
      }

      const computed = computePosition(beforePos, afterPos);
      needsRenorm = computed.needsRenorm;

      // Persist the move atomically.
      const { rows: updated } = await tx.query(
        `UPDATE cards
         SET column_id = $1, position = $2
         WHERE id = $3
         RETURNING *`,
        [columnId, computed.position, id],
      );

      card = updated[0];
    });

    // -----------------------------------------------------------------------
    // Broadcast the canonical card state (only after the transaction commits).
    // -----------------------------------------------------------------------
    broadcast('card:moved', { card });

    // -----------------------------------------------------------------------
    // If the gap was too small, renormalise the column and broadcast the
    // corrected order so all clients converge.
    // -----------------------------------------------------------------------
    if (needsRenorm) {
      try {
        const renormedCards = await renormalizeColumn(db, columnId);
        broadcast('column:renormed', { columnId, cards: renormedCards });
      } catch (renormErr) {
        // Non-fatal – the move already succeeded.
        console.error('[renorm]', renormErr);
      }
    }

    return res.json({ card });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'Card not found' });
    }
    console.error('[PATCH /api/cards/:id/move]', err);
    return res.status(500).json({ error: 'Failed to move card' });
  }
});

export default router;
