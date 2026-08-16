/**
 * Overlap layout engine.
 * 
 * Given a list of events for a single day (each with startMinutes and endMinutes
 * from midnight, 0–1440), compute the layout: column index and total columns
 * for each event.
 * 
 * Algorithm:
 * 1. Sort events by start time, then by end time descending (longer events first).
 * 2. Group into overlap clusters: maximal sets of transitively overlapping events.
 * 3. Within each cluster, greedily assign columns by start time.
 * 4. Each event's width = 1/maxColumns in the cluster, offset = columnIndex/maxColumns.
 */

/**
 * @typedef {Object} EventWithMinutes
 * @property {number} id
 * @property {string} title
 * @property {number} startMinutes - minutes from midnight (0–1440)
 * @property {number} endMinutes - minutes from midnight (0–1440)
 */

/**
 * @typedef {Object} LayoutEvent
 * @property {number} id
 * @property {string} title
 * @property {number} startMinutes
 * @property {number} endMinutes
 * @property {number} column - 0-based column index within cluster
 * @property {number} totalColumns - total columns in the cluster
 */

/**
 * Compute layout for a day's events.
 * @param {EventWithMinutes[]} events
 * @returns {LayoutEvent[]}
 */
export function computeDayLayout(events) {
  if (events.length === 0) return [];

  // Sort by start time, then by duration descending (longer events first)
  const sorted = [...events].sort((a, b) => {
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return b.endMinutes - a.endMinutes; // longer first
  });

  // Group into overlap clusters
  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = sorted[0].endMinutes;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.startMinutes < clusterEnd) {
      // Overlaps with current cluster
      currentCluster.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMinutes);
    } else {
      // New cluster
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterEnd = ev.endMinutes;
    }
  }
  clusters.push(currentCluster);

  // Assign columns within each cluster
  const results = [];

  for (const cluster of clusters) {
    // columns[i] = end time of the event currently in column i
    const columns = [];

    for (const ev of cluster) {
      // Find the first column where this event fits (column end <= event start)
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= ev.startMinutes) {
          columns[c] = ev.endMinutes;
          results.push({
            ...ev,
            column: c,
            totalColumns: 0 // will be set after processing cluster
          });
          placed = true;
          break;
        }
      }
      if (!placed) {
        const c = columns.length;
        columns.push(ev.endMinutes);
        results.push({
          ...ev,
          column: c,
          totalColumns: 0
        });
      }
    }

    // Set totalColumns for all events in this cluster
    const totalCols = columns.length;
    // The events we just added are the last cluster.length in results
    for (let i = results.length - cluster.length; i < results.length; i++) {
      results[i].totalColumns = totalCols;
    }
  }

  return results;
}
