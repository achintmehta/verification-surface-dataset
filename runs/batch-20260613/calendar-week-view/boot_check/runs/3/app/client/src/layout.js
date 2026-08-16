/**
 * Overlap layout engine — cluster-based algorithm.
 *
 * Given a list of events for a single day, returns the same events annotated
 * with layout properties:
 *   { colIndex, colCount }
 *
 * where:
 *   colIndex  — 0-based column index within the cluster
 *   colCount  — total number of columns in the cluster
 *
 * The caller maps these to CSS left/width as:
 *   left  = (colIndex / colCount) * 100%
 *   width = (1 / colCount) * 100%
 *
 * Algorithm:
 * 1. Sort events by start time (ties broken by id for stability).
 * 2. Build overlap clusters: a cluster is a maximal set of events where
 *    every event overlaps at least one other event in the set (transitive).
 *    Two events overlap iff startA < endB AND startB < endA.
 * 3. Within each cluster, assign column indices greedily:
 *    - Maintain an array of "column end times" (initially empty).
 *    - For each event (in start-time order), find the first column whose
 *      end time <= event.start (i.e. the column is free). If found, place
 *      the event there and update the column's end time. Otherwise, open a
 *      new column.
 * 4. colCount for every event in the cluster = number of columns opened.
 */

/**
 * @param {Array<{id: number, start_at: string, end_at: string}>} events
 * @returns {Array<{id: number, start_at: string, end_at: string, colIndex: number, colCount: number}>}
 */
export function computeLayout(events) {
  if (!events || events.length === 0) return [];

  // Work with numeric timestamps for speed
  const items = events.map(ev => ({
    ...ev,
    _start: new Date(ev.start_at).getTime(),
    _end:   new Date(ev.end_at).getTime(),
  }));

  // Sort by start time, then by id for stability
  items.sort((a, b) => a._start - b._start || a.id - b.id);

  // ── Step 1: Build clusters ─────────────────────────────────────────────
  // We use a sweep: maintain the maximum end time seen so far in the current
  // cluster. When a new event starts at or after that maximum, the cluster ends.
  const clusters = [];
  let currentCluster = [];
  let clusterMaxEnd = -Infinity;

  for (const item of items) {
    if (currentCluster.length === 0) {
      currentCluster.push(item);
      clusterMaxEnd = item._end;
    } else if (item._start < clusterMaxEnd) {
      // Overlaps with something in the current cluster
      currentCluster.push(item);
      if (item._end > clusterMaxEnd) clusterMaxEnd = item._end;
    } else {
      // No overlap — start a new cluster
      clusters.push(currentCluster);
      currentCluster = [item];
      clusterMaxEnd = item._end;
    }
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  // ── Step 2: Assign columns within each cluster ─────────────────────────
  const result = [];

  for (const cluster of clusters) {
    // colEnds[i] = the end time of the last event placed in column i
    const colEnds = [];

    const placed = cluster.map(item => {
      // Find first free column
      let col = -1;
      for (let i = 0; i < colEnds.length; i++) {
        if (colEnds[i] <= item._start) {
          col = i;
          break;
        }
      }
      if (col === -1) {
        // Open a new column
        col = colEnds.length;
        colEnds.push(item._end);
      } else {
        colEnds[col] = item._end;
      }
      return { item, col };
    });

    const colCount = colEnds.length;

    for (const { item, col } of placed) {
      result.push({
        ...item,
        colIndex: col,
        colCount,
      });
    }
  }

  return result;
}
