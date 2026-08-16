/**
 * Overlap layout engine.
 *
 * Given events for a single day, groups them into overlap clusters,
 * assigns columns greedily by start time, and returns layout info
 * (column index, total columns in cluster) for each event.
 */

/**
 * Compute minutes from midnight for a Date within a given day.
 * Clamps to [0, 1440].
 */
export function minutesInDay(date, dayStart) {
  const diffMs = date.getTime() - dayStart.getTime();
  const mins = diffMs / 60000;
  return Math.max(0, Math.min(1440, mins));
}

/**
 * Two events overlap if one starts before the other ends and vice versa.
 * We use strict overlap: eventA.start < eventB.end && eventB.start < eventA.end
 */
function eventsOverlap(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

/**
 * Given an array of events (each with startMin, endMin already computed),
 * compute layout: returns a Map from event.id to { column, totalColumns }.
 *
 * Algorithm:
 * 1. Sort events by startMin, then by endMin descending (longer events first).
 * 2. Build overlap clusters (maximal sets of transitively overlapping events).
 * 3. Within each cluster, greedily assign columns by start time.
 * 4. Each event in the cluster gets width = 1/totalColumns, left = column/totalColumns.
 */
export function computeLayout(events) {
  if (events.length === 0) return new Map();

  // Sort by start, then longer events first (earlier end last => descending endMin? No, longer = later end)
  // Actually: sort by startMin asc, then endMin desc (longer events first when same start)
  const sorted = [...events].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.endMin - a.endMin; // longer events first
  });

  // Build clusters: groups of transitively overlapping events
  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = sorted[0].endMin;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.startMin < clusterEnd) {
      // This event overlaps with the current cluster
      currentCluster.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMin);
    } else {
      // Start a new cluster
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterEnd = ev.endMin;
    }
  }
  clusters.push(currentCluster);

  // For each cluster, assign columns greedily
  const layoutMap = new Map();

  for (const cluster of clusters) {
    // cluster is already sorted by startMin
    // columns[i] = end time of the last event placed in column i
    const columns = [];

    for (const ev of cluster) {
      // Find the first column where the event fits (doesn't overlap)
      let placed = false;
      for (let col = 0; col < columns.length; col++) {
        if (ev.startMin >= columns[col]) {
          columns[col] = ev.endMin;
          layoutMap.set(ev.id, { column: col, totalColumns: 0 });
          placed = true;
          break;
        }
      }
      if (!placed) {
        const col = columns.length;
        columns.push(ev.endMin);
        layoutMap.set(ev.id, { column: col, totalColumns: 0 });
      }
    }

    // Total columns for this cluster
    const totalColumns = columns.length;
    for (const ev of cluster) {
      layoutMap.get(ev.id).totalColumns = totalColumns;
    }
  }

  return layoutMap;
}
