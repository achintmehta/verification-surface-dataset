import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import { computePosition, renormalizeColumn, INITIAL_GAP } from '../ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  POST /api/cards                                                     */
/*  Body: { columnId: string, text: string }                           */
/*  Creates a card at the END of the specified column.                 */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and non-empty text are required' });
  }

  try {
    const db = getDb();

    // Find the current maximum position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId],
    );
    const maxPos = maxRows[0].max_pos !== null ? parseFloat(maxRows[0].max_pos) : 0;
    const position = maxPos + INITIAL_GAP;

    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position],
    );

    const card = rows[0];
    broadcast('card:created', card);
    res.status(201).json(card);
  } catch (err) {
    console.error('[POST /api/cards]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                          */
/*  Body: { columnId: string, beforeId?: string, afterId?: string }   */
/*                                                                     */
/*  beforeId = id of the card that will be ABOVE the moved card        */
/*  afterId  = id of the card that will be BELOW the moved card        */
/*                                                                     */
/*  The server computes the canonical position, persists atomically,   */
/*  and broadcasts the result.                                         */
/* ------------------------------------------------------------------ */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = getDb();

    // Run everything in a single transaction for atomicity
    await db.query('BEGIN');

    try {
      // Verify the card exists
      const { rows: cardRows } = await db.query(
        'SELECT id FROM cards WHERE id = $1',
        [id],
      );
      if (cardRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Card not found' });
      }

      // Verify the target column exists
      const { rows: colRows } = await db.query(
        'SELECT id FROM columns WHERE id = $1',
        [columnId],
      );
      if (colRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Column not found' });
      }

      // Fetch positions of the neighbour cards (if provided)
      let beforePos = null;
      let afterPos  = null;

      if (beforeId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [beforeId, columnId],
        );
        if (rows.length > 0) beforePos = parseFloat(rows[0].position);
      }

      if (afterId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [afterId, columnId],
        );
        if (rows.length > 0) afterPos = parseFloat(rows[0].position);
      }

      // Current max position in the target column (excluding the card being moved)
      const { rows: maxRows } = await db.query(
        'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
        [columnId, id],
      );
      const maxPos = maxRows[0].max_pos !== null ? parseFloat(maxRows[0].max_pos) : 0;

      const { position, needsRenorm } = computePosition(beforePos, afterPos, maxPos);

      // Persist the move atomically
      const { rows: updated } = await db.query(
        `UPDATE cards
            SET column_id = $1, position = $2
          WHERE id = $3
          RETURNING id, column_id, text, position, created_at`,
        [columnId, position, id],
      );

      let card = updated[0];

      // Renormalize if precision is exhausted
      let renormUpdates = null;
      if (needsRenorm) {
        console.log(`[ordering] renormalizing column ${columnId}`);
        renormUpdates = await renormalizeColumn(db, columnId);
        // Refresh the moved card's position after renorm
        const { rows: refreshed } = await db.query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
          [id],
        );
        card = refreshed[0];
      }

      await db.query('COMMIT');

      // Broadcast canonical state AFTER commit
      broadcast('card:moved', card);

      if (renormUpdates) {
        // Broadcast the full renormalized column so all clients converge
        const { rows: allCards } = await db.query(
          `SELECT id, column_id, text, position, created_at
             FROM cards
            WHERE column_id = $1
            ORDER BY position ASC`,
          [columnId],
        );
        broadcast('column:reordered', { columnId, cards: allCards });
      }

      res.json(card);
    } catch (innerErr) {
      await db.query('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('[PATCH /api/cards/:id/move]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
