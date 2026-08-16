/**
 * Cluster-based overlap layout engine.
 *
 * Given an array of events for a single day, each with minuteStart and minuteEnd
 * (minutes from midnight, 0–1440), compute the layout: column index and total
 * columns in its cluster.
 *
 * Algorithm:
 * 1. Sort events by start time, then by end time descending (so longer events come first).
 * 2. Build maximal overlap clusters: a cluster is a set of events where each event
 *    overlaps at least one other event in the cluster (transitive closure of overlap).
 * 3. Within each cluster, greedily assign columns: iterate events in start-time order;
 *    assign each event the lowest-numbered column that is free at its start time.
 * 4. Each event in a cluster gets width = 1/maxColumns and left = column/maxColumns
 *    (as fractions of the day-column width).
 */

/**
 * @typedef {Object} EventInput
 * @property {number} id
 * @property {string} title
 * @property {number} minuteStart - minutes from midnight (0–1440)
 * @property {number} minuteEnd   - minutes from midnight (0–1440)
 */

/**
 * @typedef {Object} LayoutResult
 * @property {number} id
 * @property {string} title
 * @property {number} minuteStart
 * @property {number} minuteEnd
 * @property {number} column     - 0-based column index within cluster
 * @property {number} totalColumns - total columns in this cluster
 */

/**
 * Compute layout for a list of events on a single day.
 * @param {EventInput[]} events
 * @returns {LayoutResult[]}
 */
export function computeDayLayout(events) {
  if (events.length === 0) return [];

  // Sort by start time, then by longest duration first (descending end)
  const sorted = [...events].sort((a, b) => {
    if (a.minuteStart !== b.minuteStart) return a.minuteStart - b.minuteStart;
    return b.minuteEnd - a.minuteEnd;
  });

  // Build clusters: groups of transitively overlapping events
  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = sorted[0].minuteEnd;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.minuteStart < clusterEnd) {
      // Overlaps with the current cluster
      currentCluster.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.minuteEnd);
    } else {
      // No overlap; start a new cluster
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterEnd = ev.minuteEnd;
    }
  }
  clusters.push(currentCluster);

  // For each cluster, assign columns greedily
  const results = [];

  for (const cluster of clusters) {
    // columns[c] = end time of the last event placed in column c
    const columns = [];

    for (const ev of cluster) {
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= ev.minuteStart) {
          // This column is free
          columns[c] = ev.minuteEnd;
          ev._column = c;
          placed = true;
          break;
        }
      }
      if (!placed) {
        ev._column = columns.length;
        columns.push(ev.minuteEnd);
      }
    }

    const totalColumns = columns.length;

    for (const ev of cluster) {
      results.push({
        id: ev.id,
        title: ev.title,
        minuteStart: ev.minuteStart,
        minuteEnd: ev.minuteEnd,
        column: ev._column,
        totalColumns,
        // Preserve original event data for click handling
        _event: ev._event || ev
      });
    }
  }

  return results;
}
