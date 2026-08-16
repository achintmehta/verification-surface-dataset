/**
 * Cluster-based overlap layout algorithm for calendar events.
 *
 * Given an array of day-events (each with _startMinutes and _endMinutes),
 * returns an array of { event, leftPercent, widthPercent } representing
 * the horizontal position and width of each event as a percentage of
 * the day column width.
 *
 * Algorithm:
 * 1. Sort events by start time, then by end time descending (longer events first).
 * 2. Group events into overlap clusters (maximal sets of transitively overlapping events).
 * 3. Within each cluster, assign columns greedily: for each event (by start time),
 *    pick the lowest-indexed column that is free.
 * 4. Each event's width = (1 / number of columns in the cluster) * 100%.
 *    Each event's left = (column index / number of columns in the cluster) * 100%.
 */

export function layoutEventsForDay(dayEvents) {
  if (dayEvents.length === 0) return [];

  // Sort by start time, then by longest event first for tie-breaking
  const sorted = [...dayEvents].sort((a, b) => {
    if (a._startMinutes !== b._startMinutes) return a._startMinutes - b._startMinutes;
    return b._endMinutes - a._endMinutes; // longer events first
  });

  // Build overlap clusters
  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = sorted[0]._endMinutes;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev._startMinutes < clusterEnd) {
      // Overlaps with current cluster
      currentCluster.push(ev);
      clusterEnd = Math.max(clusterEnd, ev._endMinutes);
    } else {
      // New cluster
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterEnd = ev._endMinutes;
    }
  }
  clusters.push(currentCluster);

  // Layout each cluster
  const result = [];

  for (const cluster of clusters) {
    // Assign columns greedily
    // columns[i] = the end time of the last event assigned to column i
    const columns = [];
    const assignments = new Map(); // event -> column index

    for (const ev of cluster) {
      // Find the first column where this event can fit
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= ev._startMinutes) {
          columns[c] = ev._endMinutes;
          assignments.set(ev, c);
          placed = true;
          break;
        }
      }
      if (!placed) {
        assignments.set(ev, columns.length);
        columns.push(ev._endMinutes);
      }
    }

    const numColumns = columns.length;

    for (const ev of cluster) {
      const colIndex = assignments.get(ev);
      result.push({
        event: ev,
        leftPercent: (colIndex / numColumns) * 100,
        widthPercent: (1 / numColumns) * 100
      });
    }
  }

  return result;
}
