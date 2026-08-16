/**
 * Overlap layout engine for calendar events.
 *
 * Algorithm (Decision 1):
 *  1. Sort events by start time.
 *  2. Build overlap clusters: a cluster is a maximal set of events where
 *     every event overlaps at least one other event in the set (transitive).
 *     Two events overlap when startA < endB && startB < endA.
 *  3. Within each cluster, assign column indices greedily:
 *     - Process events in start-time order.
 *     - For each event, find the lowest column index not occupied by any
 *       currently-active event (an event whose end > this event's start).
 *     - Record the number of columns used by the cluster.
 *  4. Each event's rendered width = dayColumnWidth / clusterColumns.
 *     Its left offset = colIndex * (dayColumnWidth / clusterColumns).
 *
 * Returns an array of layout objects:
 *   { event, colIndex, colCount }
 * where colCount is the total columns in the event's cluster.
 */

/**
 * @param {Array<{id, title, start_at, end_at}>} events  — events for ONE day
 * @returns {Array<{event, colIndex, colCount}>}
 */
export function computeDayLayout(events) {
  if (events.length === 0) return [];

  // Work with minute-of-day for fast arithmetic
  const items = events.map(ev => ({
    event: ev,
    startMin: toMinutes(ev.start_at),
    endMin:   toEndMinutes(ev.start_at, ev.end_at),
    colIndex: 0,
    colCount: 1,
  }));

  // Sort by start time, then by end time descending (longer events first)
  items.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // Build clusters using a sweep
  const clusters = buildClusters(items);

  // Assign columns within each cluster
  for (const cluster of clusters) {
    assignColumns(cluster);
  }

  return items.map(item => ({
    event:    item.event,
    colIndex: item.colIndex,
    colCount: item.colCount,
  }));
}

/**
 * Group items into overlap clusters.
 * A cluster is a maximal set of events where the union of their time ranges
 * is contiguous (i.e. every event overlaps at least one other in the set).
 */
function buildClusters(sortedItems) {
  const clusters = [];
  let currentCluster = [];
  let clusterEnd = -Infinity;

  for (const item of sortedItems) {
    if (currentCluster.length === 0 || item.startMin < clusterEnd) {
      // Overlaps with current cluster (or first event)
      currentCluster.push(item);
      clusterEnd = Math.max(clusterEnd, item.endMin);
    } else {
      // No overlap — start a new cluster
      clusters.push(currentCluster);
      currentCluster = [item];
      clusterEnd = item.endMin;
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }
  return clusters;
}

/**
 * Greedy column assignment within a cluster.
 * For each event (in start-time order), find the lowest column not occupied
 * by any event whose end time is after this event's start time.
 */
function assignColumns(cluster) {
  // columns[i] = end time of the last event placed in column i
  const columns = [];

  for (const item of cluster) {
    let placed = false;
    for (let c = 0; c < columns.length; c++) {
      if (columns[c] <= item.startMin) {
        // Column c is free
        item.colIndex = c;
        columns[c] = item.endMin;
        placed = true;
        break;
      }
    }
    if (!placed) {
      item.colIndex = columns.length;
      columns.push(item.endMin);
    }
  }

  const colCount = columns.length;
  for (const item of cluster) {
    item.colCount = colCount;
  }
}

/**
 * Convert an ISO datetime string (YYYY-MM-DDTHH:MM:SS) to minutes since midnight.
 * Clamps to [0, 1440].
 *
 * Special case: if the time portion is "00:00:00" and the date is different from
 * the event's start date, it represents midnight (end of day = 1440 minutes).
 * Callers that need this behaviour should use toEndMinutes().
 */
export function toMinutes(isoString) {
  // Parse only the time portion to avoid timezone issues
  // isoString format from server: "YYYY-MM-DDTHH:MM:SS"
  const timePart = isoString.includes('T') ? isoString.split('T')[1] : isoString;
  const [hStr, mStr] = timePart.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  return Math.max(0, Math.min(1440, h * 60 + m));
}

/**
 * Convert an event's end_at to minutes-since-midnight relative to its start date.
 * If end_at is on the next calendar day at 00:00, treat it as 1440 (midnight = end of day).
 */
export function toEndMinutes(startISO, endISO) {
  const startDate = startISO.split('T')[0];
  const endDate   = endISO.split('T')[0];
  const endMin    = toMinutes(endISO);

  // If end is on a different day and at midnight (00:00), it means end-of-day
  if (endDate !== startDate && endMin === 0) {
    return 1440;
  }
  return endMin;
}

/**
 * Convert minutes-since-midnight to a pixel top offset.
 * @param {number} minutes
 * @param {number} hourHeight  — px per hour (CSS --hour-height)
 */
export function minutesToPx(minutes, hourHeight) {
  return (minutes / 60) * hourHeight;
}
