import { Router } from 'express';
import { getDb, newId, computePosition, renormalizeColumn } from '../db.js';
import { broadcast } from '../sse.js';

const router = Router();

/**
 * POST /api/cards
 * Body: { columnId: string, text: string }
 *
 * Creates a new card at the END of the specified column.
 */
router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: 'columnId is required.' });
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }

  try {
    const db = await getDb();

    // Verify column exists
    const { rows: cols } = await db.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (cols.length === 0) {
      return res.status(404).json({ error: 'Column not found.' });
    }

    // Find the current maximum position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1',
      [columnId]
    );
    // lowPos = current max (card above), highPos = null (no card below → append at end)
    const maxPos = maxRows[0].maxpos !== null ? parseFloat(maxRows[0].maxpos) : null;
    const { position } = computePosition(maxPos, null);

    const id = newId('card');
    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text.trim(), position]
    );

    const { rows } = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
    const card = rows[0];

    broadcast('card:created', { card });

    return res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /api/cards]', err);
    return res.status(500).json({ error: 'Failed to create card.' });
  }
});

/**
 * PATCH /api/cards/:id/move
 * Body: { columnId: string, beforeId?: string|null, afterId?: string|null }
 *
 * Moves a card to `columnId`, positioned between the card identified by
 * `afterId` (the card immediately before in the list) and `beforeId`
 * (the card immediately after in the list).
 *
 * Naming convention (matching the frontend drag-drop intent):
 *   afterId  = the card that will be ABOVE  the moved card (lower position)
 *   beforeId = the card that will be BELOW  the moved card (higher position)
 *
 * Either may be null/undefined to indicate the start or end of the column.
 */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: 'columnId is required.' });
  }

  try {
    const db = await getDb();

    // --- All reads + write happen inside a serializable transaction ---
    await db.exec('BEGIN');

    try {
      // Verify card exists
      const { rows: cardRows } = await db.query(
        'SELECT * FROM cards WHERE id = $1',
        [id]
      );
      if (cardRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Card not found.' });
      }

      // Verify target column exists
      const { rows: colRows } = await db.query(
        'SELECT id FROM columns WHERE id = $1',
        [columnId]
      );
      if (colRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Column not found.' });
      }

      // Resolve neighbour positions.
      // afterId  = the card immediately ABOVE the target slot (lower position value)
      // beforeId = the card immediately BELOW the target slot (higher position value)
      let lowPos = null;   // position of afterId card
      let highPos = null;  // position of beforeId card

      if (afterId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [afterId, columnId]
        );
        if (rows.length > 0) lowPos = parseFloat(rows[0].position);
      }

      if (beforeId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [beforeId, columnId]
        );
        if (rows.length > 0) highPos = parseFloat(rows[0].position);
      }

      // If both neighbours are in the column but lowPos >= highPos something
      // is wrong (stale client state). Fall back: place at end.
      if (lowPos !== null && highPos !== null && lowPos >= highPos) {
        const { rows: maxRows } = await db.query(
          'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1 AND id != $2',
          [columnId, id]
        );
        lowPos = maxRows[0].maxpos !== null ? parseFloat(maxRows[0].maxpos) : null;
        highPos = null;
      }

      const { position, needsRenorm } = computePosition(lowPos, highPos);

      // Atomic update: change column_id and position in one statement
      await db.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, position, id]
      );

      await db.exec('COMMIT');

      // Fetch the canonical card
      const { rows: updated } = await db.query(
        'SELECT * FROM cards WHERE id = $1',
        [id]
      );
      let card = updated[0];

      // Renormalize if precision is exhausted
      if (needsRenorm) {
        console.log(`[cards] Renormalizing column ${columnId} due to position collision.`);
        const renormed = await renormalizeColumn(db, columnId);
        // Find the card in the renormed list
        const renormedCard = renormed.find((c) => c.id === id);
        if (renormedCard) card = renormedCard;

        // Broadcast the full column renormalization
        broadcast('column:renormalized', { columnId, cards: renormed });
      }

      broadcast('card:moved', { card });

      return res.json({ card });
    } catch (innerErr) {
      await db.exec('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('[PATCH /api/cards/:id/move]', err);
    return res.status(500).json({ error: 'Failed to move card.' });
  }
});

export default router;
