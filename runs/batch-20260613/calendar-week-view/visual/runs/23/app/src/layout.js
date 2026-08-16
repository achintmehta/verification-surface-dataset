/**
 * Layout engine for overlapping events within a single day.
 *
 * Algorithm:
 * 1. Sort events by start time, then by end time descending (longer events first).
 * 2. Group events into overlap clusters (maximal sets of transitively overlapping events).
 * 3. Within each cluster, assign columns greedily: for each event (in sorted order),
 *    assign it the leftmost column where it doesn't overlap with any already-placed event.
 * 4. The number of columns for the cluster is the max column index + 1.
 * 5. Each event's width = 1 / numColumns of the day column width.
 *    Each event's left offset = columnIndex / numColumns of the day column width.
 */

/**
 * Returns minutes from midnight for a Date, clamped to [0, 1440].
 */
export function minutesFromMidnight(date, dayStart) {
  // dayStart is midnight of the day column
  const diff = date.getTime() - dayStart.getTime();
  const mins = diff / 60000;
  return Math.max(0, Math.min(1440, mins));
}

/**
 * Compute layout positions for events within a single day.
 *
 * @param {Array} events - Array of {id, title, start_at, end_at} where start_at/end_at are ISO strings
 * @param {Date} dayStart - Midnight of this day
 * @returns {Array} Array of {event, top, height, left, width} where top/height are in fractions of day (0-1),
 *          and left/width are fractions of the day column width (0-1).
 */
export function layoutEventsForDay(events, dayStart) {
  if (events.length === 0) return [];

  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  // Convert events to working format with clamped minute values
  const items = events.map(ev => {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);

    // Clamp to this day
    const clampedStart = start < dayStart ? dayStart : start;
    const clampedEnd = end > dayEnd ? dayEnd : end;

    const startMin = minutesFromMidnight(clampedStart, dayStart);
    const endMin = minutesFromMidnight(clampedEnd, dayStart);

    return {
      event: ev,
      startMin,
      endMin
    };
  }).filter(item => item.endMin > item.startMin); // Filter out zero-duration after clamping

  // Sort by start time, then by longer duration first (end time descending)
  items.sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.endMin - a.endMin;
  });

  // Check if two items overlap
  function overlaps(a, b) {
    return a.startMin < b.endMin && b.startMin < a.endMin;
  }

  // Group into overlap clusters
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < items.length; i++) {
    if (assigned.has(i)) continue;

    // Start a new cluster with item i
    const cluster = [i];
    assigned.add(i);

    // Expand cluster transitively
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (let j = 0; j < items.length; j++) {
        if (assigned.has(j)) continue;
        // Check if j overlaps with any item already in this cluster
        for (const ci of cluster) {
          if (overlaps(items[j], items[ci])) {
            cluster.push(j);
            assigned.add(j);
            expanded = true;
            break;
          }
        }
      }
    }

    clusters.push(cluster);
  }

  // Layout each cluster
  const results = [];

  for (const cluster of clusters) {
    // Sort cluster items by start time, then longer first
    const clusterItems = cluster.map(i => items[i]);
    clusterItems.sort((a, b) => {
      if (a.startMin !== b.startMin) return a.startMin - b.startMin;
      return b.endMin - a.endMin;
    });

    // Greedy column assignment
    // columns[colIndex] = endMin of the latest event in that column
    const columns = [];

    const columnAssignments = [];

    for (const item of clusterItems) {
      // Find the leftmost column where this item fits (no overlap)
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (item.startMin >= columns[c]) {
          // We can place here — but check all events in this column for overlap
          columns[c] = item.endMin;
          columnAssignments.push({ item, col: c });
          placed = true;
          break;
        }
      }
      if (!placed) {
        columnAssignments.push({ item, col: columns.length });
        columns.push(item.endMin);
      }
    }

    const numCols = columns.length;

    for (const { item, col } of columnAssignments) {
      results.push({
        event: item.event,
        top: item.startMin / 1440,
        height: (item.endMin - item.startMin) / 1440,
        left: col / numCols,
        width: 1 / numCols
      });
    }
  }

  return results;
}
