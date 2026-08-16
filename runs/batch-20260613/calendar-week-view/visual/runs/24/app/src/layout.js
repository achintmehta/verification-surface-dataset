/**
 * Overlap Layout Engine
 * 
 * Groups transitively overlapping events into clusters, then assigns
 * horizontal columns greedily by start time within each cluster.
 */

/**
 * Two events overlap if one starts before the other ends
 * (using strict inequality since events are exclusive at endpoints).
 */
function eventsOverlap(a, b) {
  return a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;
}

/**
 * Given an array of events for a single day, each with:
 *   { id, title, startMinutes, endMinutes }
 * where startMinutes/endMinutes are minutes from midnight (0–1440),
 * 
 * Returns an array of layout objects:
 *   { ...event, column, totalColumns }
 * where column is 0-based and totalColumns is the cluster's column count.
 */
export function computeLayout(events) {
  if (events.length === 0) return [];

  // Sort by start time, then by end time (longer events first for ties)
  const sorted = [...events].sort((a, b) => {
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return b.endMinutes - a.endMinutes;
  });

  // Step 1: Group into overlap clusters (maximal sets of transitively overlapping events)
  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = sorted[0].endMinutes;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.startMinutes < clusterEnd) {
      // This event overlaps with something in the current cluster
      currentCluster.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMinutes);
    } else {
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterEnd = ev.endMinutes;
    }
  }
  clusters.push(currentCluster);

  // Step 2: For each cluster, assign columns greedily
  const result = [];

  for (const cluster of clusters) {
    // columns[i] = end time of the last event placed in column i
    const columns = [];

    const assignments = cluster.map(ev => {
      // Find the first column where this event fits (no overlap)
      let col = -1;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= ev.startMinutes) {
          col = c;
          break;
        }
      }
      if (col === -1) {
        col = columns.length;
        columns.push(0);
      }
      columns[col] = ev.endMinutes;
      return { ...ev, column: col };
    });

    const totalColumns = columns.length;

    for (const a of assignments) {
      result.push({ ...a, totalColumns });
    }
  }

  return result;
}

/**
 * Convert a Date to minutes from midnight.
 */
export function dateToMinutes(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Format minutes as HH:MM.
 */
export function minutesToTimeStr(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
