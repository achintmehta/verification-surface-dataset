/**
 * Card mutation routes:
 *   POST  /api/cards          – create a card at the end of a column
 *   PATCH /api/cards/:id/move – move / reorder a card
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import { computePosition, renormalise } from '../ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  POST /api/cards                                                     */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: '`columnId` is required.' });
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '`text` is required.' });
  }

  try {
    const db = getDb();

    // Verify column exists
    const { rows: cols } = await db.query(
      `SELECT id FROM columns WHERE id = $1`,
      [columnId]
    );
    if (cols.length === 0) {
      return res.status(404).json({ error: 'Column not found.' });
    }

    // Find the current maximum position in the column
    const { rows: maxRows } = await db.query(
      `SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1`,
      [columnId]
    );
    const maxPos = parseFloat(maxRows[0].max_pos);

    const position = maxPos + 1000;
    const id = randomUUID();

    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
            VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );

    const card = rows[0];

    broadcast('card:created', { card });

    return res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /api/cards]', err);
    return res.status(500).json({ error: 'Failed to create card.' });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                           */
/* ------------------------------------------------------------------ */
/**
 * Body: { columnId, beforeId?, afterId? }
 *
 * Semantics (matching the drag-and-drop model):
 *   afterId  – the card immediately ABOVE  the drop target (null → top)
 *   beforeId – the card immediately BELOW  the drop target (null → bottom)
 *
 * The server:
 *  1. Resolves the positions of afterId / beforeId in the target column.
 *  2. Computes the new fractional position.
 *  3. Updates column_id + position atomically in a transaction.
 *  4. If renormalisation is needed, renormalises the whole column and
 *     broadcasts a `column:reordered` event in addition to `card:moved`.
 *  5. Broadcasts the canonical card state.
 */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: '`columnId` is required.' });
  }

  try {
    const db = getDb();

    // ── Verify card exists ──────────────────────────────────────────
    const { rows: cardRows } = await db.query(
      `SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1`,
      [id]
    );
    if (cardRows.length === 0) {
      return res.status(404).json({ error: 'Card not found.' });
    }

    // ── Verify target column exists ─────────────────────────────────
    const { rows: colRows } = await db.query(
      `SELECT id FROM columns WHERE id = $1`,
      [columnId]
    );
    if (colRows.length === 0) {
      return res.status(404).json({ error: 'Column not found.' });
    }

    // ── Fetch all cards in the target column (excluding the moving card) ─
    const { rows: colCards } = await db.query(
      `SELECT id, position FROM cards
        WHERE column_id = $1 AND id != $2
        ORDER BY position`,
      [columnId, id]
    );

    // Resolve neighbour positions
    let afterPos = null;
    let beforePos = null;

    if (afterId) {
      const found = colCards.find((c) => c.id === afterId);
      // afterId might be the card itself (same-column move) – already excluded
      afterPos = found ? parseFloat(found.position) : null;
    }
    if (beforeId) {
      const found = colCards.find((c) => c.id === beforeId);
      beforePos = found ? parseFloat(found.position) : null;
    }

    const maxPos =
      colCards.length > 0
        ? parseFloat(colCards[colCards.length - 1].position)
        : 0;

    const { position, needsRenorm } = computePosition(afterPos, beforePos, maxPos);

    // ── Atomic update ───────────────────────────────────────────────
    await db.exec('BEGIN');
    try {
      await db.query(
        `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3`,
        [columnId, position, id]
      );
      await db.exec('COMMIT');
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }

    // ── Fetch the canonical card ────────────────────────────────────
    const { rows: updated } = await db.query(
      `SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1`,
      [id]
    );
    const card = updated[0];

    // ── Broadcast canonical move ────────────────────────────────────
    broadcast('card:moved', { card });

    // ── Renormalise if needed ───────────────────────────────────────
    if (needsRenorm) {
      await renormaliseColumn(db, columnId);
    }

    return res.json({ card });
  } catch (err) {
    console.error('[PATCH /api/cards/:id/move]', err);
    return res.status(500).json({ error: 'Failed to move card.' });
  }
});

/* ------------------------------------------------------------------ */
/*  Internal: renormalise a column and broadcast corrected order        */
/* ------------------------------------------------------------------ */
async function renormaliseColumn(db, columnId) {
  try {
    const { rows } = await db.query(
      `SELECT id, column_id, text, position, created_at
         FROM cards
        WHERE column_id = $1
        ORDER BY position`,
      [columnId]
    );

    const normalised = renormalise(rows);

    await db.exec('BEGIN');
    try {
      for (const card of normalised) {
        await db.query(
          `UPDATE cards SET position = $1 WHERE id = $2`,
          [card.position, card.id]
        );
      }
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }

    broadcast('column:reordered', { columnId, cards: normalised });
  } catch (err) {
    console.error('[renormaliseColumn]', err);
  }
}

export default router;
