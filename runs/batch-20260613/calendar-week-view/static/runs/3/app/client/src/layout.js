/**
 * Cluster-based overlap layout engine.
 *
 * Given a list of events for a single day, computes the visual layout
 * (column index and total columns) for each event so that:
 *  - Overlapping events are placed side-by-side.
 *  - Non-overlapping events use the full column width.
 *  - The algorithm is O(n log n) in the number of events.
 *
 * Returns an array of layout descriptors:
 *   { event, colIndex, colCount }
 *
 * where:
 *   colIndex  – 0-based column within the cluster
 *   colCount  – total columns in the cluster (width = dayWidth / colCount)
 */

/**
 * @typedef {{ id: number, title: string, start_at: string, end_at: string }} CalEvent
 * @typedef {{ event: CalEvent, colIndex: number, colCount: number }} LayoutItem
 */

/**
 * Compute minutes from midnight for an ISO datetime string.
 *
 * @param {string} isoString  ISO datetime string (e.g. "2025-01-06T09:30:00")
 * @param {string} [dayStr]   "YYYY-MM-DD" of the event's calendar day.
 *                            When provided, if isoString falls on a later date
 *                            (e.g. an end time of midnight next day), returns
 *                            1440 (= 24:00) instead of 0.
 * @returns {number}  Minutes from midnight, in [0, 1440]
 */
export function minutesFromMidnight(isoString, dayStr) {
  const d = new Date(isoString);
  const minutes = d.getHours() * 60 + d.getMinutes();

  // If a reference day is provided and the datetime is on a later date,
  // treat it as 1440 (24:00 = end of day).
  if (dayStr) {
    const dateOnly = isoString.slice(0, 10);
    if (dateOnly > dayStr) {
      return 1440;
    }
  }

  return minutes;
}

/**
 * Group events into overlap clusters.
 *
 * A cluster is a maximal set of events where every event transitively
 * overlaps at least one other event in the set.
 *
 * Algorithm (sweep line):
 *  1. Sort events by start time (then by end time for stability).
 *  2. Sweep through; maintain the current cluster's maximum end time.
 *     When an event starts at or after the cluster's max end, start a new cluster.
 *
 * Correctness: events are sorted by start time, so if event[i].start >= maxEnd,
 * it cannot overlap any event in the current cluster (all their ends ≤ maxEnd).
 *
 * @param {CalEvent[]} events
 * @returns {CalEvent[][]} array of clusters
 */
function buildClusters(events) {
  if (events.length === 0) return [];

  const sorted = [...events].sort((a, b) => {
    const startDiff = new Date(a.start_at) - new Date(b.start_at);
    if (startDiff !== 0) return startDiff;
    return new Date(a.end_at) - new Date(b.end_at);
  });

  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterMaxEnd = new Date(sorted[0].end_at);

  for (let i = 1; i < sorted.length; i++) {
    const event = sorted[i];
    const eventStart = new Date(event.start_at);

    if (eventStart < clusterMaxEnd) {
      // This event overlaps the current cluster
      currentCluster.push(event);
      const eventEnd = new Date(event.end_at);
      if (eventEnd > clusterMaxEnd) {
        clusterMaxEnd = eventEnd;
      }
    } else {
      // No overlap: start a new cluster
      clusters.push(currentCluster);
      currentCluster = [event];
      clusterMaxEnd = new Date(event.end_at);
    }
  }
  clusters.push(currentCluster);

  return clusters;
}

/**
 * Assign column indices within a cluster using a greedy algorithm.
 *
 * Algorithm:
 *  - Maintain a list of "columns", each tracking the end time of the last
 *    event placed in that column.
 *  - For each event (in start-time order), find the first column whose last
 *    event ends at or before this event's start. If none, open a new column.
 *
 * This guarantees that events in the same column never overlap, and that
 * the number of columns equals the maximum number of simultaneously overlapping
 * events in the cluster.
 *
 * @param {CalEvent[]} cluster  Events in the cluster (sorted by start time)
 * @returns {{ event: CalEvent, colIndex: number }[]}
 */
function assignColumns(cluster) {
  const columnEnds = []; // End time of the last event in each column
  const assignments = [];

  for (const event of cluster) {
    const eventStart = new Date(event.start_at);
    let placed = false;

    for (let col = 0; col < columnEnds.length; col++) {
      if (columnEnds[col] <= eventStart) {
        // Column is free at this event's start time
        assignments.push({ event, colIndex: col });
        columnEnds[col] = new Date(event.end_at);
        placed = true;
        break;
      }
    }

    if (!placed) {
      // All existing columns are busy; open a new one
      assignments.push({ event, colIndex: columnEnds.length });
      columnEnds.push(new Date(event.end_at));
    }
  }

  return assignments;
}

/**
 * Compute the full layout for all events in a single day.
 *
 * Each returned item carries:
 *   - event:    the original event object
 *   - colIndex: 0-based column within its cluster
 *   - colCount: total columns in its cluster
 *
 * The event block's left offset = (colIndex / colCount) * 100%
 * The event block's width       = (1 / colCount) * 100%
 *
 * @param {CalEvent[]} events  All events for one day
 * @returns {LayoutItem[]}
 */
export function computeDayLayout(events) {
  if (events.length === 0) return [];

  const clusters = buildClusters(events);
  const result = [];

  for (const cluster of clusters) {
    const assignments = assignColumns(cluster);
    const colCount = assignments.reduce((max, a) => Math.max(max, a.colIndex + 1), 0);

    for (const { event, colIndex } of assignments) {
      result.push({ event, colIndex, colCount });
    }
  }

  return result;
}
