/**
 * Cluster-based overlap layout engine.
 *
 * Given a list of events for a single day, computes the visual layout:
 * - Groups events into overlap clusters (maximal sets of transitively overlapping events)
 * - Within each cluster, assigns columns greedily by start time
 * - Each event's width = clusterWidth / numColumns, offset = colIndex * (clusterWidth / numColumns)
 *
 * Returns an array of layout objects:
 * { event, colIndex, numCols }
 */

/**
 * Check if two events overlap in time.
 * Events overlap if one starts before the other ends (exclusive boundary).
 */
function eventsOverlap(a, b) {
  const aStart = new Date(a.start_at).getTime();
  const aEnd = new Date(a.end_at).getTime();
  const bStart = new Date(b.start_at).getTime();
  const bEnd = new Date(b.end_at).getTime();
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Build overlap clusters using union-find / transitive grouping.
 * Returns array of clusters, each cluster is an array of events.
 */
function buildClusters(events) {
  if (events.length === 0) return [];

  // Sort by start time
  const sorted = [...events].sort((a, b) =>
    new Date(a.start_at) - new Date(b.start_at)
  );

  const clusters = [];
  let currentCluster = [sorted[0]];
  // Track the maximum end time in the current cluster
  let clusterMaxEnd = new Date(sorted[0].end_at).getTime();

  for (let i = 1; i < sorted.length; i++) {
    const event = sorted[i];
    const eventStart = new Date(event.start_at).getTime();

    if (eventStart < clusterMaxEnd) {
      // Overlaps with current cluster (transitively)
      currentCluster.push(event);
      const eventEnd = new Date(event.end_at).getTime();
      if (eventEnd > clusterMaxEnd) {
        clusterMaxEnd = eventEnd;
      }
    } else {
      // New cluster
      clusters.push(currentCluster);
      currentCluster = [event];
      clusterMaxEnd = new Date(event.end_at).getTime();
    }
  }
  clusters.push(currentCluster);

  return clusters;
}

/**
 * Assign columns within a cluster greedily.
 * Events are processed in start-time order.
 * Each event is placed in the first column where it doesn't overlap
 * with the last event placed in that column.
 *
 * Returns array of { event, colIndex, numCols }
 */
function assignColumns(cluster) {
  // Sort by start time, then by end time descending for stability
  const sorted = [...cluster].sort((a, b) => {
    const startDiff = new Date(a.start_at) - new Date(b.start_at);
    if (startDiff !== 0) return startDiff;
    return new Date(b.end_at) - new Date(a.end_at);
  });

  // columns[i] = the end time of the last event placed in column i
  const columns = [];

  const assignments = sorted.map(event => {
    const eventStart = new Date(event.start_at).getTime();
    const eventEnd = new Date(event.end_at).getTime();

    // Find first column where this event fits (no overlap)
    let colIndex = -1;
    for (let c = 0; c < columns.length; c++) {
      if (columns[c] <= eventStart) {
        colIndex = c;
        break;
      }
    }

    if (colIndex === -1) {
      // Need a new column
      colIndex = columns.length;
      columns.push(eventEnd);
    } else {
      columns[colIndex] = eventEnd;
    }

    return { event, colIndex };
  });

  const numCols = columns.length;
  return assignments.map(({ event, colIndex }) => ({
    event,
    colIndex,
    numCols,
  }));
}

/**
 * Main layout function.
 * Takes an array of events for a single day.
 * Returns array of layout descriptors: { event, colIndex, numCols }
 */
export function computeDayLayout(events) {
  if (events.length === 0) return [];

  const clusters = buildClusters(events);
  const result = [];

  for (const cluster of clusters) {
    const assignments = assignColumns(cluster);
    result.push(...assignments);
  }

  return result;
}

/**
 * Convert a time (Date or ISO string) to pixels from the top of the day column.
 * @param {string|Date} time
 * @param {number} hourHeight - pixels per hour
 * @returns {number} pixels from top
 */
export function timeToPixels(time, hourHeight) {
  const d = new Date(time);
  const minutes = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  return (minutes / 60) * hourHeight;
}

/**
 * Convert pixels from top of day column to minutes from midnight.
 * @param {number} pixels
 * @param {number} hourHeight
 * @returns {number} minutes from midnight
 */
export function pixelsToMinutes(pixels, hourHeight) {
  return (pixels / hourHeight) * 60;
}

/**
 * Snap minutes to nearest N-minute interval.
 */
export function snapMinutes(minutes, snap = 15) {
  return Math.round(minutes / snap) * snap;
}
