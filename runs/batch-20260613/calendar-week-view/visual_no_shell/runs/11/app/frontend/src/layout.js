// Pure overlap-layout engine.
//
// Input: an array of events that fall (at least partially) within a single day.
// Each event must have numeric `startMin` and `endMin` (minutes from the day's
// midnight, clamped to [0, 1440]). Output: the same events annotated with
// fractional horizontal geometry { colIndex, colCount } per cluster, from which
// the renderer derives left/width as fractions of the day-column width.

// Group events into maximal clusters of transitively-overlapping events.
// Two events overlap iff a.start < b.end && b.start < a.end.
export function buildClusters(events) {
  // Sort by start time, then by end time, then id for determinism.
  const sorted = [...events].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    if (a.endMin !== b.endMin) return a.endMin - b.endMin;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  const clusters = [];
  let current = [];
  let clusterEnd = -Infinity;

  for (const ev of sorted) {
    if (current.length === 0 || ev.startMin < clusterEnd) {
      // overlaps the running cluster span -> same cluster
      current.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMin);
    } else {
      clusters.push(current);
      current = [ev];
      clusterEnd = ev.endMin;
    }
  }
  if (current.length) clusters.push(current);
  return clusters;
}

// Greedy column assignment within a cluster. Events (already start-sorted) are
// placed in the first column whose last event has ended. Returns the number of
// columns used and assigns `colIndex` to each event.
function assignColumns(cluster) {
  const columns = []; // each entry = end time of last event in that column
  for (const ev of cluster) {
    let placed = false;
    for (let i = 0; i < columns.length; i++) {
      if (ev.startMin >= columns[i]) {
        columns[i] = ev.endMin;
        ev.colIndex = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      ev.colIndex = columns.length;
      columns.push(ev.endMin);
    }
  }
  return columns.length;
}

// Annotate each event with { colIndex, colCount }. colCount is the number of
// columns the event's cluster required (so non-contended events get colCount 1
// and fill the full width).
export function layoutDay(events) {
  const clusters = buildClusters(events);
  const result = [];
  for (const cluster of clusters) {
    const colCount = assignColumns(cluster);
    for (const ev of cluster) {
      result.push({ ...ev, colCount });
    }
  }
  return result;
}
