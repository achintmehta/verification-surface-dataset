import { Router } from 'express';
import crypto from 'crypto';

const POSITION_GAP = 1000;
const MIN_GAP = 0.001;

/**
 * Compute new position between two optional neighbors.
 * Returns null if precision is exhausted (gap too small).
 */
function computePosition(afterPos, beforePos) {
  if (afterPos != null && beforePos != null) {
    const gap = beforePos - afterPos;
    if (gap <= MIN_GAP) return null; // precision exhaustion
    return afterPos + gap / 2;
  }
  if (afterPos != null) {
    return afterPos + POSITION_GAP;
  }
  if (beforePos != null) {
    return beforePos / 2;
  }
  return POSITION_GAP;
}

/**
 * Renormalize positions for all cards in a column with even spacing.
 * Returns the list of updated cards.
 */
async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  const updated = [];
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    if (cards[i].position !== newPos) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
      cards[i].position = newPos;
      updated.push(cards[i]);
    }
  }
  return { cards, updated };
}

export function createCardRoutes(db, sseManager) {
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

      // Find highest position in column
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

      const { rows: [card] } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );

      sseManager.broadcast('card:created', { card });
      res.status(201).json(card);
    } catch (err) {
      console.error('POST /api/cards error:', err);
      res.status(500).json({ error: 'Failed to create card' });
    }
  });

  /**
   * PATCH /api/cards/:id/move
   * Body: { columnId, afterId?, beforeId? }
   * Moves a card into columnId, positioned between afterId and beforeId.
   * If neither afterId nor beforeId is provided, card goes to end.
   * If only afterId, card goes after that card.
   * If only beforeId, card goes before that card.
   */
  router.patch('/cards/:id/move', async (req, res) => {
    try {
      const cardId = req.params.id;
      const { columnId, afterId, beforeId } = req.body;

      if (!columnId) {
        return res.status(400).json({ error: 'columnId is required' });
      }

      // Begin implicit transaction via sequential queries
      // Verify card exists
      const { rows: cardRows } = await db.query('SELECT id, column_id FROM cards WHERE id = $1', [cardId]);
      if (cardRows.length === 0) {
        return res.status(404).json({ error: 'Card not found' });
      }

      // Verify column exists
      const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
      if (colRows.length === 0) {
        return res.status(404).json({ error: 'Column not found' });
      }

      // Get afterId position
      let afterPos = null;
      if (afterId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [afterId, columnId]
        );
        if (rows.length > 0) {
          afterPos = rows[0].position;
        }
      }

      // Get beforeId position
      let beforePos = null;
      if (beforeId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [beforeId, columnId]
        );
        if (rows.length > 0) {
          beforePos = rows[0].position;
        }
      }

      // If no neighbors specified, place at end
      if (afterPos == null && beforePos == null && !afterId && !beforeId) {
        const { rows } = await db.query(
          'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
          [columnId, cardId]
        );
        afterPos = rows[0].max_pos;
      }

      let newPosition = computePosition(afterPos, beforePos);

      // Check for precision exhaustion / collision
      let renormalized = false;
      if (newPosition == null) {
        // Renormalize the column (excluding the card being moved for now)
        // First move the card into the column so renormalize includes it at a temp position
        // Actually, we'll renormalize after placing, so let's just renormalize first
        const { cards: normalizedCards } = await renormalizeColumn(db, columnId);

        // Re-fetch neighbor positions after renormalization
        if (afterId) {
          const { rows } = await db.query(
            'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
            [afterId, columnId]
          );
          afterPos = rows.length > 0 ? rows[0].position : null;
        }
        if (beforeId) {
          const { rows } = await db.query(
            'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
            [beforeId, columnId]
          );
          beforePos = rows.length > 0 ? rows[0].position : null;
        }

        newPosition = computePosition(afterPos, beforePos);
        if (newPosition == null) {
          newPosition = afterPos != null ? afterPos + POSITION_GAP : POSITION_GAP;
        }
        renormalized = true;
      }

      // Atomically update the card
      await db.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, cardId]
      );

      // Fetch updated card
      const { rows: [updatedCard] } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [cardId]
      );

      // Check for position collision with existing cards in the column
      const { rows: collisionRows } = await db.query(
        'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
        [columnId, newPosition, cardId]
      );

      if (collisionRows.length > 0) {
        renormalized = true;
      }

      if (renormalized || collisionRows.length > 0) {
        // Renormalize and broadcast full column state
        const { cards: allCards } = await renormalizeColumn(db, columnId);
        // Re-fetch the moved card after renormalization
        const { rows: [freshCard] } = await db.query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
          [cardId]
        );

        sseManager.broadcast('column:renormalized', {
          columnId,
          cards: allCards,
        });
        res.json(freshCard);
      } else {
        sseManager.broadcast('card:moved', { card: updatedCard });
        res.json(updatedCard);
      }
    } catch (err) {
      console.error('PATCH /api/cards/:id/move error:', err);
      res.status(500).json({ error: 'Failed to move card' });
    }
  });

  /**
   * DELETE /api/cards/:id
   * Deletes a card.
   */
  router.delete('/cards/:id', async (req, res) => {
    try {
      const cardId = req.params.id;
      const { rows } = await db.query('SELECT id, column_id FROM cards WHERE id = $1', [cardId]);
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Card not found' });
      }
      await db.query('DELETE FROM cards WHERE id = $1', [cardId]);
      sseManager.broadcast('card:deleted', { cardId, columnId: rows[0].column_id });
      res.json({ success: true });
    } catch (err) {
      console.error('DELETE /api/cards/:id error:', err);
      res.status(500).json({ error: 'Failed to delete card' });
    }
  });

  return router;
}
