/**
 * layout.js – Overlap layout engine for the week-view calendar.
 *
 * Algorithm (Decision 1 from spec):
 *   1. For each day, sort events by start time.
 *   2. Group events into "clusters" – maximal sets of transitively overlapping
 *      events.  Two events overlap when one starts before the other ends.
 *   3. Within each cluster, assign a column index to each event greedily:
 *      scan events in start-time order; place each event in the first column
 *      whose last-placed event ends at or before the current event's start.
 *   4. The cluster's column count = max(assigned column index) + 1.
 *   5. Each event's rendered width  = dayColumnWidth / clusterColumns
 *      Each event's rendered left   = (assignedColumn / clusterColumns) * dayColumnWidth
 *
 * Vertical geometry (Decision 2):
 *   top    = (minutesFromMidnight(start) / 1440) * TOTAL_HEIGHT
 *   height = (durationMinutes / 1440) * TOTAL_HEIGHT
 *
 * Both HOUR_HEIGHT and TOTAL_HEIGHT are exported so the renderer and CSS
 * can stay in sync.
 */

/** Height of one hour row in pixels.  Must match --hour-height in style.css. */
export const HOUR_HEIGHT = 64;

/** Total height of the 24-hour grid in pixels. */
export const TOTAL_HEIGHT = HOUR_HEIGHT * 24; // 1536

/**
 * Convert a Date (or ISO string) to minutes elapsed since midnight of that
 * same calendar day (in local time).
 *
 * Special case: if the time is exactly 00:00:00 AND the date is the *next*
 * day relative to a reference day, we treat it as 1440 (end of day).
 * In practice we always pass the event's own start/end, so we just return
 * hours*60 + minutes.  An event ending at 24:00 is stored as the next day's
 * 00:00; the caller is responsible for clamping to 1440 when needed.
 *
 * @param {Date|string} dt
 * @returns {number} minutes [0, 1440)
 */
export function minutesFromMidnight(dt) {
  const d = dt instanceof Date ? dt : new Date(dt);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/**
 * Convert minutes-from-midnight to a pixel offset from the top of the grid.
 * @param {number} minutes
 * @returns {number}
 */
export function minutesToPx(minutes) {
  return (minutes / 1440) * TOTAL_HEIGHT;
}

/**
 * Group an array of events (already sorted by start_at) into clusters.
 * A cluster is a maximal set of transitively overlapping events.
 *
 * Uses a sweep-line approach: maintain the maximum end time seen so far in
 * the current cluster.  An event joins the current cluster if its start time
 * is strictly before that maximum end time (i.e. it overlaps at least one
 * event already in the cluster).
 *
 * @param {Array<object>} sortedEvents  Events sorted by start_at ascending.
 * @returns {Array<Array<object>>}      Array of clusters.
 */
function buildClusters(sortedEvents) {
  /** @type {Array<Array<object>>} */
  const clusters = [];
  /** @type {Array<object>} */
  let currentCluster = [];
  let clusterMaxEnd = -Infinity;

  for (const event of sortedEvents) {
    const start = new Date(event.start_at).getTime();
    const end   = new Date(event.end_at).getTime();

    if (currentCluster.length === 0 || start < clusterMaxEnd) {
      // This event overlaps the current cluster (or starts it).
      currentCluster.push(event);
      if (end > clusterMaxEnd) clusterMaxEnd = end;
    } else {
      // No overlap with the current cluster – flush and start a new one.
      clusters.push(currentCluster);
      currentCluster = [event];
      clusterMaxEnd = end;
    }
  }

  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  return clusters;
}

/**
 * Assign a column index to each event within a cluster using a greedy
 * algorithm.  Events are processed in start-time order (already sorted).
 *
 * For each event, find the first column whose last-placed event ends at or
 * before this event's start time.  If no such column exists, open a new one.
 *
 * @param {Array<object>} clusterEvents  Events in the cluster (sorted by start).
 * @returns {{ columns: number, assignments: Map<number, number> }}
 *   columns      – total number of columns needed by this cluster
 *   assignments  – map from event.id to column index (0-based)
 */
function assignColumns(clusterEvents) {
  // columnEnds[i] = end time (ms) of the last event placed in column i.
  /** @type {number[]} */
  const columnEnds = [];
  /** @type {Map<number, number>} */
  const assignments = new Map();

  for (const event of clusterEvents) {
    const start = new Date(event.start_at).getTime();
    const end   = new Date(event.end_at).getTime();

    // Find the first column whose last event has ended by this event's start.
    let placed = false;
    for (let col = 0; col < columnEnds.length; col++) {
      if (columnEnds[col] <= start) {
        assignments.set(event.id, col);
        columnEnds[col] = end;
        placed = true;
        break;
      }
    }

    if (!placed) {
      // All existing columns are busy – open a new one.
      const col = columnEnds.length;
      assignments.set(event.id, col);
      columnEnds.push(end);
    }
  }

  return { columns: columnEnds.length, assignments };
}

/**
 * Compute layout rectangles for all events in a single day column.
 *
 * Returns one layout record per event with pixel-based top, height, left,
 * and width values.  left and width are expressed in pixels relative to
 * dayWidth so the caller can convert to percentages if desired.
 *
 * @param {Array<object>} events   Raw event objects for one day.
 * @param {number} dayWidth        Pixel width of the day column.
 * @returns {Array<{
 *   event: object,
 *   top: number,
 *   height: number,
 *   left: number,
 *   width: number
 * }>}
 */
export function computeDayLayout(events, dayWidth) {
  if (events.length === 0) return [];

  // Sort by start time, then by id for determinism when starts are equal.
  const sorted = [...events].sort((a, b) => {
    const diff = new Date(a.start_at).getTime() - new Date(b.start_at).getTime();
    return diff !== 0 ? diff : a.id - b.id;
  });

  const clusters = buildClusters(sorted);
  const result = [];

  for (const cluster of clusters) {
    const { columns, assignments } = assignColumns(cluster);

    for (const event of cluster) {
      // Compute minutes-from-midnight for start and end.
      const startMins = minutesFromMidnight(event.start_at);

      // For end_at: if the time is 00:00 it means the event ends at the
      // boundary of the next day, which we render as 1440 (bottom of grid).
      const endDate = new Date(event.end_at);
      const rawEndMins = minutesFromMidnight(endDate);
      // If end is midnight (00:00:00) treat as 1440 (end of day).
      const endMins = (rawEndMins === 0 && endDate.getTime() > new Date(event.start_at).getTime())
        ? 1440
        : rawEndMins;

      // Clamp to [0, 1440].
      const clampedStart = Math.max(0, Math.min(1440, startMins));
      const clampedEnd   = Math.max(0, Math.min(1440, endMins));

      const top    = minutesToPx(clampedStart);
      const height = Math.max(minutesToPx(clampedEnd) - top, 2); // min 2px visible

      const colIndex = assignments.get(event.id) ?? 0;
      const colWidth = dayWidth / columns;
      const left     = colIndex * colWidth;
      const width    = colWidth;

      result.push({ event, top, height, left, width });
    }
  }

  return result;
}

/**
 * Format a Date as "HH:MM" in local time.
 * @param {Date|string} dt
 * @returns {string}
 */
export function formatTime(dt) {
  const d = dt instanceof Date ? dt : new Date(dt);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Format a Date as "YYYY-MM-DDTHH:MM" suitable for datetime-local inputs.
 * @param {Date|string} dt
 * @returns {string}
 */
export function toDatetimeLocal(dt) {
  const d = dt instanceof Date ? dt : new Date(dt);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
