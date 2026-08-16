/**
 * Fractional-position ordering helpers.
 *
 * Positions are stored as DOUBLE PRECISION (float8) in PGLite.
 * We use a base of 1000 so there is plenty of room between initial values.
 *
 * Collision / precision-exhaustion detection:
 *   If the computed position already exists in the column, OR the gap between
 *   the two neighbours is smaller than MIN_GAP, we renormalise the entire
 *   column by spacing cards 1000 apart, then recompute the target position
 *   from the fresh positions.
 */

const BASE = 1000;
const MIN_GAP = 1e-9; // below this we consider positions "colliding"

/**
 * Compute a position value that sits between `before` and `after`.
 *
 * @param {number|null} before  - position of the card that will come before the new one (or null)
 * @param {number|null} after   - position of the card that will come after  the new one (or null)
 * @returns {number}
 */
export function between(before, after) {
  if (before === null && after === null) return BASE;
  if (before === null) return after - BASE;
  if (after  === null) return before + BASE;
  return (before + after) / 2;
}

/**
 * Renormalise all cards in a column by assigning evenly-spaced positions,
 * EXCLUDING the card being moved (so it doesn't occupy a slot between its
 * future neighbours during the renorm pass).
 *
 * Returns the updated card rows (excluding the moving card) so the caller
 * can broadcast them.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {string} columnId
 * @param {string} excludeId  - id of the card being moved (skip during renorm)
 * @returns {Promise<void>}
 */
export async function renormalizeColumn(db, columnId, excludeId) {
  // Fetch current order, excluding the card being moved
  const { rows } = await db.query(
    `SELECT id FROM cards
     WHERE column_id = $1 AND id != $2
     ORDER BY position ASC, created_at ASC, id ASC`,
    [columnId, excludeId ?? '']
  );

  // Assign new evenly-spaced positions inside a transaction
  await db.exec('BEGIN');
  try {
    for (let i = 0; i < rows.length; i++) {
      const newPos = (i + 1) * BASE;
      await db.query(
        'UPDATE cards SET position = $1 WHERE id = $2',
        [newPos, rows[i].id]
      );
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Compute the canonical position for a card being moved between beforeId and afterId
 * within a column. If the computed position collides with an existing card, or the
 * gap is too small, renormalise the column first and recompute from fresh positions.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {string}      columnId
 * @param {string|null} beforeId  - card that will be immediately before the moved card
 * @param {string|null} afterId   - card that will be immediately after  the moved card
 * @param {string}      movingId  - the card being moved (excluded from collision check)
 * @returns {Promise<{ position: number, renormalized: boolean }>}
 */
export async function computePosition(db, columnId, beforeId, afterId, movingId) {
  async function resolvePos(id) {
    if (!id) return null;
    const { rows } = await db.query('SELECT position FROM cards WHERE id = $1', [id]);
    return rows.length ? rows[0].position : null;
  }

  let beforePos = await resolvePos(beforeId);
  let afterPos  = await resolvePos(afterId);

  let position = between(beforePos, afterPos);

  // Check for collision: does any OTHER card in this column already have this exact position?
  // Also check if the gap is too small for further subdivision.
  const needsRenorm = await (async () => {
    // Gap too small
    if (beforePos !== null && afterPos !== null && Math.abs(afterPos - beforePos) < MIN_GAP) {
      return true;
    }
    // Exact collision with an existing card (excluding the card being moved)
    const { rows } = await db.query(
      'SELECT id FROM cards WHERE column_id = $1 AND position = $2 AND id != $3',
      [columnId, position, movingId]
    );
    return rows.length > 0;
  })();

  if (needsRenorm) {
    console.log(`[ordering] collision/gap detected at pos=${position} (before=${beforePos}, after=${afterPos}), renormalizing column ${columnId}`);

    // Renorm excluding the moving card so it doesn't occupy a slot between its neighbours
    await renormalizeColumn(db, columnId, movingId);

    // Re-resolve positions from the freshly normalised column
    beforePos = await resolvePos(beforeId);
    afterPos  = await resolvePos(afterId);
    position  = between(beforePos, afterPos);

    console.log(`[ordering] after renorm: before=${beforePos}, after=${afterPos}, new pos=${position}`);

    return { position, renormalized: true };
  }

  return { position, renormalized: false };
}

/**
 * Renormalise a full column (including all cards) and return the updated rows.
 * Used for broadcasting after a move that triggered renorm.
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {string} columnId
 * @returns {Promise<Array>}
 */
export async function renormalizeColumnFull(db, columnId) {
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [columnId]
  );

  await db.exec('BEGIN');
  try {
    for (let i = 0; i < rows.length; i++) {
      await db.query('UPDATE cards SET position = $1 WHERE id = $2', [(i + 1) * BASE, rows[i].id]);
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }

  const { rows: updated } = await db.query(
    'SELECT * FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );
  return updated;
}
