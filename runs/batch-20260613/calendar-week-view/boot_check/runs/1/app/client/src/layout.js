/**
 * Cluster-based overlap layout engine.
 *
 * Given a list of events for a single day, computes the visual layout
 * (column index and total columns) for each event so that:
 *  - Overlapping events are placed side-by-side (never on top of each other).
 *  - Non-overlapping events use the full column width.
 *  - Width is divided equally among all columns in a cluster.
 *
 * Algorithm:
 *  1. Sort events by start time (ties broken by id).
 *  2. Build overlap clusters: a cluster is a maximal set of transitively
 *     overlapping events. Two events overlap if one starts before the other ends.
 *  3. Within each cluster, assign column slots greedily: for each event (in
 *     start-time order), assign the lowest-indexed slot whose last occupant
 *     ends at or before this event's start.
 *  4. The cluster's column count = max slot index used + 1.
 *  5. Each event's left offset = slotIndex / totalCols, width = 1 / totalCols.
 */

/**
 * @typedef {Object} CalEvent
 * @property {number} id
 * @property {string} title
 * @property {string} start_at  ISO datetime string
 * @property {string} end_at    ISO datetime string
 */

/**
 * @typedef {Object} LayoutEvent
 * @property {CalEvent} event
 * @property {number} colIndex   0-based column within the cluster
 * @property {number} colTotal   total columns in the cluster
 */

/**
 * Compute layout for a list of events belonging to a single day.
 * @param {CalEvent[]} events
 * @returns {LayoutEvent[]}
 */
export function computeDayLayout(events) {
  if (events.length === 0) return [];

  // Sort by start time, then by id for determinism
  const sorted = [...events].sort((a, b) => {
    const diff = new Date(a.start_at) - new Date(b.start_at);
    return diff !== 0 ? diff : a.id - b.id;
  });

  // Build clusters: each cluster is an array of event indices (into `sorted`)
  const clusters = buildClusters(sorted);

  // For each cluster, assign column slots
  const result = new Array(sorted.length);

  for (const cluster of clusters) {
    const slots = assignSlots(cluster, sorted);
    const colTotal = slots.numCols;

    for (const { idx, colIndex } of slots.assignments) {
      result[idx] = {
        event: sorted[idx],
        colIndex,
        colTotal,
      };
    }
  }

  return result;
}

/**
 * Build maximal overlap clusters.
 * A cluster is a maximal set of events where every event overlaps with at
 * least one other event in the set (transitive closure).
 *
 * Two events A and B overlap iff A.start < B.end AND B.start < A.end.
 *
 * @param {CalEvent[]} sorted  events sorted by start_at
 * @returns {number[][]}  array of clusters; each cluster is an array of indices into `sorted`
 */
function buildClusters(sorted) {
  const clusters = [];
  let currentCluster = [];
  // Track the maximum end time seen so far in the current cluster
  let clusterMaxEnd = -Infinity;

  for (let i = 0; i < sorted.length; i++) {
    const start = new Date(sorted[i].start_at).getTime();
    const end   = new Date(sorted[i].end_at).getTime();

    if (currentCluster.length === 0 || start < clusterMaxEnd) {
      // This event overlaps with the current cluster (or starts it)
      currentCluster.push(i);
      if (end > clusterMaxEnd) clusterMaxEnd = end;
    } else {
      // No overlap — start a new cluster
      clusters.push(currentCluster);
      currentCluster = [i];
      clusterMaxEnd = end;
    }
  }

  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  return clusters;
}

/**
 * Greedy slot assignment within a cluster.
 *
 * For each event (in start-time order), assign the lowest-indexed slot
 * whose last occupant ends at or before this event's start time.
 *
 * @param {number[]} clusterIndices  indices into `sorted`
 * @param {CalEvent[]} sorted
 * @returns {{ assignments: {idx: number, colIndex: number}[], numCols: number }}
 */
function assignSlots(clusterIndices, sorted) {
  // slotEndTimes[s] = end time (ms) of the last event assigned to slot s
  const slotEndTimes = [];
  const assignments = [];

  for (const idx of clusterIndices) {
    const start = new Date(sorted[idx].start_at).getTime();
    const end   = new Date(sorted[idx].end_at).getTime();

    // Find the first slot that is free (its last event ended <= this event's start)
    let assigned = -1;
    for (let s = 0; s < slotEndTimes.length; s++) {
      if (slotEndTimes[s] <= start) {
        assigned = s;
        break;
      }
    }

    if (assigned === -1) {
      // No free slot — open a new one
      assigned = slotEndTimes.length;
      slotEndTimes.push(end);
    } else {
      slotEndTimes[assigned] = end;
    }

    assignments.push({ idx, colIndex: assigned });
  }

  return { assignments, numCols: slotEndTimes.length };
}

/**
 * Convert a time string "HH:MM" or a Date to minutes from midnight.
 * @param {Date|string} time
 * @returns {number}
 */
export function toMinutes(time) {
  if (time instanceof Date) {
    return time.getHours() * 60 + time.getMinutes();
  }
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Given a datetime string, return minutes from midnight (clamped 0–1440).
 * @param {string} isoStr
 * @returns {number}
 */
export function isoToMinutes(isoStr) {
  const d = new Date(isoStr);
  return Math.min(1440, Math.max(0, d.getHours() * 60 + d.getMinutes()));
}
