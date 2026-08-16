/**
 * Cluster-based overlap layout engine.
 *
 * Given a list of events for a single day, returns the same events annotated
 * with layout information:
 *   { ...event, col: number, totalCols: number }
 *
 * Algorithm:
 *  1. Sort events by start time (ties broken by id for stability).
 *  2. Build overlap clusters: a cluster is a maximal set of events where
 *     every event overlaps at least one other event in the set (transitively).
 *     Two events overlap when startA < endB AND startB < endA.
 *  3. Within each cluster, assign columns greedily:
 *     - Maintain a list of "column end times" (initially empty).
 *     - For each event (in start-time order), find the first column whose
 *       current end time <= event.start_at; assign the event there and update
 *       the column's end time.  If no such column exists, open a new one.
 *  4. totalCols for every event in the cluster = number of columns the cluster
 *     needed.
 */

/**
 * @param {Array<{id:number, start_at:string, end_at:string}>} events
 * @returns {Array<{id:number, start_at:string, end_at:string, col:number, totalCols:number}>}
 */
export function computeLayout(events) {
  if (!events.length) return [];

  // Work with numeric timestamps for speed
  const evs = events.map(e => ({
    ...e,
    _start: new Date(e.start_at).getTime(),
    _end:   new Date(e.end_at).getTime(),
  }));

  // Sort by start time, then by id for stability
  evs.sort((a, b) => a._start - b._start || a.id - b.id);

  // ── Step 1: Build clusters ──────────────────────────────────────────────
  // We sweep through sorted events and merge into the current cluster as long
  // as the event starts before the cluster's maximum end time.

  const clusters = [];
  let currentCluster = null;
  let clusterMaxEnd = -Infinity;

  for (const ev of evs) {
    if (currentCluster === null || ev._start >= clusterMaxEnd) {
      // Start a new cluster
      currentCluster = [ev];
      clusterMaxEnd = ev._end;
      clusters.push(currentCluster);
    } else {
      // Overlaps with current cluster
      currentCluster.push(ev);
      if (ev._end > clusterMaxEnd) clusterMaxEnd = ev._end;
    }
  }

  // ── Step 2: Assign columns within each cluster ──────────────────────────
  const result = [];

  for (const cluster of clusters) {
    // colEnds[i] = the end time of the last event placed in column i
    const colEnds = [];

    for (const ev of cluster) {
      let placed = false;
      for (let c = 0; c < colEnds.length; c++) {
        if (colEnds[c] <= ev._start) {
          ev._col = c;
          colEnds[c] = ev._end;
          placed = true;
          break;
        }
      }
      if (!placed) {
        ev._col = colEnds.length;
        colEnds.push(ev._end);
      }
    }

    const totalCols = colEnds.length;
    for (const ev of cluster) {
      result.push({
        id:        ev.id,
        title:     ev.title,
        start_at:  ev.start_at,
        end_at:    ev.end_at,
        col:       ev._col,
        totalCols,
      });
    }
  }

  return result;
}
