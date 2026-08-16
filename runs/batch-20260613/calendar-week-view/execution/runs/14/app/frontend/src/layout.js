// Pure cluster-based overlap layout engine.
//
// All geometry is computed as fractions/minutes so it can be unit-tested with
// no DOM. The renderer maps these fractions onto pixels.

export const MINUTES_PER_DAY = 24 * 60;

/**
 * Given an event's start/end (Date) and the day boundaries (Date), compute the
 * vertical placement within that day clamped to [0, MINUTES_PER_DAY].
 *
 * Returns { topMin, heightMin } in minutes from midnight, or null if the event
 * does not intersect the day at all.
 */
export function verticalPlacement(eventStart, eventEnd, dayStart, dayEnd) {
  const start = Math.max(eventStart.getTime(), dayStart.getTime());
  const end = Math.min(eventEnd.getTime(), dayEnd.getTime());
  if (end <= start) return null;

  const topMin = (start - dayStart.getTime()) / 60000;
  const heightMin = (end - start) / 60000;
  return { topMin, heightMin };
}

/**
 * Cluster-based overlap layout for a single day.
 *
 * Input: array of items shaped { id, topMin, heightMin } where each item is the
 * vertical placement of an event already clamped to this day (minutes).
 *
 * Output: array of { id, topMin, heightMin, widthFrac, leftFrac } where
 * widthFrac and leftFrac are fractions in [0,1] of the day column width.
 *
 * Algorithm:
 *  1. Sort by start time (then by end time for determinism).
 *  2. Walk events in order, building maximal clusters of transitively
 *     overlapping events. A cluster ends when an event starts at or after the
 *     maximum end seen so far in the cluster.
 *  3. Within a cluster, greedily assign each event to the first column whose
 *     last event has already ended (no overlap). The number of columns used is
 *     the cluster's width divisor; each event's width = 1 / columnsUsed and
 *     left = assignedColumn / columnsUsed.
 *
 * This guarantees no two blocks overlap visually, and a cluster needing only
 * one column fills the full width.
 */
export function layoutDay(items) {
  const sorted = [...items].sort((a, b) => {
    if (a.topMin !== b.topMin) return a.topMin - b.topMin;
    const aEnd = a.topMin + a.heightMin;
    const bEnd = b.topMin + b.heightMin;
    if (aEnd !== bEnd) return aEnd - bEnd;
    return String(a.id).localeCompare(String(b.id));
  });

  const result = [];
  let cluster = [];
  let clusterMaxEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    layoutCluster(cluster, result);
    cluster = [];
    clusterMaxEnd = -Infinity;
  };

  for (const item of sorted) {
    if (cluster.length > 0 && item.topMin >= clusterMaxEnd) {
      // No overlap with anything currently in the cluster -> new cluster.
      flush();
    }
    cluster.push(item);
    clusterMaxEnd = Math.max(clusterMaxEnd, item.topMin + item.heightMin);
  }
  flush();

  return result;
}

function layoutCluster(cluster, result) {
  // columns[i] holds the end time of the last event placed in column i.
  const columnEnds = [];
  const assigned = new Map(); // id -> column index

  for (const item of cluster) {
    let placed = false;
    for (let c = 0; c < columnEnds.length; c++) {
      if (item.topMin >= columnEnds[c]) {
        columnEnds[c] = item.topMin + item.heightMin;
        assigned.set(item.id, c);
        placed = true;
        break;
      }
    }
    if (!placed) {
      columnEnds.push(item.topMin + item.heightMin);
      assigned.set(item.id, columnEnds.length - 1);
    }
  }

  const columnsUsed = columnEnds.length;
  const widthFrac = 1 / columnsUsed;

  for (const item of cluster) {
    const col = assigned.get(item.id);
    result.push({
      id: item.id,
      topMin: item.topMin,
      heightMin: item.heightMin,
      widthFrac,
      leftFrac: col * widthFrac,
    });
  }
}

/**
 * High-level convenience: lay out events for one day, given raw events with
 * Date start/end and the day boundaries. Returns placement objects with the
 * vertical (minutes) and horizontal (fraction) geometry merged with the event.
 */
export function layoutEventsForDay(events, dayStart, dayEnd) {
  const items = [];
  const byId = new Map();
  for (const ev of events) {
    const v = verticalPlacement(
      new Date(ev.start_at),
      new Date(ev.end_at),
      dayStart,
      dayEnd
    );
    if (!v) continue;
    items.push({ id: ev.id, topMin: v.topMin, heightMin: v.heightMin });
    byId.set(ev.id, ev);
  }
  const laid = layoutDay(items);
  return laid.map((p) => ({ ...p, event: byId.get(p.id) }));
}
