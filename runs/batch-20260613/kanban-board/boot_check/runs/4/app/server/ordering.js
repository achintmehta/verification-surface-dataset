/**
 * Fractional-position ordering helpers.
 *
 * Positions are DOUBLE PRECISION values.  We use a gap of 1000 between
 * "round" positions so there is plenty of room for insertions before
 * renormalisation is needed.
 *
 * Renormalisation is triggered when the gap between two adjacent positions
 * falls below MIN_GAP (2^-40 ≈ 9e-13), which is well above the limits of
 * IEEE-754 double precision.
 */

export const INITIAL_GAP = 1000;
export const MIN_GAP     = 1e-9;

/**
 * Compute a position value that sits between `before` and `after`.
 *
 * @param {number|null} before  - position of the card that will come before
 *                                the new card (null → insert at the start)
 * @param {number|null} after   - position of the card that will come after
 *                                the new card (null → insert at the end)
 * @param {number}      [max]   - current maximum position in the column
 *                                (used when after is null)
 * @returns {{ position: number, needsRenorm: boolean }}
 */
export function computePosition(before, after, max = 0) {
  let position;

  if (before === null && after === null) {
    // Empty column – start at INITIAL_GAP
    position = INITIAL_GAP;
  } else if (before === null) {
    // Insert before the first card
    position = after - INITIAL_GAP;
    if (position <= 0) position = after / 2;
  } else if (after === null) {
    // Insert after the last card
    position = before + INITIAL_GAP;
  } else {
    // Insert between two cards
    position = (before + after) / 2;
  }

  const gap = after !== null ? after - position : INITIAL_GAP;
  const needsRenorm = after !== null && before !== null && (after - before) < MIN_GAP;

  return { position, needsRenorm };
}

/**
 * Renormalise all card positions in a column so they are evenly spaced
 * by INITIAL_GAP, preserving their current order.
 *
 * @param {import('./db.js').getDb} db
 * @param {string} columnId
 * @returns {Promise<Array<{id:string, position:number}>>} updated cards
 */
export async function renormalizeColumn(db, columnId) {
  const result = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId]
  );

  const updates = [];
  for (let i = 0; i < result.rows.length; i++) {
    const newPos = (i + 1) * INITIAL_GAP;
    await db.query(
      'UPDATE cards SET position = $1 WHERE id = $2',
      [newPos, result.rows[i].id]
    );
    updates.push({ id: result.rows[i].id, position: newPos });
  }
  return updates;
}
