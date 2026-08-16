/**
 * Overlap layout engine — cluster-based algorithm.
 *
 * Given a list of events for a single day, returns each event annotated with:
 *   colIndex  – 0-based column within its cluster
 *   colCount  – total columns in its cluster (width divisor)
 *
 * Algorithm:
 *  1. Sort events by start_at, then by end_at descending (longer first).
 *  2. Build overlap clusters: a cluster is a maximal set of events where
 *     every event overlaps at least one other event in the set (transitive).
 *     Two events overlap when start_a < end_b AND start_b < end_a.
 *  3. Within each cluster, assign column indices greedily:
 *     - Maintain a list of "lanes", each tracking the latest end_at seen.
 *     - For each event (in sorted order), place it in the first lane whose
 *       latest end_at <= event.start_at; if none, open a new lane.
 *  4. colCount = number of lanes used by the cluster.
 */

/**
 * @param {Array<{id, start_at, end_at, title}>} events  – events for ONE day
 * @returns {Array<{event, colIndex, colCount}>}
 */
export function computeLayout(events) {
  if (!events.length) return [];

  // Work with millisecond timestamps for speed
  const items = events.map(ev => ({
    event:   ev,
    startMs: new Date(ev.start_at).getTime(),
    endMs:   new Date(ev.end_at).getTime(),
    colIndex: 0,
    colCount: 1,
  }));

  // Sort by start time, then by duration descending (longer events first)
  items.sort((a, b) => a.startMs - b.startMs || (b.endMs - b.startMs) - (a.endMs - a.startMs));

  // ── Step 1: build clusters ────────────────────────────────────────────────
  // Each cluster is an array of item indices.
  const clusters = [];
  const assigned = new Array(items.length).fill(false);

  for (let i = 0; i < items.length; i++) {
    if (assigned[i]) continue;

    // BFS / flood-fill to find all transitively overlapping events
    const cluster = [i];
    assigned[i] = true;
    let qi = 0;
    while (qi < cluster.length) {
      const ci = cluster[qi++];
      for (let j = 0; j < items.length; j++) {
        if (assigned[j]) continue;
        // Check overlap: items[ci] overlaps items[j]?
        if (items[ci].startMs < items[j].endMs && items[j].startMs < items[ci].endMs) {
          cluster.push(j);
          assigned[j] = true;
        }
      }
    }
    clusters.push(cluster);
  }

  // ── Step 2: assign columns within each cluster ────────────────────────────
  for (const cluster of clusters) {
    // Sort cluster members by start time (they may not be contiguous in items[])
    const members = cluster
      .map(i => items[i])
      .sort((a, b) => a.startMs - b.startMs || (b.endMs - b.startMs) - (a.endMs - a.startMs));

    // Greedy lane assignment
    // lanes[k] = the endMs of the last event placed in lane k
    const lanes = [];

    for (const item of members) {
      let placed = false;
      for (let k = 0; k < lanes.length; k++) {
        if (lanes[k] <= item.startMs) {
          item.colIndex = k;
          lanes[k] = item.endMs;
          placed = true;
          break;
        }
      }
      if (!placed) {
        item.colIndex = lanes.length;
        lanes.push(item.endMs);
      }
    }

    const colCount = lanes.length;
    for (const item of members) {
      item.colCount = colCount;
    }
  }

  return items.map(item => ({
    event:    item.event,
    colIndex: item.colIndex,
    colCount: item.colCount,
  }));
}
