const express = require('express');
const { getDb } = require('../db');
const { broadcast } = require('../broadcast');
const { v4: uuidv4 } = require('../uuid');

const router = express.Router();

// Position gap for new cards
const POSITION_GAP = 1000;
// Minimum gap before renormalization
const MIN_GAP = 0.0001;

// POST /api/cards - Create a new card at the end of a column
router.post('/cards', async (req, res) => {
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

    // Get max position in column
    const maxResult = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPosition = parseFloat(maxResult.rows[0].max_pos) + POSITION_GAP;

    const id = uuidv4();
    const result = await db.query(
      `INSERT INTO cards (id, column_id, text, position) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), newPosition]
    );

    const card = {
      id: result.rows[0].id,
      columnId: result.rows[0].column_id,
      text: result.rows[0].text,
      position: result.rows[0].position,
      createdAt: result.rows[0].created_at
    };

    // Broadcast to all connected clients
    broadcast('card-created', card);

    res.status(201).json(card);
  } catch (err) {
    console.error('Error creating card:', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// PATCH /api/cards/:id/move - Move a card within or across columns
router.patch('/cards/:id/move', async (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    // Verify card exists
    const cardResult = await db.query('SELECT id, column_id, position FROM cards WHERE id = $1', [id]);
    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Verify target column exists
    const colResult = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colResult.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    let newPosition;

    if (afterId && beforeId) {
      // Between two cards
      const afterResult = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      const beforeResult = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);

      if (afterResult.rows.length === 0 || beforeResult.rows.length === 0) {
        return res.status(404).json({ error: 'Reference card not found' });
      }

      const afterPos = parseFloat(afterResult.rows[0].position);
      const beforePos = parseFloat(beforeResult.rows[0].position);
      newPosition = (afterPos + beforePos) / 2;
    } else if (afterId) {
      // After a card (at the end after afterId)
      const afterResult = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (afterResult.rows.length === 0) {
        return res.status(404).json({ error: 'Reference card not found' });
      }
      const afterPos = parseFloat(afterResult.rows[0].position);

      // Find the next card after afterId in the same column
      const nextResult = await db.query(
        `SELECT position FROM cards 
         WHERE column_id = $1 AND position > $2 AND id != $3
         ORDER BY position ASC LIMIT 1`,
        [columnId, afterPos, id]
      );

      if (nextResult.rows.length > 0) {
        newPosition = (afterPos + parseFloat(nextResult.rows[0].position)) / 2;
      } else {
        newPosition = afterPos + POSITION_GAP;
      }
    } else if (beforeId) {
      // Before a card (at the beginning before beforeId)
      const beforeResult = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      if (beforeResult.rows.length === 0) {
        return res.status(404).json({ error: 'Reference card not found' });
      }
      const beforePos = parseFloat(beforeResult.rows[0].position);

      // Find the previous card before beforeId in the same column
      const prevResult = await db.query(
        `SELECT position FROM cards 
         WHERE column_id = $1 AND position < $2 AND id != $3
         ORDER BY position DESC LIMIT 1`,
        [columnId, beforePos, id]
      );

      if (prevResult.rows.length > 0) {
        newPosition = (parseFloat(prevResult.rows[0].position) + beforePos) / 2;
      } else {
        newPosition = beforePos / 2;
      }
    } else {
      // No reference cards - put at the end of column
      const maxResult = await db.query(
        'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1 AND id != $2',
        [columnId, id]
      );
      newPosition = parseFloat(maxResult.rows[0].max_pos) + POSITION_GAP;
    }

    // Atomic update: move card to new column and position
    const updateResult = await db.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3
       RETURNING id, column_id, text, position, created_at`,
      [columnId, newPosition, id]
    );

    const card = {
      id: updateResult.rows[0].id,
      columnId: updateResult.rows[0].column_id,
      text: updateResult.rows[0].text,
      position: updateResult.rows[0].position,
      createdAt: updateResult.rows[0].created_at
    };

    // Check for renormalization need
    await maybeRenormalize(db, columnId);

    // Also renormalize source column if it changed
    const oldColumnId = cardResult.rows[0].column_id;
    if (oldColumnId !== columnId) {
      await maybeRenormalize(db, oldColumnId);
    }

    // Broadcast to all connected clients
    broadcast('card-moved', { card, sourceColumnId: oldColumnId });

    res.json(card);
  } catch (err) {
    console.error('Error moving card:', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// DELETE /api/cards/:id - Delete a card
router.delete('/cards/:id', async (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const result = await db.query(
      'DELETE FROM cards WHERE id = $1 RETURNING id, column_id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    broadcast('card-deleted', {
      id: result.rows[0].id,
      columnId: result.rows[0].column_id
    });

    res.json({ id: result.rows[0].id });
  } catch (err) {
    console.error('Error deleting card:', err);
    res.status(500).json({ error: 'Failed to delete card' });
  }
});

// Renormalize positions in a column if gaps are too small
async function maybeRenormalize(db, columnId) {
  const cardsResult = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  const cards = cardsResult.rows;
  if (cards.length < 2) return;

  // Check if any gap is too small
  let needsRenorm = false;
  for (let i = 1; i < cards.length; i++) {
    const gap = parseFloat(cards[i].position) - parseFloat(cards[i - 1].position);
    if (gap < MIN_GAP) {
      needsRenorm = true;
      break;
    }
  }

  if (!needsRenorm) return;

  console.log(`Renormalizing column ${columnId}`);

  // Reassign positions with even gaps
  const updates = [];
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
    updates.push({ id: cards[i].id, position: newPos });
  }

  // Broadcast renormalization
  broadcast('column-renormalized', { columnId, cards: updates });
}

module.exports = router;
