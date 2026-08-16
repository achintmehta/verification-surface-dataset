import { randomUUID } from 'node:crypto';
import { db } from './db.js';

// Spacing used when appending to the end of a column and when renormalizing.
const STEP = 1000;
// If two neighbouring positions are closer than this, we consider precision
// exhausted and renormalize the whole column.
const MIN_GAP = 1e-6;

/**
 * Compute a position strictly between `after` and `before`.
 * `after` is the position of the card that should end up ABOVE the moved card
 * (smaller position), `before` is the card BELOW it (larger position).
 *
 * Returns { position } when a safe midpoint exists, or { needsRenormalize:true }
 * when the gap is too small to subdivide.
 */
export function computeBetween(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) {
    // empty column
    return { position: STEP };
  }
  if (afterPos == null) {
    // insert at the very top
    return { position: beforePos - STEP };
  }
  if (beforePos == null) {
    // insert at the very bottom
    return { position: afterPos + STEP };
  }
  const gap = beforePos - afterPos;
  if (gap <= MIN_GAP) {
    return { needsRenormalize: true };
  }
  return { position: afterPos + gap / 2 };
}

/**
 * Append a new card at the end of a column inside an existing transaction-less
 * context. Uses the current max position + STEP.
 */
export async function createCard(columnId, text) {
  const id = randomUUID();
  // Validate the column exists.
  const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
  if (colRows.length === 0) {
    const err = new Error('column_not_found');
    err.code = 'COLUMN_NOT_FOUND';
    throw err;
  }

  const { rows: maxRows } = await db.query(
    'SELECT COALESCE(MAX(position), 0) AS maxpos FROM cards WHERE column_id = $1',
    [columnId]
  );
  const position = Number(maxRows[0].maxpos) + STEP;

  const { rows } = await db.query(
    `INSERT INTO cards (id, column_id, text, position)
     VALUES ($1, $2, $3, $4)
     RETURNING id, column_id, text, position, created_at`,
    [id, columnId, text, position]
  );
  return rows[0];
}

/**
 * Renormalize a column: rewrite every card's position to evenly spaced values
 * preserving current order. Must be called inside a transaction.
 * Returns the ordered list of cards after renormalization.
 */
async function renormalizeColumn(columnId) {
  const { rows: ordered } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  let pos = STEP;
  for (const c of ordered) {
    await db.query('UPDATE cards SET position = $1 WHERE id = $2', [pos, c.id]);
    pos += STEP;
  }
  const { rows } = await db.query(
    'SELECT id, column_id, text, position, created_at FROM cards WHERE column_id = $1 ORDER BY position ASC, id ASC',
    [columnId]
  );
  return rows;
}

/**
 * Move a card into `columnId` between `afterId` (above) and `beforeId` (below).
 *
 * The whole operation runs in a single transaction so the card is never
 * observed in two columns and broadcasts only reflect committed state.
 *
 * Returns:
 *   {
 *     card,                      // canonical moved card
 *     affectedColumnIds,         // columns whose contents changed
 *     renormalizedColumns,       // { [columnId]: [cards...] } if any renormalized
 *   }
 */
export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  await db.query('BEGIN');
  try {
    const { rows: cardRows } = await db.query(
      'SELECT id, column_id FROM cards WHERE id = $1',
      [cardId]
    );
    if (cardRows.length === 0) {
      const err = new Error('card_not_found');
      err.code = 'CARD_NOT_FOUND';
      throw err;
    }
    const sourceColumnId = cardRows[0].column_id;

    const { rows: colRows } = await db.query('SELECT id FROM columns WHERE id = $1', [columnId]);
    if (colRows.length === 0) {
      const err = new Error('column_not_found');
      err.code = 'COLUMN_NOT_FOUND';
      throw err;
    }

    // Look up neighbour positions in the TARGET column. Ignore the moving card
    // itself (in case before/afterId reference it or it's already there).
    const neighbourPos = async (id) => {
      if (!id || id === cardId) return null;
      const { rows } = await db.query(
        'SELECT position FROM cards WHERE id = $1 AND column_id = $2',
        [id, columnId]
      );
      return rows.length ? Number(rows[0].position) : null;
    };

    let afterPos = await neighbourPos(afterId);
    let beforePos = await neighbourPos(beforeId);

    // Guard against contradictory/stale neighbours: if order is inverted, fall
    // back to recomputing against actual column contents.
    if (afterPos != null && beforePos != null && afterPos >= beforePos) {
      afterPos = Math.min(afterPos, beforePos);
      beforePos = Math.max(afterPos, beforePos);
    }

    let result = computeBetween(afterPos, beforePos);

    if (result.needsRenormalize) {
      // First place the card temporarily, then renormalize the target column so
      // the moved card lands in the right relative slot.
      // Give it a position just above `beforePos` (or just below afterPos) using
      // a tiny nudge, then renormalize evenly.
      const temp = afterPos != null ? afterPos + (beforePos - afterPos) / 2 : beforePos;
      await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
        columnId,
        temp,
        cardId,
      ]);
    } else {
      await db.query('UPDATE cards SET column_id = $1, position = $2 WHERE id = $3', [
        columnId,
        result.position,
        cardId,
      ]);
    }

    const renormalizedColumns = {};
    const affected = new Set([columnId, sourceColumnId]);

    if (result.needsRenormalize) {
      renormalizedColumns[columnId] = await renormalizeColumn(columnId);
    }

    // Detect any residual position collision in the target column (two equal
    // positions) and renormalize defensively if found.
    if (!renormalizedColumns[columnId]) {
      const { rows: dupRows } = await db.query(
        `SELECT position, COUNT(*)::int AS n FROM cards
         WHERE column_id = $1 GROUP BY position HAVING COUNT(*) > 1 LIMIT 1`,
        [columnId]
      );
      if (dupRows.length > 0) {
        renormalizedColumns[columnId] = await renormalizeColumn(columnId);
      }
    }

    const { rows: finalRows } = await db.query(
      'SELECT id, column_id, text, position, created_at FROM cards WHERE id = $1',
      [cardId]
    );

    await db.query('COMMIT');

    return {
      card: finalRows[0],
      affectedColumnIds: Array.from(affected),
      renormalizedColumns,
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}
