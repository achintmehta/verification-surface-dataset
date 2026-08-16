/**
 * Cluster-based overlap layout engine.
 *
 * Given a list of events for a single day, computes for each event:
 *   - colIndex:    which column within its cluster (0-based)
 *   - colCount:    total columns opened in this event's cluster
 *
 * The caller maps these to pixel geometry:
 *   left  = (colIndex / colCount) * dayColumnWidth
 *   width = dayColumnWidth / colCount
 *
 * ── Algorithm ────────────────────────────────────────────────────────────────
 *
 * Phase 1 – Cluster detection (transitive overlap grouping)
 *   Sort events by start time. Sweep through; maintain the running maximum
 *   end time of the current cluster. When an event starts at or after that
 *   maximum, it belongs to a new cluster. This correctly groups transitively
 *   overlapping events: if A overlaps B and B overlaps C (but A doesn't
 *   overlap C), all three are in the same cluster.
 *
 * Phase 2 – Column assignment (greedy, within each cluster)
 *   Maintain colEnds[c] = end time of the last event placed in column c.
 *   For each event (sorted by start, then longer-first), find the first
 *   column c where colEnds[c] <= event.start; assign it there and update
 *   colEnds[c] = event.end. If no free column exists, open a new one.
 *   colCount for every event in the cluster = total columns opened.
 *
 * This guarantees:
 *   - No two events in the same cluster share a column at the same time
 *     → no visual overlap.
 *   - Events in different clusters (non-overlapping) each get their own
 *     cluster with colCount = 1 → full day-column width.
 *   - N identical-time events → N columns → each gets width 1/N.
 *   - Partially overlapping chains: all events in the chain share the same
 *     colCount (= max simultaneous overlap in the chain), ensuring consistent
 *     horizontal geometry with no visual overlap.
 */

/**
 * @typedef {{ id: number, start_at: string, end_at: string, title: string }} CalEvent
 * @typedef {{ event: CalEvent, colIndex: number, colCount: number }} LayoutItem
 */

/**
 * @param {CalEvent[]} events  All events for one day (any order).
 * @returns {LayoutItem[]}
 */
export function computeDayLayout(events) {
  if (events.length === 0) return [];

  // Convert to working objects with numeric timestamps
  const items = events.map(ev => ({
    event:    ev,
    start:    new Date(ev.start_at).getTime(),
    end:      new Date(ev.end_at).getTime(),
    colIndex: 0,
    colCount: 1,
  }));

  // Sort by start time, then by end time descending (longer events first)
  items.sort((a, b) => a.start - b.start || b.end - a.end);

  // ── Phase 1: Build clusters ───────────────────────────────────────────────
  // A cluster is a maximal set of transitively overlapping events.
  // The sweep correctly handles transitive overlap: if A overlaps B and B
  // overlaps C, the cluster's running max-end will still be >= C's start.
  const clusters = [];
  let currentCluster = [];
  let clusterMaxEnd  = -Infinity;

  for (const item of items) {
    if (currentCluster.length > 0 && item.start >= clusterMaxEnd) {
      // This event doesn't overlap anything in the current cluster
      clusters.push(currentCluster);
      currentCluster = [];
      clusterMaxEnd  = -Infinity;
    }
    currentCluster.push(item);
    if (item.end > clusterMaxEnd) clusterMaxEnd = item.end;
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  // ── Phase 2: Assign columns within each cluster ───────────────────────────
  for (const cluster of clusters) {
    // colEnds[c] = end time of the last event placed in column c
    const colEnds = [];

    for (const item of cluster) {
      // Find the first column that is free at item.start
      let placed = false;
      for (let c = 0; c < colEnds.length; c++) {
        if (colEnds[c] <= item.start) {
          item.colIndex = c;
          colEnds[c]    = item.end;
          placed = true;
          break;
        }
      }
      if (!placed) {
        // All existing columns are busy; open a new one
        item.colIndex = colEnds.length;
        colEnds.push(item.end);
      }
    }

    // All events in this cluster share the same colCount
    const colCount = colEnds.length;
    for (const item of cluster) {
      item.colCount = colCount;
    }
  }

  return items.map(item => ({
    event:    item.event,
    colIndex: item.colIndex,
    colCount: item.colCount,
  }));
}
