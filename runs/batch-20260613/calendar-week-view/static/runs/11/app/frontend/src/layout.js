// ---------------------------------------------------------------------------
// Overlap layout engine
//
// This module is pure (no DOM, no dates beyond simple math). Given a list of
// events that belong to a single day, expressed as minute offsets from the top
// of the day (startMin, endMin), it computes for each event a fractional
// horizontal placement:
//
//   { id, startMin, endMin, left, width }
//
// where `left` and `width` are fractions in [0, 1] of the day-column width.
//
// Algorithm (cluster-based):
//   1. Sort events by start time (then end time).
//   2. Group events into "clusters": maximal sets of transitively overlapping
//      events. A new cluster begins when an event starts at or after the
//      maximum end time seen so far in the current cluster.
//   3. Within a cluster, assign each event the lowest-indexed column whose last
//      event has already ended (greedy by start time). The number of columns a
//      cluster needs is its width divisor.
//   4. Each event's width = 1 / columnsInCluster, left = columnIndex / columns.
//
// This guarantees:
//   * No two blocks overlap (events in the same column never overlap in time;
//     events in different columns are visually separated).
//   * A cluster needing K columns divides the width into K equal parts.
//   * An event overlapping nothing forms a 1-column cluster -> full width,
//     regardless of other clusters earlier/later the same day.
// ---------------------------------------------------------------------------

/**
 * Two intervals overlap iff a.start < b.end AND b.start < a.end.
 * Touching endpoints (a.end === b.start) do NOT overlap.
 */
function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

/**
 * Compute layout for a single day's events.
 * @param {Array<{id:any,startMin:number,endMin:number}>} events
 * @returns {Array<{id:any,startMin:number,endMin:number,left:number,width:number,column:number,columns:number}>}
 */
export function layoutDay(events) {
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
    layoutCluster(cluster, result);
    cluster = [];
    clusterMaxEnd = -Infinity;
  };

  for (const ev of sorted) {
    // If this event starts at/after the running cluster end, the previous
    // cluster is complete (no transitive overlap can reach further).
    if (cluster.length > 0 && ev.startMin >= clusterMaxEnd) {
      flush();
    }
    cluster.push(ev);
    clusterMaxEnd = Math.max(clusterMaxEnd, ev.endMin);
  }
  flush();

  return result;
}

/**
 * Assign columns greedily within one cluster and push results.
 */
function layoutCluster(cluster, result) {
  // columns[i] holds the endMin of the last event placed in column i.
  const columnEnds = [];
  const assigned = [];

  for (const ev of cluster) {
    let placed = false;
    for (let i = 0; i < columnEnds.length; i++) {
      // The event can reuse a column if it does not overlap that column's
      // current last event (i.e. it starts at/after that event's end).
      if (ev.startMin >= columnEnds[i]) {
        columnEnds[i] = ev.endMin;
        assigned.push({ ev, column: i });
        placed = true;
        break;
      }
    }
    if (!placed) {
      columnEnds.push(ev.endMin);
      assigned.push({ ev, column: columnEnds.length - 1 });
    }
  }

  const columns = columnEnds.length;
  for (const { ev, column } of assigned) {
    result.push({
      id: ev.id,
      startMin: ev.startMin,
      endMin: ev.endMin,
      column,
      columns,
      left: column / columns,
      width: 1 / columns,
    });
  }
}
