import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import { between, needsRenorm, renormalize } from '../ordering.js';

const router = Router();

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/cards
   Body: { columnId: string, text: string }
   Creates a card at the END of the specified column.
───────────────────────────────────────────────────────────────────────────── */
router.post('/', async (req, res) => {
  const { columnId, text } = req.body;
  if (!columnId || !text || !text.trim()) {
    return res.status(400).json({ error: 'columnId and text are required' });
  }

  try {
    const db = getDb();

    // Find the current maximum position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS maxpos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxRows[0].maxpos !== null ? parseFloat(maxRows[0].maxpos) : 0;
    const newPos = between(maxPos === 0 ? null : maxPos, null);

    const id = randomUUID();
    await db.query(
      `INSERT INTO cards (id, column_id, text, position, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [id, columnId, text.trim(), newPos]
    );

    const { rows } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [id]
    );
    const card = rows[0];

    broadcast('card:created', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /api/cards]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   PATCH /api/cards/:id/move
   Body: { columnId: string, beforeId?: string|null, afterId?: string|null }
   
   Semantics (matching the client's drag-and-drop intent):
     - beforeId: the card that will be ABOVE  the moved card (null = moved to top)
     - afterId:  the card that will be BELOW  the moved card (null = moved to bottom)
   
   The server computes the canonical position, persists atomically, and
   broadcasts the result.  If the resulting gap is too small it renormalises
   the whole column and broadcasts the corrected order.
───────────────────────────────────────────────────────────────────────────── */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body;

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = getDb();

    // ── Verify the card exists ──────────────────────────────────────────────
    const { rows: cardRows } = await db.query(
      'SELECT id FROM cards WHERE id = $1',
      [id]
    );
    if (cardRows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // ── Verify the target column exists ────────────────────────────────────
    const { rows: colRows } = await db.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (colRows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // ── Fetch neighbour positions ───────────────────────────────────────────
    let beforePos = null;
    let afterPos  = null;

    if (beforeId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1',
        [beforeId]
      );
      if (rows.length) beforePos = parseFloat(rows[0].position);
    }

    if (afterId) {
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1',
        [afterId]
      );
      if (rows.length) afterPos = parseFloat(rows[0].position);
    }

    // ── Compute new position ────────────────────────────────────────────────
    // If we only have one neighbour, derive the other from the column's
    // actual sorted list so we never accidentally overlap.
    if (beforeId && !afterId) {
      // Inserting after beforeId – find the card that currently follows it
      const { rows } = await db.query(
        `SELECT position FROM cards
          WHERE column_id = $1 AND position > $2 AND id != $3
          ORDER BY position ASC LIMIT 1`,
        [columnId, beforePos, id]
      );
      if (rows.length) afterPos = parseFloat(rows[0].position);
    } else if (afterId && !beforeId) {
      // Inserting before afterId – find the card that currently precedes it
      const { rows } = await db.query(
        `SELECT position FROM cards
          WHERE column_id = $1 AND position < $2 AND id != $3
          ORDER BY position DESC LIMIT 1`,
        [columnId, afterPos, id]
      );
      if (rows.length) beforePos = parseFloat(rows[0].position);
    }

    const newPos = between(beforePos, afterPos);

    // ── Atomic update ───────────────────────────────────────────────────────
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, newPos, id]
    );

    // ── Fetch canonical card ────────────────────────────────────────────────
    const { rows: updated } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [id]
    );
    const card = updated[0];

    // ── Check for renormalisation need ──────────────────────────────────────
    const { rows: colCards } = await db.query(
      'SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position ASC',
      [columnId]
    );

    let needsRenormFlag = false;
    for (let i = 0; i < colCards.length - 1; i++) {
      if (needsRenorm(parseFloat(colCards[i].position), parseFloat(colCards[i + 1].position))) {
        needsRenormFlag = true;
        break;
      }
    }

    if (needsRenormFlag) {
      const normalized = renormalize(colCards);
      for (const { id: cid, position: cpos } of normalized) {
        await db.query('UPDATE cards SET position = $1 WHERE id = $2', [cpos, cid]);
      }

      // Fetch the full updated column for broadcast
      const { rows: renormedCards } = await db.query(
        'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
        [columnId]
      );

      broadcast('column:reordered', { columnId, cards: renormedCards });

      // Return the card with its renormalised position
      const renormedCard = renormedCards.find(c => c.id === id);
      return res.json({ card: renormedCard || card });
    }

    // ── Broadcast the move ──────────────────────────────────────────────────
    broadcast('card:moved', { card });
    res.json({ card });
  } catch (err) {
    console.error('[PATCH /api/cards/:id/move]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
