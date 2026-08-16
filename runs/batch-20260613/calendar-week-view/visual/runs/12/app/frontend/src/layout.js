// Cluster-based overlap layout engine.
//
// Input: a list of events for a single day, each with numeric `startMin` and
// `endMin` (minutes from midnight, already clamped to [0, 1440]).
//
// Output: the same events annotated with { col, cols } where `col` is the
// assigned column index within its cluster and `cols` is the total number of
// columns the cluster required. From these, horizontal width/offset are
// derived as fractions of the day column width:
//   width   = 1 / cols
//   leftPct = col / cols
//
// Algorithm:
//   1. Sort events by start time (then end time, then id) for determinism.
//   2. Walk events in order building maximal clusters of transitively
//      overlapping events. A cluster ends when an event starts at or after the
//      maximum end time seen so far in the cluster (no overlap with anything
//      in the cluster).
//   3. Within a cluster, greedily assign each event to the first column whose
//      last event has already ended (end <= this event's start). Track the
//      number of columns used; that count is the cluster width divisor.

export function computeLayout(events) {
  const sorted = [...events].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    if (a.endMin !== b.endMin) return a.endMin - b.endMin;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  const result = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    layoutCluster(cluster, result);
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const ev of sorted) {
    if (cluster.length > 0 && ev.startMin >= clusterEnd) {
      // No overlap with current cluster -> finalize it.
      flush();
    }
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.endMin);
  }
  flush();

  return result;
}

function layoutCluster(cluster, result) {
  // columns[i] holds the end time of the last event placed in column i.
  const columnEnds = [];
  const assignments = new Map();

  for (const ev of cluster) {
    let placed = false;
    for (let i = 0; i < columnEnds.length; i++) {
      if (ev.startMin >= columnEnds[i]) {
        columnEnds[i] = ev.endMin;
        assignments.set(ev, i);
        placed = true;
        break;
      }
    }
    if (!placed) {
      columnEnds.push(ev.endMin);
      assignments.set(ev, columnEnds.length - 1);
    }
  }

  const cols = columnEnds.length;
  for (const ev of cluster) {
    result.push({ ...ev, col: assignments.get(ev), cols });
  }
}
