// Cluster-based overlap layout engine.
//
// Given a list of events for a single day (each with numeric `start` and `end`
// minutes-from-midnight, clamped to [0, 1440]), compute for each event a
// fractional horizontal position:
//   - colIndex:   the assigned column within its cluster (0-based)
//   - colCount:   the number of columns its cluster requires
// width fraction = 1 / colCount, left fraction = colIndex / colCount.
//
// Algorithm:
//   1. Sort events by start, then by end, then by id for determinism.
//   2. Group into maximal clusters of transitively overlapping events.
//      A cluster ends when we encounter an event whose start is >= the maximum
//      end seen so far in the cluster (no overlap with anything in it).
//   3. Within a cluster, greedily assign each event to the first column whose
//      last event has already ended (end <= this event's start). The number of
//      columns used by the cluster is its colCount; all events in the cluster
//      share that colCount so they tile the full width without gaps.

export function overlaps(a, b) {
  // Strict overlap: zero-length adjacency (a.end === b.start) does NOT overlap.
  return a.start < b.end && b.start < a.end;
}

export function layoutDay(events) {
  const items = events
    .map((e) => ({ ...e }))
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.id - b.id));

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

  for (const ev of items) {
    if (cluster.length > 0 && ev.start >= clusterMaxEnd) {
      // No overlap with anything in the current cluster -> close it.
      flush();
    }
    cluster.push(ev);
    clusterMaxEnd = Math.max(clusterMaxEnd, ev.end);
  }
  flush();

  return result;
}

function assignColumns(cluster) {
  // columns[i] holds the end time of the last event placed in column i.
  const columnEnds = [];
  for (const ev of cluster) {
    let placed = false;
    for (let i = 0; i < columnEnds.length; i++) {
      if (ev.start >= columnEnds[i]) {
        ev.colIndex = i;
        columnEnds[i] = ev.end;
        placed = true;
        break;
      }
    }
    if (!placed) {
      ev.colIndex = columnEnds.length;
      columnEnds.push(ev.end);
    }
  }
  const colCount = columnEnds.length;
  for (const ev of cluster) {
    ev.colCount = colCount;
  }
}
