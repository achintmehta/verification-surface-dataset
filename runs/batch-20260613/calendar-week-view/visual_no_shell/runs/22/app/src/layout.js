/**
 * Overlap layout engine.
 * 
 * Given a list of events for a single day, computes layout columns
 * so that overlapping events are placed side-by-side.
 * 
 * Returns events augmented with: column, totalColumns
 */

/**
 * Two events overlap if one starts before the other ends. 
 * (They must share strictly positive time overlap.)
 */
function eventsOverlap(a, b) {
  return a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;
}

/**
 * Group events into overlap clusters (maximal sets of transitively overlapping events).
 * Events should be pre-sorted by startMinutes.
 */
function buildClusters(events) {
  if (events.length === 0) return [];

  const clusters = [];
  let currentCluster = [events[0]];
  let clusterEnd = events[0].endMinutes;

  for (let i = 1; i < events.length; i++) {
    const ev = events[i];
    if (ev.startMinutes < clusterEnd) {
      // This event overlaps with the current cluster
      currentCluster.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMinutes);
    } else {
      // No overlap: start a new cluster
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterEnd = ev.endMinutes;
    }
  }
  clusters.push(currentCluster);

  return clusters;
}

/**
 * Within a cluster, assign columns greedily by start time.
 * Each event gets the lowest-numbered column where it doesn't overlap
 * with any event already assigned to that column.
 */
function assignColumns(cluster) {
  // columns[i] = array of events in column i
  const columns = [];

  for (const ev of cluster) {
    let placed = false;
    for (let col = 0; col < columns.length; col++) {
      // Check if ev overlaps with the last event in this column
      // (since events are sorted by start time, we only need to check the last one)
      const lastInCol = columns[col][columns[col].length - 1];
      if (!eventsOverlap(lastInCol, ev)) {
        columns[col].push(ev);
        ev.column = col;
        placed = true;
        break;
      }
    }
    if (!placed) {
      ev.column = columns.length;
      columns.push([ev]);
    }
  }

  const totalColumns = columns.length;
  for (const ev of cluster) {
    ev.totalColumns = totalColumns;
  }

  return totalColumns;
}

/**
 * Compute layout for a list of events in a single day.
 * 
 * Each event object should have:
 *   - startMinutes: number (minutes from midnight)
 *   - endMinutes: number (minutes from midnight, clamped to 1440)
 * 
 * After this function, each event will also have:
 *   - column: number (0-based column index)
 *   - totalColumns: number (total columns in its cluster)
 */
export function computeLayout(events) {
  if (events.length === 0) return;

  // Sort by start time, then by end time (longer events first for consistent layout)
  events.sort((a, b) => {
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return a.endMinutes - b.endMinutes;
  });

  const clusters = buildClusters(events);

  for (const cluster of clusters) {
    assignColumns(cluster);
  }
}
