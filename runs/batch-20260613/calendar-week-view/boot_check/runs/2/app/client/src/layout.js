/**
 * Cluster-based overlap layout engine.
 *
 * Given a list of events for a single day, computes for each event:
 *   - colIndex:    which horizontal slot it occupies (0-based)
 *   - colCount:    total number of columns in its cluster
 *
 * The caller then maps these to pixel geometry:
 *   left  = (colIndex / colCount) * dayColumnWidth
 *   width = dayColumnWidth / colCount
 *
 * Algorithm:
 *   1. Sort events by start time (ties broken by id for stability).
 *   2. Build overlap clusters: a cluster is a maximal set of events where
 *      every event overlaps at least one other event in the set (transitive).
 *      Two events overlap when startA < endB && startB < endA.
 *   3. Within each cluster, assign column indices greedily:
 *      - Maintain a list of "columns", each tracking the latest end time
 *        of the event placed in it.
 *      - For each event (in start-time order), place it in the first column
 *        whose latest end time <= event's start time.
 *        If no such column exists, open a new column.
 *   4. colCount for every event in the cluster = number of columns used.
 */

/**
 * @typedef {{ id: number, start_at: string, end_at: string }} CalEvent
 * @typedef {{ id: number, colIndex: number, colCount: number }} LayoutResult
 */

/**
 * Compute layout for a list of events belonging to a single day.
 * @param {CalEvent[]} events
 * @returns {Map<number, LayoutResult>}  keyed by event id
 */
export function computeDayLayout(events) {
  if (events.length === 0) return new Map();

  // Convert to internal representation with numeric timestamps
  const items = events.map(ev => ({
    id:    ev.id,
    start: new Date(ev.start_at).getTime(),
    end:   new Date(ev.end_at).getTime(),
  }));

  // Sort by start time, then by id for stability
  items.sort((a, b) => a.start - b.start || a.id - b.id);

  // ── Step 1: Build overlap clusters ────────────────────────────────────────
  // We use a sweep: maintain the maximum end time seen so far in the current
  // cluster. When a new event starts at or after that maximum, it starts a
  // new cluster.

  const clusters = []; // Array of arrays of item indices into `items`
  let clusterEnd = -Infinity;
  let currentCluster = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.start >= clusterEnd) {
      // Start a new cluster
      if (currentCluster.length > 0) clusters.push(currentCluster);
      currentCluster = [i];
      clusterEnd = item.end;
    } else {
      // Extend current cluster
      currentCluster.push(i);
      if (item.end > clusterEnd) clusterEnd = item.end;
    }
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  // ── Step 2: Assign columns within each cluster ────────────────────────────
  const result = new Map();

  for (const cluster of clusters) {
    // columns[c] = latest end time of the event placed in column c
    const columns = []; // array of end-times

    const assignments = []; // assignments[i] = column index for cluster[i]

    for (const idx of cluster) {
      const item = items[idx];
      // Find the first column whose end time <= item.start
      let placed = -1;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= item.start) {
          placed = c;
          break;
        }
      }
      if (placed === -1) {
        // Open a new column
        placed = columns.length;
        columns.push(item.end);
      } else {
        columns[placed] = item.end;
      }
      assignments.push(placed);
    }

    const colCount = columns.length;

    for (let i = 0; i < cluster.length; i++) {
      const item = items[cluster[i]];
      result.set(item.id, {
        id:       item.id,
        colIndex: assignments[i],
        colCount,
      });
    }
  }

  return result;
}

/**
 * Given a list of events for the whole week, group them by day (Mon–Sun)
 * and compute layout for each day.
 *
 * @param {CalEvent[]} events  – all events for the week
 * @param {Date}       weekStart – Monday 00:00:00 local time
 * @returns {Map<number, LayoutResult>}  keyed by event id
 */
export function computeWeekLayout(events, weekStart) {
  // Group events by day index (0 = Monday … 6 = Sunday)
  const byDay = Array.from({ length: 7 }, () => []);

  for (const ev of events) {
    const start = new Date(ev.start_at);
    // Compute which day column this event belongs to
    const dayIdx = getDayIndex(start, weekStart);
    if (dayIdx >= 0 && dayIdx < 7) {
      byDay[dayIdx].push(ev);
    }
  }

  const result = new Map();
  for (const dayEvents of byDay) {
    const dayResult = computeDayLayout(dayEvents);
    for (const [id, layout] of dayResult) {
      result.set(id, layout);
    }
  }
  return result;
}

/**
 * Return the 0-based day index (Mon=0 … Sun=6) for a given date
 * relative to the week start (Monday).
 */
export function getDayIndex(date, weekStart) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const diff = startOfDay(date).getTime() - startOfDay(weekStart).getTime();
  return Math.round(diff / msPerDay);
}

/**
 * Return midnight (00:00:00.000) of the given date in local time.
 */
export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Return the Monday of the week containing `date` (local time).
 */
export function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // getDay(): 0=Sun, 1=Mon, …, 6=Sat
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * Return the Sunday (end of week) 24:00 = next Monday 00:00.
 */
export function getWeekEnd(weekStart) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 7);
  return d;
}

/**
 * Format a Date as "HH:MM" in local time.
 */
export function formatTime(date) {
  const d = new Date(date);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Format a Date as "YYYY-MM-DDTHH:MM" for datetime-local inputs.
 */
export function toDatetimeLocal(date) {
  const d = new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Convert minutes-from-midnight to pixels.
 * HOUR_HEIGHT = 64px, so 1 minute = 64/60 px.
 */
export const HOUR_HEIGHT = 64; // px

export function minutesToPx(minutes) {
  return (minutes / 60) * HOUR_HEIGHT;
}

/**
 * Convert a Date to minutes from midnight (local time).
 */
export function dateToMinutes(date) {
  const d = new Date(date);
  return d.getHours() * 60 + d.getMinutes();
}
