/**
 * Overlap layout engine.
 *
 * Given a list of events for a single day, computes layout columns so that
 * overlapping events are placed side-by-side and non-overlapping events
 * use the full column width.
 *
 * Returns an array of { event, column, totalColumns } objects.
 */

/**
 * Two events overlap if one starts before the other ends and vice versa.
 * We use strict inequality: [s1, e1) overlaps [s2, e2) iff s1 < e2 && s2 < e1.
 */
function eventsOverlap(a, b) {
  return a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;
}

/**
 * Groups events into maximal overlap clusters.
 * Events must be pre-sorted by startMinutes ascending, then endMinutes ascending.
 *
 * A cluster is a maximal set of events such that they are transitively connected
 * by pairwise overlap. We track the running maximum end time; when a new event
 * starts at or after that maximum, a new cluster begins.
 */
function buildClusters(sortedEvents) {
  const clusters = [];
  let current = null;

  for (const ev of sortedEvents) {
    if (!current || ev.startMinutes >= current.maxEnd) {
      // Start a new cluster
      current = { events: [ev], maxEnd: ev.endMinutes };
      clusters.push(current);
    } else {
      current.events.push(ev);
      if (ev.endMinutes > current.maxEnd) {
        current.maxEnd = ev.endMinutes;
      }
    }
  }

  return clusters;
}

/**
 * Within a cluster, greedily assign each event to the first available column.
 * Events are processed in order of start time. A column is "available" if its
 * last event ended at or before the current event's start.
 *
 * Returns the total number of columns used and annotates each event with its column index.
 */
function assignColumns(clusterEvents) {
  // columnEnds[i] = the end-minute of the last event placed in column i
  const columnEnds = [];
  const assignments = [];

  for (const ev of clusterEvents) {
    let placed = false;
    for (let col = 0; col < columnEnds.length; col++) {
      if (columnEnds[col] <= ev.startMinutes) {
        columnEnds[col] = ev.endMinutes;
        assignments.push({ event: ev, column: col });
        placed = true;
        break;
      }
    }
    if (!placed) {
      assignments.push({ event: ev, column: columnEnds.length });
      columnEnds.push(ev.endMinutes);
    }
  }

  return { assignments, totalColumns: columnEnds.length };
}

/**
 * Main entry point. Given events for a single day (each with startMinutes and endMinutes,
 * 0–1440), returns layout data for each event.
 *
 * @param {Array<{id, title, startMinutes: number, endMinutes: number}>} events
 * @returns {Array<{event, column: number, totalColumns: number}>}
 */
export function computeDayLayout(events) {
  if (events.length === 0) return [];

  // Sort by start time, then by end time
  const sorted = [...events].sort((a, b) => {
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return a.endMinutes - b.endMinutes;
  });

  const clusters = buildClusters(sorted);
  const results = [];

  for (const cluster of clusters) {
    const { assignments, totalColumns } = assignColumns(cluster.events);
    for (const a of assignments) {
      results.push({
        event: a.event,
        column: a.column,
        totalColumns,
      });
    }
  }

  return results;
}
