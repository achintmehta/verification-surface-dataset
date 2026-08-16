/**
 * Card mutation routes:
 *   POST  /api/cards          – create a card at the end of a column
 *   PATCH /api/cards/:id/move – move/reorder a card
 */

import { Router } from 'express';
import { db } from '../db.js';
import { broadcast } from '../sse.js';
import { computePosition, renormalise, POSITION_GAP } from '../ordering.js';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a simple unique id (timestamp + random suffix). */
function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Fetch all cards in a column ordered by position.
 * @param {string} columnId
 * @returns {Promise<Array>}
 */
async function getColumnCards(columnId) {
  const result = await db.query(
    `SELECT id, column_id, text, position, created_at
       FROM cards
      WHERE column_id = $1
      ORDER BY position`,
    [columnId]
  );
  return result.rows;
}

/**
 * Renormalise a column's card positions and persist them.
 * Returns the updated card rows.
 * @param {string} columnId
 * @returns {Promise<Array>}
 */
async function renormaliseColumn(columnId) {
  const cards = await getColumnCards(columnId);
  const updates = renormalise(cards);

  for (const { id, position } of updates) {
    await db.query(`UPDATE cards SET position = $1 WHERE id = $2`, [
      position,
      id,
    ]);
  }

  // Return fresh rows after update.
  return getColumnCards(columnId);
}

// ---------------------------------------------------------------------------
// POST /api/cards
// ---------------------------------------------------------------------------

router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and non-empty text are required' });
  }

  try {
    // Verify column exists.
    const colCheck = await db.query(`SELECT id FROM columns WHERE id = $1`, [columnId]);
    if (colCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Find the current maximum position in the column.
    const maxResult = await db.query(
      `SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1`,
      [columnId]
    );
    const maxPos = Number(maxResult.rows[0].max_pos);

    const position = maxPos + POSITION_GAP;
    const id = uid();

    await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)`,
      [id, columnId, text.trim(), position]
    );

    const cardResult = await db.query(
      `SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1`,
      [id]
    );
    const card = cardResult.rows[0];

    broadcast('card:created', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('[cards] POST /api/cards error:', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/move
// ---------------------------------------------------------------------------

/**
 * Body: { columnId, beforeId?, afterId? }
 *
 * Semantics (matching the drag-and-drop model):
 *   beforeId – the card that will be immediately BEFORE the moved card
 *              (i.e. the card above it / to its left in position order)
 *   afterId  – the card that will be immediately AFTER the moved card
 *              (i.e. the card below it / to its right in position order)
 *
 * Either or both may be null/omitted to indicate the head or tail of the column.
 */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    // Verify card exists.
    const cardCheck = await db.query(`SELECT id FROM cards WHERE id = $1`, [id]);
    if (cardCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Verify column exists.
    const colCheck = await db.query(`SELECT id FROM columns WHERE id = $1`, [columnId]);
    if (colCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Resolve neighbour positions.
    let beforePos = null;
    let afterPos = null;

    if (beforeId) {
      const r = await db.query(`SELECT position FROM cards WHERE id = $1`, [beforeId]);
      if (r.rows.length > 0) beforePos = Number(r.rows[0].position);
    }

    if (afterId) {
      const r = await db.query(`SELECT position FROM cards WHERE id = $1`, [afterId]);
      if (r.rows.length > 0) afterPos = Number(r.rows[0].position);
    }

    // If no neighbours provided, find the max position in the target column
    // (excluding the card being moved itself).
    let maxPos = 0;
    if (beforeId === null && afterId === null) {
      const maxResult = await db.query(
        `SELECT COALESCE(MAX(position), 0) AS max_pos
           FROM cards
          WHERE column_id = $1 AND id != $2`,
        [columnId, id]
      );
      maxPos = Number(maxResult.rows[0].max_pos);
    }

    const { position, needsRenorm } = computePosition(beforePos, afterPos, maxPos);

    // Atomic update: change column_id and position in one statement.
    await db.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3`,
      [columnId, position, id]
    );

    // Fetch the canonical card.
    const cardResult = await db.query(
      `SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1`,
      [id]
    );
    const card = cardResult.rows[0];

    // Broadcast the canonical move first.
    broadcast('card:moved', { card });
    res.json({ card });

    // If precision was exhausted, renormalise the column and broadcast the
    // corrected order as a separate event (after responding to the client).
    if (needsRenorm) {
      console.warn(`[ordering] Renormalising column ${columnId} due to position collision`);
      const updatedCards = await renormaliseColumn(columnId);
      broadcast('column:reorder', { columnId, cards: updatedCards });
    }
  } catch (err) {
    console.error('[cards] PATCH /api/cards/:id/move error:', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

export default router;
