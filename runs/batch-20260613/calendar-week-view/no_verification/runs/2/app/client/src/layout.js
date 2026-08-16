/**
 * Cluster-based overlap layout engine.
 *
 * Given a list of events for a single day, returns the same events annotated
 * with layout information:
 *   { ...event, _col: number, _numCols: number }
 *
 * Algorithm:
 *  1. Sort events by start time (ties broken by id for stability).
 *  2. Build overlap clusters: a cluster is a maximal set of events where
 *     every event overlaps at least one other event in the set (transitively).
 *     Two events overlap when start_a < end_b AND start_b < end_a.
 *  3. Within each cluster, assign column indices greedily:
 *     - Maintain a list of "column end times" (initially empty).
 *     - For each event (in start-time order), find the first column whose
 *       end time <= event.start_at; assign that column and update its end time.
 *       If no such column exists, open a new one.
 *  4. The number of columns for the cluster = max column index + 1.
 *     Each event's width fraction = 1 / numCols.
 *     Each event's left offset fraction = col / numCols.
 */

/**
 * @param {Array<{id:number, start_at:string, end_at:string}>} events
 * @returns {Array<{id:number, start_at:string, end_at:string, _col:number, _numCols:number}>}
 */
export function computeLayout(events) {
  if (!events || events.length === 0) return [];

  // Work with millisecond timestamps for speed
  const evs = events.map(e => ({
    ...e,
    _s: new Date(e.start_at).getTime(),
    _e: new Date(e.end_at).getTime(),
  }));

  // Sort by start time, then by id for stability
  evs.sort((a, b) => a._s - b._s || a.id - b.id);

  // ── Step 1: Build clusters ──────────────────────────────────────────────
  // We use a sweep: maintain the maximum end time seen so far in the current
  // cluster. When a new event starts at or after that maximum, it starts a
  // new cluster.
  const clusters = [];
  let currentCluster = [];
  let clusterMaxEnd = -Infinity;

  for (const ev of evs) {
    if (currentCluster.length === 0 || ev._s < clusterMaxEnd) {
      // Overlaps with something in the current cluster (or first event)
      currentCluster.push(ev);
      if (ev._e > clusterMaxEnd) clusterMaxEnd = ev._e;
    } else {
      // No overlap with current cluster → start a new one
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterMaxEnd = ev._e;
    }
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  // ── Step 2: Assign columns within each cluster ──────────────────────────
  const result = [];

  for (const cluster of clusters) {
    // colEnds[i] = end time of the last event placed in column i
    const colEnds = [];

    for (const ev of cluster) {
      let assigned = -1;
      for (let c = 0; c < colEnds.length; c++) {
        if (colEnds[c] <= ev._s) {
          assigned = c;
          break;
        }
      }
      if (assigned === -1) {
        assigned = colEnds.length;
        colEnds.push(ev._e);
      } else {
        colEnds[assigned] = ev._e;
      }
      ev._col = assigned;
    }

    const numCols = colEnds.length;
    for (const ev of cluster) {
      ev._numCols = numCols;
      // Clean up temp props before returning
      const { _s, _e, ...rest } = ev;
      result.push(rest);
    }
  }

  return result;
}

/**
 * Convert a Date (or ISO string) to minutes since midnight (local time).
 * @param {Date|string} dt
 * @returns {number}
 */
export function toMinutes(dt) {
  const d = dt instanceof Date ? dt : new Date(dt);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/**
 * Given a minutes-since-midnight value and the pixel height per hour,
 * return the pixel offset from the top of the day column.
 * @param {number} minutes
 * @param {number} hourHeight  px per hour
 * @returns {number}
 */
export function minutesToPx(minutes, hourHeight) {
  return (minutes / 60) * hourHeight;
}
