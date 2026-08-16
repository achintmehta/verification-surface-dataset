const express = require('express');
const crypto = require('crypto');
const { getDb } = require('./db');
const { addClient, broadcast } = require('./sse');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId() {
  return crypto.randomUUID();
}

const POSITION_GAP = 1000;
const MIN_POSITION_DIFF = 0.0001;

/**
 * Renormalize all card positions in a column to evenly spaced integers.
 * Returns the full list of cards in their new order.
 */
async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 AND position >= 0 ORDER BY position ASC, created_at ASC',
    [columnId]
  );
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    if (cards[i].position !== newPos) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
      cards[i].position = newPos;
    }
  }
  return cards;
}

/**
 * Compute a position between two neighbor positions.
 * abovePos = position of the card above (lower value), belowPos = position of the card below (higher value).
 * Returns null if the gap is too small (needs renormalization).
 */
function computePositionBetween(abovePos, belowPos) {
  if (abovePos === null && belowPos === null) {
    return POSITION_GAP;
  }
  if (abovePos === null) {
    // Insert at the very top
    return belowPos / 2;
  }
  if (belowPos === null) {
    // Insert at the very bottom
    return abovePos + POSITION_GAP;
  }
  if (belowPos - abovePos < MIN_POSITION_DIFF) {
    return null; // need renormalization
  }
  return (abovePos + belowPos) / 2;
}

// ── SSE Stream ───────────────────────────────────────────────────────────────

router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');

  // Send a heartbeat every 15 seconds to keep the connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeat);
  });

  addClient(res);
});

// ── GET /api/board ───────────────────────────────────────────────────────────

router.get('/board', async (req, res) => {
  try {
    const db = await getDb();
    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC'
    );
    const { rows: cards } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC, created_at ASC'
    );

    // Group cards by column
    const cardsByColumn = {};
    for (const col of columns) {
      cardsByColumn[col.id] = [];
    }
    for (const card of cards) {
      if (cardsByColumn[card.column_id]) {
        cardsByColumn[card.column_id].push(card);
      }
    }

    const result = columns.map((col) => ({
      id: col.id,
      title: col.title,
      position: col.position,
      cards: cardsByColumn[col.id] || [],
    }));

    res.json(result);
  } catch (err) {
    console.error('GET /api/board error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/cards ──────────────────────────────────────────────────────────

router.post('/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text || !text.trim()) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    const db = await getDb();

    // Verify column exists
    const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colRows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Get the max position in the column
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPosition = maxRows[0].max_pos + POSITION_GAP;
    const id = generateId();

    const { rows: inserted } = await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4) RETURNING id, column_id, text, position, created_at',
      [id, columnId, text.trim(), newPosition]
    );

    const card = inserted[0];
    broadcast('card:created', card);
    res.status(201).json(card);
  } catch (err) {
    console.error('POST /api/cards error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/cards/:id/move ────────────────────────────────────────────────
// Body: { columnId, afterId, beforeId }
//   afterId  = the card directly ABOVE the drop position (lower position value)
//   beforeId = the card directly BELOW the drop position (higher position value)
//   Both can be null. If both null: append to end of column.

router.patch('/cards/:id/move', async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId } = req.body;
    const afterId = req.body.afterId || null;
    const beforeId = req.body.beforeId || null;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const db = await getDb();

    // Use a transaction for atomicity
    await db.exec('BEGIN');

    try {
      // Verify the card exists
      const { rows: cardRows } = await db.query(
        'SELECT id, column_id FROM cards WHERE id = $1',
        [id]
      );
      if (cardRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Card not found' });
      }
      const sourceColumnId = cardRows[0].column_id;

      // Verify target column exists
      const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
      if (colRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Column not found' });
      }

      // Get positions of the reference cards (they must be in the target column and not be the moved card)
      let abovePos = null;
      let belowPos = null;

      if (afterId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2 AND id != $3',
          [afterId, columnId, id]
        );
        if (rows.length > 0) {
          abovePos = rows[0].position;
        }
      }

      if (beforeId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2 AND id != $3',
          [beforeId, columnId, id]
        );
        if (rows.length > 0) {
          belowPos = rows[0].position;
        }
      }

      // If neither reference is valid, determine placement
      if (afterId === null && beforeId === null) {
        // Append to end of column
        const { rows: maxRows } = await db.query(
          'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
          [columnId, id]
        );
        const maxPos = maxRows[0].max_pos;
        abovePos = maxPos > 0 ? maxPos : null;
        belowPos = null;
      } else if (afterId && abovePos === null && beforeId && belowPos === null) {
        // Both references are gone; append to end
        const { rows: maxRows } = await db.query(
          'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
          [columnId, id]
        );
        const maxPos = maxRows[0].max_pos;
        abovePos = maxPos > 0 ? maxPos : null;
        belowPos = null;
      } else if (afterId && abovePos === null) {
        // afterId gone; if beforeId exists, insert above beforeId
        // abovePos stays null, belowPos is set
      } else if (beforeId && belowPos === null) {
        // beforeId gone; insert after afterId
        // belowPos stays null, abovePos is set
      }

      let newPosition = computePositionBetween(abovePos, belowPos);
      let renormedCards = null;

      // If position is null, we need to renormalize
      if (newPosition === null) {
        // Temporarily move the card to position -1 so renormalize ignores it
        await db.query(
          'UPDATE cards SET column_id = $1, position = -1 WHERE id = $2',
          [columnId, id]
        );

        renormedCards = await renormalizeColumn(db, columnId);

        // Re-fetch neighbor positions after renormalization
        let newAbovePos = null;
        let newBelowPos = null;
        if (afterId) {
          const found = renormedCards.find((c) => c.id === afterId);
          if (found) newAbovePos = found.position;
        }
        if (beforeId) {
          const found = renormedCards.find((c) => c.id === beforeId);
          if (found) newBelowPos = found.position;
        }

        newPosition = computePositionBetween(newAbovePos, newBelowPos);
        if (newPosition === null) {
          // Absolute fallback - should never happen after renormalization
          newPosition = (newAbovePos || 0) + POSITION_GAP;
        }
      }

      // Perform the move atomically
      const { rows: updatedRows } = await db.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3 RETURNING id, column_id, text, position, created_at',
        [columnId, newPosition, id]
      );

      await db.exec('COMMIT');

      const updatedCard = updatedRows[0];

      // Broadcast only after commit to ensure clients never see uncommitted state
      // If renormalization happened, broadcast it first so clients have correct positions
      // before receiving the move event
      if (renormedCards) {
        broadcast('column:renormalized', { columnId, cards: renormedCards });
      }

      broadcast('card:moved', {
        card: updatedCard,
        sourceColumnId,
      });

      res.json(updatedCard);
    } catch (innerErr) {
      await db.exec('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('PATCH /api/cards/:id/move error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/cards/:id ────────────────────────────────────────────────────

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

    broadcast('card:deleted', rows[0]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/cards/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
