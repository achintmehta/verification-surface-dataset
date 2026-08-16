import { Router } from 'express';
import { getDB } from './db.js';
import { addClient, broadcast } from './sse.js';
import { computePosition, renormalizeIfNeeded } from './ordering.js';

const router = Router();

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------
router.get('/stream', (req, res) => {
  addClient(req, res);
});

// ---------------------------------------------------------------------------
// GET /board — full board state
// ---------------------------------------------------------------------------
router.get('/board', async (_req, res) => {
  try {
    const db = getDB();

    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC',
    );

    const { rows: cards } = await db.query(
      `SELECT id, column_id AS "columnId", text, position, created_at AS "createdAt"
       FROM cards ORDER BY position ASC`,
    );

    // Group cards by column
    /** @type {Record<string, typeof cards>} */
    const cardsByCol = {};
    for (const col of columns) {
      cardsByCol[col.id] = [];
    }
    for (const card of cards) {
      if (cardsByCol[card.columnId]) {
        cardsByCol[card.columnId].push(card);
      }
    }

    const board = columns.map((col) => ({
      id: col.id,
      title: col.title,
      position: col.position,
      cards: cardsByCol[col.id] || [],
    }));

    res.json(board);
  } catch (err) {
    console.error('GET /board error', err);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

// ---------------------------------------------------------------------------
// POST /cards — create a card
// ---------------------------------------------------------------------------
router.post('/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    const db = getDB();

    // Get the max position in the target column
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) AS max_pos FROM cards WHERE column_id = $1',
      [columnId],
    );
    const newPos = /** @type {number} */ (maxRows[0].max_pos) + 1000;

    const { rows } = await db.query(
      `INSERT INTO cards (column_id, text, position)
       VALUES ($1, $2, $3)
       RETURNING id, column_id AS "columnId", text, position, created_at AS "createdAt"`,
      [columnId, text, newPos],
    );

    const card = rows[0];

    broadcast('card_created', card);
    res.status(201).json(card);
  } catch (err) {
    console.error('POST /cards error', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /cards/:id/move — move / reorder a card
// ---------------------------------------------------------------------------
router.patch('/cards/:id/move', async (req, res) => {
  try {
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const db = getDB();

    // Verify card exists
    const { rows: existing } = await db.query('SELECT id FROM cards WHERE id = $1', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Determine neighbour positions
    let afterPos = null;
    let beforePos = null;

    if (afterId) {
      const { rows } = await db.query('SELECT position FROM cards WHERE id = $1', [afterId]);
      if (rows.length > 0) afterPos = rows[0].position;
    }

    if (beforeId) {
      const { rows } = await db.query('SELECT position FROM cards WHERE id = $1', [beforeId]);
      if (rows.length > 0) beforePos = rows[0].position;
    }

    // If no neighbours specified, place at end of column
    if (afterPos == null && beforePos == null) {
      // Check if there are cards already in the target column (excluding the moved card)
      const { rows: colCards } = await db.query(
        'SELECT position FROM cards WHERE column_id = $1 AND id != $2 ORDER BY position ASC',
        [columnId, id],
      );
      if (colCards.length === 0) {
        // Empty column, use default
        afterPos = null;
        beforePos = null;
      } else {
        // Place at end
        afterPos = colCards[colCards.length - 1].position;
        beforePos = null;
      }
    }

    const newPos = computePosition(afterPos, beforePos);

    // Atomic update: column_id + position in one statement
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPos, id],
    );

    // Read back the canonical card
    const { rows: updated } = await db.query(
      `SELECT id, column_id AS "columnId", text, position, created_at AS "createdAt"
       FROM cards WHERE id = $1`,
      [id],
    );

    const card = updated[0];

    // Check for renormalization
    const gapBefore = afterPos != null ? Math.abs(newPos - afterPos) : Infinity;
    const gapAfter = beforePos != null ? Math.abs(beforePos - newPos) : Infinity;
    await renormalizeIfNeeded(columnId, id, gapBefore, gapAfter);

    broadcast('card_moved', card);
    res.json(card);
  } catch (err) {
    console.error('PATCH /cards/:id/move error', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /cards/:id — delete a card
// ---------------------------------------------------------------------------
router.delete('/cards/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDB();

    const { rows } = await db.query(
      `DELETE FROM cards WHERE id = $1
       RETURNING id, column_id AS "columnId"`,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    broadcast('card_deleted', { id: rows[0].id, columnId: rows[0].columnId });
    res.json({ id: rows[0].id });
  } catch (err) {
    console.error('DELETE /cards/:id error', err);
    res.status(500).json({ error: 'Failed to delete card' });
  }
});

export default router;
