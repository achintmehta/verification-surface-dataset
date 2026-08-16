/**
 * Cluster-based overlap layout engine.
 *
 * Input: an array of events for a SINGLE day, each with numeric `start` and
 * `end` measured in minutes-from-midnight, clamped to [0, 1440].
 *
 * Output: the same events, each annotated with fractional geometry:
 *   - top:    fraction of the day axis (0..1) where the block begins
 *   - height: fraction of the day axis the block occupies
 *   - left:   fraction (0..1) of the day-column width for the block's left edge
 *   - width:  fraction (0..1) of the day-column width the block spans
 *
 * Algorithm:
 *   1. Sort events by start (then end).
 *   2. Group into clusters: a maximal run of events where each event overlaps
 *      at least one already in the open cluster (transitive overlap). A new
 *      event joins the open cluster iff it starts before the cluster's current
 *      maximum end; otherwise the open cluster is closed and a new one begins.
 *   3. Within a cluster, assign each event greedily (by start time) to the
 *      lowest-indexed column whose last event has ended (end <= this.start).
 *      The number of columns the cluster used = its width divisor.
 *   4. width = 1 / columnsUsed; left = assignedColumn / columnsUsed.
 *
 * Property: a non-overlapping event forms its own singleton cluster and gets
 * full width, even when other (denser) clusters exist earlier the same day.
 */

const DAY_MINUTES = 1440;

export function layoutDayEvents(events) {
  // Defensive clamp + copy so callers' objects are not mutated in place
  // beyond the geometry fields we set on the returned shallow copies.
  const items = events
    .map((e) => {
      const start = clamp(e.start, 0, DAY_MINUTES);
      const end = clamp(e.end, 0, DAY_MINUTES);
      return { ...e, start, end };
    })
    .filter((e) => e.end > e.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const clusters = buildClusters(items);

  const result = [];
  for (const cluster of clusters) {
    const columns = assignColumns(cluster);
    const columnsUsed = columns.length;
    columns.forEach((column, colIndex) => {
      for (const e of column) {
        result.push({
          ...e,
          top: e.start / DAY_MINUTES,
          height: (e.end - e.start) / DAY_MINUTES,
          left: colIndex / columnsUsed,
          width: 1 / columnsUsed,
        });
      }
    });
  }

  return result;
}

function buildClusters(sortedItems) {
  const clusters = [];
  let current = [];
  let currentMaxEnd = -Infinity;

  for (const e of sortedItems) {
    if (current.length === 0) {
      current = [e];
      currentMaxEnd = e.end;
      continue;
    }
    // If this event starts before the running max end of the open cluster,
    // it transitively overlaps the cluster -> join it.
    if (e.start < currentMaxEnd) {
      current.push(e);
      currentMaxEnd = Math.max(currentMaxEnd, e.end);
    } else {
      clusters.push(current);
      current = [e];
      currentMaxEnd = e.end;
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/**
 * Greedy column assignment within a cluster (events already sorted by start).
 * Returns an array of columns, each an array of events placed in that column.
 */
function assignColumns(clusterItems) {
  const columns = []; // columns[i] = array of events; track last end via last item
  for (const e of clusterItems) {
    let placed = false;
    for (const column of columns) {
      const last = column[column.length - 1];
      if (last.end <= e.start) {
        column.push(e);
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns.push([e]);
    }
  }
  return columns;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export { DAY_MINUTES };
