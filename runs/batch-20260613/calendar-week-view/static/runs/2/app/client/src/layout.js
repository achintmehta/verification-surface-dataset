/**
 * Overlap layout engine.
 *
 * Given a list of events for a single day, computes for each event:
 *   - colIndex  : which horizontal slot it occupies (0-based)
 *   - colCount  : total number of columns in its cluster
 *
 * Algorithm (cluster-based, greedy):
 *  1. Sort events by start time (ties broken by earlier end time).
 *  2. Build overlap clusters: a cluster is a maximal set of events where
 *     every event overlaps at least one other event in the set (transitive).
 *     Two events overlap when startA < endB && startB < endA.
 *  3. Within each cluster, assign column indices greedily:
 *     - Maintain a list of "column end times".
 *     - For each event (in start-time order), find the first column whose
 *       end time <= event.start; assign that column and update its end time.
 *       If no such column exists, open a new one.
 *  4. colCount for every event in the cluster = number of columns opened.
 *
 * Returns an array of layout objects parallel to the input array:
 *   { colIndex, colCount }
 */
export function computeDayLayout(events) {
  if (!events.length) return [];

  // Sort by start, then by end (longer events first within same start)
  const sorted = events
    .map((e, i) => ({ ...e, _origIdx: i, startMs: +new Date(e.start_at), endMs: +new Date(e.end_at) }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  // Build clusters (union-find style via sweep)
  const clusters = buildClusters(sorted);

  // Result array indexed by original position
  const result = new Array(events.length);

  for (const cluster of clusters) {
    const colEndTimes = []; // colEndTimes[i] = endMs of last event placed in column i

    for (const ev of cluster) {
      // Find first column where the last event ended <= this event's start
      let assigned = -1;
      for (let c = 0; c < colEndTimes.length; c++) {
        if (colEndTimes[c] <= ev.startMs) {
          assigned = c;
          break;
        }
      }
      if (assigned === -1) {
        assigned = colEndTimes.length;
        colEndTimes.push(0);
      }
      colEndTimes[assigned] = ev.endMs;
      ev._colIndex = assigned;
    }

    const colCount = colEndTimes.length;
    for (const ev of cluster) {
      result[ev._origIdx] = { colIndex: ev._colIndex, colCount };
    }
  }

  return result;
}

/**
 * Groups sorted events into maximal overlap clusters.
 * A cluster is a maximal set of events where the union of their time ranges
 * forms a contiguous block (i.e. every event overlaps the "active window").
 *
 * We use a sweep: maintain the maximum end time seen so far in the current
 * cluster. If the next event's start >= that max end, it starts a new cluster.
 */
function buildClusters(sortedEvents) {
  const clusters = [];
  let current = [];
  let clusterMaxEnd = -Infinity;

  for (const ev of sortedEvents) {
    if (current.length === 0 || ev.startMs < clusterMaxEnd) {
      // Overlaps the current cluster window
      current.push(ev);
      if (ev.endMs > clusterMaxEnd) clusterMaxEnd = ev.endMs;
    } else {
      // No overlap — start a new cluster
      clusters.push(current);
      current = [ev];
      clusterMaxEnd = ev.endMs;
    }
  }

  if (current.length > 0) clusters.push(current);
  return clusters;
}
