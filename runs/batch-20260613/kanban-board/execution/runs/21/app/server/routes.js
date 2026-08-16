const express = require('express');
const { getDb } = require('./db');
const { addClient, broadcast } = require('./sse');
const { computePosition, needsRenormalization, renormalize } = require('./ordering');
const crypto = require('crypto');

const router = express.Router();

// Mutex for serializing mutations to avoid race conditions
let mutexQueue = Promise.resolve();
function withMutex(fn) {
  const p = mutexQueue.then(() => fn());
  mutexQueue = p.catch(() => {});
  return p;
}

// GET /api/board - Return full board state
router.get('/board', async (req, res) => {
  try {
    const db = await getDb();
    const columnsResult = await db.query('SELECT id, title, position FROM columns ORDER BY position ASC');
    const cardsResult = await db.query('SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC');

    const columns = columnsResult.rows.map(col => ({
      id: col.id,
      title: col.title,
      position: col.position,
      cards: cardsResult.rows
        .filter(card => card.column_id === col.id)
        .map(card => ({
          id: card.id,
          columnId: card.column_id,
          text: card.text,
          position: card.position,
          createdAt: card.created_at
        }))
    }));

    res.json({ columns });
  } catch (err) {
    console.error('Error fetching board:', err);
    res.status(500).json({ error: 'Failed to fetch board' });
  }
});

// POST /api/cards - Create a new card
router.post('/cards', async (req, res) => {
  try {
    const result = await withMutex(async () => {
      const db = await getDb();
      const { columnId, text } = req.body;

      if (!columnId || !text) {
        return { error: 'columnId and text are required', status: 400 };
      }

      // Check column exists
      const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
      if (colCheck.rows.length === 0) {
        return { error: 'Column not found', status: 404 };
      }

      // Get the last position in column
      const lastCard = await db.query(
        'SELECT position FROM cards WHERE column_id = $1 ORDER BY position DESC LIMIT 1',
        [columnId]
      );

      const lastPos = lastCard.rows.length > 0 ? lastCard.rows[0].position : null;
      const position = computePosition(lastPos, null);

      const id = 'card-' + crypto.randomUUID();
      const insertResult = await db.query(
        'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING id, column_id, text, position, created_at',
        [id, columnId, text, position]
      );

      const card = {
        id: insertResult.rows[0].id,
        columnId: insertResult.rows[0].column_id,
        text: insertResult.rows[0].text,
        position: insertResult.rows[0].position,
        createdAt: insertResult.rows[0].created_at
      };

      return { card };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    broadcast('card:created', result.card);
    res.status(201).json(result.card);
  } catch (err) {
    console.error('Error creating card:', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// PATCH /api/cards/:id/move - Move a card
router.patch('/cards/:id/move', async (req, res) => {
  try {
    const result = await withMutex(async () => {
      const db = await getDb();
      const { id } = req.params;
      const { columnId, afterId, beforeId } = req.body;

      if (!columnId) {
        return { error: 'columnId is required', status: 400 };
      }

      // Verify card exists
      const cardCheck = await db.query('SELECT id, column_id FROM cards WHERE id = $1', [id]);
      if (cardCheck.rows.length === 0) {
        return { error: 'Card not found', status: 404 };
      }

      // Verify column exists
      const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
      if (colCheck.rows.length === 0) {
        return { error: 'Column not found', status: 404 };
      }

      // Get positions of anchor cards
      let afterPos = null;
      let beforePos = null;

      if (afterId) {
        const afterCard = await db.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [afterId, columnId]);
        if (afterCard.rows.length > 0) {
          afterPos = afterCard.rows[0].position;
        }
      }

      if (beforeId) {
        const beforeCard = await db.query('SELECT position FROM cards WHERE id = $1 AND column_id = $2', [beforeId, columnId]);
        if (beforeCard.rows.length > 0) {
          beforePos = beforeCard.rows[0].position;
        }
      }

      // If neither anchor found, figure out position from column state
      if (afterPos == null && beforePos == null) {
        if (afterId || beforeId) {
          // Anchors were specified but not found (maybe moved), just put at end
          const lastCard = await db.query(
            'SELECT position FROM cards WHERE column_id = $1 AND id != $2 ORDER BY position DESC LIMIT 1',
            [columnId, id]
          );
          afterPos = lastCard.rows.length > 0 ? lastCard.rows[0].position : null;
        }
      }

      let position = computePosition(afterPos, beforePos);

      // Check if renormalization is needed
      let renormalized = null;
      if (position === null) {
        // Gap too small, need to renormalize
        // Get all cards in the target column except the moving card, in order
        const colCards = await db.query(
          'SELECT id, position FROM cards WHERE column_id = $1 AND id != $2 ORDER BY position ASC',
          [columnId, id]
        );

        // Figure out where to insert in the ordered list
        const orderedIds = colCards.rows.map(c => c.id);
        let insertIdx = orderedIds.length; // default: end

        if (afterId && beforeId) {
          const afterIdx = orderedIds.indexOf(afterId);
          if (afterIdx >= 0) {
            insertIdx = afterIdx + 1;
          }
        } else if (afterId) {
          const afterIdx = orderedIds.indexOf(afterId);
          if (afterIdx >= 0) {
            insertIdx = afterIdx + 1;
          }
        } else if (beforeId) {
          const beforeIdx = orderedIds.indexOf(beforeId);
          if (beforeIdx >= 0) {
            insertIdx = beforeIdx;
          }
        }

        // Insert the card at the right spot
        orderedIds.splice(insertIdx, 0, id);

        // Renormalize all positions
        const newPositions = renormalize(orderedIds);
        position = newPositions.find(p => p.id === id).position;

        // Update all other cards' positions
        for (const np of newPositions) {
          if (np.id !== id) {
            await db.query('UPDATE cards SET position = $1 WHERE id = $2', [np.position, np.id]);
          }
        }

        renormalized = newPositions.map(np => ({
          id: np.id,
          position: np.position,
          columnId
        }));
      } else {
        // Check for collisions with existing cards
        const colCards = await db.query(
          'SELECT id, position FROM cards WHERE column_id = $1 AND id != $2',
          [columnId, id]
        );

        const existingPositions = colCards.rows.map(c => c.position);
        if (needsRenormalization(existingPositions, position)) {
          // Renormalize this column
          const allCards = await db.query(
            'SELECT id, position FROM cards WHERE column_id = $1 AND id != $2 ORDER BY position ASC',
            [columnId, id]
          );

          const orderedIds = allCards.rows.map(c => c.id);

          // Find insert position
          let insertIdx = orderedIds.length;
          if (afterId) {
            const afterIdx = orderedIds.indexOf(afterId);
            if (afterIdx >= 0) insertIdx = afterIdx + 1;
          } else if (beforeId) {
            const beforeIdx = orderedIds.indexOf(beforeId);
            if (beforeIdx >= 0) insertIdx = beforeIdx;
          }

          orderedIds.splice(insertIdx, 0, id);
          const newPositions = renormalize(orderedIds);
          position = newPositions.find(p => p.id === id).position;

          for (const np of newPositions) {
            if (np.id !== id) {
              await db.query('UPDATE cards SET position = $1 WHERE id = $2', [np.position, np.id]);
            }
          }

          renormalized = newPositions.map(np => ({
            id: np.id,
            position: np.position,
            columnId
          }));
        }
      }

      // Perform the move atomically
      const sourceColumnId = cardCheck.rows[0].column_id;
      await db.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, position, id]
      );

      const updatedCard = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );

      const card = {
        id: updatedCard.rows[0].id,
        columnId: updatedCard.rows[0].column_id,
        text: updatedCard.rows[0].text,
        position: updatedCard.rows[0].position,
        createdAt: updatedCard.rows[0].created_at
      };

      return { card, renormalized, sourceColumnId };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    // Broadcast after committed
    if (result.renormalized) {
      broadcast('column:renormalized', {
        columnId: result.card.columnId,
        cards: result.renormalized
      });
    }
    broadcast('card:moved', {
      card: result.card,
      sourceColumnId: result.sourceColumnId
    });

    res.json(result.card);
  } catch (err) {
    console.error('Error moving card:', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// DELETE /api/cards/:id - Delete a card
router.delete('/cards/:id', async (req, res) => {
  try {
    const result = await withMutex(async () => {
      const db = await getDb();
      const { id } = req.params;

      const cardCheck = await db.query('SELECT id, column_id FROM cards WHERE id = $1', [id]);
      if (cardCheck.rows.length === 0) {
        return { error: 'Card not found', status: 404 };
      }

      await db.query('DELETE FROM cards WHERE id = $1', [id]);
      return { id, columnId: cardCheck.rows[0].column_id };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    broadcast('card:deleted', { id: result.id, columnId: result.columnId });
    res.json({ id: result.id });
  } catch (err) {
    console.error('Error deleting card:', err);
    res.status(500).json({ error: 'Failed to delete card' });
  }
});

// GET /api/stream - SSE endpoint
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send initial comment to establish connection
  res.write(':connected\n\n');

  // Keep alive with periodic comments
  const keepAlive = setInterval(() => {
    res.write(':keep-alive\n\n');
  }, 30000);

  addClient(res);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

module.exports = router;
