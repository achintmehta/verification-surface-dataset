import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';
import {
  computePosition,
  renormalizeColumn,
  resolveNeighbourPositions,
  getMaxPosition,
} from './ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  GET /api/board  – full board state                                  */
/* ------------------------------------------------------------------ */
router.get('/board', async (_req, res) => {
  try {
    const db = getDb();

    const { rows: columns } = await db.query(
      'SELECT * FROM columns ORDER BY position ASC'
    );

    const { rows: cards } = await db.query(
      'SELECT * FROM cards ORDER BY column_id, position ASC, created_at ASC'
    );

    // Group cards by column
    const cardsByColumn = {};
    for (const card of cards) {
      if (!cardsByColumn[card.column_id]) cardsByColumn[card.column_id] = [];
      cardsByColumn[card.column_id].push(card);
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

/* ------------------------------------------------------------------ */
/*  POST /api/cards  – create a card at the end of a column            */
/* ------------------------------------------------------------------ */
router.post('/cards', async (req, res) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || !text?.trim()) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    const db = getDb();

    // Verify column exists
    const { rows: cols } = await db.query(
      'SELECT id FROM columns WHERE id = $1', [columnId]
    );
    if (!cols.length) return res.status(404).json({ error: 'Column not found' });

    const maxPos = await getMaxPosition(columnId);
    const position = maxPos + 1000;

    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, columnId, text.trim(), position]
    );

    const card = rows[0];
    broadcast('card-created', { card });
    res.status(201).json({ card });

    // Renorm if somehow a collision occurred (defensive)
    const { rows: colliders } = await db.query(
      'SELECT COUNT(*) AS cnt FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
      [columnId, position, id]
    );
    if (parseInt(colliders[0].cnt, 10) > 0) {
      await renormalizeColumn(columnId);
    }
  } catch (err) {
    console.error('[POST /cards]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move  – move / reorder a card                 */
/* ------------------------------------------------------------------ */
router.patch('/cards/:id/move', async (req, res) => {
  try {
    const { id } = req.params;
    // beforeId: card immediately above the target slot (higher in list = lower position)
    // afterId:  card immediately below the target slot
    const { columnId, beforeId = null, afterId = null } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const db = getDb();

    // Verify card exists
    const { rows: existing } = await db.query(
      'SELECT * FROM cards WHERE id = $1', [id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Card not found' });

    // Verify target column exists
    const { rows: cols } = await db.query(
      'SELECT id FROM columns WHERE id = $1', [columnId]
    );
    if (!cols.length) return res.status(404).json({ error: 'Column not found' });

    // Resolve neighbour positions in the TARGET column
    // (exclude the card being moved so its old position doesn't interfere)
    let { beforePos, afterPos } = await resolveNeighbourPositions(
      beforeId, afterId, columnId, id
    );

    // If neighbours weren't found (e.g. cross-column move where IDs don't exist
    // in target yet), fall back gracefully
    if (beforeId && beforePos === null && afterId && afterPos === null) {
      // Both neighbours missing – just append
      beforePos = await getMaxPosition(columnId);
    }

    const { position, needsRenorm } = computePosition(beforePos, afterPos);

    // Atomic update: change column_id and position in one transaction
    let card;
    await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE cards
            SET column_id = $1,
                position  = $2
          WHERE id = $3
          RETURNING *`,
        [columnId, position, id]
      );
      card = rows[0];
    });

    broadcast('card-moved', { card });
    res.json({ card });

    // Renormalise if:
    //  a) float midpoint collapsed to a neighbour (precision exhausted), OR
    //  b) another card already occupies this exact position (collision)
    const { rows: colliders } = await db.query(
      'SELECT COUNT(*) AS cnt FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
      [columnId, position, id]
    );
    const hasCollision = parseInt(colliders[0].cnt, 10) > 0;

    if (needsRenorm || hasCollision) {
      await renormalizeColumn(columnId);
    }
  } catch (err) {
    console.error('[PATCH /cards/:id/move]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/stream  – SSE endpoint                                     */
/* ------------------------------------------------------------------ */
router.get('/stream', (req, res) => {
  addClient(req, res);
});

export default router;
