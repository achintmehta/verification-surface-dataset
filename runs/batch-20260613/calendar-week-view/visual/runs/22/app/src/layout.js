/**
 * Layout engine for overlapping events within a single day.
 *
 * Algorithm:
 * 1. Sort events by start time, then by end time descending (longer events first).
 * 2. Group events into overlap clusters:
 *    A cluster is a maximal set of transitively overlapping events.
 *    Two events overlap if one starts before the other ends.
 * 3. Within each cluster, assign column indices greedily:
 *    For each event (sorted by start), pick the lowest column index
 *    not occupied by any currently overlapping event.
 * 4. Each cluster has a total number of columns = max column index + 1.
 *    Each event's width = 1/totalColumns of the day column width,
 *    and its left offset = columnIndex / totalColumns.
 *
 * This guarantees:
 * - No two events visually overlap.
 * - N identical-time events get N equal-width columns filling the day.
 * - Events outside any cluster use the full width.
 */

/**
 * @typedef {Object} EventLayout
 * @property {number} id
 * @property {string} title
 * @property {number} startMinutes - minutes from midnight (0-1440)
 * @property {number} endMinutes - minutes from midnight (0-1440)
 * @property {number} column - assigned column index
 * @property {number} totalColumns - total columns in this cluster
 */

/**
 * Compute layout for a list of events on a single day.
 * @param {Array<{id: number, title: string, startMinutes: number, endMinutes: number}>} events
 * @returns {EventLayout[]}
 */
export function computeDayLayout(events) {
  if (events.length === 0) return [];

  // Sort by start time, then by longer events first (end desc)
  const sorted = [...events].sort((a, b) => {
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return b.endMinutes - a.endMinutes;
  });

  // Build overlap clusters
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
      // Start a new cluster
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterEnd = ev.endMinutes;
    }
  }
  clusters.push(currentCluster);

  // For each cluster, assign columns greedily
  const results = [];

  for (const cluster of clusters) {
    // cluster is already sorted by start time
    const columnEnds = []; // columnEnds[i] = the end time of the last event placed in column i

    const assignments = [];
    for (const ev of cluster) {
      // Find the first column where no event overlaps
      let col = -1;
      for (let c = 0; c < columnEnds.length; c++) {
        if (columnEnds[c] <= ev.startMinutes) {
          col = c;
          break;
        }
      }
      if (col === -1) {
        col = columnEnds.length;
        columnEnds.push(0);
      }
      columnEnds[col] = ev.endMinutes;
      assignments.push({ ...ev, column: col });
    }

    const totalColumns = columnEnds.length;
    for (const a of assignments) {
      results.push({
        ...a,
        totalColumns
      });
    }
  }

  return results;
}
