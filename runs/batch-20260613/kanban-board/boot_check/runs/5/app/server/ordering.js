/**
 * Fractional-position ordering helpers.
 *
 * Positions are DOUBLE PRECISION values.  Inserting between two items uses
 * the midpoint.  When the gap becomes too small (< MIN_GAP) we renormalize
 * the entire column so every card gets a clean integer-spaced position.
 */

export const INITIAL_GAP = 1024;   // gap between freshly seeded / renormalized cards
export const MIN_GAP     = 1e-9;   // below this we must renormalize

/**
 * Compute a position value that sits between `before` and `after`.
 *
 * @param {number|null} before  position of the card that will come before the
 *                              new position (null = insert at the very start)
 * @param {number|null} after   position of the card that will come after the
 *                              new position (null = insert at the very end)
 * @param {number}      max     current maximum position in the column (used
 *                              when inserting at the end)
 * @returns {{ position: number, needsRenorm: boolean }}
 */
export function computePosition(before, after, max) {
  let position;

  if (before === null && after === null) {
    // Empty column – first card
    position = INITIAL_GAP;
  } else if (before === null) {
    // Insert before the first card
    position = after / 2;
  } else if (after === null) {
    // Insert after the last card
    position = (max ?? before) + INITIAL_GAP;
  } else {
    // Insert between two cards
    position = (before + after) / 2;
  }

  const gap = Math.min(
    before !== null ? position - before : Infinity,
    after  !== null ? after  - position : Infinity,
  );

  return { position, needsRenorm: gap < MIN_GAP };
}

/**
 * Renormalize all cards in a column so they have evenly-spaced positions
 * (INITIAL_GAP apart, starting at INITIAL_GAP).
 *
 * Returns the updated rows: [{ id, position }]
 *
 * @param {import('@electric-sql/pglite').PGlite} db
 * @param {string} columnId
 */
export async function renormalizeColumn(db, columnId) {
  // Fetch current order
  const { rows } = await db.query(
    'SELECT id FROM cards WHERE column_id = $1 ORDER BY position ASC',
    [columnId],
  );

  const updates = rows.map((row, i) => ({
    id:       row.id,
    position: (i + 1) * INITIAL_GAP,
  }));

  // Apply updates inside the same (already open) transaction context.
  // Callers are responsible for wrapping in a transaction if needed.
  for (const { id, position } of updates) {
    await db.query(
      'UPDATE cards SET position = $1 WHERE id = $2',
      [position, id],
    );
  }

  return updates;
}
