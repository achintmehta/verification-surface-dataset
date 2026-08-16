/**
 * Cluster-based overlap layout engine.
 *
 * Given a list of events for a single day, computes the visual column
 * assignment and width fraction for each event so that:
 *  - No two event blocks overlap visually.
 *  - Events that do not overlap use the full column width.
 *  - N events sharing the same time range render as N equal-width blocks.
 *
 * Returns an array of layout descriptors:
 *   { event, colIndex, colCount }
 *
 * colIndex  – 0-based column within the cluster
 * colCount  – total columns in the cluster (width = dayWidth / colCount)
 */
export function computeDayLayout(events) {
  if (!events || events.length === 0) return [];

  // Sort by start time, then by id for determinism
  const sorted = [...events].sort((a, b) => {
    const ds = a.startMin - b.startMin;
    return ds !== 0 ? ds : a.id - b.id;
  });

  // ── Step 1: Build overlap clusters ────────────────────────────────────────
  // A cluster is a maximal set of events where every event overlaps at least
  // one other event in the set (transitive closure).
  // Two events overlap iff startA < endB AND startB < endA.

  const clusters = [];
  let currentCluster = [];
  let clusterMaxEnd = -Infinity;

  for (const ev of sorted) {
    if (currentCluster.length === 0 || ev.startMin < clusterMaxEnd) {
      // Overlaps with the current cluster (or starts it)
      currentCluster.push(ev);
      clusterMaxEnd = Math.max(clusterMaxEnd, ev.endMin);
    } else {
      // No overlap — flush current cluster and start a new one
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterMaxEnd = ev.endMin;
    }
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  // ── Step 2: Assign columns within each cluster ────────────────────────────
  // Greedy algorithm: for each event (in start-time order), assign it to the
  // first column whose last event ends at or before this event's start.

  const result = [];

  for (const cluster of clusters) {
    // colEnds[i] = the endMin of the last event placed in column i
    const colEnds = [];

    const clusterLayout = cluster.map(ev => {
      // Find the first column that is free at ev.startMin
      let assigned = -1;
      for (let c = 0; c < colEnds.length; c++) {
        if (colEnds[c] <= ev.startMin) {
          assigned = c;
          break;
        }
      }
      if (assigned === -1) {
        // Need a new column
        assigned = colEnds.length;
        colEnds.push(ev.endMin);
      } else {
        colEnds[assigned] = ev.endMin;
      }
      return { event: ev, colIndex: assigned };
    });

    const colCount = colEnds.length;
    for (const item of clusterLayout) {
      result.push({ event: item.event, colIndex: item.colIndex, colCount });
    }
  }

  return result;
}

/**
 * Convert a Date (or ISO string) to minutes from midnight (local time).
 */
export function toMinutes(dateOrStr) {
  const d = dateOrStr instanceof Date ? dateOrStr : new Date(dateOrStr);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Clamp minutes to [0, 1440].
 */
export function clampMinutes(m) {
  return Math.max(0, Math.min(1440, m));
}
