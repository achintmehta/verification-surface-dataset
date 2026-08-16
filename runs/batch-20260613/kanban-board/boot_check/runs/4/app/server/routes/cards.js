import { Router } from 'express';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import { computePosition, renormalizeColumn } from '../ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  POST /api/cards  – create a new card at the end of a column        */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and non-empty text are required' });
  }

  try {
    const db = getDb();

    // Find the current maximum position in the column
    const maxResult = await db.query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxResult.rows[0].max_pos ?? 0;

    const { position } = computePosition(maxPos === 0 ? null : maxPos, null, maxPos);

    const insertResult = await db.query(
      `INSERT INTO cards (column_id, text, position)
       VALUES ($1, $2, $3)
       RETURNING id, column_id, text, position, created_at`,
      [columnId, text.trim(), position]
    );

    const card = insertResult.rows[0];

    broadcast('card:created', { card });

    res.status(201).json({ card });
  } catch (err) {
    console.error('POST /api/cards error:', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                          */
/*  Body: { columnId, beforeId?, afterId? }                            */
/*    beforeId – id of the card that should come BEFORE the moved card */
/*    afterId  – id of the card that should come AFTER  the moved card */
/* ------------------------------------------------------------------ */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = getDb();

    // Verify the target column exists
    const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Verify the card exists
    const cardCheck = await db.query('SELECT id FROM cards WHERE id = $1', [id]);
    if (cardCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Fetch neighbour positions
    let beforePos = null;
    let afterPos  = null;

    if (beforeId) {
      const r = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [beforeId, columnId]
      );
      if (r.rows.length > 0) beforePos = r.rows[0].position;
    }

    if (afterId) {
      const r = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [afterId, columnId]
      );
      if (r.rows.length > 0) afterPos = r.rows[0].position;
    }

    // If neither neighbour was found, place at the end
    if (beforePos === null && afterPos === null && (beforeId || afterId)) {
      // Neighbours may have moved; fall back to end-of-column
      const maxResult = await db.query(
        'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
        [columnId, id]
      );
      beforePos = maxResult.rows[0].max_pos ?? 0;
    }

    const { position, needsRenorm } = computePosition(beforePos, afterPos);

    // Atomic update
    const updateResult = await db.query(
      `UPDATE cards SET column_id = $1, position = $2
       WHERE id = $3
       RETURNING id, column_id, text, position, created_at`,
      [columnId, position, id]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const card = updateResult.rows[0];

    // Renormalise if positions are too close
    if (needsRenorm) {
      const renormed = await renormalizeColumn(db, columnId);
      // Find the canonical position for this card after renorm
      const updated = renormed.find(r => r.id === id);
      if (updated) card.position = updated.position;

      broadcast('column:reordered', {
        columnId,
        cards: renormed,
      });
    }

    broadcast('card:moved', { card });

    res.json({ card });
  } catch (err) {
    console.error('PATCH /api/cards/:id/move error:', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

export default router;
