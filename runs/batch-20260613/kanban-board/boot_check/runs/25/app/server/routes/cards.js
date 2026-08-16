import { Router } from 'express';
import crypto from 'crypto';

const POSITION_GAP = 1000;
const MIN_GAP = 0.001; // threshold to trigger renormalization

/**
 * Compute a position value between two optional bounds.
 * If both are null, returns POSITION_GAP.
 * If only afterPos exists (inserting at end after it), returns afterPos + POSITION_GAP.
 * If only beforePos exists (inserting at start before it), returns beforePos / 2.
 * If both exist, returns the midpoint.
 */
function computePosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) return POSITION_GAP;
  if (afterPos == null) return beforePos / 2;
  if (beforePos == null) return afterPos + POSITION_GAP;
  return (afterPos + beforePos) / 2;
}

export function createCardRoutes(db, sse) {
  const router = Router();

  /**
   * POST /api/cards
   * Body: { columnId, text }
   * Creates a card at the end of the specified column.
   */
  router.post('/cards', async (req, res) => {
    try {
      const { columnId, text } = req.body;
      if (!columnId || !text) {
        return res.status(400).json({ error: 'columnId and text are required' });
      }

      // Verify column exists
      const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
      if (colRows.length === 0) {
        return res.status(404).json({ error: 'Column not found' });
      }

      // Find the max position in the column
      const { rows: maxRows } = await db.query(
        'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
        [columnId]
      );
      const maxPos = maxRows[0].max_pos;
      const position = maxPos != null ? maxPos + POSITION_GAP : POSITION_GAP;

      const id = 'card-' + crypto.randomUUID();

      await db.query(
        'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
        [id, columnId, text, position]
      );

      const { rows } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );
      const card = rows[0];

      // Broadcast
      sse.broadcast('card-created', { card });

      res.status(201).json(card);
    } catch (err) {
      console.error('POST /api/cards error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * PATCH /api/cards/:id/move
   * Body: { columnId, afterId?, beforeId? }
   *
   * Moves a card into columnId, positioned between afterId and beforeId.
   * - afterId is the card that should be directly above (before) this card.
   * - beforeId is the card that should be directly below (after) this card.
   * - If neither is provided, card goes to the end of the column.
   * - If only afterId, card goes after that card (at end).
   * - If only beforeId, card goes before that card (at start).
   */
  router.patch('/cards/:id/move', async (req, res) => {
    try {
      const cardId = req.params.id;
      const { columnId, afterId, beforeId } = req.body;

      if (!columnId) {
        return res.status(400).json({ error: 'columnId is required' });
      }

      // Verify card exists
      const { rows: cardRows } = await db.query('SELECT id FROM cards WHERE id = $1', [cardId]);
      if (cardRows.length === 0) {
        return res.status(404).json({ error: 'Card not found' });
      }

      // Verify column exists
      const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
      if (colRows.length === 0) {
        return res.status(404).json({ error: 'Column not found' });
      }

      // Get positions of after and before cards
      let afterPos = null;
      let beforePos = null;

      if (afterId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [afterId, columnId]
        );
        if (rows.length > 0) afterPos = rows[0].position;
      }

      if (beforeId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [beforeId, columnId]
        );
        if (rows.length > 0) beforePos = rows[0].position;
      }

      // If neither afterId nor beforeId resolved, figure out placement
      if (afterPos == null && beforePos == null) {
        if (!afterId && !beforeId) {
          // Place at end of column
          const { rows: maxRows } = await db.query(
            'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
            [columnId, cardId]
          );
          if (maxRows[0].max_pos != null) {
            afterPos = maxRows[0].max_pos;
          }
        }
      }

      const newPosition = computePosition(afterPos, beforePos);

      // Atomic update: change column and position
      await db.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, cardId]
      );

      // Check if renormalization is needed
      await maybeRenormalize(db, sse, columnId);

      // Return canonical card
      const { rows: updated } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [cardId]
      );
      const card = updated[0];

      // Broadcast the move
      sse.broadcast('card-moved', { card });

      res.json(card);
    } catch (err) {
      console.error('PATCH /api/cards/:id/move error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * DELETE /api/cards/:id
   * Deletes a card.
   */
  router.delete('/cards/:id', async (req, res) => {
    try {
      const cardId = req.params.id;
      const { rows } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [cardId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Card not found' });
      }

      await db.query('DELETE FROM cards WHERE id = $1', [cardId]);

      sse.broadcast('card-deleted', { cardId, columnId: rows[0].column_id });

      res.json({ success: true });
    } catch (err) {
      console.error('DELETE /api/cards/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

/**
 * Check if any adjacent cards in the column have positions too close together.
 * If so, renormalize all positions in the column evenly and broadcast.
 */
async function maybeRenormalize(db, sse, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );

  if (cards.length < 2) return;

  // Check for collisions or precision exhaustion
  let needsRenorm = false;
  for (let i = 1; i < cards.length; i++) {
    const gap = cards[i].position - cards[i - 1].position;
    if (gap < MIN_GAP) {
      needsRenorm = true;
      break;
    }
  }

  if (!needsRenorm) return;

  console.log(`Renormalizing column ${columnId} (${cards.length} cards)`);

  // Renormalize: assign evenly spaced positions
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
  }

  // Fetch and broadcast the corrected column state
  const { rows: updatedCards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );

  sse.broadcast('column-renormalized', { columnId, cards: updatedCards });
}
