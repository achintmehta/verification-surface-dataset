/**
 * Cluster-based overlap layout engine.
 *
 * Given a list of events for a single day, computes the visual layout:
 * - Groups events into overlap clusters (maximal sets of transitively overlapping events)
 * - Within each cluster, assigns column indices greedily by start time
 * - Each event's width = 100% / numColumns, offset = colIndex * (100% / numColumns)
 *
 * All events passed in must belong to the same calendar day (same date in start_at).
 * The layout uses minute-of-day arithmetic parsed directly from the time string,
 * so it is immune to timezone interpretation.
 *
 * For events that end at midnight of the NEXT day (end_at date > start_at date),
 * the end time is treated as 1440 (24:00) so the block reaches the column bottom.
 */

export const HOUR_HEIGHT = 60; // px per hour — must match CSS --hour-height
export const TOTAL_HEIGHT = HOUR_HEIGHT * 24; // 1440px

/**
 * Parse "YYYY-MM-DDTHH:MM:SS" → minutes from midnight (0–1440).
 * For an end_at that is on the NEXT day (e.g. "2026-06-20T00:00:00" when the
 * event started on "2026-06-19"), we pass isEnd=true and the event's start date
 * so we can detect the cross-midnight case and return 1440.
 */
export function toMinutes(datetimeStr, startDateStr, isEnd) {
  const timePart = datetimeStr.slice(11); // "HH:MM:SS" or "HH:MM"
  const [hStr, mStr] = timePart.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const minutes = h * 60 + m;

  // If this is an end time and the date portion differs from the start date,
  // the event crosses midnight — treat as 1440 (24:00).
  if (isEnd && startDateStr) {
    const endDateStr = datetimeStr.slice(0, 10);
    if (endDateStr !== startDateStr && minutes === 0) {
      return 1440;
    }
  }

  return minutes;
}

/**
 * Get start minutes for an event (always from its own date).
 */
function startMin(event) {
  return toMinutes(event.start_at);
}

/**
 * Get end minutes for an event, handling cross-midnight correctly.
 */
function endMin(event) {
  return toMinutes(event.end_at, event.start_at.slice(0, 10), true);
}

/**
 * Convert minutes-from-midnight to pixels.
 */
export function minutesToPx(minutes) {
  return (minutes / 60) * HOUR_HEIGHT;
}

/**
 * Check if two events overlap in time.
 * Overlap: a.start < b.end AND a.end > b.start
 */
function overlaps(a, b) {
  return startMin(a) < endMin(b) && endMin(a) > startMin(b);
}

/**
 * Group events into overlap clusters using union-find.
 * A cluster is a maximal set of events where every pair is connected
 * through a chain of overlapping events.
 */
function buildClusters(events) {
  const n = events.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(x, y) {
    const px = find(x), py = find(y);
    if (px !== py) parent[px] = py;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (overlaps(events[i], events[j])) {
        union(i, j);
      }
    }
  }

  const clusterMap = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root).push(i);
  }

  return Array.from(clusterMap.values()).map(indices => indices.map(i => events[i]));
}

/**
 * Assign column indices within a cluster using a greedy algorithm.
 * Sort events by start time; for each event find the first column
 * whose last event has already ended.
 *
 * Returns array of { event, colIndex, numCols }
 */
function assignColumns(clusterEvents) {
  const sorted = [...clusterEvents].sort((a, b) => {
    const diff = startMin(a) - startMin(b);
    return diff !== 0 ? diff : endMin(a) - endMin(b);
  });

  // columns[i] = end time (minutes) of the last event placed in column i
  const columns = [];
  const assignments = new Map(); // event.id -> colIndex

  for (const event of sorted) {
    const s = startMin(event);
    let placed = false;
    for (let col = 0; col < columns.length; col++) {
      if (columns[col] <= s) {
        columns[col] = endMin(event);
        assignments.set(event.id, col);
        placed = true;
        break;
      }
    }
    if (!placed) {
      assignments.set(event.id, columns.length);
      columns.push(endMin(event));
    }
  }

  const numCols = columns.length;
  return clusterEvents.map(event => ({
    event,
    colIndex: assignments.get(event.id),
    numCols,
  }));
}

/**
 * Compute the full layout for a list of events in a single day column.
 *
 * Returns array of:
 * {
 *   event,
 *   top: number,        // px from top of day column
 *   height: number,     // px
 *   leftPct: number,    // percentage (0–100) from left of day column
 *   widthPct: number,   // percentage (0–100) of day column width
 *   colIndex: number,
 *   numCols: number,
 * }
 */
export function computeLayout(events) {
  if (!events || events.length === 0) return [];

  const clusters = buildClusters(events);
  const result = [];

  for (const cluster of clusters) {
    const assigned = assignColumns(cluster);
    for (const { event, colIndex, numCols } of assigned) {
      const sMin = startMin(event);
      // Clamp end to 24:00 (1440 minutes)
      const eMin = Math.min(endMin(event), 1440);
      const top = minutesToPx(sMin);
      // Minimum visual height of 15 minutes so tiny events are clickable
      const height = minutesToPx(Math.max(eMin - sMin, 15));

      const widthPct = 100 / numCols;
      const leftPct = colIndex * widthPct;

      result.push({ event, top, height, leftPct, widthPct, colIndex, numCols });
    }
  }

  return result;
}
