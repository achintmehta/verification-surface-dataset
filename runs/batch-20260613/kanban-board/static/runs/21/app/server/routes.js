import { Router } from 'express';
import crypto from 'crypto';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a position value between `after` and `before`.
 * If both are null the card goes to position 1000.
 * If only one is null, offset by 1000 in the appropriate direction.
 */
function computePosition(afterPos, beforePos) {
  if (afterPos != null && beforePos != null) {
    return (afterPos + beforePos) / 2;
  }
  if (afterPos != null) {
    return afterPos + 1000;
  }
  if (beforePos != null) {
    return beforePos / 2;
  }
  return 1000;
}

/**
 * Minimum gap before we consider positions too close and need renormalization.
 */
const MIN_GAP = 1e-9;

/**
 * Renormalize all card positions in a column so they are evenly spaced.
 * Returns the array of updated cards (for broadcasting).
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {string} columnId
 * @returns {Promise<Array<{id: string, column_id: string, text: string, position: number, created_at: string}>>}
 */
async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC',
    [columnId],
  );

  const step = 1000;
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * step;
    if (cards[i].position !== newPos) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
      cards[i].position = newPos;
    }
  }
  return cards;
}

/**
 * Check whether a column needs renormalization (duplicate or too-close positions).
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {string} columnId
 * @returns {Promise<boolean>}
 */
async function needsRenormalization(db, columnId) {
  const { rows } = await db.query(
    'SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId],
  );
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].position - rows[i - 1].position < MIN_GAP) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// GET /api/board – full board state
// ---------------------------------------------------------------------------
router.get('/board', async (_req, res) => {
  try {
    const db = getDb();
    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC',
    );
    const { rows: cards } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC, created_at ASC',
    );

    // Group cards by column
    /** @type {Record<string, typeof cards>} */
    const cardsByCol = {};
    for (const col of columns) {
      cardsByCol[col.id] = [];
    }
    for (const card of cards) {
      if (cardsByCol[card.column_id]) {
        cardsByCol[card.column_id].push(card);
      }
    }

    const board = columns.map((col) => ({
      ...col,
      cards: cardsByCol[col.id] || [],
    }));

    res.json(board);
  } catch (err) {
    console.error('GET /api/board error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/cards – create a new card
// ---------------------------------------------------------------------------
router.post('/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    const db = getDb();

    // Verify column exists
    const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colRows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Get max position in column
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1',
      [columnId],
    );
    const newPos = maxRows[0].max_pos + 1000;

    const id = `card-${crypto.randomUUID()}`;

    const { rows: inserted } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text, newPos],
    );

    const card = inserted[0];
    broadcast('card:created', card);
    res.status(201).json(card);
  } catch (err) {
    console.error('POST /api/cards error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/move – move / reorder a card
// ---------------------------------------------------------------------------
router.patch('/cards/:id/move', async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const db = getDb();

    // We perform everything inside a transaction-like sequential block.
    // PGLite is single-connection, so sequential queries are already serialized.

    // 1. Verify the card exists
    const { rows: cardRows } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [id],
    );
    if (cardRows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // 2. Verify column exists
    const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colRows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // 3. Look up afterId / beforeId positions
    let afterPos = null;
    let beforePos = null;

    if (afterId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [afterId, columnId],
      );
      if (rows.length > 0) {
        afterPos = rows[0].position;
      }
    }

    if (beforeId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [beforeId, columnId],
      );
      if (rows.length > 0) {
        beforePos = rows[0].position;
      }
    }

    // If we didn't get explicit neighbors, figure out the edge positions
    if (!afterId && !beforeId) {
      // Dropping into empty column or at the end
      const { rows: maxRows } = await db.query(
        'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
        [columnId, id],
      );
      afterPos = maxRows[0].max_pos > 0 ? maxRows[0].max_pos : null;
    }

    const newPos = computePosition(afterPos, beforePos);

    // 4. Atomically update column_id and position
    const { rows: updated } = await db.query(
      `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3
       RETURNING id, column_id, text, position, created_at`,
      [columnId, newPos, id],
    );

    const card = updated[0];

    // 5. Check if renormalization is needed
    if (await needsRenormalization(db, columnId)) {
      const normalizedCards = await renormalizeColumn(db, columnId);
      broadcast('column:renormalized', { columnId, cards: normalizedCards });
    } else {
      broadcast('card:moved', card);
    }

    // Also check the old column if it changed
    const oldColumnId = cardRows[0].column_id;
    if (oldColumnId !== columnId) {
      if (await needsRenormalization(db, oldColumnId)) {
        const normalizedCards = await renormalizeColumn(db, oldColumnId);
        broadcast('column:renormalized', { columnId: oldColumnId, cards: normalizedCards });
      }
    }

    res.json(card);
  } catch (err) {
    console.error('PATCH /api/cards/:id/move error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stream – SSE endpoint
// ---------------------------------------------------------------------------
router.get('/stream', (req, res) => {
  addClient(req, res);
});

export default router;
