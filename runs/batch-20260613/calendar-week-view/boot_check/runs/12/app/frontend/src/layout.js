// Cluster-based overlap layout engine.
//
// Given a list of events for a single day (each with numeric `startMin` and
// `endMin` minutes-from-midnight, already clamped to [0, 1440]), assign each a
// horizontal `colIndex` and `colCount` such that:
//   - events that transitively overlap form a cluster
//   - within a cluster events are greedily assigned to the first free column
//   - the cluster's required column count is shared equally
//   - width  = 1 / colCount  (fraction of the day column)
//   - offset = colIndex / colCount
//
// Two events overlap iff a.start < b.end AND a.end > b.start. Events that merely
// touch (a.end === b.start) do NOT overlap and may share a column.

export function layoutDayEvents(events) {
  // Sort by start, then by end, then by id for deterministic packing.
  const sorted = [...events].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    if (a.endMin !== b.endMin) return a.endMin - b.endMin;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  const result = [];
  let cluster = []; // events in the current cluster
  let clusterEnd = -Infinity; // max endMin seen in the current cluster

  const flush = () => {
    if (cluster.length === 0) return;
    assignColumns(cluster, result);
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const ev of sorted) {
    // If this event starts at or after every prior event in the cluster has
    // ended, the cluster is complete and width can be reclaimed.
    if (cluster.length > 0 && ev.startMin >= clusterEnd) {
      flush();
    }
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.endMin);
  }
  flush();

  return result;
}

function assignColumns(cluster, result) {
  // Greedy column assignment by start time.
  // columns[i] holds the endMin of the last event placed in column i.
  const columns = [];
  const placement = new Map(); // ev -> colIndex

  for (const ev of cluster) {
    let placed = -1;
    for (let i = 0; i < columns.length; i++) {
      // Column free if the last event there ends at or before this one starts.
      if (columns[i] <= ev.startMin) {
        columns[i] = ev.endMin;
        placed = i;
        break;
      }
    }
    if (placed === -1) {
      columns.push(ev.endMin);
      placed = columns.length - 1;
    }
    placement.set(ev, placed);
  }

  const colCount = columns.length;
  for (const ev of cluster) {
    result.push({
      ...ev,
      colIndex: placement.get(ev),
      colCount,
    });
  }
}
