// Overlap layout engine.
//
// All functions here are pure: they operate on plain data and return plain
// data so the geometry can be reasoned about and tested independently of the
// DOM.

export const MINUTES_PER_DAY = 24 * 60;

/**
 * Map a Date to minutes-from-midnight (local time), clamped to a given day.
 * For an event spanning a particular day, we clamp its start to >= 0 (the day
 * start) and its end to <= MINUTES_PER_DAY (the day end).
 *
 * @param {Date} date
 * @param {Date} dayStart - midnight (local) of the day in question
 * @returns {number} minutes from the dayStart midnight (may be negative or > 1440)
 */
export function minutesFromDayStart(date, dayStart) {
  return (date.getTime() - dayStart.getTime()) / 60000;
}

/**
 * Given an event and a particular day (midnight local), compute the
 * [topMinutes, bottomMinutes] segment of that event clamped to the day's
 * 0..1440 range. Returns null if the event does not intersect the day at all.
 *
 * @param {{start: Date, end: Date}} event
 * @param {Date} dayStart
 */
export function clampEventToDay(event, dayStart) {
  const startMin = minutesFromDayStart(event.start, dayStart);
  const endMin = minutesFromDayStart(event.end, dayStart);
  const top = Math.max(0, startMin);
  const bottom = Math.min(MINUTES_PER_DAY, endMin);
  if (bottom <= top) return null; // does not visibly occupy this day
  return { top, bottom };
}

/**
 * Compute the column layout for a set of segments within a single day.
 *
 * Each input item must have `{ top, bottom }` in minutes. The algorithm:
 *   1. Group segments into clusters of transitively overlapping segments.
 *   2. Within each cluster, assign each segment (ordered by start) the lowest
 *      column index not occupied by a still-active earlier segment.
 *   3. The cluster's column count is the max column index + 1.
 *
 * Returns an array (parallel to input) of `{ colIndex, colCount }` where
 * width = 1/colCount and left offset = colIndex/colCount of the day column.
 *
 * Two segments "overlap" iff a.top < b.bottom && b.top < a.bottom (touching
 * edges do not overlap).
 *
 * @param {Array<{top:number, bottom:number}>} segments
 * @returns {Array<{colIndex:number, colCount:number}>}
 */
export function computeColumns(segments) {
  const n = segments.length;
  const result = new Array(n);

  // Preserve original indices but order by start time (then end, then index)
  // for greedy column assignment.
  const order = segments
    .map((seg, i) => ({ ...seg, i }))
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom || a.i - b.i);

  let clusterMembers = []; // indices (into `order`) of current cluster
  let clusterEnd = -Infinity; // max bottom seen in the current cluster

  const flushCluster = () => {
    if (clusterMembers.length === 0) return;
    // Greedy column assignment within the cluster.
    const columns = []; // columns[c] = bottom of last event placed in column c
    const assigned = {}; // order-index -> colIndex
    for (const idx of clusterMembers) {
      const seg = order[idx];
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= seg.top) {
          columns[c] = seg.bottom;
          assigned[idx] = c;
          placed = true;
          break;
        }
      }
      if (!placed) {
        columns.push(seg.bottom);
        assigned[idx] = columns.length - 1;
      }
    }
    const colCount = columns.length;
    for (const idx of clusterMembers) {
      result[order[idx].i] = { colIndex: assigned[idx], colCount };
    }
    clusterMembers = [];
    clusterEnd = -Infinity;
  };

  for (let k = 0; k < order.length; k++) {
    const seg = order[k];
    // A new cluster begins when this segment starts at or after the running
    // cluster end (no overlap with anything currently in the cluster).
    if (clusterMembers.length > 0 && seg.top >= clusterEnd) {
      flushCluster();
    }
    clusterMembers.push(k);
    clusterEnd = Math.max(clusterEnd, seg.bottom);
  }
  flushCluster();

  return result;
}

/**
 * High-level helper: given events that intersect a given day, produce
 * positioned blocks with fractional geometry.
 *
 * @param {Array<{id:any, title:string, start:Date, end:Date}>} events
 * @param {Date} dayStart - midnight local of the day
 * @returns {Array<{event, topFrac, heightFrac, leftFrac, widthFrac}>}
 */
export function layoutDay(events, dayStart) {
  const segments = [];
  const kept = [];
  for (const ev of events) {
    const seg = clampEventToDay(ev, dayStart);
    if (seg) {
      segments.push(seg);
      kept.push(ev);
    }
  }
  const cols = computeColumns(segments);
  return kept.map((ev, i) => {
    const seg = segments[i];
    const { colIndex, colCount } = cols[i];
    return {
      event: ev,
      topFrac: seg.top / MINUTES_PER_DAY,
      heightFrac: (seg.bottom - seg.top) / MINUTES_PER_DAY,
      leftFrac: colIndex / colCount,
      widthFrac: 1 / colCount,
    };
  });
}
