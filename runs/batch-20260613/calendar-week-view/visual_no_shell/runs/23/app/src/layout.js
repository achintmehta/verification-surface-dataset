/**
 * Layout engine for overlapping events.
 *
 * The algorithm:
 * 1. Sort events by start time, then by end time descending (longer events first).
 * 2. Group events into "clusters": maximal sets of transitively overlapping events.
 * 3. Within each cluster, assign columns greedily: for each event (in start-time order),
 *    assign it to the first column that is free (i.e., the column's last event ends before
 *    or at this event's start).
 * 4. Each event's width = day-column-width / cluster-column-count.
 *    Each event's left offset = column-index * event-width.
 */

/**
 * Compute layout positions for an array of events within a single day.
 * 
 * Each event is expected to have:
 *   - startMinutes: minutes from midnight (0-1440) for the start within this day
 *   - endMinutes: minutes from midnight (0-1440) for the end within this day
 *
 * Returns an array of layout objects:
 *   { event, top (fraction 0-1), height (fraction 0-1), left (fraction 0-1), width (fraction 0-1) }
 */
export function computeDayLayout(events) {
  if (!events || events.length === 0) return [];

  const TOTAL_MINUTES = 1440; // 24 * 60

  // Sort by start time, then by end time descending (longer events first among ties)
  const sorted = [...events].sort((a, b) => {
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return b.endMinutes - a.endMinutes;
  });

  // Group into clusters of transitively overlapping events
  const clusters = [];
  let currentCluster = null;
  let clusterEnd = -1;

  for (const evt of sorted) {
    if (currentCluster === null || evt.startMinutes >= clusterEnd) {
      // Start a new cluster
      currentCluster = [evt];
      clusters.push(currentCluster);
      clusterEnd = evt.endMinutes;
    } else {
      // Add to existing cluster
      currentCluster.push(evt);
      clusterEnd = Math.max(clusterEnd, evt.endMinutes);
    }
  }

  // For each cluster, assign columns greedily
  const layoutResults = [];

  for (const cluster of clusters) {
    // columns[i] = end time of the last event placed in column i
    const columns = [];

    const eventColumns = new Map();

    for (const evt of cluster) {
      // Find the first column where the last event ends at or before this event's start
      let placed = false;
      for (let col = 0; col < columns.length; col++) {
        if (columns[col] <= evt.startMinutes) {
          columns[col] = evt.endMinutes;
          eventColumns.set(evt, col);
          placed = true;
          break;
        }
      }
      if (!placed) {
        eventColumns.set(evt, columns.length);
        columns.push(evt.endMinutes);
      }
    }

    const numColumns = columns.length;

    for (const evt of cluster) {
      const col = eventColumns.get(evt);
      layoutResults.push({
        event: evt,
        top: evt.startMinutes / TOTAL_MINUTES,
        height: (evt.endMinutes - evt.startMinutes) / TOTAL_MINUTES,
        left: col / numColumns,
        width: 1 / numColumns
      });
    }
  }

  return layoutResults;
}
