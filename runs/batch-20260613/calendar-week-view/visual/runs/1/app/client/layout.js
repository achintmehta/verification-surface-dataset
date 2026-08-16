/**
 * Cluster-based overlap layout engine.
 *
 * Algorithm:
 * 1. Sort events by start time.
 * 2. Group into clusters: maximal sets of transitively overlapping events.
 *    Two events overlap if one starts before the other ends (strict).
 * 3. Within each cluster, assign column indices greedily:
 *    - For each event (sorted by start), assign the lowest column index
 *      not occupied by any event that overlaps it.
 * 4. The cluster's column count = max assigned index + 1.
 * 5. Each event's left = colIndex / numCols, width = 1 / numCols.
 *
 * Returns an array of positioned events:
 *   { id, startMin, endMin, left, width }
 * where left and width are fractions of the day column (0..1).
 */
export function computeLayout(events) {
  if (!events || events.length === 0) return [];

  // Sort by start time, then by end time descending (longer events first)
  const sorted = [...events].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.endMin - a.endMin;
  });

  // ── Step 1: Build clusters ──────────────────────────────────────────────────
  // A cluster is a maximal set of events where every event overlaps at least
  // one other event in the set (transitive closure).
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < sorted.length; i++) {
    if (assigned.has(i)) continue;

    // Start a new cluster with event i
    const cluster = [i];
    assigned.add(i);

    // Expand cluster: find all events that transitively overlap any event in cluster
    // We track the maximum end time of the cluster to efficiently check overlap
    let clusterMaxEnd = sorted[i].endMin;

    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < sorted.length; j++) {
        if (assigned.has(j)) continue;
        // Check if event j overlaps any event already in the cluster
        // Since events are sorted by start, event j starts at sorted[j].startMin
        // It overlaps the cluster if its start < clusterMaxEnd AND its end > clusterMinStart
        // More precisely: check against each cluster member
        const overlapsCluster = cluster.some(ci => overlaps(sorted[ci], sorted[j]));
        if (overlapsCluster) {
          cluster.push(j);
          assigned.add(j);
          clusterMaxEnd = Math.max(clusterMaxEnd, sorted[j].endMin);
          changed = true;
        }
      }
    }

    clusters.push(cluster.map(ci => sorted[ci]));
  }

  // ── Step 2: Assign columns within each cluster ──────────────────────────────
  const result = [];

  for (const cluster of clusters) {
    // Sort cluster events by start time (they may already be sorted)
    const clusterSorted = [...cluster].sort((a, b) => {
      if (a.startMin !== b.startMin) return a.startMin - b.startMin;
      return b.endMin - a.endMin;
    });

    // colAssignments[i] = column index for clusterSorted[i]
    const colAssignments = new Array(clusterSorted.length).fill(-1);
    // For each column, track the events assigned to it
    const columns = []; // columns[colIdx] = array of event indices in clusterSorted

    for (let i = 0; i < clusterSorted.length; i++) {
      const ev = clusterSorted[i];

      // Find the lowest column where no existing event overlaps ev
      let placed = false;
      for (let col = 0; col < columns.length; col++) {
        const colEvents = columns[col];
        const hasConflict = colEvents.some(j => overlaps(clusterSorted[j], ev));
        if (!hasConflict) {
          colAssignments[i] = col;
          columns[col].push(i);
          placed = true;
          break;
        }
      }

      if (!placed) {
        // Need a new column
        colAssignments[i] = columns.length;
        columns.push([i]);
      }
    }

    const numCols = columns.length;

    // ── Step 3: Compute width for each event ──────────────────────────────────
    // Standard approach: each event gets width = 1/numCols.
    // For a more space-efficient layout, we could compute the max concurrent
    // columns at each event's time range, but the spec says "divide the
    // cluster's width equally among its columns", so we use numCols.
    for (let i = 0; i < clusterSorted.length; i++) {
      const ev = clusterSorted[i];
      const col = colAssignments[i];

      result.push({
        id:       ev.id,
        startMin: ev.startMin,
        endMin:   ev.endMin,
        left:     col / numCols,
        width:    1 / numCols,
      });
    }
  }

  return result;
}

/**
 * Returns true if two events overlap in time (strict: one starts before the other ends).
 */
function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}
