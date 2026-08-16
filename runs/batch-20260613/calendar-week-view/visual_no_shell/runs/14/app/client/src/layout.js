// Pure overlap-layout engine.
//
// Input: an array of events for a SINGLE day, each with numeric
//   `startMin` and `endMin` (minutes from midnight, clamped to [0, 1440]).
// Output: the same events annotated with `col` (column index),
//   `cols` (number of columns in its cluster). Width fraction = 1/cols,
//   left fraction = col/cols.
//
// Algorithm (cluster-based greedy column assignment):
//   1. Sort events by start time (then end, then id) for determinism.
//   2. Sweep through events. Maintain the set of "active" columns, each
//      holding the end time of the event currently occupying it.
//      A cluster is a maximal run of transitively-overlapping events.
//   3. Within a cluster, assign each event to the first column whose
//      current event has already ended (free column); otherwise open a
//      new column.
//   4. When no active columns remain (a gap), close the cluster: every
//      event in it gets `cols = clusterColumnCount`.

export function layoutDay(events) {
  const sorted = events
    .map((e) => ({ ...e }))
    .sort((a, b) => {
      if (a.startMin !== b.startMin) return a.startMin - b.startMin;
      if (a.endMin !== b.endMin) return a.endMin - b.endMin;
      return (a.id ?? 0) - (b.id ?? 0);
    });

  let cluster = []; // events in the current cluster
  let columns = []; // columns[i] = endMin of the event currently in column i
  let clusterMaxEnd = -Infinity;

  const flush = () => {
    const cols = columns.length;
    for (const ev of cluster) {
      ev.cols = cols;
    }
    cluster = [];
    columns = [];
    clusterMaxEnd = -Infinity;
  };

  for (const ev of sorted) {
    // If this event starts at or after the furthest end so far, the
    // current cluster has fully ended -> start a new cluster.
    if (cluster.length > 0 && ev.startMin >= clusterMaxEnd) {
      flush();
    }

    // Find first free column (an event that has ended by ev.startMin).
    let placed = false;
    for (let i = 0; i < columns.length; i++) {
      if (columns[i] <= ev.startMin) {
        columns[i] = ev.endMin;
        ev.col = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      ev.col = columns.length;
      columns.push(ev.endMin);
    }

    cluster.push(ev);
    clusterMaxEnd = Math.max(clusterMaxEnd, ev.endMin);
  }

  if (cluster.length > 0) flush();

  return sorted;
}
