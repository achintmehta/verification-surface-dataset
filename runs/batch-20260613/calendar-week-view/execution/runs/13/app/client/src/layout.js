// Cluster-based overlap layout engine.
//
// Given a set of events (each with numeric start/end, e.g. minutes from
// midnight), group them into maximal clusters of transitively overlapping
// events, assign each event a column greedily by start time, and compute the
// number of columns required by the cluster. The fractional width/offset of
// each event is then derived so that:
//   - events that contend for time share the column width equally,
//   - non-overlapping events reclaim the full width,
//   - no two blocks ever overlap.
//
// Returns the same event objects augmented with:
//   columnIndex  - the column the event was placed in (0-based)
//   columnCount  - number of columns in the event's cluster
//   width        - fraction of the day column width [0..1]
//   left         - fractional horizontal offset [0..1]

function overlaps(a, b) {
  // strict overlap; events that merely touch (a.end === b.start) do not overlap
  return a.start < b.end && b.start < a.end;
}

export function computeLayout(events) {
  // Sort by start, then by longer duration first, then id for stability.
  const sorted = events
    .slice()
    .sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      if (a.end !== b.end) return b.end - a.end;
      return (a.id ?? 0) - (b.id ?? 0);
    });

  const result = [];

  // Build clusters: a cluster continues while a new event starts before the
  // current maximum end of any event already in the cluster.
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length) layoutCluster(cluster, result);
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const ev of sorted) {
    if (cluster.length && ev.start >= clusterEnd) {
      // No overlap with the running cluster -> close it.
      flush();
    }
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.end);
  }
  flush();

  return result;
}

function layoutCluster(cluster, result) {
  // Greedy column assignment. Each column tracks the end time of the last
  // event placed in it; an event reuses the earliest-freed column.
  const columns = []; // array of end-times per column

  for (const ev of cluster) {
    let placed = false;
    for (let c = 0; c < columns.length; c++) {
      if (ev.start >= columns[c]) {
        columns[c] = ev.end;
        ev.columnIndex = c;
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

  // For each event, determine how many columns it can expand across to the
  // right before hitting an event it overlaps. This lets a lone event in a
  // cluster of width N still fill remaining width if nothing contends.
  for (const ev of cluster) {
    let span = 1;
    for (let c = ev.columnIndex + 1; c < columnCount; c++) {
      // Does any event in this column overlap ev?
      const blocked = cluster.some(
        (other) => other !== ev && other.columnIndex === c && overlaps(ev, other)
      );
      if (blocked) break;
      span++;
    }
    ev.columnCount = columnCount;
    ev.width = span / columnCount;
    ev.left = ev.columnIndex / columnCount;
    result.push(ev);
  }
}
