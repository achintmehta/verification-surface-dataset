/**
 * Overlap layout engine — cluster-based algorithm.
 *
 * Given a list of events for a single day, returns the same events annotated
 * with layout information:
 *   { ...event, col, totalCols }
 *
 * Algorithm:
 *  1. Sort events by start_at, then by end_at descending (longer events first).
 *  2. Group into clusters: a cluster is a maximal set of transitively
 *     overlapping events. Two events overlap when one starts before the other
 *     ends (strict: start < end of other).
 *  3. Within each cluster, assign column indices greedily: for each event
 *     (in sorted order) assign the lowest column index not occupied by any
 *     event that overlaps it.
 *  4. totalCols for each event = the number of columns the cluster needed.
 */

/**
 * @param {Array<{id, start_at, end_at, title}>} events  — events for ONE day
 * @returns {Array<{id, start_at, end_at, title, col, totalCols}>}
 */
export function computeLayout(events) {
  if (events.length === 0) return [];

  // Work with numeric timestamps for speed
  const evs = events.map(e => ({
    ...e,
    _start: new Date(e.start_at).getTime(),
    _end:   new Date(e.end_at).getTime(),
  }));

  // Sort by start time, then by duration descending (longer events first)
  evs.sort((a, b) => {
    if (a._start !== b._start) return a._start - b._start;
    return (b._end - b._start) - (a._end - a._start);
  });

  // ── Step 1: Build clusters ────────────────────────────────────────────────
  // A cluster is a maximal set of transitively overlapping events.
  // We sweep through sorted events and extend the current cluster as long as
  // the next event starts before the cluster's maximum end time.

  const clusters = [];
  let currentCluster = [];
  let clusterMaxEnd = -Infinity;

  for (const ev of evs) {
    if (currentCluster.length === 0 || ev._start < clusterMaxEnd) {
      currentCluster.push(ev);
      clusterMaxEnd = Math.max(clusterMaxEnd, ev._end);
    } else {
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterMaxEnd = ev._end;
    }
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  // ── Step 2: Assign columns within each cluster ────────────────────────────
  const result = [];

  for (const cluster of clusters) {
    // columns[i] = end time of the last event placed in column i
    const colEnds = [];

    // Map from event id → assigned column
    const colAssignment = new Map();

    for (const ev of cluster) {
      // Find the first column whose last event has ended by the time this one starts
      let assigned = -1;
      for (let c = 0; c < colEnds.length; c++) {
        if (colEnds[c] <= ev._start) {
          assigned = c;
          break;
        }
      }
      if (assigned === -1) {
        // Need a new column
        assigned = colEnds.length;
        colEnds.push(ev._end);
      } else {
        colEnds[assigned] = ev._end;
      }
      colAssignment.set(ev.id, assigned);
    }

    const totalCols = colEnds.length;

    for (const ev of cluster) {
      result.push({
        id:        ev.id,
        title:     ev.title,
        start_at:  ev.start_at,
        end_at:    ev.end_at,
        col:       colAssignment.get(ev.id),
        totalCols,
      });
    }
  }

  return result;
}

/**
 * Convert a time (Date or ISO string) to a pixel offset from the top of the
 * day column, given the total column height in pixels (= 24 * hourHeight).
 *
 * The time is interpreted in local time. If the time is midnight of the
 * *next* day (i.e. 24:00 of the current day), it maps to the full height.
 *
 * @param {string|Date} time
 * @param {number} hourHeight  — pixels per hour
 * @param {Date|null} dayDate  — the calendar day; if provided, times on the
 *                               next day at 00:00 are treated as 24:00
 * @returns {number}           — pixel offset from midnight
 */
export function timeToPixels(time, hourHeight, dayDate = null) {
  const d = time instanceof Date ? time : new Date(time);
  let minutesFromMidnight = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;

  // If dayDate is provided and `d` is midnight of the next day, treat as 24:00
  if (dayDate && minutesFromMidnight === 0) {
    const day = dayDate instanceof Date ? dayDate : new Date(dayDate);
    // Check if d is on a different (later) day than dayDate
    const dayMidnight = new Date(day);
    dayMidnight.setHours(0, 0, 0, 0);
    const dMidnight = new Date(d);
    dMidnight.setHours(0, 0, 0, 0);
    if (dMidnight > dayMidnight) {
      minutesFromMidnight = 24 * 60;
    }
  }

  return (minutesFromMidnight / 60) * hourHeight;
}

/**
 * Convert a pixel offset from the top of the day column back to a Date on
 * the given calendar day.
 *
 * @param {number} px          — pixel offset from midnight
 * @param {number} hourHeight  — pixels per hour
 * @param {Date}   dayDate     — the calendar day (year/month/day)
 * @returns {Date}
 */
export function pixelsToTime(px, hourHeight, dayDate) {
  const totalMinutes = Math.round((px / hourHeight) * 60);
  const clamped = Math.max(0, Math.min(24 * 60, totalMinutes));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  const d = new Date(dayDate);
  d.setHours(h, m, 0, 0);
  return d;
}
