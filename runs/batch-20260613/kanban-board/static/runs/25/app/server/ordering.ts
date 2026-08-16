import type { PGlite } from "@electric-sql/pglite";

const POSITION_GAP = 1000;
const MIN_GAP = 0.001; // Below this, renormalize

/**
 * Compute a position value between two existing positions. 
 * If afterPos and beforePos are null, place at end/start accordingly.
 */
export function computePosition(
  afterPos: number | null,
  beforePos: number | null
): number {
  if (afterPos != null && beforePos != null) {
    return (afterPos + beforePos) / 2;
  }
  if (afterPos != null) {
    // Placing after the last item (no item before)
    return afterPos + POSITION_GAP;
  }
  if (beforePos != null) {
    // Placing before the first item (no item after)
    return beforePos / 2;
  }
  // No reference positions — first card in column
  return POSITION_GAP;
}

/**
 * Check if a column's positions need renormalization (gaps too small)
 * and renormalize if needed. Returns the list of updated cards if
 * renormalization occurred.
 */
export async function maybeRenormalize(
  db: PGlite,
  columnId: string
): Promise<
  Array<{ id: string; column_id: string; text: string; position: number; created_at: string }> | null
> {
  const result = await db.query(
    `SELECT id, column_id, text, position, created_at::text as created_at
     FROM cards WHERE column_id = $1 ORDER BY position ASC`,
    [columnId]
  );
  const cards = result.rows as Array<{
    id: string;
    column_id: string;
    text: string;
    position: number;
    created_at: string;
  }>;

  if (cards.length < 2) return null;

  // Check if any adjacent gap is too small
  let needsRenorm = false;
  for (let i = 1; i < cards.length; i++) {
    const gap = cards[i].position - cards[i - 1].position;
    if (Math.abs(gap) < MIN_GAP) {
      needsRenorm = true;
      break;
    }
  }

  if (!needsRenorm) return null;

  // Renormalize: assign evenly spaced positions
  for (let i = 0; i < cards.length; i++) {
    const newPos = (i + 1) * POSITION_GAP;
    cards[i].position = newPos;
    await db.query(
      `UPDATE cards SET position = $1 WHERE id = $2`,
      [newPos, cards[i].id]
    );
  }

  return cards;
}
