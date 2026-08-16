// Pure overlap-layout engine.
//
// Given a set of events that fall on a single day (already clamped to the
// day's [dayStart, dayEnd) window via minute offsets), produce, for each
// event, a horizontal slot: { colIndex, colCount }. Combined with the
// vertical geometry computed from start/end minutes this yields a layout
// where no two blocks overlap and width is reclaimed once a cluster ends.
//
// The algorithm (Decision 1):
//   1. Group events into maximal clusters of transitively-overlapping events.
//   2. Within a cluster, sort by start time, assign each event to the first
//      column whose last event has already ended (greedy column packing).
//   3. The cluster's column count = max columns used by any event. Each event
//      in the cluster gets width = 1 / colCount and offset = colIndex / colCount.
//
// Two events overlap iff a.start < b.end AND b.start < a.end. Events that
// merely touch (a.end === b.start) do NOT overlap.

export function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

// Compute layout slots for events on a single day.
// Each input event must carry { startMin, endMin } (minutes from day start,
// already clamped to [0, dayMinutes]). Returns a Map from event reference to
// { colIndex, colCount }.
export function computeDayLayout(events) {
  const slots = new Map();
  if (events.length === 0) return slots;

  // Stable ordering: by start, then by end, then by id for determinism.
  const sorted = [...events].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    if (a.endMin !== b.endMin) return a.endMin - b.endMin;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  // --- Build clusters of transitively-overlapping events. ---
  // Walk in start order; a cluster continues as long as the next event starts
  // before the cluster's running maximum end. Otherwise a new cluster begins.
  let cluster = [];
  let clusterMaxEnd = -Infinity;

  const flush = () => {
    if (cluster.length > 0) layoutCluster(cluster, slots);
    cluster = [];
    clusterMaxEnd = -Infinity;
  };

  for (const ev of sorted) {
    if (cluster.length === 0 || ev.startMin < clusterMaxEnd) {
      cluster.push(ev);
      clusterMaxEnd = Math.max(clusterMaxEnd, ev.endMin);
    } else {
      flush();
      cluster.push(ev);
      clusterMaxEnd = ev.endMin;
    }
  }
  flush();

  return slots;
}

// Greedily assign columns within a single cluster, then fix column count to
// the maximum number of simultaneously-active columns.
function layoutCluster(cluster, slots) {
  // columns[i] holds the endMin of the last event placed in column i.
  const columnEnds = [];
  const assigned = []; // parallel: { ev, colIndex }

  for (const ev of cluster) {
    let placed = false;
    for (let i = 0; i < columnEnds.length; i++) {
      // Column free if its last event ends at or before this one starts.
      if (columnEnds[i] <= ev.startMin) {
        columnEnds[i] = ev.endMin;
        assigned.push({ ev, colIndex: i });
        placed = true;
        break;
      }
    }
    if (!placed) {
      columnEnds.push(ev.endMin);
      assigned.push({ ev, colIndex: columnEnds.length - 1 });
    }
  }

  const colCount = columnEnds.length;
  for (const { ev, colIndex } of assigned) {
    slots.set(ev, { colIndex, colCount });
  }
}
