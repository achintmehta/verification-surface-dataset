// Pure, testable overlap-layout engine.
//
// Input: a list of events that all belong to a single day, each with numeric
// `startMin` and `endMin` (minutes from midnight, clamped to [0, 1440]).
//
// Output: the same events, each annotated with fractional horizontal geometry:
//   - left:  0..1  (fraction of the day column width)
//   - width: 0..1  (fraction of the day column width)
//
// Algorithm (cluster-based):
//   1. Sort events by start time (then end, then id) for determinism.
//   2. Group into clusters: a maximal run of events that transitively overlap.
//      A new cluster starts when an event's start is >= the max end seen so far.
//   3. Within a cluster, assign each event to the lowest-indexed column whose
//      last event has already ended (greedy). The number of columns the cluster
//      used is its width divisor.
//   4. Each event's width = 1 / (columns used by its cluster); left = colIndex * width.
//
// This guarantees zero visual overlap, equal widths for identically-timed
// events, and full width when there is no contention.

export function layoutDayEvents(events) {
  if (events.length === 0) return [];

  const sorted = [...events].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    if (a.endMin !== b.endMin) return a.endMin - b.endMin;
    return String(a.id).localeCompare(String(b.id));
  });

  const result = [];

  let cluster = [];
  let clusterMaxEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    assignColumns(cluster, result);
    cluster = [];
    clusterMaxEnd = -Infinity;
  };

  for (const ev of sorted) {
    if (cluster.length > 0 && ev.startMin >= clusterMaxEnd) {
      // No overlap with anything currently in the cluster -> new cluster.
      flush();
    }
    cluster.push(ev);
    clusterMaxEnd = Math.max(clusterMaxEnd, ev.endMin);
  }
  flush();

  return result;
}

function assignColumns(cluster, result) {
  // columns[i] holds the endMin of the last event placed in column i.
  const columnEnds = [];

  for (const ev of cluster) {
    let placed = -1;
    for (let i = 0; i < columnEnds.length; i++) {
      if (ev.startMin >= columnEnds[i]) {
        columnEnds[i] = ev.endMin;
        placed = i;
        break;
      }
    }
    if (placed === -1) {
      columnEnds.push(ev.endMin);
      placed = columnEnds.length - 1;
    }
    ev.__col = placed;
  }

  const ncols = columnEnds.length;
  const width = 1 / ncols;

  for (const ev of cluster) {
    result.push({
      ...ev,
      left: ev.__col * width,
      width,
    });
  }
}
