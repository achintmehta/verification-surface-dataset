import { Router } from 'express';
import { getDb } from '../db.js';
import { broadcast } from './sse.js';

export const cardsRouter = Router();

// Minimum gap between positions before we renormalize
const MIN_GAP = 0.0001;
const POSITION_BASE = 1000;
const POSITION_GAP = 1000;

function generateId() {
  return 'card-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 9);
}

/**
 * Renormalize positions for all cards in a column.
 * Returns the updated cards array.
 */
async function renormalizeColumn(db, columnId) {
  const result = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  const cards = result.rows;
  if (cards.length === 0) return [];

  const updates = [];
  for (let i = 0; i < cards.length; i++) {
    const newPosition = POSITION_BASE + i * POSITION_GAP;
    if (cards[i].position !== newPosition) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPosition, cards[i].id]);
      cards[i].position = newPosition;
      updates.push(cards[i]);
    }
  }

  return { cards, updates };
}

/**
 * Compute a position between two values. Triggers renormalization if gap is too small.
 */
function computePositionBetween(before, after) {
  if (before === null && after === null) {
    return POSITION_BASE;
  }
  if (before === null) {
    return after - POSITION_GAP;
  }
  if (after === null) {
    return before + POSITION_GAP;
  }
  return (before + after) / 2;
}

// POST /api/cards - Create a new card
cardsRouter.post('/cards', async (req, res) => {
  try {
    const db = getDb();
    const { columnId, text } = req.body;

    if (!columnId || !text || !text.trim()) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    // Verify column exists
    const colResult = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colResult.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Get the last position in the column
    const lastCard = await db.query(
      'SELECT position FROM cards WHERE column_id = $1 ORDER BY position DESC LIMIT 1',
      [columnId]
    );

    const position =
      lastCard.rows.length > 0 ? lastCard.rows[0].position + POSITION_GAP : POSITION_BASE;

    const id = generateId();
    const result = await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING id, column_id, text, position, created_at',
      [id, columnId, text.trim(), position]
    );

    const card = result.rows[0];

    broadcast('card:created', { card });

    res.status(201).json({ card });
  } catch (err) {
    console.error('Error creating card:', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// PATCH /api/cards/:id/move - Move/reorder a card
cardsRouter.patch('/cards/:id/move', async (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { columnId, beforeId, afterId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    // Verify card exists
    const cardResult = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [id]
    );
    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const card = cardResult.rows[0];
    const sourceColumnId = card.column_id;

    // Verify target column exists
    const colResult = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colResult.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Get reference positions
    let beforePosition = null;
    let afterPosition = null;

    if (afterId) {
      const afterResult = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [afterId, columnId]
      );
      if (afterResult.rows.length > 0) {
        afterPosition = afterResult.rows[0].position;
      }
    }

    if (beforeId) {
      const beforeResult = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [beforeId, columnId]
      );
      if (beforeResult.rows.length > 0) {
        beforePosition = beforeResult.rows[0].position;
      }
    }

    // If no references provided, place at end of column
    if (!afterId && !beforeId) {
      const lastCard = await db.query(
        'SELECT position FROM cards WHERE column_id = $1 AND id != $2 ORDER BY position DESC LIMIT 1',
        [columnId, id]
      );
      if (lastCard.rows.length > 0) {
        afterPosition = lastCard.rows[0].position;
        beforePosition = null;
      }
    }

    // If only afterId provided but it wasn't found (card may have moved),
    // or only beforeId provided but not found, place at end/beginning
    if (afterId && afterPosition === null && !beforeId) {
      const lastCard = await db.query(
        'SELECT position FROM cards WHERE column_id = $1 AND id != $2 ORDER BY position DESC LIMIT 1',
        [columnId, id]
      );
      afterPosition = lastCard.rows.length > 0 ? lastCard.rows[0].position : null;
    }

    if (beforeId && beforePosition === null && !afterId) {
      const firstCard = await db.query(
        'SELECT position FROM cards WHERE column_id = $1 AND id != $2 ORDER BY position ASC LIMIT 1',
        [columnId, id]
      );
      beforePosition = firstCard.rows.length > 0 ? firstCard.rows[0].position : null;
    }

    let newPosition = computePositionBetween(afterPosition, beforePosition);

    // Atomic update: move card to new column and position
    await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
      columnId,
      newPosition,
      id,
    ]);

    // Check if we need to renormalize (gap too small)
    let needsRenormalize = false;
    if (afterPosition !== null && beforePosition !== null) {
      const gap = Math.abs(beforePosition - afterPosition);
      if (gap < MIN_GAP) {
        needsRenormalize = true;
      }
    }

    // Also check precision: if position is very close to neighbors
    if (!needsRenormalize) {
      const neighbors = await db.query(
        `SELECT position FROM cards WHERE column_id = $1 AND id != $2 
         AND ABS(position - $3) < $4 ORDER BY position`,
        [columnId, id, newPosition, MIN_GAP]
      );
      if (neighbors.rows.length > 0) {
        needsRenormalize = true;
      }
    }

    if (needsRenormalize) {
      const { cards: normalizedCards } = await renormalizeColumn(db, columnId);

      // Broadcast full column renormalization
      broadcast('column:renormalized', {
        columnId,
        cards: normalizedCards,
      });

      // If source column is different, also renormalize it
      if (sourceColumnId !== columnId) {
        const { cards: sourceCards } = await renormalizeColumn(db, sourceColumnId);
        broadcast('column:renormalized', {
          columnId: sourceColumnId,
          cards: sourceCards,
        });
      }

      // Return the updated card
      const updatedCard = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );
      return res.json({ card: updatedCard.rows[0] });
    }

    // Read back the canonical card
    const updatedCard = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [id]
    );

    const canonicalCard = updatedCard.rows[0];

    broadcast('card:moved', {
      card: canonicalCard,
      sourceColumnId,
    });

    res.json({ card: canonicalCard });
  } catch (err) {
    console.error('Error moving card:', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// DELETE /api/cards/:id - Delete a card
cardsRouter.delete('/cards/:id', async (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const cardResult = await db.query(
      'SELECT id, column_id FROM cards WHERE id = $1',
      [id]
    );
    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const card = cardResult.rows[0];
    await db.query('DELETE FROM cards WHERE id = $1', [id]);

    broadcast('card:deleted', { cardId: id, columnId: card.column_id });

    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting card:', err);
    res.status(500).json({ error: 'Failed to delete card' });
  }
});
