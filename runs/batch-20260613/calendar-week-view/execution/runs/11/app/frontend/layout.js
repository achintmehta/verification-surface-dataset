// Cluster-based overlap layout engine.
//
// Pure functions operating on numeric intervals so they can be unit-tested
// independently from the DOM. Times are expressed in minutes-from-midnight
// (or any consistent numeric unit) for layout purposes.

/**
 * Group events into clusters of transitively overlapping events.
 * Events must already be sorted by start ascending. Returns an array of
 * clusters, each cluster being an array of the original event objects.
 *
 * Two intervals overlap iff a.start < b.end && b.start < a.end.
 * A cluster is the maximal set such that the running maximum end time of the
 * cluster is greater than the next event's start.
 *
 * @param {Array<{start:number,end:number}>} events
 * @returns {Array<Array>}
 */
export function clusterEvents(events) {
  const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end);
  const clusters = [];
  let current = [];
  let clusterEnd = -Infinity;

  for (const ev of sorted) {
    if (current.length === 0 || ev.start < clusterEnd) {
      // overlaps the existing cluster (shares time with at least one member)
      current.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.end);
    } else {
      clusters.push(current);
      current = [ev];
      clusterEnd = ev.end;
    }
  }
  if (current.length) clusters.push(current);
  return clusters;
}

/**
 * Within a single cluster, greedily assign each event (ordered by start) to
 * the lowest-indexed column whose last event has already ended. Returns the
 * number of columns used and annotates each event with its column index.
 *
 * @param {Array<{start:number,end:number}>} cluster
 * @returns {{columnCount:number, placements:Array<{event:object,column:number}>}}
 */
export function assignColumns(cluster) {
  const sorted = [...cluster].sort((a, b) => a.start - b.start || a.end - b.end);
  const columnEnds = []; // columnEnds[i] = end time of last event in column i
  const placements = [];

  for (const ev of sorted) {
    let col = -1;
    for (let i = 0; i < columnEnds.length; i++) {
      if (ev.start >= columnEnds[i]) {
        col = i;
        break;
      }
    }
    if (col === -1) {
      col = columnEnds.length;
      columnEnds.push(ev.end);
    } else {
      columnEnds[col] = ev.end;
    }
    placements.push({ event: ev, column: col });
  }

  return { columnCount: columnEnds.length, placements };
}

/**
 * Compute the horizontal layout (fractional left + width, in [0,1]) for a set
 * of events within one day column. Returns a Map keyed by the event object.
 *
 * Each event's width is 1 / columnCount of its cluster, and its left offset is
 * column / columnCount. An event in a 1-column cluster fills the full width.
 *
 * @param {Array<{start:number,end:number}>} events
 * @returns {Map<object,{left:number,width:number,column:number,columns:number}>}
 */
export function layoutDay(events) {
  const result = new Map();
  const clusters = clusterEvents(events);

  for (const cluster of clusters) {
    const { columnCount, placements } = assignColumns(cluster);
    for (const { event, column } of placements) {
      result.set(event, {
        left: column / columnCount,
        width: 1 / columnCount,
        column,
        columns: columnCount
      });
    }
  }

  return result;
}
