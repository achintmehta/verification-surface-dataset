// layout.js — pure functions for the overlap layout engine.
//
// The engine is intentionally free of DOM/time-zone concerns: it works on
// numeric [start, end) intervals (minutes from midnight) and returns, for each
// event, a horizontal column index and the number of columns in its cluster.
// The renderer turns those into pixel geometry.

/**
 * Given an array of events for a single day, where each event has numeric
 * `start` and `end` (minutes-from-midnight, already clamped to [0, 1440]),
 * compute layout metadata:
 *   { ...event, _col, _cols }
 * where _col is the assigned column index (0-based) and _cols is the total
 * number of columns its overlap-cluster required.
 *
 * Algorithm (Decision 1):
 *   1. Sort events by start time (then end time, then id) for determinism.
 *   2. Walk events accumulating a "cluster" of transitively overlapping events.
 *      A new event belongs to the current cluster iff it starts before the
 *      maximum end time seen so far in the cluster.
 *   3. Within a cluster, assign each event to the lowest-indexed column whose
 *      last event has already ended (greedy by start time).
 *   4. All events in a cluster share the same _cols = max columns used.
 */
export function layoutDayEvents(events) {
  const sorted = [...events].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  const result = [];
  let cluster = [];
  let clusterMaxEnd = -Infinity;
  // columns[i] holds the end time of the last event placed in column i.
  let columns = [];

  const flush = () => {
    const cols = columns.length;
    for (const e of cluster) {
      e._cols = cols;
      result.push(e);
    }
    cluster = [];
    columns = [];
    clusterMaxEnd = -Infinity;
  };

  for (const ev of sorted) {
    // If this event does not overlap the current cluster, the cluster is done.
    if (cluster.length > 0 && ev.start >= clusterMaxEnd) {
      flush();
    }

    // Find the first column whose last event ends at/before this event's start.
    let placed = false;
    for (let i = 0; i < columns.length; i++) {
      if (columns[i] <= ev.start) {
        columns[i] = ev.end;
        ev._col = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      ev._col = columns.length;
      columns.push(ev.end);
    }

    cluster.push(ev);
    clusterMaxEnd = Math.max(clusterMaxEnd, ev.end);
  }

  if (cluster.length > 0) flush();

  return result;
}
