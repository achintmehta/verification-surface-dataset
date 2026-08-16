// Pure geometry + cluster overlap layout engine.
//
// Everything here is a pure function of input data so the geometry is exact
// and testable independent of the DOM.

export const MINUTES_PER_DAY = 24 * 60;

/**
 * Map a Date to minutes-from-midnight within a specific day, clamped to
 * the [0, 1440] visible range for that day.
 *
 * @param {Date} when - the instant
 * @param {Date} dayStart - midnight (local) of the day column
 * @returns {number} minutes from midnight, clamped to [0, 1440]
 */
export function minutesFromDayStart(when, dayStart) {
  const diffMs = when.getTime() - dayStart.getTime();
  const minutes = diffMs / 60000;
  if (minutes < 0) return 0;
  if (minutes > MINUTES_PER_DAY) return MINUTES_PER_DAY;
  return minutes;
}

/**
 * Compute the vertical placement of an event within a day column, as
 * fractions of the axis height (0..1). Clamps to the day's bounds so an
 * event ending at/after 24:00 ends exactly at the bottom edge and an event
 * starting before 00:00 starts at the top.
 *
 * @param {{start: Date, end: Date}} event
 * @param {Date} dayStart - midnight of the day column
 * @returns {{topFrac: number, heightFrac: number}}
 */
export function verticalPlacement(event, dayStart) {
  const startMin = minutesFromDayStart(event.start, dayStart);
  const endMin = minutesFromDayStart(event.end, dayStart);
  const topFrac = startMin / MINUTES_PER_DAY;
  const heightFrac = (endMin - startMin) / MINUTES_PER_DAY;
  return { topFrac, heightFrac };
}

/**
 * Determine whether two [start, end) intervals overlap.
 * Touching endpoints (a.end === b.start) do NOT overlap.
 */
function intervalsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Group events into maximal clusters of transitively overlapping events.
 * Events are compared by their effective [start, end) within the given day,
 * using the numeric minute bounds so clamping is consistent with rendering.
 *
 * Returns an array of clusters; each cluster is an array of the original
 * event objects (augmented with numeric s/e minute bounds).
 *
 * @param {Array<{start:Date,end:Date}>} events
 * @param {Date} dayStart
 */
export function buildClusters(events, dayStart) {
  // Annotate with numeric bounds and sort by start, then end.
  const annotated = events
    .map((ev) => ({
      ev,
      start: minutesFromDayStart(ev.start, dayStart),
      end: minutesFromDayStart(ev.end, dayStart),
    }))
    // Drop zero-height events (start === end after clamping); they cannot render.
    .filter((a) => a.end > a.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const clusters = [];
  let current = [];
  let clusterEnd = -Infinity;

  for (const item of annotated) {
    if (current.length === 0) {
      current.push(item);
      clusterEnd = item.end;
      continue;
    }
    // If this event starts before the running max-end of the cluster, it
    // overlaps the cluster (transitively) and joins it.
    if (item.start < clusterEnd) {
      current.push(item);
      clusterEnd = Math.max(clusterEnd, item.end);
    } else {
      clusters.push(current);
      current = [item];
      clusterEnd = item.end;
    }
  }
  if (current.length > 0) clusters.push(current);

  return clusters;
}

/**
 * Assign columns greedily within a cluster (sorted by start time). Each event
 * takes the first column whose last event has already ended.
 *
 * @param {Array<{start:number,end:number,ev:object}>} cluster
 * @returns {{ assignments: Array<{item:object, col:number}>, columnCount: number }}
 */
export function assignColumns(cluster) {
  // cluster is already sorted by start (then end) from buildClusters.
  const columnEnds = []; // columnEnds[i] = end minute of the last event in column i
  const assignments = [];

  for (const item of cluster) {
    let placed = false;
    for (let col = 0; col < columnEnds.length; col++) {
      // Free if the column's last event ends at or before this event's start.
      if (columnEnds[col] <= item.start) {
        columnEnds[col] = item.end;
        assignments.push({ item, col });
        placed = true;
        break;
      }
    }
    if (!placed) {
      columnEnds.push(item.end);
      assignments.push({ item, col: columnEnds.length - 1 });
    }
  }

  return { assignments, columnCount: columnEnds.length };
}

/**
 * Full layout for one day's events. Produces an array of placed blocks with
 * fractional horizontal (left/width) and vertical (top/height) geometry, all
 * in 0..1 of the day column.
 *
 * Non-overlapping events (singleton clusters) get the full width. Events in a
 * contended cluster split the width equally by the number of columns that
 * cluster required.
 *
 * @param {Array<{id:any,title:string,start:Date,end:Date}>} events
 * @param {Date} dayStart
 * @returns {Array<{event:object, topFrac:number, heightFrac:number, leftFrac:number, widthFrac:number}>}
 */
export function layoutDay(events, dayStart) {
  const clusters = buildClusters(events, dayStart);
  const placed = [];

  for (const cluster of clusters) {
    const { assignments, columnCount } = assignColumns(cluster);
    const widthFrac = 1 / columnCount;

    for (const { item, col } of assignments) {
      const topFrac = item.start / MINUTES_PER_DAY;
      const heightFrac = (item.end - item.start) / MINUTES_PER_DAY;
      placed.push({
        event: item.ev,
        topFrac,
        heightFrac,
        leftFrac: col * widthFrac,
        widthFrac,
      });
    }
  }

  return placed;
}
