import { Router } from 'express';
import { v4 as uuidv4 } from './uuid.js';
import { getDb } from './db.js';
import { addClient, broadcast } from './sse.js';

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

const POSITION_GAP = 1000;
const MIN_GAP = 0.0001; // threshold below which we renormalize

/**
 * Compute a position between `lower` and `upper`.
 * @param {number|null} lower – position of the card above (smaller position)
 * @param {number|null} upper – position of the card below (larger position)
 */
function positionBetween(lower, upper) {
  if (lower == null && upper == null) return POSITION_GAP;
  if (lower == null) return upper / 2;
  if (upper == null) return lower + POSITION_GAP;
  return (lower + upper) / 2;
}

/**
 * Renormalize all card positions in a column to be evenly spaced.
 * Returns the list of updated cards (with new positions).
 */
async function renormalizeColumn(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  const updated = [];
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    if (cards[i].position !== newPos) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [newPos, cards[i].id]);
      updated.push({ id: cards[i].id, position: newPos });
    }
  }
  return updated;
}

/**
 * Check whether a column needs renormalization (gaps too small or position collision).
 */
async function checkAndRenormalize(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );
  if (cards.length < 2) return null;

  let needsRenorm = false;
  for (let i = 1; i < cards.length; i++) {
    if (Math.abs(cards[i].position - cards[i - 1].position) < MIN_GAP) {
      needsRenorm = true;
      break;
    }
  }

  if (!needsRenorm) return null;

  const updated = await renormalizeColumn(db, columnId);
  return updated.length > 0 ? updated : null;
}

// ─── GET /api/board ─────────────────────────────────────────────────────────

router.get('/board', async (_req, res) => {
  try {
    const db = await getDb();
    const { rows: columns } = await db.query(
      'SELECT id, title, position FROM columns ORDER BY position ASC'
    );
    const { rows: cards } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards ORDER BY position ASC'
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

    const board = columns.map((col) => ({
      id: col.id,
      title: col.title,
      position: col.position,
      cards: cardsByColumn[col.id],
    }));

    res.json(board);
  } catch (err) {
    console.error('GET /api/board error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/cards ────────────────────────────────────────────────────────

router.post('/cards', async (req, res) => {
  try {
    const db = await getDb();
    const { columnId, text } = req.body;

    if (!columnId || !text || !text.trim()) {
      return res.status(400).json({ error: 'columnId and text are required' });
    }

    // Verify column exists
    const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colRows.length === 0) {
      return res.status(400).json({ error: 'Column not found' });
    }

    // Determine position at end of column
    const { rows: last } = await db.query(
      'SELECT position FROM cards WHERE column_id = $1 ORDER BY position DESC LIMIT 1',
      [columnId]
    );
    const position = last.length > 0 ? last[0].position + POSITION_GAP : POSITION_GAP;

    const id = uuidv4();
    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );

    const card = rows[0];

    // Broadcast to all SSE clients
    broadcast('card_created', { card });

    res.status(201).json(card);
  } catch (err) {
    console.error('POST /api/cards error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /api/cards/:id/move ──────────────────────────────────────────────

router.patch('/cards/:id/move', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { columnId, afterId, beforeId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    // Use a transaction to ensure atomicity
    await db.query('BEGIN');

    try {
      // Verify the card exists
      const { rows: existing } = await db.query(
        'SELECT id, column_id FROM cards WHERE id = $1',
        [id]
      );
      if (existing.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Card not found' });
      }

      const oldColumnId = existing[0].column_id;

      // Look up the positions of the neighbor cards
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

      // If neither afterId nor beforeId provided, place at end of column
      if (afterPos == null && beforePos == null) {
        const { rows: last } = await db.query(
          'SELECT position FROM cards WHERE column_id = $1 AND id != $2 ORDER BY position DESC LIMIT 1',
          [columnId, id]
        );
        afterPos = last.length > 0 ? last[0].position : null;
        // beforePos stays null → will place after last card
      }

      const newPosition = positionBetween(afterPos, beforePos);

      // Atomic update: column_id + position in one statement
      await db.query(
        'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
        [columnId, newPosition, id]
      );

      // Check if renormalization is needed for the target column
      const renormalized = await checkAndRenormalize(db, columnId);

      // If the source column is different, also check it
      let sourceRenormalized = null;
      if (oldColumnId !== columnId) {
        sourceRenormalized = await checkAndRenormalize(db, oldColumnId);
      }

      // Commit the transaction
      await db.query('COMMIT');

      // Fetch the updated card after commit
      const { rows: updatedRows } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
        [id]
      );
      const card = updatedRows[0];

      // If renormalization happened, broadcast full column state
      if (renormalized || sourceRenormalized) {
        const renormData = {};
        if (renormalized) {
          const { rows: colCards } = await db.query(
            'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
            [columnId]
          );
          renormData[columnId] = colCards;
        }
        if (sourceRenormalized && oldColumnId !== columnId) {
          const { rows: colCards } = await db.query(
            'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
            [oldColumnId]
          );
          renormData[oldColumnId] = colCards;
        }

        broadcast('card_moved', {
          card,
          oldColumnId,
          renormalized: renormData,
        });

        return res.json(card);
      }

      // Normal broadcast (no renormalization)
      broadcast('card_moved', { card, oldColumnId });

      res.json(card);
    } catch (innerErr) {
      await db.query('ROLLBACK');
      throw innerErr;
    }
  } catch (err) {
    console.error('PATCH /api/cards/:id/move error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/stream (SSE) ─────────────────────────────────────────────────

router.get('/stream', (req, res) => {
  addClient(req, res);
});

export default router;
