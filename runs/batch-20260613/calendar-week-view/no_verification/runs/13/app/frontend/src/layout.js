// layout.js
// Pure functions for placing events within a day column.
//
// The output geometry is expressed in fractions [0..1]:
//   - top:    fraction of the day height where the block starts
//   - height: fraction of the day height the block spans
//   - left:   fraction of the day width where the block starts
//   - width:  fraction of the day width the block spans
//
// Callers multiply by pixel dimensions to obtain absolute positions.

const MINUTES_PER_DAY = 24 * 60;

/**
 * Compute minutes-from-midnight for a Date, clamped to [0, 1440].
 * `dayStart` is a Date at 00:00 of the relevant day (local time).
 */
export function minutesFromMidnight(date, dayStart) {
  const diffMs = date.getTime() - dayStart.getTime();
  const minutes = diffMs / 60000;
  if (minutes < 0) return 0;
  if (minutes > MINUTES_PER_DAY) return MINUTES_PER_DAY;
  return minutes;
}

/**
 * Given a list of events for a single day, compute their layout geometry.
 *
 * Each input event must have: { id, startMin, endMin, ...rest }
 * where startMin/endMin are minutes-from-midnight already clamped to
 * [0, 1440]. The function does NOT mutate the inputs.
 *
 * Returns an array of objects: { ...event, top, height, left, width }.
 *
 * Algorithm (Decision 1 — cluster-based overlap layout):
 *  1. Sort events by start time (then end time).
 *  2. Group into clusters: maximal sets of transitively overlapping events.
 *  3. Within a cluster, assign each event the lowest-indexed column whose
 *     last event has ended (greedy by start time).
 *  4. The cluster's column count is the max columns used; every event's
 *     width = 1 / columnCount, left = columnIndex / columnCount.
 *
 * This guarantees no two blocks overlap, while an uncontended event
 * (its own cluster of size 1) gets the full width.
 */
export function layoutDayEvents(events) {
  // Defensive copy + stable sort.
  const sorted = events
    .map((e) => ({ ...e }))
    .sort((a, b) => {
      if (a.startMin !== b.startMin) return a.startMin - b.startMin;
      if (a.endMin !== b.endMin) return a.endMin - b.endMin;
      return String(a.id).localeCompare(String(b.id));
    });

  const result = [];

  // Walk events, accumulating clusters. A new event belongs to the current
  // cluster if it starts before the maximum end time seen so far in the
  // cluster.
  let cluster = [];
  let clusterMaxEnd = -Infinity;

  const flushCluster = () => {
    if (cluster.length === 0) return;
    layoutCluster(cluster).forEach((e) => result.push(e));
    cluster = [];
    clusterMaxEnd = -Infinity;
  };

  for (const ev of sorted) {
    if (cluster.length > 0 && ev.startMin >= clusterMaxEnd) {
      // No overlap with anything in the current cluster -> close it.
      flushCluster();
    }
    cluster.push(ev);
    clusterMaxEnd = Math.max(clusterMaxEnd, ev.endMin);
  }
  flushCluster();

  return result;
}

/**
 * Lay out a single cluster (already known to be transitively overlapping
 * in time, or a singleton). Assigns columns greedily and computes geometry.
 */
function layoutCluster(cluster) {
  // columns[i] holds the end time of the last event placed in column i.
  const columnEnds = [];
  // Track the column index assigned to each event.
  const assignments = [];

  for (const ev of cluster) {
    let placed = false;
    for (let col = 0; col < columnEnds.length; col++) {
      // An event can reuse a column if the column's last event has ended
      // at or before this event's start (no overlap).
      if (ev.startMin >= columnEnds[col]) {
        columnEnds[col] = ev.endMin;
        assignments.push(col);
        placed = true;
        break;
      }
    }
    if (!placed) {
      columnEnds.push(ev.endMin);
      assignments.push(columnEnds.length - 1);
    }
  }

  const columnCount = columnEnds.length;

  return cluster.map((ev, i) => {
    const col = assignments[i];
    const top = ev.startMin / MINUTES_PER_DAY;
    const height = (ev.endMin - ev.startMin) / MINUTES_PER_DAY;
    return {
      ...ev,
      top,
      height,
      left: col / columnCount,
      width: 1 / columnCount,
      _column: col,
      _columnCount: columnCount,
    };
  });
}
