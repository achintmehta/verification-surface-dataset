/**
 * Card mutation routes:
 *   POST  /api/cards          – create a card
 *   PATCH /api/cards/:id/move – move / reorder a card
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import { computeAndPersistMove } from '../ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/* POST /api/cards                                                      */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res, next) => {
  try {
    const { columnId, text } = req.body;

    if (!columnId || typeof columnId !== 'string') {
      return res.status(400).json({ error: 'columnId is required' });
    }
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }

    const db = getDb();

    // Verify column exists
    const { rows: colRows } = await db.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (!colRows.length) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Append at end: position = max + 1000
    const { rows: maxRows } = await db.query(
      'SELECT COALESCE(MAX(position), 0) AS maxpos FROM cards WHERE column_id = $1',
      [columnId]
    );
    const newPos = parseFloat(maxRows[0].maxpos) + 1000;

    const id = randomUUID();
    const trimmedText = text.trim();

    await db.query(
      'INSERT INTO cards (id, column_id, text, position) VALUES ($1, $2, $3, $4)',
      [id, columnId, trimmedText, newPos]
    );

    const { rows: cardRows } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [id]
    );
    const card = cardRows[0];

    // Broadcast to all SSE clients
    broadcast('card:created', { card });

    res.status(201).json({ card });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* PATCH /api/cards/:id/move                                           */
/* ------------------------------------------------------------------ */
router.patch('/:id/move', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnId, beforeId = null, afterId = null } = req.body;

    if (!columnId || typeof columnId !== 'string') {
      return res.status(400).json({ error: 'columnId is required' });
    }

    const db = getDb();

    // Verify card exists
    const { rows: cardCheck } = await db.query(
      'SELECT id FROM cards WHERE id = $1',
      [id]
    );
    if (!cardCheck.length) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Verify target column exists
    const { rows: colCheck } = await db.query(
      'SELECT id FROM columns WHERE id = $1',
      [columnId]
    );
    if (!colCheck.length) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Execute the move atomically inside a transaction.
    // PGLite is single-connection so BEGIN/COMMIT gives us serialized atomicity.
    let result;
    try {
      await db.query('BEGIN');
      result = await computeAndPersistMove(id, columnId, afterId, beforeId);
      await db.query('COMMIT');
    } catch (txErr) {
      try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw txErr;
    }

    const { card, renormalized, renormPositions } = result;

    // Broadcast canonical card state
    broadcast('card:moved', { card });

    // If renormalization happened, broadcast the corrected column order
    if (renormalized && renormPositions) {
      broadcast('column:renormalized', {
        columnId,
        positions: renormPositions, // [{id, position}]
      });
    }

    res.json({ card });
  } catch (err) {
    next(err);
  }
});

export default router;
