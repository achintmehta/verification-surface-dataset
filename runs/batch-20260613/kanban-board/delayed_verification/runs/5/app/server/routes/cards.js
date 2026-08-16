/**
 * routes/cards.js – Card mutation endpoints.
 *
 *   POST  /api/cards           – create a card at the end of a column
 *   PATCH /api/cards/:id/move  – move / reorder a card
 */

import { Router }     from 'express';
import { randomUUID } from 'crypto';
import { getDb }      from '../db.js';
import { broadcast, broadcastReorder } from '../sse.js';
import { appendPosition, computePosition, renormalise } from '../ordering.js';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/cards
// Body: { columnId: string, text: string }
// ---------------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  try {
    const { columnId, text } = req.body;

    if (!columnId || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'columnId and non-empty text are required' });
    }

    const db = await getDb();

    // Find the current maximum position in the target column.
    const { rows: [lastRow] } = await db.query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );

    const position = appendPosition(lastRow?.max_pos ?? null);
    const id       = randomUUID();
    const now      = new Date().toISOString();

    await db.query(
      `INSERT INTO cards (id, column_id, text, position, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, columnId, text.trim(), position, now]
    );

    const card = { id, column_id: columnId, text: text.trim(), position, created_at: now };

    broadcast('card:created', { card });

    return res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/cards/:id/move
// Body: { columnId: string, beforeId?: string|null, afterId?: string|null }
//
// Semantics (from the client's perspective after the drop):
//   beforeId – id of the card that will sit immediately BEFORE (lower position)
//              the moved card in the target column.  null → moved card goes first.
//   afterId  – id of the card that will sit immediately AFTER (higher position)
//              the moved card in the target column.  null → moved card goes last.
//
// The server:
//  1. Looks up the current positions of beforeId and afterId in the target column.
//  2. Computes a new position between them (fractional midpoint).
//  3. Updates column_id + position atomically.
//  4. Broadcasts the canonical card.
//  5. Renormalises the column if positions are exhausted.
// ---------------------------------------------------------------------------
router.patch('/:id/move', async (req, res, next) => {
  try {
    const { id }                          = req.params;
    const { columnId, beforeId, afterId } = req.body;

    if (!columnId) {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const db = await getDb();

    // Verify the card exists.
    const { rows: [existing] } = await db.query(
      'SELECT id FROM cards WHERE id = $1',
      [id]
    );
    if (!existing) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // ------------------------------------------------------------------
    // Determine the new position.
    //
    // We fetch all cards in the target column (excluding the card being
    // moved so its current position doesn't interfere) ordered by position,
    // then locate the neighbours by id.
    // ------------------------------------------------------------------
    const { rows: colCards } = await db.query(
      `SELECT id, position FROM cards
       WHERE column_id = $1 AND id != $2
       ORDER BY position`,
      [columnId, id]
    );

    let beforePos = null;
    let afterPos  = null;

    if (beforeId) {
      const found = colCards.find(c => c.id === beforeId);
      beforePos = found?.position ?? null;
    }

    if (afterId) {
      const found = colCards.find(c => c.id === afterId);
      afterPos = found?.position ?? null;
    }

    // If both neighbours are absent (empty column or both ids unknown),
    // treat as append-to-end.
    if (beforePos === null && afterPos === null && !beforeId && !afterId) {
      // Append to end: use the max position of remaining cards as the lower bound.
      const lastCard = colCards[colCards.length - 1];
      beforePos = lastCard?.position ?? null;
      // afterPos stays null → computePosition will add GAP*2 above beforePos
    }

    const { position, needsRenorm } = computePosition(beforePos, afterPos);

    // Atomic update: change column_id and position in one statement.
    await db.query(
      'UPDATE cards SET column_id = $1, position = $2 WHERE id = $3',
      [columnId, position, id]
    );

    // Fetch the full updated card to return / broadcast.
    const { rows: [card] } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [id]
    );

    broadcast('card:moved', { card });

    // Renormalise if positions are dangerously close.
    if (needsRenorm) {
      await renormaliseColumn(db, columnId);
    }

    return res.json({ card });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Internal helper: renormalise all card positions in a column and broadcast.
// ---------------------------------------------------------------------------
async function renormaliseColumn(db, columnId) {
  const { rows: cards } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position',
    [columnId]
  );

  const updates = renormalise(cards);

  for (const { id, position } of updates) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [position, id]);
  }

  // Fetch the freshly normalised cards to broadcast.
  const { rows: fresh } = await db.query(
    `SELECT id, column_id, text, position, created_at
     FROM cards WHERE column_id = $1 ORDER BY position`,
    [columnId]
  );

  broadcastReorder([{ columnId, cards: fresh }]);
}

export default router;
