const express = require('express');
const { getDb } = require('./db');
const { addClient, broadcast } = require('./sse');
const crypto = require('crypto');

const router = express.Router();

// ─── SSE stream endpoint ───────────────────────────────────────────
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  // Send keepalive every 15s
  const keepalive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 15000);

  res.on('close', () => {
    clearInterval(keepalive);
  });

  addClient(res);
});

// ─── GET /board — Full board state ─────────────────────────────────
router.get('/board', async (req, res) => {
  try {
    const db = await getDb();
    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC'
    );
    const { rows: cards } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC'
    );

    // Group cards into their columns
    const columnMap = {};
    for (const col of columns) {
      columnMap[col.id] = { ...col, cards: [] };
    }
    for (const card of cards) {
      if (columnMap[card.column_id]) {
        columnMap[card.column_id].cards.push(card);
      }
    }

    res.json({ columns: columns.map(c => columnMap[c.id]) });
  } catch (err) {
    console.error('GET /board error:', err);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

// ─── POST /cards — Create a card ───────────────────────────────────
router.post('/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text || !text.trim()) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    const db = await getDb();
    const id = 'card-' + crypto.randomUUID();

    // Find the max position in the column to place at end
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const position = parseFloat(maxRows[0].max_pos) + 1000;

    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );

    const card = rows[0];
    broadcast('card-created', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('POST /cards error:', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// ─── PATCH /cards/:id/move — Move/reorder a card ──────────────────
router.patch('/cards/:id/move', async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const db = await getDb();

    // Verify card exists
    const { rows: cardRows } = await db.query(
      'SELECT id, column_id, position FROM cards WHERE id = $1',
      [id]
    );
    if (cardRows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Compute new position
    let newPosition;

    if (afterId && beforeId) {
      // Between two cards
      const { rows: afterRows } = await db.query(
        'SELECT position FROM cards WHERE id = $1', [afterId]
      );
      const { rows: beforeRows } = await db.query(
        'SELECT position FROM cards WHERE id = $1', [beforeId]
      );
      if (afterRows.length && beforeRows.length) {
        const afterPos = parseFloat(afterRows[0].position);
        const beforePos = parseFloat(beforeRows[0].position);
        newPosition = (afterPos + beforePos) / 2;
      } else {
        // Fallback: place at end
        newPosition = await getEndPosition(db, columnId);
      }
    } else if (afterId) {
      // After a card (at the end after afterId)
      const { rows: afterRows } = await db.query(
        'SELECT position FROM cards WHERE id = $1', [afterId]
      );
      if (afterRows.length) {
        const afterPos = parseFloat(afterRows[0].position);
        // Find the next card after afterId in this column
        const { rows: nextRows } = await db.query(
          `SELECT position FROM cards 
           WHERE column_id = $1 AND position > $2 AND id != $3
           ORDER BY position ASC LIMIT 1`,
          [columnId, afterPos, id]
        );
        if (nextRows.length) {
          newPosition = (afterPos + parseFloat(nextRows[0].position)) / 2;
        } else {
          newPosition = afterPos + 1000;
        }
      } else {
        newPosition = await getEndPosition(db, columnId);
      }
    } else if (beforeId) {
      // Before a card (at the beginning before beforeId)
      const { rows: beforeRows } = await db.query(
        'SELECT position FROM cards WHERE id = $1', [beforeId]
      );
      if (beforeRows.length) {
        const beforePos = parseFloat(beforeRows[0].position);
        // Find the prev card before beforeId in this column
        const { rows: prevRows } = await db.query(
          `SELECT position FROM cards 
           WHERE column_id = $1 AND position < $2 AND id != $3
           ORDER BY position DESC LIMIT 1`,
          [columnId, beforePos, id]
        );
        if (prevRows.length) {
          newPosition = (parseFloat(prevRows[0].position) + beforePos) / 2;
        } else {
          newPosition = beforePos / 2;
        }
      } else {
        newPosition = await getEndPosition(db, columnId);
      }
    } else {
      // No reference cards — place at end
      newPosition = await getEndPosition(db, columnId);
    }

    // Perform the atomic update
    const { rows: updatedRows } = await db.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3
       RETURNING id, column_id, text, position, created_at`,
      [columnId, newPosition, id]
    );

    const updatedCard = updatedRows[0];

    // Check for position collisions / precision exhaustion and renormalize if needed
    const renormalized = await maybeRenormalize(db, columnId, id);

    if (renormalized) {
      // Re-fetch the updated card after renormalization
      const { rows: refetched } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );
      const finalCard = refetched[0];

      // Broadcast the full column state so all clients converge
      const { rows: colCards } = await db.query(
        `SELECT id, column_id, text, position, created_at FROM cards 
         WHERE column_id = $1 ORDER BY position ASC`,
        [columnId]
      );
      broadcast('column-renormalized', { columnId, cards: colCards });

      // Also broadcast the old column if it changed
      const oldColumnId = cardRows[0].column_id;
      if (oldColumnId !== columnId) {
        const { rows: oldColCards } = await db.query(
          `SELECT id, column_id, text, position, created_at FROM cards 
           WHERE column_id = $1 ORDER BY position ASC`,
          [oldColumnId]
        );
        broadcast('column-renormalized', { columnId: oldColumnId, cards: oldColCards });
      }

      res.json({ card: finalCard, renormalized: true });
    } else {
      broadcast('card-moved', {
        card: updatedCard,
        fromColumnId: cardRows[0].column_id,
      });
      res.json({ card: updatedCard });
    }
  } catch (err) {
    console.error('PATCH /cards/:id/move error:', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// ─── DELETE /cards/:id — Delete a card ─────────────────────────────
router.delete('/cards/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();

    const { rows } = await db.query(
      'DELETE FROM cards WHERE id = $1 RETURNING id, column_id',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    broadcast('card-deleted', { cardId: rows[0].id, columnId: rows[0].column_id });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /cards/:id error:', err);
    res.status(500).json({ error: 'Failed to delete card' });
  }
});

// ─── Helpers ───────────────────────────────────────────────────────

async function getEndPosition(db, columnId) {
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
    [columnId]
  );
  return parseFloat(rows[0].max_pos) + 1000;
}

/**
 * Check if the column needs renormalization due to position collisions
 * or insufficient precision gaps. Returns true if renormalization happened.
 */
async function maybeRenormalize(db, columnId, movedCardId) {
  const { rows: cards } = await db.query(
    `SELECT id, position FROM cards 
     WHERE column_id = $1 ORDER BY position ASC`,
    [columnId]
  );

  if (cards.length < 2) return false;

  // Check for collisions or gaps too small (< 0.001)
  let needsRenorm = false;
  for (let i = 1; i < cards.length; i++) {
    const gap = parseFloat(cards[i].position) - parseFloat(cards[i - 1].position);
    if (gap < 0.001) {
      needsRenorm = true;
      break;
    }
  }

  if (!needsRenorm) return false;

  // Renormalize: assign positions 1000, 2000, 3000, ...
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * 1000;
    await db.query(
      'UPDATE cards SET position = $1 WHERE id = $2',
      [newPos, cards[i].id]
    );
  }

  return true;
}

module.exports = router;
