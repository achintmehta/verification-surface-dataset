// Fractional position ordering helpers.
//
// Each card carries a DOUBLE PRECISION `position` within its column. To insert
// a card between two neighbors we pick a value strictly between their
// positions. This avoids re-indexing an entire column on every move.
//
// We guard against the two failure modes of fractional indexing:
//   1. Collision    - computed position equals an existing one.
//   2. Exhaustion   - the gap between neighbors is too small for double
//                     precision to represent a distinct midpoint.
// In either case the caller renormalizes the column.

export const POSITION_STEP = 1000;

// Minimum representable gap before we consider precision exhausted.
const MIN_GAP = 1e-6;

/**
 * Compute a position strictly between `after` and `before`.
 * Either bound may be null/undefined meaning "open end".
 *
 * Returns { position } on success, or { needsRenormalize: true } when the
 * gap is too small to place a distinct value.
 */
export function computePosition(afterPos, beforePos) {
  const hasAfter = afterPos !== null && afterPos !== undefined && Number.isFinite(afterPos);
  const hasBefore = beforePos !== null && beforePos !== undefined && Number.isFinite(beforePos);

  let position;
  if (!hasAfter && !hasBefore) {
    // Empty column.
    position = POSITION_STEP;
  } else if (hasAfter && !hasBefore) {
    // Append to the end.
    position = afterPos + POSITION_STEP;
  } else if (!hasAfter && hasBefore) {
    // Prepend to the front.
    position = beforePos - POSITION_STEP;
  } else {
    // Between two cards.
    if (beforePos - afterPos <= MIN_GAP) {
      return { needsRenormalize: true };
    }
    position = afterPos + (beforePos - afterPos) / 2;
    // Verify the midpoint is actually distinct from both neighbors.
    if (position <= afterPos || position >= beforePos) {
      return { needsRenormalize: true };
    }
  }

  return { position };
}
