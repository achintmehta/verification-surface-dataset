import { Router } from 'express';
import crypto from 'crypto';

const POSITION_GAP = 1000;
const MIN_GAP = 0.001;

/**
 * Compute a position between two values.
 * @param {number|null} lower - position of the card above (afterId's position)
 * @param {number|null} upper - position of the card below (beforeId's position)
 * @returns {number|null} the computed position, or null if renormalization is needed
 */
function computePosition(lower, upper) {
  if (lower === null && upper === null) {
    return POSITION_GAP;
  }
  if (lower === null) {
    return upper - POSITION_GAP;
  }
  if (upper === null) {
    return lower + POSITION_GAP;
  }
  if (Math.abs(upper - lower) < MIN_GAP) {
    return null; // needs renormalization
  }
  return (lower + upper) / 2;
}

/**
 * Renormalize all card positions in a column, evenly spacing them.
 * Returns the array of updated cards.
 */
async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    if (cards[i].position !== newPos) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
    }
    cards[i].position = newPos;
  }

  return { cards };
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

      const id = crypto.randomUUID();

      // Find the max position in the column
      const { rows: maxRows } = await db.query(
        'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
        [columnId]
      );
      const position = parseFloat(maxRows[0].max_pos) + POSITION_GAP;

      await db.query(
        'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
        [id, columnId, text, position]
      );

      const { rows } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );
      const card = rows[0];

      sseManager.broadcast('card:created', { card });

      res.status(201).json(card);
    } catch (err) {
      console.error('POST /api/cards error:', err);
      res.status(500).json({ error: 'Failed to create card' });
    }
  });

  /**
   * DELETE /api/cards/:id
   * Deletes a card.
   */
  router.delete('/cards/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { rows } = await db.query('SELECT id, column_id FROM cards WHERE id = $1', [id]);
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Card not found' });
      }

      await db.query('DELETE FROM cards WHERE id = $1', [id]);

      sseManager.broadcast('card:deleted', { id, columnId: rows[0].column_id });

      res.json({ success: true });
    } catch (err) {
      console.error('DELETE /api/cards/:id error:', err);
      res.status(500).json({ error: 'Failed to delete card' });
    }
  });

  /**
   * PATCH /api/cards/:id/move
   * Body: { columnId, afterId?, beforeId? }
   *
   * Moves a card to a target column, positioned between afterId and beforeId.
   * - afterId: the card that should be ABOVE (lower position) the moved card
   * - beforeId: the card that should be BELOW (higher position) the moved card
   * - If neither given, card goes to end of column
   * - If only afterId given, card goes right after afterId
   * - If only beforeId given, card goes right before beforeId
   */
  router.patch('/cards/:id/move', async (req, res) => {
    try {
      const { id } = req.params;
      const { columnId, afterId, beforeId } = req.body;

      if (!columnId) {
        return res.status(400).json({ error: 'columnId is required' });
      }

      // Verify the card exists
      const { rows: cardRows } = await db.query('SELECT id, column_id FROM cards WHERE id = $1', [id]);
      if (cardRows.length === 0) {
        return res.status(404).json({ error: 'Card not found' });
      }

      // Get the positions of the reference cards
      let afterPos = null;
      let beforePos = null;

      if (afterId) {
        const { rows } = await db.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [afterId, columnId]);
        if (rows.length > 0) {
          afterPos = parseFloat(rows[0].position);
        }
      }

      if (beforeId) {
        const { rows } = await db.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [beforeId, columnId]);
        if (rows.length > 0) {
          beforePos = parseFloat(rows[0].position);
        }
      }

      // If neither reference provided, go to end
      if (afterPos === null && beforePos === null) {
        if (!afterId && !beforeId) {
          // Move to end of column
          const { rows: maxRows } = await db.query(
            'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1 AND id != $2',
            [columnId, id]
          );
          afterPos = parseFloat(maxRows[0].max_pos);
          if (afterPos === 0) {
            afterPos = null; // empty column
          }
        }
      }

      let position = computePosition(afterPos, beforePos);

      // Perform the atomic update
      if (position !== null) {
        await db.query(
          'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
          [columnId, position, id]
        );
      } else {
        // Need renormalization: first do the move, then renormalize
        // Place it temporarily
        const tempPos = afterPos !== null ? afterPos + MIN_GAP / 2 : (beforePos !== null ? beforePos - MIN_GAP / 2 : POSITION_GAP);
        await db.query(
          'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
          [columnId, tempPos, id]
        );

        // Renormalize the entire column
        const { cards: renormalized } = await renormalizeColumn(db, columnId);

        // Also renormalize the source column if different
        const sourceColumnId = cardRows[0].column_id;
        if (sourceColumnId !== columnId) {
          const { cards: sourceRenormalized } = await renormalizeColumn(db, sourceColumnId);
          sseManager.broadcast('column:renormalized', {
            columnId: sourceColumnId,
            cards: sourceRenormalized,
          });
        }

        // Broadcast renormalization
        sseManager.broadcast('column:renormalized', {
          columnId,
          cards: renormalized,
        });

        // Get the final card state
        const { rows: finalRows } = await db.query(
          'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
          [id]
        );

        return res.json(finalRows[0]);
      }

      // Get the updated card
      const { rows: updatedRows } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );
      const updatedCard = updatedRows[0];

      // Broadcast the move
      const sourceColumnId = cardRows[0].column_id;
      sseManager.broadcast('card:moved', {
        card: updatedCard,
        sourceColumnId,
      });

      res.json(updatedCard);
    } catch (err) {
      console.error('PATCH /api/cards/:id/move error:', err);
      res.status(500).json({ error: 'Failed to move card' });
    }
  });

  return router;
}
