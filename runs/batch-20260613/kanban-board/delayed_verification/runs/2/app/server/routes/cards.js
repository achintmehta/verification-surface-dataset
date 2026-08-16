/**
 * Card mutation routes:
 *   POST  /api/cards          – create a card
 *   PATCH /api/cards/:id/move – move / reorder a card
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import { computePosition, renormalizeColumn } from '../ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  POST /api/cards                                                     */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: 'columnId is required' });
  }
  if (!text || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    const db = getDb();

    // Verify column exists
    const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // New card goes to the end of the column
    const { position, needsRenorm } = await computePosition(columnId, null, null, null);

    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO cards (id, column_id, text, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, column_id, text, position, created_at`,
      [id, columnId, text.trim(), position]
    );

    const card = rows[0];

    // Broadcast before potential renorm so clients get the card first
    broadcast('card-created', { card });

    if (needsRenorm) {
      await renormalizeColumn(columnId);
    }

    res.status(201).json({ card });
  } catch (err) {
    console.error('POST /api/cards error:', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                           */
/* ------------------------------------------------------------------ */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: 'columnId is required' });
  }

  try {
    const db = getDb();

    // Verify card exists
    const cardCheck = await db.query('SELECT id FROM cards WHERE id = $1', [id]);
    if (cardCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Verify target column exists
    const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Compute the canonical position on the server
    const { position, needsRenorm } = await computePosition(
      columnId,
      afterId,
      beforeId,
      id // exclude the card being moved from boundary lookups
    );

    // Atomically update column_id and position
    const { rows } = await db.transaction(async (tx) => {
      return tx.query(
        `UPDATE cards
         SET column_id = $1, position = $2
         WHERE id = $3
         RETURNING id, column_id, text, position, created_at`,
        [columnId, position, id]
      );
    });

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const card = rows[0];

    // Broadcast the canonical move to all clients
    broadcast('card-moved', { card });

    if (needsRenorm) {
      await renormalizeColumn(columnId);
    }

    res.json({ card });
  } catch (err) {
    console.error(`PATCH /api/cards/${req.params.id}/move error:`, err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

export default router;
