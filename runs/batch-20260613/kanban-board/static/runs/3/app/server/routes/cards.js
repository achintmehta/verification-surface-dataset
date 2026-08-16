import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import { between, evenlySpaced, INITIAL_GAP } from '../ordering.js';

const router = Router();

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/cards
   Body: { columnId: string, text: string }
   Creates a card at the end of the specified column.
───────────────────────────────────────────────────────────────────────────── */
router.post('/', async (req, res, next) => {
  try {
    const { columnId, text } = req.body;
    if (!columnId || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }

    const db = getDb();

    // Find the current maximum position in the column
    const maxResult = await db.query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxResult.rows[0].max_pos ?? 0;
    const position = maxPos + INITIAL_GAP;

    const id = randomUUID();
    const insertResult = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );

    const card = insertResult.rows[0];
    broadcast('card:created', card);
    return res.status(201).json(card);
  } catch (err) {
    next(err);
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   PATCH /api/cards/:id/move
   Body: { columnId: string, beforeId?: string|null, afterId?: string|null }

   `beforeId` is the card that will come BEFORE the moved card in the final order.
   `afterId`  is the card that will come AFTER  the moved card in the final order.
   Either may be null/omitted to indicate the start or end of the column.

   The server computes the canonical position, persists atomically, and broadcasts.
───────────────────────────────────────────────────────────────────────────── */
router.patch('/:id/move', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnId, beforeId = null, afterId = null } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const db = getDb();

    // Verify the card exists
    const cardCheck = await db.query('SELECT id FROM cards WHERE id = $1', [id]);
    if (cardCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Verify the target column exists
    const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Fetch neighbour positions (excluding the card being moved to avoid self-reference issues)
    let beforePos = null;
    let afterPos  = null;

    if (beforeId) {
      const r = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [beforeId, columnId]
      );
      if (r.rows.length > 0) beforePos = r.rows[0].position;
    }

    if (afterId) {
      const r = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [afterId, columnId]
      );
      if (r.rows.length > 0) afterPos = r.rows[0].position;
    }

    // If neither neighbour was found (e.g. empty column or IDs not in target column),
    // fall back to appending at the end.
    if (beforePos === null && afterPos === null && !beforeId && !afterId) {
      const maxResult = await db.query(
        'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
        [columnId, id]
      );
      beforePos = maxResult.rows[0].max_pos ?? 0;
    }

    const { position, needsRenorm } = between(beforePos, afterPos);

    // Atomic update
    const updateResult = await db.query(
      `UPDATE cards SET column_id = $1, position = $2
       WHERE id = $3
       RETURNING id, column_id, text, position, created_at`,
      [columnId, position, id]
    );

    const card = updateResult.rows[0];

    if (needsRenorm) {
      await renormalizeColumn(db, columnId);
      // After renorm, fetch the updated card position
      const refreshed = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );
      const refreshedCard = refreshed.rows[0];

      // Broadcast the full column order so all clients can reconcile
      const allCards = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position',
        [columnId]
      );
      broadcast('column:reordered', { columnId, cards: allCards.rows });
      return res.json(refreshedCard);
    }

    broadcast('card:moved', card);
    return res.json(card);
  } catch (err) {
    next(err);
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   Renormalise all card positions in a column to evenly-spaced values.
   Called when fractional precision is exhausted.
───────────────────────────────────────────────────────────────────────────── */
async function renormalizeColumn(db, columnId) {
  const result = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );
  const ids = result.rows.map((r) => r.id);
  const positions = evenlySpaced(ids.length);

  for (let i = 0; i < ids.length; i++) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [positions[i], ids[i]]);
  }
}

export default router;
