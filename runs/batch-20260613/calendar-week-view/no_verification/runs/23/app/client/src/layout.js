/**
 * Overlap layout engine for calendar events.
 *
 * Given a list of events for a single day, computes each event's column index
 * and the total number of columns in its cluster, so that overlapping events
 * are rendered side-by-side.
 *
 * Algorithm:
 * 1. Sort events by start time, then by end time descending (longer events first).
 * 2. Build overlap clusters: maximal sets of transitively overlapping events.
 * 3. Within each cluster, greedily assign columns by start time.
 * 4. Each event's width = 1/clusterColumns, offset = colIndex/clusterColumns.
 */

/**
 * Check if two events overlap in time.
 * Events overlap if one starts before the other ends and vice versa.
 * We use strict inequality: events touching at a boundary do NOT overlap.
 */
function eventsOverlap(a, b) {
  return a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;
}

/**
 * Compute layout for a list of events on a single day.
 *
 * Each event should have:
 *   - startMinutes: minutes from midnight (0-1440)
 *   - endMinutes: minutes from midnight (0-1440)
 *   - (other fields are preserved)
 *
 * Returns an array of layout objects:
 *   { ...event, column, totalColumns }
 */
export function computeDayLayout(events) {
  if (!events || events.length === 0) return [];

  // Sort by start time, then by duration descending (longer first for stability)
  const sorted = [...events].sort((a, b) => {
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return b.endMinutes - a.endMinutes; // longer events first
  });

  // Build clusters of transitively overlapping events
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

  // For each cluster, assign columns greedily
  const results = [];

  for (const cluster of clusters) {
    // columns[i] = end time of the last event placed in column i
    const columns = [];

    for (const ev of cluster) {
      // Find the first column where this event fits
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (ev.startMinutes >= columns[c]) {
          // Event fits in this column
          columns[c] = ev.endMinutes;
          results.push({ ...ev, column: c, totalColumns: 0 });
          placed = true;
          break;
        }
      }
      if (!placed) {
        // Need a new column
        const c = columns.length;
        columns.push(ev.endMinutes);
        results.push({ ...ev, column: c, totalColumns: 0 });
      }
    }

    // Set totalColumns for all events in this cluster
    const totalCols = columns.length;
    for (const r of results) {
      if (r.totalColumns === 0) {
        r.totalColumns = totalCols;
      }
    }
  }

  return results;
}

/**
 * Given an event's startMinutes, endMinutes, and the axis height (in px),
 * compute its top and height in pixels.
 *
 * axisHeight is the total height for 24 hours (1440 minutes).
 */
export function computeEventPosition(startMinutes, endMinutes, axisHeight) {
  const minuteHeight = axisHeight / 1440;
  const top = startMinutes * minuteHeight;
  const height = (endMinutes - startMinutes) * minuteHeight;
  return { top, height };
}
