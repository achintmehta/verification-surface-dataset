// Pure overlap-layout engine.
//
// Given a list of events that fall within a single day, compute for each one a
// fractional horizontal layout: { left, width } as fractions of the day-column
// width (0..1), plus the assigned column index and cluster column count.
//
// Algorithm (cluster-based greedy column assignment):
//   1. Sort events by start time (then end time).
//   2. Walk events; a "cluster" is a maximal set of transitively overlapping
//      events. We accumulate events into the current cluster as long as a new
//      event starts before the cluster's maximum end time.
//   3. Within a cluster, assign each event greedily to the first column whose
//      last event has already ended (no overlap). The number of columns the
//      cluster needs is its width divisor.
//   4. width = 1 / columnsUsed, left = columnIndex / columnsUsed.
//
// Two events overlap iff a.start < b.end && b.start < a.end (touching
// endpoints do NOT overlap).

function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

// items: [{ id, startMin, endMin, ... }]
// returns map id -> { left, width, col, cols }
export function computeLayout(items) {
  const events = items
    .slice()
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const layout = new Map();

  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    assignCluster(cluster, layout);
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const ev of events) {
    if (cluster.length > 0 && ev.startMin >= clusterEnd) {
      // No overlap with anything in the current cluster -> close it.
      flush();
    }
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.endMin);
  }
  flush();

  return layout;
}

function assignCluster(cluster, layout) {
  // columns[i] = endMin of the last event placed in column i
  const columnEnds = [];
  const colOf = new Map();

  for (const ev of cluster) {
    let placed = false;
    for (let i = 0; i < columnEnds.length; i++) {
      if (ev.startMin >= columnEnds[i]) {
        columnEnds[i] = ev.endMin;
        colOf.set(ev.id, i);
        placed = true;
        break;
      }
    }
    if (!placed) {
      columnEnds.push(ev.endMin);
      colOf.set(ev.id, columnEnds.length - 1);
    }
  }

  const cols = columnEnds.length;
  for (const ev of cluster) {
    const col = colOf.get(ev.id);
    layout.set(ev.id, {
      col,
      cols,
      left: col / cols,
      width: 1 / cols
    });
  }
}

export { overlaps };
