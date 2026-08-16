/**
 * Layout engine for calendar events.
 *
 * The algorithm:
 * 1. For a given day, sort events by start time, then by end time descending.
 * 2. Group events into "clusters" — maximal sets of transitively overlapping events.
 * 3. Within each cluster, greedily assign events to columns (the first column
 *    where no existing event overlaps).
 * 4. Each event's width = columnWidth / totalColumnsInCluster,
 *    and its left offset = columnIndex * (columnWidth / totalColumnsInCluster).
 *
 * This guarantees:
 * - No two event blocks ever visually overlap.
 * - N identical-time events get N equal-width columns.
 * - Events outside any cluster use the full day-column width.
 */

/**
 * Checks if two events overlap in time.
 * Events overlap if one starts before the other ends and vice versa.
 * @param {Object} a - { startMinutes, endMinutes }
 * @param {Object} b - { startMinutes, endMinutes }
 * @returns {boolean}
 */
function eventsOverlap(a, b) {
  return a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;
}

/**
 * Given an array of events for a single day, compute layout positions.
 *
 * Each event object should have:
 *   - id
 *   - startMinutes (minutes from midnight, 0–1440)
 *   - endMinutes   (minutes from midnight, 0–1440)
 *   - ...any other fields (title, etc)
 *
 * Returns an array of layout descriptors:
 *   { event, column, totalColumns }
 *
 * The caller converts column/totalColumns into pixel positions.
 */
export function computeDayLayout(events) {
  if (!events || events.length === 0) return [];

  // Sort by start time ascending, then by duration descending (longer events first)
  const sorted = [...events].sort((a, b) => {
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    // Longer events first so they get assigned earlier columns
    return (b.endMinutes - b.startMinutes) - (a.endMinutes - a.startMinutes);
  });

  // Step 1: Build clusters of transitively overlapping events
  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = sorted[0].endMinutes;

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.startMinutes < clusterEnd) {
      // This event overlaps with the current cluster
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

  // Step 2: For each cluster, assign columns greedily
  const results = [];

  for (const cluster of clusters) {
    // columns[i] = array of events in column i
    const columns = [];

    for (const ev of cluster) {
      // Find the first column where this event doesn't overlap with any existing event
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        // Check if ev overlaps with the last event in this column
        // Since events are sorted by start time, we only need to check the last event
        const lastInCol = columns[c][columns[c].length - 1];
        if (!eventsOverlap(ev, lastInCol)) {
          columns[c].push(ev);
          placed = true;
          break;
        }
      }
      if (!placed) {
        // Need a new column
        columns.push([ev]);
      }
    }

    const totalColumns = columns.length;

    for (let c = 0; c < columns.length; c++) {
      for (const ev of columns[c]) {
        results.push({
          event: ev,
          column: c,
          totalColumns
        });
      }
    }
  }

  return results;
}

/**
 * Convert minutes from midnight to a top position in pixels.
 * @param {number} minutes - minutes from midnight (0-1440)
 * @param {number} axisHeight - total pixel height of the 24-hour axis
 * @returns {number} pixel position from top
 */
export function minutesToPixels(minutes, axisHeight) {
  return (minutes / 1440) * axisHeight;
}

/**
 * Convert a pixel position to minutes from midnight.
 * @param {number} px - pixel position from top of the axis
 * @param {number} axisHeight - total pixel height of the 24-hour axis
 * @returns {number} minutes from midnight
 */
export function pixelsToMinutes(px, axisHeight) {
  return Math.round((px / axisHeight) * 1440);
}

/**
 * Get the start-of-day minutes for a Date in local time.
 * Returns minutes from midnight: hours * 60 + minutes
 */
export function dateToMinutes(date) {
  return date.getHours() * 60 + date.getMinutes();
}
