/**
 * Cluster-based overlap layout engine.
 *
 * Given a list of events for a single day, computes the visual column
 * assignment and width fraction for each event so that:
 *   - No two event blocks overlap visually.
 *   - Events that do not overlap use the full column width.
 *   - N events sharing the same time range render as N equal-width blocks.
 *
 * Algorithm:
 *   1. Sort events by start time (ties broken by id for stability).
 *   2. Group into "clusters": maximal sets of transitively overlapping events.
 *      Two events overlap when one starts before the other ends.
 *   3. Within each cluster, greedily assign visual columns:
 *      - Maintain a list of "lanes", each tracking the latest end time.
 *      - For each event (in start-time order), place it in the first lane
 *        whose latest end time <= event's start time.
 *      - If no such lane exists, open a new one.
 *   4. Each event's width fraction = 1 / (number of lanes in its cluster).
 *      Its left offset fraction = laneIndex / numLanes.
 *
 * Returns an array of layout descriptors parallel to the input events array.
 */

/**
 * @typedef {Object} CalendarEvent
 * @property {number|string} id
 * @property {string} title
 * @property {string} start_at  ISO datetime string
 * @property {string} end_at    ISO datetime string
 */

/**
 * @typedef {Object} LayoutItem
 * @property {CalendarEvent} event
 * @property {number} top        0–1 fraction of day height
 * @property {number} height     0–1 fraction of day height
 * @property {number} left       0–1 fraction of column width
 * @property {number} width      0–1 fraction of column width
 */

const MINUTES_PER_DAY = 24 * 60; // 1440

/**
 * Convert an ISO datetime string to minutes since midnight of its date (local time).
 * Clamps to [0, 1440].
 * @param {string} iso
 * @returns {number}
 */
export function isoToMinutes(iso) {
  const d = new Date(iso);
  const minutes = d.getHours() * 60 + d.getMinutes();
  return Math.max(0, Math.min(MINUTES_PER_DAY, minutes));
}

/**
 * Compute minutes-from-midnight for a start/end pair, correctly handling
 * events that end at midnight of the next day (24:00 = 1440 minutes).
 *
 * @param {string} startIso
 * @param {string} endIso
 * @returns {{ startMin: number, endMin: number }}
 */
export function eventMinutes(startIso, endIso) {
  const startDate = new Date(startIso);
  const endDate   = new Date(endIso);

  // Midnight of the start day (local time)
  const dayStart = new Date(startDate);
  dayStart.setHours(0, 0, 0, 0);

  const startMin = Math.round((startDate.getTime() - dayStart.getTime()) / 60000);
  const endMin   = Math.round((endDate.getTime()   - dayStart.getTime()) / 60000);

  return {
    startMin: Math.max(0, Math.min(startMin, MINUTES_PER_DAY)),
    endMin:   Math.max(0, Math.min(endMin,   MINUTES_PER_DAY)),
  };
}

/**
 * Compute layout for a list of events belonging to a single day column.
 *
 * @param {CalendarEvent[]} events
 * @returns {LayoutItem[]}
 */
export function computeDayLayout(events) {
  if (events.length === 0) return [];

  // Step 1: sort by start time, then by id for stability
  const sorted = [...events].sort((a, b) => {
    const diff = new Date(a.start_at) - new Date(b.start_at);
    return diff !== 0 ? diff : (a.id < b.id ? -1 : 1);
  });

  // Step 2: build clusters (maximal sets of transitively overlapping events)
  const clusters = buildClusters(sorted);

  // Step 3 & 4: assign lanes within each cluster
  const layoutMap = new Map(); // event.id -> LayoutItem

  for (const cluster of clusters) {
    const numLanes = assignLanes(cluster, layoutMap);
    // Update width for all events in this cluster now that we know numLanes
    for (const ev of cluster) {
      const item = layoutMap.get(ev.id);
      item.width = 1 / numLanes;
      item.left  = item._laneIndex / numLanes;
    }
  }

  // Return in original input order
  return events.map(ev => layoutMap.get(ev.id));
}

/**
 * Group sorted events into clusters of transitively overlapping events.
 * A cluster is a maximal set where every event overlaps at least one other.
 *
 * @param {CalendarEvent[]} sorted  events sorted by start_at
 * @returns {CalendarEvent[][]}
 */
function buildClusters(sorted) {
  const clusters = [];
  let currentCluster = [];
  // Track the maximum end time seen so far in the current cluster
  let clusterMaxEnd = -Infinity;

  for (const ev of sorted) {
    const start = new Date(ev.start_at).getTime();
    const end   = new Date(ev.end_at).getTime();

    if (currentCluster.length === 0 || start < clusterMaxEnd) {
      // Overlaps with the current cluster (or first event)
      currentCluster.push(ev);
      if (end > clusterMaxEnd) clusterMaxEnd = end;
    } else {
      // No overlap: flush current cluster and start a new one
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterMaxEnd  = end;
    }
  }

  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  return clusters;
}

/**
 * Greedily assign lane indices to events within a cluster.
 * Mutates layoutMap with preliminary LayoutItems (width/left set later).
 *
 * @param {CalendarEvent[]} cluster  events in this cluster, sorted by start_at
 * @param {Map}             layoutMap
 * @returns {number}  total number of lanes used
 */
function assignLanes(cluster, layoutMap) {
  // lanes[i] = end time (ms) of the last event placed in lane i
  const laneEnds = [];

  for (const ev of cluster) {
    const startMs = new Date(ev.start_at).getTime();
    const endMs   = new Date(ev.end_at).getTime();
    const { startMin, endMin } = eventMinutes(ev.start_at, ev.end_at);

    // Find the first lane whose last event ends at or before this event's start
    let assignedLane = -1;
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] <= startMs) {
        assignedLane = i;
        break;
      }
    }

    if (assignedLane === -1) {
      // Open a new lane
      assignedLane = laneEnds.length;
      laneEnds.push(endMs);
    } else {
      laneEnds[assignedLane] = endMs;
    }

    const top    = startMin / MINUTES_PER_DAY;
    const height = Math.max((endMin - startMin) / MINUTES_PER_DAY, 1 / MINUTES_PER_DAY);

    layoutMap.set(ev.id, {
      event:      ev,
      top,
      height,
      left:       0,   // filled in after we know numLanes
      width:      1,   // filled in after we know numLanes
      _laneIndex: assignedLane,
    });
  }

  return laneEnds.length;
}

/**
 * Group a flat list of events by their date (YYYY-MM-DD in local time).
 *
 * @param {CalendarEvent[]} events
 * @returns {Map<string, CalendarEvent[]>}
 */
export function groupByDay(events) {
  const map = new Map();
  for (const ev of events) {
    const key = localDateKey(new Date(ev.start_at));
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ev);
  }
  return map;
}

/**
 * Return "YYYY-MM-DD" for a Date in local time.
 * @param {Date} d
 * @returns {string}
 */
export function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
