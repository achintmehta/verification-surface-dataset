// Pure cluster-based overlap layout engine.
//
// All geometry is computed as fractions/minutes so it is testable and
// independent of any pixel/styling concerns. The renderer multiplies by the
// axis height for vertical placement and by the column width for horizontal.

export const MINUTES_PER_DAY = 24 * 60;

/**
 * Minutes from midnight for a Date, in local time.
 */
export function minutesFromMidnight(date, dayStart) {
  return (date.getTime() - dayStart.getTime()) / 60000;
}

/**
 * Clamp an event to a single day [dayStart, dayStart + 24h) and return its
 * vertical extent in minutes, or null if it does not intersect the day.
 *
 * @returns {{ topMin: number, bottomMin: number }|null}
 */
export function clampToDay(event, dayStart) {
  const dayEnd = new Date(dayStart.getTime() + MINUTES_PER_DAY * 60000);
  const start = new Date(event.start_at);
  const end = new Date(event.end_at);
  // No intersection with this day.
  if (end <= dayStart || start >= dayEnd) return null;

  const rawTop = minutesFromMidnight(start, dayStart);
  const rawBottom = minutesFromMidnight(end, dayStart);
  const topMin = Math.max(0, rawTop);
  // An event ending at or after midnight of the next day terminates exactly at
  // the bottom edge (MINUTES_PER_DAY).
  const bottomMin = Math.min(MINUTES_PER_DAY, rawBottom);
  if (bottomMin <= topMin) return null;
  return { topMin, bottomMin };
}

/**
 * Two intervals overlap if one starts strictly before the other ends.
 * Adjacent events (a.end === b.start) do NOT overlap.
 */
function intervalsOverlap(a, b) {
  return a.topMin < b.bottomMin && b.topMin < a.bottomMin;
}

/**
 * Lay out a list of items for a single day.
 *
 * Each input item is { event, topMin, bottomMin } (already clamped to the day).
 *
 * Algorithm (standard calendar cluster layout):
 *   1. Sort by start time (then end time, then id) for deterministic packing.
 *   2. Group into clusters: maximal sets of transitively overlapping events.
 *      A new cluster begins when an event starts at or after the maximum end
 *      time seen so far in the current cluster.
 *   3. Within a cluster, assign each event greedily to the first column whose
 *      last event has ended (no overlap). Track the number of columns used.
 *   4. width = 1 / clusterColumnCount; left = assignedColumn / clusterColumnCount.
 *
 * Returns an array of placement objects:
 *   { event, topMin, bottomMin, widthFrac, leftFrac }
 */
export function layoutDay(items) {
  const sorted = [...items].sort((a, b) => {
    if (a.topMin !== b.topMin) return a.topMin - b.topMin;
    if (a.bottomMin !== b.bottomMin) return a.bottomMin - b.bottomMin;
    return (a.event.id ?? 0) - (b.event.id ?? 0);
  });

  const placements = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    // Greedy column assignment within this cluster.
    // columns[i] holds the bottomMin of the last event placed in column i.
    const columnEnds = [];
    for (const item of cluster) {
      let placed = false;
      for (let col = 0; col < columnEnds.length; col++) {
        // Can reuse this column only if the previous event has ended
        // (i.e. no overlap with the most recent event there).
        if (item.topMin >= columnEnds[col]) {
          item._col = col;
          columnEnds[col] = item.bottomMin;
          placed = true;
          break;
        }
      }
      if (!placed) {
        item._col = columnEnds.length;
        columnEnds.push(item.bottomMin);
      }
    }
    const colCount = columnEnds.length;
    for (const item of cluster) {
      placements.push({
        event: item.event,
        topMin: item.topMin,
        bottomMin: item.bottomMin,
        widthFrac: 1 / colCount,
        leftFrac: item._col / colCount,
      });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const item of sorted) {
    if (cluster.length > 0 && item.topMin >= clusterEnd) {
      // This event does not overlap anything currently in the cluster.
      flush();
    }
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.bottomMin);
  }
  flush();

  return placements;
}

/**
 * Sanity check used by tests: no two placements in the same day visually
 * overlap (their time ranges intersect AND their horizontal ranges intersect).
 */
export function placementsOverlap(a, b) {
  const timeOverlap = a.topMin < b.bottomMin && b.topMin < a.bottomMin;
  if (!timeOverlap) return false;
  const aRight = a.leftFrac + a.widthFrac;
  const bRight = b.leftFrac + b.widthFrac;
  const eps = 1e-9;
  const horizOverlap = a.leftFrac < bRight - eps && b.leftFrac < aRight - eps;
  return horizOverlap;
}

export { intervalsOverlap };
