/**
 * Layout engine for overlapping calendar events.
 *
 * Algorithm:
 * 1. Sort events by start time, then by end time descending (longer events first).
 * 2. Group into overlap clusters: a cluster is a maximal set of transitively
 *    overlapping events. A new event joins the current cluster if its start time
 *    is before the cluster's running maximum end time.
 * 3. Within each cluster, greedily assign columns: for each event (sorted by start),
 *    pick the first column whose last event ends at or before this event's start.
 * 4. The total columns in a cluster determines the width fraction for each event.
 *    Events outside the cluster get full width.
 *
 * Returns an array of { event, top, height, left (fraction), width (fraction) }.
 */

/**
 * Convert an event's start/end times to minutes from midnight for a given day.
 * Clamps to [0, 1440].
 */
export function eventToMinutes(event, dayStart) {
  const dayMs = dayStart.getTime();
  const dayEndMs = dayMs + 24 * 60 * 60 * 1000;

  const startMs = new Date(event.start_at).getTime();
  const endMs = new Date(event.end_at).getTime();

  // Clamp to the day boundaries
  const clampedStart = Math.max(startMs, dayMs);
  const clampedEnd = Math.min(endMs, dayEndMs);

  const startMin = (clampedStart - dayMs) / 60000;
  const endMin = (clampedEnd - dayMs) / 60000;

  return {
    startMin: Math.max(0, Math.min(1440, startMin)),
    endMin: Math.max(0, Math.min(1440, endMin)),
  };
}

/**
 * Compute layout for events on a single day.
 *
 * @param {Array} events - events to lay out, each with start_at and end_at strings
 * @param {Date} dayStart - midnight of the day
 * @param {number} axisHeight - total pixel height of the time axis (24 hours)
 * @returns {Array} layout entries: { event, top, height, left, width }
 *   where left and width are CSS-ready strings (percentages)
 */
export function layoutDay(events, dayStart, axisHeight) {
  if (!events || events.length === 0) return [];

  const pixelsPerMinute = axisHeight / 1440;

  // Compute minute ranges
  const items = events.map((ev) => {
    const { startMin, endMin } = eventToMinutes(ev, dayStart);
    return { event: ev, startMin, endMin };
  });

  // Sort by start time, then longer events first for stable greedy assignment
  items.sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.endMin - a.endMin; // longer events first
  });

  // Build overlap clusters
  const clusters = [];
  let clusterStart = -1;
  let clusterEnd = -1;
  let currentCluster = [];

  for (const item of items) {
    if (currentCluster.length === 0 || item.startMin < clusterEnd) {
      // Extends/joins current cluster
      currentCluster.push(item);
      if (currentCluster.length === 1) {
        clusterStart = item.startMin;
        clusterEnd = item.endMin;
      } else {
        clusterEnd = Math.max(clusterEnd, item.endMin);
      }
    } else {
      // Start new cluster
      clusters.push(currentCluster);
      currentCluster = [item];
      clusterStart = item.startMin;
      clusterEnd = item.endMin;
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  // Assign columns within each cluster
  const results = [];

  for (const cluster of clusters) {
    // columns[col] = end time of the last event placed in that column
    const columns = [];

    const assignments = []; // { item, col }

    for (const item of cluster) {
      // Find first column where the last event ends at or before this event's start
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= item.startMin) {
          columns[c] = item.endMin;
          assignments.push({ item, col: c });
          placed = true;
          break;
        }
      }
      if (!placed) {
        assignments.push({ item, col: columns.length });
        columns.push(item.endMin);
      }
    }

    const numCols = columns.length;

    for (const { item, col } of assignments) {
      const top = item.startMin * pixelsPerMinute;
      const height = (item.endMin - item.startMin) * pixelsPerMinute;
      const widthPct = 100 / numCols;
      const leftPct = col * widthPct;

      results.push({
        event: item.event,
        top,
        height,
        left: `${leftPct}%`,
        width: `${widthPct}%`,
      });
    }
  }

  return results;
}
