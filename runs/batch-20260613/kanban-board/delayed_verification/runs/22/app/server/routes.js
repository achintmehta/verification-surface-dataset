import { Router } from 'express';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';

const router = Router();

// ─── Position helpers ───────────────────────────────────────────────────────

const POSITION_GAP = 1000;
const MIN_GAP = 0.001; // threshold for precision exhaustion

/**
 * Compute the position for a card being placed between afterPos and beforePos.
 * - afterPos = null means "beginning of column"
 * - beforePos = null means "end of column"
 */
function computePosition(afterPos, beforePos) {
  if (afterPos != null && beforePos != null) {
    return (afterPos + beforePos) / 2;
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
 * Renormalize all card positions in a column with even POSITION_GAP spacing.
 * Returns the list of renormalized cards.
 */
async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  const updates = [];
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    if (cards[i].position !== newPos) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
      updates.push({ id: cards[i].id, position: newPos });
    }
  }
  return updates;
}

/**
 * Check if a column needs renormalization (duplicate positions or precision exhaustion).
 */
async function checkAndRenormalize(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );

  let needsRenorm = false;
  for (let i = 0; i < cards.length - 1; i++) {
    const gap = cards[i + 1].position - cards[i].position;
    if (gap < MIN_GAP || gap === 0) {
      needsRenorm = true;
      break;
    }
  }

  // Also check for duplicate positions
  const positions = cards.map(c => c.position);
  const uniquePositions = new Set(positions);
  if (uniquePositions.size < positions.length) {
    needsRenorm = true;
  }

  if (needsRenorm) {
    const updates = await renormalizeColumn(db, columnId);
    if (updates.length > 0) {
      // Broadcast the full column state after renormalization
      const { rows: updatedCards } = await db.query(
        `SELECT id, column_id, text, position, created_at FROM cards
         WHERE column_id = $1 ORDER BY position ASC, id ASC`,
        [columnId]
      );
      broadcast('column_renormalized', { columnId, cards: updatedCards });
    }
  }
}

// ─── GET /api/board ─────────────────────────────────────────────────────────

router.get('/board', async (req, res) => {
  try {
    const db = await getDb();
    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC'
    );
    const { rows: cards } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC, id ASC'
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

    const board = columns.map(col => ({
      ...col,
      cards: cardsByColumn[col.id] || []
    }));

    res.json(board);
  } catch (err) {
    console.error('GET /api/board error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/cards ────────────────────────────────────────────────────────

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

    // Get the max position in the column to append at the end
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPosition = maxRows[0].max_pos + POSITION_GAP;

    const { rows } = await db.query(
      `INSERT INTO cards (column_id, text, position)
       VALUES ($1, $2, $3)
       RETURNING id, column_id, text, position, created_at`,
      [columnId, text.trim(), newPosition]
    );

    const card = rows[0];

    // Broadcast to all clients
    broadcast('card_created', { card });

    res.status(201).json(card);
  } catch (err) {
    console.error('POST /api/cards error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/cards/:id/move ──────────────────────────────────────────────

router.patch('/cards/:id/move', async (req, res) => {
  try {
    const cardId = parseInt(req.params.id, 10);
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const db = await getDb();

    // Use a transaction for atomicity
    await db.exec('BEGIN');

    try {
      // Verify card exists
      const { rows: cardRows } = await db.query(
        'SELECT id, column_id, position FROM cards WHERE id = $1',
        [cardId]
      );
      if (cardRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Card not found' });
      }

      const oldColumnId = cardRows[0].column_id;

      // Verify target column exists
      const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
      if (colRows.length === 0) {
        await db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Target column not found' });
      }

      // Resolve afterId and beforeId to positions
      // Ignore self-references (shouldn't happen but be safe)
      let afterPos = null;
      let beforePos = null;

      if (afterId != null && afterId !== cardId) {
        // Look up in the target column; the afterId card might also be in the source column
        // if we're reordering within the same column
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [afterId, columnId]
        );
        if (rows.length > 0) {
          afterPos = rows[0].position;
        }
      }

      if (beforeId != null && beforeId !== cardId) {
        const { rows } = await db.query(
          'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
          [beforeId, columnId]
        );
        if (rows.length > 0) {
          beforePos = rows[0].position;
        }
      }

      // If neither afterId nor beforeId resolved, figure out placement
      // If no references, place at end of column
      if (afterPos == null && beforePos == null) {
        // Check if column has cards (excluding the moving card itself if same column)
        const { rows: existingCards } = await db.query(
          'SELECT position FROM cards WHERE column_id = $1 AND id != $2 ORDER BY position ASC',
          [columnId, cardId]
        );
        if (existingCards.length > 0) {
          // Place at end
          afterPos = existingCards[existingCards.length - 1].position;
        }
        // else column is empty, use default position
      }

      const newPosition = computePosition(afterPos, beforePos);

      // Atomically update column_id and position
      const { rows: updatedRows } = await db.query(
        `UPDATE cards SET column_id = $1, position = $2
         WHERE id = $3
         RETURNING id, column_id, text, position, created_at`,
        [columnId, newPosition, cardId]
      );

      await db.exec('COMMIT');

      const card = updatedRows[0];

      // Broadcast canonical state to all clients
      broadcast('card_moved', {
        card,
        fromColumnId: oldColumnId,
        toColumnId: parseInt(columnId, 10)
      });

      // Check and renormalize if needed (after commit and broadcast of the move)
      await checkAndRenormalize(db, parseInt(columnId, 10));
      // Also renormalize source column if different
      if (oldColumnId !== parseInt(columnId, 10)) {
        await checkAndRenormalize(db, oldColumnId);
      }

      res.json(card);
    } catch (innerErr) {
      await db.exec('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('PATCH /api/cards/:id/move error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/cards/:id ──────────────────────────────────────────────────

router.delete('/cards/:id', async (req, res) => {
  try {
    const cardId = parseInt(req.params.id, 10);
    const db = await getDb();

    const { rows } = await db.query(
      'DELETE FROM cards WHERE id = $1 RETURNING id, column_id',
      [cardId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    broadcast('card_deleted', { cardId: rows[0].id, columnId: rows[0].column_id });

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/cards/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/stream (SSE) ─────────────────────────────────────────────────

router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send initial keepalive
  res.write('event: connected\ndata: {}\n\n');

  // Heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 30000);

  addClient(res);

  req.on('close', () => {
    clearInterval(heartbeat);
  });
});

export default router;
