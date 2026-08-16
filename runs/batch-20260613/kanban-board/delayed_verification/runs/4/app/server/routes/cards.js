/**
 * Card mutation routes:
 *   POST  /api/cards          – create a card at the end of a column
 *   PATCH /api/cards/:id/move – move/reorder a card
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import {
  computePosition,
  needsRenormalization,
  renormalizeColumn,
  resolveNeighbourPositions,
  INITIAL_POSITION,
} from '../ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  POST /api/cards                                                     */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: '`columnId` is required.' });
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '`text` is required.' });
  }

  try {
    const db = getDb();

    // Verify column exists
    const { rows: colRows } = await db.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (!colRows.length) {
      return res.status(404).json({ error: `Column "${columnId}" not found.` });
    }

    // Find the current maximum position in the column
    const { rows: maxRows } = await db.query(
      'SELECT MAX(position) AS max_pos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const maxPos = maxRows[0].max_pos != null ? Number(maxRows[0].max_pos) : null;
    const position = maxPos == null ? INITIAL_POSITION : maxPos + INITIAL_POSITION;

    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );

    const card = rows[0];
    broadcast('card-created', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /api/cards]', err);
    res.status(500).json({ error: 'Failed to create card.' });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                           */
/* ------------------------------------------------------------------ */
/**
 * Body: { columnId: string, beforeId?: string|null, afterId?: string|null }
 *
 * Semantics:
 *   afterId  – the card that will be immediately ABOVE  the moved card (lower position)
 *   beforeId – the card that will be immediately BELOW  the moved card (higher position)
 *
 * The server computes the canonical position, persists atomically, and
 * broadcasts the result. If the computed position is too close to a neighbour
 * the column is renormalized and a separate broadcast is emitted.
 */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: '`columnId` is required.' });
  }

  try {
    const db = getDb();

    // Verify card exists
    const { rows: cardRows } = await db.query(
      'SELECT id, column_id, position FROM cards WHERE id = $1',
      [id]
    );
    if (!cardRows.length) {
      return res.status(404).json({ error: `Card "${id}" not found.` });
    }

    // Verify target column exists
    const { rows: colRows } = await db.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (!colRows.length) {
      return res.status(404).json({ error: `Column "${columnId}" not found.` });
    }

    // Resolve neighbour positions (exclude the card being moved to avoid
    // using its own position as a reference when it's already in the column)
    const { afterPos, beforePos } = await resolveNeighbourPositions(beforeId, afterId);

    const newPosition = computePosition(afterPos, beforePos);

    // Atomic update
    const { rows: updated } = await db.query(
      `UPDATE cards
          SET column_id = $1,
              position  = $2
        WHERE id = $3
        RETURNING id, column_id, text, position, created_at`,
      [columnId, newPosition, id]
    );

    const card = updated[0];

    // Broadcast the canonical move immediately
    broadcast('card-moved', { card });

    // Check if renormalization is needed AFTER the move
    // (checks both precision exhaustion and position collisions)
    if (await needsRenormalization(columnId, id, afterPos, beforePos, newPosition)) {
      // renormalizeColumn broadcasts 'column-reordered' internally
      await renormalizeColumn(columnId);
    }

    res.json({ card });
  } catch (err) {
    console.error(`[PATCH /api/cards/${req.params.id}/move]`, err);
    res.status(500).json({ error: 'Failed to move card.' });
  }
});

export default router;
