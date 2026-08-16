/**
 * Overlap layout engine for calendar events.
 *
 * Given a list of events for a single day, computes each event's
 * column index and total columns in its cluster, enabling side-by-side
 * rendering of overlapping events.
 */

/**
 * Computes layout information for events in a single day.
 * 
 * @param {Array} events - Array of event objects with start_at and end_at (Date or ISO string)
 * @param {Date} dayStart - The start of the day (00:00)
 * @returns {Array} Array of { event, top, height, column, totalColumns }
 *   where top and height are in fractions of the day (0-1),
 *   column is 0-indexed column assignment,
 *   totalColumns is the number of columns in the event's cluster.
 */
export function computeDayLayout(events, dayStart) {
  if (!events || events.length === 0) return [];

  const MINUTES_IN_DAY = 24 * 60;
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayStartMs + MINUTES_IN_DAY * 60 * 1000;

  // Convert events to layout items with clamped minute offsets
  const items = events.map(event => {
    const startMs = new Date(event.start_at).getTime();
    const endMs = new Date(event.end_at).getTime();

    // Clamp to day boundaries
    const clampedStartMs = Math.max(startMs, dayStartMs);
    const clampedEndMs = Math.min(endMs, dayEndMs);

    const startMinutes = (clampedStartMs - dayStartMs) / (60 * 1000);
    const endMinutes = (clampedEndMs - dayStartMs) / (60 * 1000);

    return {
      event,
      startMinutes,
      endMinutes,
      column: -1,
      totalColumns: 1
    };
  });

  // Sort by start time, then by duration descending (longer events first)
  items.sort((a, b) => {
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return (b.endMinutes - b.startMinutes) - (a.endMinutes - a.startMinutes);
  });

  // Group into overlap clusters (maximal sets of transitively overlapping events)
  const clusters = [];
  let currentCluster = [];
  let clusterEnd = -1;

  for (const item of items) {
    if (currentCluster.length === 0 || item.startMinutes < clusterEnd) {
      // This event overlaps with the current cluster
      currentCluster.push(item);
      clusterEnd = Math.max(clusterEnd, item.endMinutes);
    } else {
      // Start a new cluster
      clusters.push(currentCluster);
      currentCluster = [item];
      clusterEnd = item.endMinutes;
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  // For each cluster, assign columns greedily
  for (const cluster of clusters) {
    // columns[i] = end time of the last event placed in column i
    const columns = [];

    for (const item of cluster) {
      // Find the first column where this event fits (doesn't overlap)
      let placed = false;
      for (let col = 0; col < columns.length; col++) {
        if (item.startMinutes >= columns[col]) {
          item.column = col;
          columns[col] = item.endMinutes;
          placed = true;
          break;
        }
      }
      if (!placed) {
        item.column = columns.length;
        columns.push(item.endMinutes);
      }
    }

    // Total columns for this cluster
    const totalColumns = columns.length;
    for (const item of cluster) {
      item.totalColumns = totalColumns;
    }
  }

  // Convert to output format
  return items.map(item => ({
    event: item.event,
    top: item.startMinutes / MINUTES_IN_DAY,
    height: (item.endMinutes - item.startMinutes) / MINUTES_IN_DAY,
    column: item.column,
    totalColumns: item.totalColumns
  }));
}
