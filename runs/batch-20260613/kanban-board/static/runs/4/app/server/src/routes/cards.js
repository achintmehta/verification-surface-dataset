/**
 * Card mutation routes:
 *
 *   POST  /api/cards            – create a card at the end of a column
 *   PATCH /api/cards/:id/move   – move/reorder a card (server-authoritative position)
 */

import { Router } from 'express';
import { query, transaction } from '../db.js';
import { broadcast } from '../sse.js';
import { computePosition, needsRenorm, renormalize, POSITION_GAP } from '../ordering.js';

const router = Router();

/* ─────────────────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────────────────── */

/** Generate a simple unique id (timestamp + random suffix). */
function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Renormalise all card positions in a column and broadcast the corrected order.
 * Called when floating-point precision is about to be exhausted.
 *
 * @param {string} columnId
 */
async function renormalizeColumn(columnId) {
  const { rows: cards } = await query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId],
  );

  if (cards.length === 0) return;

  const newPositions = renormalize(cards.length);

  await transaction(async (q) => {
    for (let i = 0; i < cards.length; i++) {
      await q(
        'UPDATE cards SET position = $1 WHERE id = $2',
        [newPositions[i], cards[i].id],
      );
    }
  });

  // Fetch the updated cards to broadcast canonical state
  const { rows: updated } = await query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId],
  );

  broadcast('column:reordered', { columnId, cards: updated });
  console.log(`[ordering] Renormalised column ${columnId} (${cards.length} cards).`);
}

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/cards
   Body: { columnId: string, text: string }
───────────────────────────────────────────────────────────────────────────── */
router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: '`columnId` is required.' });
  }
  if (!text || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: '`text` is required and must be non-empty.' });
  }

  try {
    // Verify column exists
    const { rows: cols } = await query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (cols.length === 0) {
      return res.status(404).json({ error: `Column '${columnId}' not found.` });
    }

    // Find the current maximum position in the column
    const { rows: maxRows } = await query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId],
    );
    const maxPos = maxRows[0].max_pos !== null ? Number(maxRows[0].max_pos) : 0;
    const position = maxPos + POSITION_GAP;

    const id = uid();
    const { rows } = await query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position],
    );

    const card = rows[0];
    broadcast('card:created', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /api/cards]', err);
    res.status(500).json({ error: 'Failed to create card.' });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   PATCH /api/cards/:id/move
   Body: { columnId: string, beforeId?: string|null, afterId?: string|null }
     afterId  – id of the card immediately ABOVE the target slot (lower position)
     beforeId – id of the card immediately BELOW the target slot (higher position)
───────────────────────────────────────────────────────────────────────────── */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: '`columnId` is required.' });
  }

  try {
    // Verify column exists
    const { rows: cols } = await query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (cols.length === 0) {
      return res.status(404).json({ error: `Column '${columnId}' not found.` });
    }

    // Verify card exists
    const { rows: cardRows } = await query('SELECT * FROM cards WHERE id = $1', [id]);
    if (cardRows.length === 0) {
      return res.status(404).json({ error: `Card '${id}' not found.` });
    }

    // Resolve neighbour positions
    let afterPos = null;
    let beforePos = null;

    if (afterId) {
      const { rows } = await query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [afterId, columnId],
      );
      if (rows.length > 0) afterPos = Number(rows[0].position);
    }

    if (beforeId) {
      const { rows } = await query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [beforeId, columnId],
      );
      if (rows.length > 0) beforePos = Number(rows[0].position);
    }

    // If neither neighbour resolved (e.g. empty column or IDs not in target column),
    // fall back to appending at the end.
    if (afterPos === null && beforePos === null && (afterId || beforeId)) {
      // Neighbours may be in a different column or stale – just append
      const { rows: maxRows } = await query(
        'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1 AND id != $2',
        [columnId, id],
      );
      afterPos = maxRows[0].max_pos !== null ? Number(maxRows[0].max_pos) : null;
    }

    const newPosition = computePosition(afterPos, beforePos, afterPos ?? 0);

    // Atomically update column_id and position
    let card;
    await transaction(async (q) => {
      const { rows } = await q(
        `UPDATE cards
         SET column_id = $1, position = $2
         WHERE id = $3
         RETURNING id, column_id, text, position, created_at`,
        [columnId, newPosition, id],
      );
      card = rows[0];
    });

    broadcast('card:moved', { card });
    res.json({ card });

    // Post-response: check if renormalisation is needed
    setImmediate(async () => {
      try {
        const { rows: colCards } = await query(
          'SELECT position FROM cards WHERE column_id = $1 ORDER BY position ASC',
          [columnId],
        );
        const positions = colCards.map((c) => Number(c.position));
        if (needsRenorm(positions)) {
          await renormalizeColumn(columnId);
        }
      } catch (e) {
        console.error('[ordering] Renorm check failed:', e);
      }
    });
  } catch (err) {
    console.error('[PATCH /api/cards/:id/move]', err);
    res.status(500).json({ error: 'Failed to move card.' });
  }
});

export default router;
