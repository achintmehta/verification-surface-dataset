/**
 * Card mutation routes.
 *
 *  POST  /api/cards            – create a card at the end of a column
 *  PATCH /api/cards/:id/move   – move / reorder a card
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../db.js';
import { broadcast } from '../sse.js';
import { computePosition, renormalizeColumn } from '../ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  POST /api/cards                                                     */
/* ------------------------------------------------------------------ */

router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: '`columnId` is required.' });
  }
  if (!text || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: '`text` is required and must be non-empty.' });
  }

  try {
    // Verify the column exists.
    const { rows: cols } = await db.query(
      `SELECT id FROM columns WHERE id = $1`,
      [columnId]
    );
    if (cols.length === 0) {
      return res.status(404).json({ error: `Column "${columnId}" not found.` });
    }

    // Append to end of column (no afterId / beforeId).
    const { position, needsRenorm } = await computePosition(columnId, null, null);

    const id = randomUUID();
    const now = new Date().toISOString();

    await db.query(
      `INSERT INTO cards (id, column_id, text, position, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, columnId, text.trim(), position, now]
    );

    const card = { id, column_id: columnId, text: text.trim(), position, created_at: now };

    if (needsRenorm) {
      const updates = await renormalizeColumn(columnId);
      // Find the canonical position for the newly created card.
      const updated = updates.find((u) => u.id === id);
      if (updated) card.position = updated.position;
      broadcast('renorm', { columnId, cards: updates });
    }

    broadcast('card:created', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('[cards] POST /api/cards error:', err);
    res.status(500).json({ error: 'Failed to create card.' });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                           */
/* ------------------------------------------------------------------ */

router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, beforeId = null, afterId = null } = req.body ?? {};

  if (!columnId || typeof columnId !== 'string') {
    return res.status(400).json({ error: '`columnId` is required.' });
  }

  try {
    // Verify the card exists.
    const { rows: existing } = await db.query(
      `SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1`,
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: `Card "${id}" not found.` });
    }

    // Verify the target column exists.
    const { rows: cols } = await db.query(
      `SELECT id FROM columns WHERE id = $1`,
      [columnId]
    );
    if (cols.length === 0) {
      return res.status(404).json({ error: `Column "${columnId}" not found.` });
    }

    const sourceColumnId = existing[0].column_id;

    // Compute the new position.  We temporarily exclude the card being moved
    // from the column so that its own position does not interfere with the
    // midpoint calculation when it is being reordered within the same column.
    const { position, needsRenorm } = await computePosition(
      columnId,
      afterId === id ? null : afterId,
      beforeId === id ? null : beforeId
    );

    // Perform the update atomically inside a transaction.
    // PGLite is single-connection so this also serialises concurrent moves.
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE cards SET column_id = $1, position = $2 WHERE id = $3`,
        [columnId, position, id]
      );
    });

    // Fetch the canonical card after the committed update.
    const { rows: updated } = await db.query(
      `SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1`,
      [id]
    );
    const card = updated[0];

    let renormData = null;

    if (needsRenorm) {
      const updates = await renormalizeColumn(columnId);
      const canonical = updates.find((u) => u.id === id);
      if (canonical) card.position = canonical.position;
      renormData = { columnId, cards: updates };
    }

    // If the card moved between columns we may also need to renorm the source.
    if (sourceColumnId !== columnId) {
      const { rows: srcCards } = await db.query(
        `SELECT id, position FROM cards WHERE column_id = $1 ORDER BY position`,
        [sourceColumnId]
      );
      // Check if source column needs renorm (unlikely after a removal, but be safe).
      if (srcCards.length > 1) {
        let srcNeedsRenorm = false;
        for (let i = 1; i < srcCards.length; i++) {
          if (srcCards[i].position - srcCards[i - 1].position < 1e-9) {
            srcNeedsRenorm = true;
            break;
          }
        }
        if (srcNeedsRenorm) {
          const srcUpdates = await renormalizeColumn(sourceColumnId);
          broadcast('renorm', { columnId: sourceColumnId, cards: srcUpdates });
        }
      }
    }

    if (renormData) {
      broadcast('renorm', renormData);
    }

    broadcast('card:moved', { card, sourceColumnId });
    res.json({ card });
  } catch (err) {
    console.error('[cards] PATCH /api/cards/:id/move error:', err);
    res.status(500).json({ error: 'Failed to move card.' });
  }
});

export default router;
