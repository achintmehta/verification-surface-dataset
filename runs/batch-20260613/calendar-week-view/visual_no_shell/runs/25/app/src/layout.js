/**
 * Layout engine for overlapping events.
 *
 * Given an array of events for a single day, each with startMinutes and endMinutes
 * (minutes from midnight, 0–1440), compute cluster-based overlap layout.
 *
 * Returns each event augmented with:
 *   - column: the column index within its cluster
 *   - totalColumns: how many columns the cluster needs
 */
export function computeOverlapLayout(events) {
  if (events.length === 0) return [];

  // Sort by start time, then by end time (longer events first for tie-breaking)
  const sorted = [...events].sort((a, b) => {
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return a.endMinutes - b.endMinutes;
  });

  // Step 1: Group into clusters of transitively overlapping events
  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = sorted[0].endMinutes;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.startMinutes < clusterEnd) {
      // Overlaps with current cluster
      currentCluster.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMinutes);
    } else {
      // Start a new cluster
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterEnd = ev.endMinutes;
    }
  }
  clusters.push(currentCluster);

  // Step 2: For each cluster, assign columns greedily
  const result = [];
  for (const cluster of clusters) {
    // columns[i] = end time of the last event placed in column i
    const columns = [];

    for (const ev of cluster) {
      // Find the first column where this event doesn't overlap
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (ev.startMinutes >= columns[c]) {
          columns[c] = ev.endMinutes;
          result.push({ ...ev, column: c });
          placed = true;
          break;
        }
      }
      if (!placed) {
        const c = columns.length;
        columns.push(ev.endMinutes);
        result.push({ ...ev, column: c });
      }
    }

    // Set totalColumns for all events in this cluster
    const totalCols = columns.length;
    for (const r of result) {
      if (r.totalColumns === undefined) {
        r.totalColumns = totalCols;
      }
    }
  }

  return result;
}
