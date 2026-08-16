// Cluster-based overlap layout engine.
//
// Input: a list of events for a single day, each with numeric `startMin` and
// `endMin` (minutes from midnight, clamped to [0, 1440]).
//
// Output: the same events annotated with horizontal layout fractions:
//   - colIndex:    assigned column within its cluster
//   - colCount:    number of columns the cluster needed
//   - left:        fractional left offset in [0, 1)  (colIndex / colCount)
//   - width:       fractional width in (0, 1]        (1 / colCount)
//
// Two events overlap iff a.startMin < b.endMin && b.startMin < a.endMin.
// A cluster is a maximal set of transitively overlapping events. Within a
// cluster, events are placed greedily by start time into the first column whose
// last event has already ended; the cluster width is split equally among the
// number of columns the cluster ended up needing.

export function layoutDayEvents(events) {
  // Sort by start, then by end, then id for determinism.
  const sorted = [...events].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    if (a.endMin !== b.endMin) return a.endMin - b.endMin;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  const result = [];
  let cluster = []; // events in the current cluster
  let columns = []; // columns[i] = endMin of the last event placed in column i
  let clusterMaxEnd = -Infinity;

  const flushCluster = () => {
    const colCount = columns.length || 1;
    for (const e of cluster) {
      e.colCount = colCount;
      e.left = e.colIndex / colCount;
      e.width = 1 / colCount;
      result.push(e);
    }
    cluster = [];
    columns = [];
    clusterMaxEnd = -Infinity;
  };

  for (const ev of sorted) {
    const e = { ...ev };
    // If this event starts at or after every running event has ended, the
    // current cluster is closed.
    if (cluster.length > 0 && e.startMin >= clusterMaxEnd) {
      flushCluster();
    }

    // Greedily find the first column whose last event ends at or before this
    // event's start (i.e. is free).
    let placed = false;
    for (let i = 0; i < columns.length; i++) {
      if (columns[i] <= e.startMin) {
        columns[i] = e.endMin;
        e.colIndex = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      e.colIndex = columns.length;
      columns.push(e.endMin);
    }

    cluster.push(e);
    clusterMaxEnd = Math.max(clusterMaxEnd, e.endMin);
  }

  if (cluster.length > 0) flushCluster();

  return result;
}
