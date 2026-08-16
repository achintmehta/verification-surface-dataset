// Cluster-based overlap layout engine.
//
// Given a set of events (each with numeric `start` and `end` minutes-from-day-start),
// compute, for each event, a horizontal layout: `columnIndex`, `columnCount`.
// Width fraction = 1 / columnCount, left fraction = columnIndex / columnCount.
//
// The algorithm:
//  1. Sort events by start time (then end time).
//  2. Walk events building "clusters": a cluster is a maximal run of events that
//     transitively overlap. A new cluster starts when the current event's start is
//     >= the maximum end time seen so far in the cluster (no overlap with anything
//     in the running cluster).
//  3. Within a cluster, greedily assign each event the first column whose last
//     event has already ended (end <= this event's start). Track the number of
//     columns used by the cluster.
//  4. Every event in a cluster gets columnCount = number of columns used by that
//     cluster, so non-overlapping events in a sparse cluster still divide width.
//     (A truly non-overlapping event forms its own single-column cluster and gets
//     full width.)
//
// Returns a new array of objects: { ...event, columnIndex, columnCount }.

export function layoutEvents(events) {
  const sorted = events
    .map((e) => ({ ...e }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const result = [];
  let cluster = [];
  let clusterMaxEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    assignColumns(cluster);
    for (const ev of cluster) result.push(ev);
    cluster = [];
    clusterMaxEnd = -Infinity;
  };

  for (const ev of sorted) {
    if (cluster.length > 0 && ev.start >= clusterMaxEnd) {
      // No overlap with the running cluster -> finalize it and start fresh.
      flush();
    }
    cluster.push(ev);
    clusterMaxEnd = Math.max(clusterMaxEnd, ev.end);
  }
  flush();

  return result;
}

// Assign each event in a cluster the first free column (greedy by start time).
function assignColumns(cluster) {
  // columns[i] = end time of the last event placed in column i.
  const columns = [];
  for (const ev of cluster) {
    let placed = false;
    for (let i = 0; i < columns.length; i++) {
      if (ev.start >= columns[i]) {
        columns[i] = ev.end;
        ev.columnIndex = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      ev.columnIndex = columns.length;
      columns.push(ev.end);
    }
  }
  const columnCount = columns.length;
  for (const ev of cluster) {
    ev.columnCount = columnCount;
  }
}
