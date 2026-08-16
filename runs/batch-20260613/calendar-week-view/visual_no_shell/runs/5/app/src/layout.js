/**
 * Overlap layout engine for calendar events.
 *
 * Algorithm:
 * 1. Sort events by start time.
 * 2. Group into clusters: maximal sets of transitively overlapping events.
 *    Two events overlap if one starts before the other ends (strict).
 * 3. Within each cluster, assign column indices greedily:
 *    - For each event (sorted by start), find the lowest column index
 *      not occupied by any event that overlaps with it.
 * 4. The cluster's column count = max assigned index + 1.
 * 5. Each event's width = dayColumnWidth / clusterColumns.
 *    Each event's left offset = colIndex * width.
 */

/**
 * @param {Array} events - Array of event objects with start_at, end_at (ISO strings or Date)
 * @returns {Array} - Same events with added layout properties:
 *   { colIndex, colCount, clusterIndex }
 */
export function computeLayout(events) {
  if (!events || events.length === 0) return [];

  // Normalize to minutes-from-midnight for comparison
  const evts = events.map((e, i) => ({
    ...e,
    _idx: i,
    _start: toMinutes(e.start_at),
    _end: toMinutes(e.end_at),
  }));

  // Sort by start time, then by end time descending (longer events first)
  evts.sort((a, b) => a._start - b._start || b._end - a._end);

  // Build clusters: maximal groups of transitively overlapping events
  const clusters = buildClusters(evts);

  // Assign columns within each cluster
  const result = [];
  for (const cluster of clusters) {
    const colCount = assignColumns(cluster);
    for (const evt of cluster) {
      result.push({
        ...evt,
        colIndex: evt._colIndex,
        colCount,
      });
    }
  }

  return result;
}

/**
 * Convert an ISO timestamp to minutes from midnight (local time).
 * Clamps to [0, 1440].
 */
export function toMinutes(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  const mins = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  return Math.max(0, Math.min(1440, mins));
}

/**
 * Build clusters of transitively overlapping events.
 * Events must be sorted by start time before calling.
 */
function buildClusters(sortedEvents) {
  const clusters = [];
  let currentCluster = [];
  let clusterEnd = -Infinity;

  for (const evt of sortedEvents) {
    if (currentCluster.length === 0 || evt._start < clusterEnd) {
      // Overlaps with current cluster (or first event)
      currentCluster.push(evt);
      clusterEnd = Math.max(clusterEnd, evt._end);
    } else {
      // No overlap: start a new cluster
      clusters.push(currentCluster);
      currentCluster = [evt];
      clusterEnd = evt._end;
    }
  }

  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  return clusters;
}

/**
 * Greedily assign column indices to events within a cluster.
 * Returns the total number of columns needed.
 */
function assignColumns(cluster) {
  // columns[i] = end time of the last event placed in column i
  const columns = [];

  for (const evt of cluster) {
    // Find the first column where the last event ends <= this event's start
    let placed = false;
    for (let col = 0; col < columns.length; col++) {
      if (columns[col] <= evt._start) {
        evt._colIndex = col;
        columns[col] = evt._end;
        placed = true;
        break;
      }
    }
    if (!placed) {
      evt._colIndex = columns.length;
      columns.push(evt._end);
    }
  }

  return columns.length;
}

/**
 * Compute pixel geometry for an event block.
 *
 * @param {number} startMinutes - minutes from midnight
 * @param {number} endMinutes   - minutes from midnight
 * @param {number} colIndex     - 0-based column index within cluster
 * @param {number} colCount     - total columns in cluster
 * @param {number} hourHeight   - pixels per hour (default 60)
 * @param {number} columnWidth  - total width of the day column in pixels
 * @param {number} padding      - horizontal padding between events (default 2)
 * @returns {{ top, height, left, width }} in pixels
 */
export function computeGeometry(
  startMinutes,
  endMinutes,
  colIndex,
  colCount,
  hourHeight = 60,
  columnWidth = 100,
  padding = 2
) {
  const pxPerMinute = hourHeight / 60;

  // Clamp to [0, 1440]
  const clampedStart = Math.max(0, Math.min(1440, startMinutes));
  const clampedEnd = Math.max(0, Math.min(1440, endMinutes));

  const top = clampedStart * pxPerMinute;
  const height = Math.max(18, (clampedEnd - clampedStart) * pxPerMinute);

  const slotWidth = columnWidth / colCount;
  const left = colIndex * slotWidth + padding;
  const width = slotWidth - padding * 2;

  return { top, height, left: Math.max(0, left), width: Math.max(4, width) };
}
