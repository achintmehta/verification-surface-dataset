import { Router } from 'express';
import {
  getDb,
  newId,
  midpoint,
  needsRenormalization,
  renormalizeColumn,
} from './db.js';
import { addClient, broadcast } from './sse.js';

const router = Router();

// ─── GET /api/board ──────────────────────────────────────────────────────────
router.get('/board', async (_req, res) => {
  try {
    const db = getDb();
    const { rows: columns } = await db.query(
      'SELECT * FROM columns ORDER BY position ASC'
    );
    const { rows: cards } = await db.query(
      'SELECT * FROM cards ORDER BY column_id, position ASC'
    );

    // Group cards by column
    const cardsByColumn = {};
    for (const card of cards) {
      if (!cardsByColumn[card.column_id]) cardsByColumn[card.column_id] = [];
      cardsByColumn[card.column_id].push(card);
    }

    const board = columns.map((col) => ({
      ...col,
      cards: cardsByColumn[col.id] || [],
    }));

    res.json(board);
  } catch (err) {
    console.error('[GET /board]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/cards ─────────────────────────────────────────────────────────
router.post('/cards', async (req, res) => {
  const { columnId, text } = req.body;
  if (!columnId || !text?.trim()) {
    return res.status(400).json({ error: 'columnId and text are required' });
  }

  try {
    const db = getDb();

    // Find the current max position in the column
    const { rows } = await db.query(
      'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = rows[0].maxpos != null ? parseFloat(rows[0].maxpos) : 0;
    const position = maxPos + 1000;

    const id = newId();
    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, text.trim(), position]
    );

    const { rows: created } = await db.query(
      'SELECT * FROM cards WHERE id = $1',
      [id]
    );
    const card = created[0];

    broadcast('card:created', { card });
    res.status(201).json(card);
  } catch (err) {
    console.error('[POST /cards]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/cards/:id/move ───────────────────────────────────────────────
// Body: { columnId, beforeId?, afterId? }
//   afterId  = the card immediately ABOVE  the drop target (null if top)
//   beforeId = the card immediately BELOW  the drop target (null if bottom)
router.patch('/cards/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body;

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = getDb();

    // Resolve neighbour positions
    let afterPos = null;
    let beforePos = null;

    if (afterId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1',
        [afterId]
      );
      if (rows.length) afterPos = parseFloat(rows[0].position);
    }
    if (beforeId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1',
        [beforeId]
      );
      if (rows.length) beforePos = parseFloat(rows[0].position);
    }

    // When both neighbours are null, place at the end of the target column
    // (excluding the card being moved itself)
    if (afterId == null && beforeId == null) {
      const { rows: maxRows } = await db.query(
        'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1 AND id != $2',
        [columnId, id]
      );
      const maxPos = maxRows[0].maxpos != null ? parseFloat(maxRows[0].maxpos) : 0;
      afterPos = maxPos;
    }

    let position = midpoint(afterPos, beforePos);

    // Perform the atomic update
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, position, id]
    );

    // Check for precision exhaustion / collision
    if (needsRenormalization(position, afterPos, beforePos)) {
      console.warn('[move] renormalizing column', columnId);
      const updatedCards = await renormalizeColumn(columnId);
      // Find the new position of the moved card
      const movedCard = updatedCards.find((c) => c.id === id);
      broadcast('column:reordered', { columnId, cards: updatedCards });
      return res.json(movedCard);
    }

    const { rows: updated } = await db.query(
      'SELECT * FROM cards WHERE id = $1',
      [id]
    );
    const card = updated[0];

    broadcast('card:moved', { card });
    res.json(card);
  } catch (err) {
    console.error('[PATCH /cards/:id/move]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/stream (SSE) ───────────────────────────────────────────────────
router.get('/stream', (req, res) => {
  addClient(req, res);
});

export default router;
