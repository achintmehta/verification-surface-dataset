import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import { computePosition, needsRenormalisation, renormalisedPositions } from '../ordering.js';

const router = Router();

/* ─────────────────────────────────────────────────────────────
   POST /api/cards
   Body: { columnId, text }
   Creates a card at the end of the column.
───────────────────────────────────────────────────────────── */
router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and non-empty text are required' });
  }

  try {
    const db = getDb();

    // Find the current maximum position in the column
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1',
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
    broadcast('card:created', card);
    res.status(201).json(card);
  } catch (err) {
    console.error('[POST /api/cards]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   PATCH /api/cards/:id/move
   Body: { columnId, beforeId?, afterId? }

   beforeId = the card currently BELOW the drop target (null → drop at bottom)
   afterId  = the card currently ABOVE the drop target (null → drop at top)

   The server computes the canonical position, persists atomically,
   and broadcasts the result.
───────────────────────────────────────────────────────────── */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = getDb();

    // Run everything inside a transaction for atomicity
    await db.exec('BEGIN');

    try {
      // Lock the card row
      const { rows: cardRows } = await db.query(
        'SELECT id, column_id, position FROM cards WHERE id = $1',
        [id]
      );
      if (cardRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Card not found' });
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

      // Fetch current max position in target column (for append case)
      const { rows: maxRows } = await db.query(
        'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
        [columnId, id]
      );
      const maxPos = parseFloat(maxRows[0].max_pos);

      const newPosition = computePosition(afterPos, beforePos, maxPos);

      // Update the card
      const { rows: updated } = await db.query(
        `UPDATE cards
         SET column_id = $1, position = $2
         WHERE id = $3
         RETURNING id, column_id, text, position, created_at`,
        [columnId, newPosition, id]
      );

      await db.exec('COMMIT');

      const card = updated[0];

      // Check if renormalisation is needed for the target column
      await maybeRenormalise(db, columnId);

      // Re-fetch the card in case renormalisation changed its position
      const { rows: finalRows } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );
      const finalCard = finalRows[0] ?? card;

      broadcast('card:moved', finalCard);
      res.json(finalCard);
    } catch (innerErr) {
      await db.exec('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('[PATCH /api/cards/:id/move]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   Renormalisation helper
   If any two adjacent cards in a column are too close together,
   rewrite all positions to evenly-spaced multiples of 1000 and
   broadcast the corrected column order.
───────────────────────────────────────────────────────────── */
async function maybeRenormalise(db, columnId) {
  const { rows } = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );

  if (rows.length < 2) return;

  const positions = rows.map(r => parseFloat(r.position));
  if (!needsRenormalisation(positions)) return;

  console.log(`[ordering] renormalising column ${columnId} (${rows.length} cards)`);

  const fresh = renormalisedPositions(rows.length);
  await db.exec('BEGIN');
  try {
    for (let i = 0; i < rows.length; i++) {
      await db.query(
        'UPDATE cards SET position = $1 WHERE id = $2',
        [fresh[i], rows[i].id]
      );
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error('[ordering] renormalisation failed', err);
    return;
  }

  // Broadcast the corrected order for the whole column
  const { rows: corrected } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  broadcast('column:reordered', { columnId, cards: corrected });
}

export default router;
