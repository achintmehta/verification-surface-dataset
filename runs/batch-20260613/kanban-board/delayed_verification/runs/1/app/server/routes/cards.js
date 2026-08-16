import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { broadcast } from '../sse.js';
import { computePosition, renormaliseColumn } from '../ordering.js';

const router = Router();

/* ------------------------------------------------------------------ */
/*  POST /api/cards                                                     */
/*  Body: { columnId, text }                                            */
/*  Creates a card at the end of the column and broadcasts it.         */
/* ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { columnId, text } = req.body ?? {};

  if (!columnId || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'columnId and non-empty text are required' });
  }

  try {
    const db = getDb();

    // Verify column exists
    const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (!colCheck.rows.length) {
      return res.status(404).json({ error: 'Column not found' });
    }

    // Position = max existing position + STEP  (handled by computePosition with no neighbours)
    // Retry once on unique-constraint collision (two concurrent creates).
    let card;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { position } = await computePosition(columnId, null, null);
      const newId = randomUUID();
      try {
        const { rows } = await db.query(
          `INSERT INTO cards (id, column_id, text, position)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [newId, columnId, text.trim(), position]
        );
        card = rows[0];
        break;
      } catch (err) {
        // On unique-constraint violation (code 23505), retry with fresh MAX
        if (err.code === '23505' && attempt < 2) {
          console.warn('[create] position collision, retrying');
          continue;
        }
        throw err;
      }
    }

    broadcast('card-created', { card });
    res.status(201).json({ card });
  } catch (err) {
    console.error('[POST /api/cards]', err);
    res.status(500).json({ error: 'Failed to create card' });
  }
});

/* ------------------------------------------------------------------ */
/*  PATCH /api/cards/:id/move                                           */
/*  Body: { columnId, afterId?, beforeId? }                            */
/*  Moves a card to columnId, positioned between afterId and beforeId. */
/* ------------------------------------------------------------------ */
router.patch('/:id/move', async (req, res) => {
  const { id } = req.params;
  const { columnId, afterId = null, beforeId = null } = req.body ?? {};

  if (!columnId) {
    return res.status(400).json({ error: 'columnId is required' });
  }

  const db = getDb();

  // Verify card exists
  const cardCheck = await db.query('SELECT * FROM cards WHERE id = $1', [id]);
  if (!cardCheck.rows.length) {
    return res.status(404).json({ error: 'Card not found' });
  }

  // Verify column exists
  const colCheck = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  if (!colCheck.rows.length) {
    return res.status(404).json({ error: 'Column not found' });
  }

  try {
    // Compute canonical position and perform the atomic update.
    // We retry once if there is a position collision (unique constraint violation).
    let card;
    let needsRenorm = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      const computed = await computePosition(columnId, afterId, beforeId, id);
      needsRenorm = computed.needsRenorm;

      await db.exec('BEGIN');
      try {
        const { rows } = await db.query(
          `UPDATE cards
              SET column_id = $1,
                  position  = $2
            WHERE id = $3
            RETURNING *`,
          [columnId, computed.position, id]
        );
        card = rows[0];
        await db.exec('COMMIT');
        break; // success
      } catch (err) {
        await db.exec('ROLLBACK');
        // On unique-constraint violation (code 23505), renorm and retry
        if (err.code === '23505' && attempt === 0) {
          console.warn('[move] position collision, renormalising and retrying');
          await renormaliseColumn(columnId);
          continue;
        }
        throw err;
      }
    }

    // Broadcast the canonical card state BEFORE any renorm so clients get
    // the move immediately.
    broadcast('card-moved', { card });
    res.json({ card });

    // Renormalise asynchronously if precision is exhausted
    if (needsRenorm) {
      renormaliseColumn(columnId).catch(err =>
        console.error('[renorm]', err)
      );
    }
  } catch (err) {
    console.error('[PATCH /api/cards/:id/move]', err);
    res.status(500).json({ error: 'Failed to move card' });
  }
});

export default router;
