/**
 * Overlap layout engine.
 *
 * Given an array of events for a single day, each with minuteStart and minuteEnd
 * (minutes from midnight, 0–1440), computes the layout: column index and total
 * columns in the event's cluster.
 *
 * Algorithm:
 * 1. Sort events by start time, then by end time descending (longer events first).
 * 2. Build maximal overlap clusters: a cluster is a set of events where each
 *    transitively overlaps with at least one other event in the cluster.
 * 3. Within each cluster, greedily assign columns: for each event (in start order),
 *    assign the smallest column index not occupied by any already-placed event that
 *    overlaps with it.
 * 4. The total columns for the cluster is the max column index + 1.
 *
 * Returns an array of { event, column, totalColumns } objects.
 */

export function computeLayout(events) {
  if (events.length === 0) return [];

  // Augment events with minute-based positions
  const items = events.map(e => ({
    event: e,
    minuteStart: e.minuteStart,
    minuteEnd: e.minuteEnd
  }));

  // Sort by start time, then by duration descending (longer first for tie-breaking)
  items.sort((a, b) => {
    if (a.minuteStart !== b.minuteStart) return a.minuteStart - b.minuteStart;
    return b.minuteEnd - a.minuteEnd;
  });

  // Build overlap clusters
  const clusters = [];
  let currentCluster = [items[0]];
  let clusterEnd = items[0].minuteEnd;

  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    if (item.minuteStart < clusterEnd) {
      // Overlaps with the current cluster
      currentCluster.push(item);
      clusterEnd = Math.max(clusterEnd, item.minuteEnd);
    } else {
      // No overlap, start a new cluster
      clusters.push(currentCluster);
      currentCluster = [item];
      clusterEnd = item.minuteEnd;
    }
  }
  clusters.push(currentCluster);

  // Assign columns within each cluster
  const results = [];

  for (const cluster of clusters) {
    const placed = []; // { item, column }

    for (const item of cluster) {
      // Find columns occupied by overlapping already-placed events
      const occupiedColumns = new Set();
      for (const p of placed) {
        if (p.item.minuteStart < item.minuteEnd && p.item.minuteEnd > item.minuteStart) {
          occupiedColumns.add(p.column);
        }
      }

      // Find the smallest free column
      let col = 0;
      while (occupiedColumns.has(col)) col++;

      placed.push({ item, column: col });
    }

    // Total columns for this cluster
    const totalColumns = Math.max(...placed.map(p => p.column)) + 1;

    for (const p of placed) {
      results.push({
        event: p.item.event,
        column: p.column,
        totalColumns
      });
    }
  }

  return results;
}
