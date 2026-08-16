/**
 * Cluster-based overlap layout engine.
 *
 * Given an array of events for a single day, returns an array of layout
 * descriptors: { event, col, totalCols } where:
 *   - col       : 0-based column index within the cluster
 *   - totalCols : number of columns the cluster required
 *
 * Algorithm:
 *  1. Sort events by start time (ties broken by id for stability).
 *  2. Build overlap clusters: a cluster is a maximal set of events where
 *     every event overlaps at least one other event in the set (transitive).
 *     Two events overlap when event_a.start < event_b.end AND event_a.end > event_b.start.
 *  3. Within each cluster, assign columns greedily:
 *     - Maintain a list of "column end times" (initially empty).
 *     - For each event (sorted by start), find the first column whose end
 *       time <= event.start; assign the event there and update that column's
 *       end time to event.end.  If no column is free, open a new one.
 *  4. totalCols for every event in the cluster = max column index used + 1.
 */

/**
 * @param {Array<{id:number, start_at:string, end_at:string}>} events
 * @returns {Array<{event:object, col:number, totalCols:number}>}
 */
export function computeLayout(events) {
  if (events.length === 0) return [];

  // Sort by start time, then by id for determinism
  const sorted = [...events].sort((a, b) => {
    const diff = new Date(a.start_at) - new Date(b.start_at);
    return diff !== 0 ? diff : a.id - b.id;
  });

  // ── Step 1: Build clusters ────────────────────────────────────────────────
  // Each cluster is an array of event indices (into `sorted`).
  const clusters = [];
  // clusterMaxEnd[i] = the maximum end_at seen so far in cluster i
  const clusterMaxEnd = [];

  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    const evStart = new Date(ev.start_at).getTime();
    const evEnd   = new Date(ev.end_at).getTime();

    // Find an existing cluster whose time span overlaps this event.
    // A cluster overlaps if clusterMaxEnd > evStart (since events are sorted
    // by start, any cluster that hasn't ended yet overlaps).
    let placed = false;
    for (let c = 0; c < clusters.length; c++) {
      if (clusterMaxEnd[c] > evStart) {
        clusters[c].push(i);
        if (evEnd > clusterMaxEnd[c]) clusterMaxEnd[c] = evEnd;
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push([i]);
      clusterMaxEnd.push(evEnd);
    }
  }

  // ── Step 2: Assign columns within each cluster ────────────────────────────
  const result = new Array(sorted.length);

  for (const clusterIndices of clusters) {
    // clusterIndices are already in sorted order (we pushed in sorted order)
    const colEndTimes = []; // end time (ms) of the last event placed in each column

    for (const idx of clusterIndices) {
      const ev = sorted[idx];
      const evStart = new Date(ev.start_at).getTime();
      const evEnd   = new Date(ev.end_at).getTime();

      // Find first column that is free (its last event ended <= evStart)
      let assignedCol = -1;
      for (let c = 0; c < colEndTimes.length; c++) {
        if (colEndTimes[c] <= evStart) {
          assignedCol = c;
          break;
        }
      }
      if (assignedCol === -1) {
        assignedCol = colEndTimes.length;
        colEndTimes.push(0);
      }
      colEndTimes[assignedCol] = evEnd;

      result[idx] = { event: ev, col: assignedCol, totalCols: 0 /* filled below */ };
    }

    const totalCols = colEndTimes.length;
    for (const idx of clusterIndices) {
      result[idx].totalCols = totalCols;
    }
  }

  return result;
}
