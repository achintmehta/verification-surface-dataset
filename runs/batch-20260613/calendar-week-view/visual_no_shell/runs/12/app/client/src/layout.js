// Cluster-based overlap layout engine.
//
// Input: an array of events, each with numeric `start` and `end`
//   (e.g. minutes-from-midnight). Two events overlap iff
//   a.start < b.end && b.start < a.end (touching endpoints do NOT overlap).
//
// Output: for each event, { columnIndex, columnCount } where:
//   - columnCount is the number of columns the event's cluster needed,
//   - columnIndex is the event's assigned column (0-based).
// width fraction  = 1 / columnCount
// left   fraction = columnIndex / columnCount
//
// Guarantees:
//   - Events that never contend take a full-width (columnCount = 1) slot,
//     even if other clusters exist earlier the same day.
//   - N events sharing an identical range render as N equal-width blocks.

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

// Group events into maximal sets of transitively overlapping events.
function buildClusters(events) {
  const sorted = [...events].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return a.end - b.end;
  });

  const clusters = [];
  let current = [];
  let clusterEnd = -Infinity;

  for (const ev of sorted) {
    if (current.length > 0 && ev.start < clusterEnd) {
      // Still overlapping the running cluster span.
      current.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.end);
    } else {
      if (current.length > 0) clusters.push(current);
      current = [ev];
      clusterEnd = ev.end;
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

// Greedy column assignment within a cluster.
function layoutCluster(cluster) {
  // cluster is already sorted by start (then end) from buildClusters.
  const columns = []; // columns[i] = end time of last event placed in column i
  const assignment = new Map(); // event -> columnIndex

  for (const ev of cluster) {
    let placed = false;
    for (let i = 0; i < columns.length; i++) {
      if (ev.start >= columns[i]) {
        columns[i] = ev.end;
        assignment.set(ev, i);
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns.push(ev.end);
      assignment.set(ev, columns.length - 1);
    }
  }

  const columnCount = columns.length;
  const result = new Map();
  for (const ev of cluster) {
    result.set(ev, { columnIndex: assignment.get(ev), columnCount });
  }
  return result;
}

// Returns a Map from event -> { columnIndex, columnCount }.
export function computeLayout(events) {
  const layout = new Map();
  for (const cluster of buildClusters(events)) {
    const clusterLayout = layoutCluster(cluster);
    for (const [ev, info] of clusterLayout) {
      layout.set(ev, info);
    }
  }
  return layout;
}
