import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb, computePosition, needsRenormalization, renormalizeColumn } from './db.js';
import { addClient, broadcast } from './sse.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/board  – full board state
// ---------------------------------------------------------------------------
router.get('/board', async (_req, res) => {
  try {
    const db = getDb();

    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC'
    );

    const { rows: cards } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY column_id, position ASC'
    );

    // Group cards by column
    const cardsByColumn = {};
    for (const col of columns) cardsByColumn[col.id] = [];
    for (const card of cards) {
      if (cardsByColumn[card.column_id]) {
        cardsByColumn[card.column_id].push(card);
      }
    }

    const board = columns.map((col) => ({
      ...col,
      cards: cardsByColumn[col.id] ?? [],
    }));

    res.json({ columns: board });
  } catch (err) {
    console.error('[GET /board]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/cards  – create a card at the end of a column
// ---------------------------------------------------------------------------
router.post('/cards', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and non-empty text are required' });
  }

  try {
    const db = getDb();

    // Find the current maximum position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxRows[0].maxpos !== null ? parseFloat(maxRows[0].maxpos) : 0;
    const newPosition = maxPos + 1000;

    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), newPosition]
    );

    const card = rows[0];
    broadcast('card-created', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /cards]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/move  – move / reorder a card
//
// Body: { columnId, beforeId?, afterId? }
//   beforeId  = id of the card that will be ABOVE  the moved card (null → top)
//   afterId   = id of the card that will be BELOW  the moved card (null → bottom)
//
// The server computes the canonical position, persists atomically, and
// broadcasts the result.
// ---------------------------------------------------------------------------
router.patch('/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = getDb();

    // --- Fetch neighbour positions -------------------------------------------
    // We need to exclude the card being moved from the column's card list
    // so that its current position doesn't interfere with the computation.
    let beforePos = null;
    let afterPos = null;

    if (beforeId) {
      // beforeId must be in the target column (excluding the card being moved)
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2 AND id != $3',
        [beforeId, columnId, id]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: `beforeId card "${beforeId}" not found in column` });
      }
      beforePos = parseFloat(rows[0].position);
    }

    if (afterId) {
      // afterId must be in the target column (excluding the card being moved)
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2 AND id != $3',
        [afterId, columnId, id]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: `afterId card "${afterId}" not found in column` });
      }
      afterPos = parseFloat(rows[0].position);
    }

    // When both are null, append to the end of the target column
    // (excluding the card being moved itself)
    let newPosition;
    if (beforeId === null && afterId === null) {
      const { rows: maxRows } = await db.query(
        'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1 AND id != $2',
        [columnId, id]
      );
      const maxPos = maxRows[0].maxpos !== null ? parseFloat(maxRows[0].maxpos) : 0;
      newPosition = maxPos + 1000;
    } else {
      newPosition = computePosition(beforePos, afterPos);
    }

    // --- Atomic update -------------------------------------------------------
    // We do this in a single UPDATE; PGLite doesn't expose explicit transactions
    // via the query API but a single statement is inherently atomic.
    const { rows: updated } = await db.query(
      `UPDATE cards
          SET column_id = $1,
              position  = $2
        WHERE id = $3
       RETURNING id, column_id, text, position, created_at`,
      [columnId, newPosition, id]
    );

    if (updated.length === 0) {
      return res.status(404).json({ error: `Card "${id}" not found` });
    }

    const card = updated[0];

    // --- Check for position collision / precision exhaustion -----------------
    const { rows: colCards } = await db.query(
      'SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC',
      [columnId]
    );
    const positions = colCards.map((r) => parseFloat(r.position));

    if (needsRenormalization(positions)) {
      console.warn(`[move] renormalizing column ${columnId} due to position collision`);
      const updates = await renormalizeColumn(columnId);

      // Fetch the full updated column cards to broadcast
      const { rows: renormCards } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
        [columnId]
      );

      broadcast('column-renormalized', { columnId, cards: renormCards });

      // Return the card with its new canonical position
      const renormedCard = renormCards.find((c) => c.id === id);
      return res.json({ card: renormedCard ?? card });
    }

    broadcast('card-moved', { card });
    res.json({ card });
  } catch (err) {
    console.error('[PATCH /cards/:id/move]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stream  – SSE endpoint
// ---------------------------------------------------------------------------
router.get('/stream', (req, res) => {
  addClient(req, res);
});

export default router;
