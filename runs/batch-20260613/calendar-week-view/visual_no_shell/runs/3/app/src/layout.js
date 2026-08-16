/**
 * Cluster-based overlap layout engine.
 *
 * Given a list of events for a single day, computes the visual column
 * assignment and width fraction for each event so that no two events
 * visually overlap.
 *
 * Algorithm:
 * 1. Sort events by start time (then by end time descending for stability).
 * 2. Group into clusters: a cluster is a maximal set of events where every
 *    pair is transitively connected by overlapping intervals.
 * 3. Within each cluster, greedily assign events to the first available
 *    visual column (a column is available if its last event has ended).
 * 4. Each event's width = 1 / (number of columns in its cluster).
 *    Its left offset = columnIndex / numColumns.
 *
 * Returns an array of layout objects:
 *   { event, left, width }   (fractions of the day-column width, 0..1)
 */
export function computeDayLayout(events) {
  if (!events || events.length === 0) return [];

  // Sort by start time, then by end time descending (longer events first)
  const sorted = [...events].sort((a, b) => {
    const startDiff = getMinutesOfDay(a.start_at) - getMinutesOfDay(b.start_at);
    if (startDiff !== 0) return startDiff;
    return getMinutesOfDay(b.end_at) - getMinutesOfDay(a.end_at);
  });

  // Step 1: Build clusters (maximal groups of transitively overlapping events)
  const clusters = buildClusters(sorted);

  // Step 2: For each cluster, assign visual columns
  const result = [];
  for (const cluster of clusters) {
    const colAssignments = assignColumns(cluster);
    const numCols = colAssignments.numCols;

    for (const { event, col } of colAssignments.assignments) {
      result.push({
        event,
        left:  col / numCols,
        width: 1 / numCols,
      });
    }
  }

  return result;
}

/**
 * Returns minutes elapsed since the start of the day for a clamped event
 * timestamp. Handles the special case where an event ends at midnight of the
 * NEXT day (i.e. 24:00 = 1440 minutes).
 *
 * The caller is responsible for passing clamped timestamps: start_at is
 * clamped to >= day 00:00 and end_at is clamped to <= next-day 00:00.
 *
 * We detect the midnight-end case by checking if the time component is
 * exactly 00:00:00.000 AND the date is one day after the event's start date.
 * Since the layout engine receives pairs of (start_at, end_at) for the same
 * logical day, we use a simpler heuristic: if the local time is 00:00 and
 * the value is being used as an end time, treat it as 1440.
 *
 * To avoid ambiguity, we export two functions:
 *   getMinutesStart(ts) — for start times (00:00 = 0)
 *   getMinutesEnd(ts)   — for end times   (00:00 = 1440 if it's midnight)
 */
export function getMinutesStart(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

export function getMinutesEnd(ts) {
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes();
  // If the time component is exactly midnight (0), this is the end-of-day
  // clamp (24:00). Return 1440 so height is computed correctly.
  return m === 0 ? 1440 : m;
}

/**
 * Returns minutes from midnight for layout purposes.
 * For start times use getMinutesStart; for end times use getMinutesEnd.
 * This function is used internally where we need a unified value.
 */
export function getMinutes(ts) {
  return getMinutesStart(ts);
}

/**
 * Groups events into maximal clusters of transitively overlapping events.
 * Two events overlap if one starts before the other ends (strict).
 */
function buildClusters(sortedEvents) {
  const clusters    = [];
  let currentCluster = [];
  let clusterEnd    = -Infinity; // latest end time (minutes) in current cluster

  for (const event of sortedEvents) {
    const start = getMinutesStart(event.start_at);
    const end   = getMinutesEnd(event.end_at);

    if (currentCluster.length === 0 || start < clusterEnd) {
      currentCluster.push(event);
      clusterEnd = Math.max(clusterEnd, end);
    } else {
      clusters.push(currentCluster);
      currentCluster = [event];
      clusterEnd     = end;
    }
  }

  if (currentCluster.length > 0) clusters.push(currentCluster);
  return clusters;
}

/**
 * Greedily assigns visual columns to events within a cluster.
 * Returns { assignments: [{event, col}], numCols }.
 */
function assignColumns(clusterEvents) {
  // columns[i] = end time (minutes) of the last event placed in column i
  const columns = [];

  const assignments = clusterEvents.map(event => {
    const start = getMinutesStart(event.start_at);
    const end   = getMinutesEnd(event.end_at);

    // Find the first column whose last event has already ended
    let col = -1;
    for (let i = 0; i < columns.length; i++) {
      if (columns[i] <= start) {
        col = i;
        break;
      }
    }

    if (col === -1) {
      col = columns.length;
      columns.push(end);
    } else {
      columns[col] = end;
    }

    return { event, col };
  });

  return { assignments, numCols: columns.length };
}

/**
 * Internal helper used only for sorting — same as getMinutesStart but
 * named clearly for the sort comparator.
 */
function getMinutesOfDay(ts) {
  return getMinutesStart(ts);
}
