/**
 * Cluster-based overlap layout engine.
 *
 * Given a list of events for a single day, returns each event annotated with:
 *   colIndex  – 0-based column within its cluster
 *   colCount  – total columns in its cluster (width = dayWidth / colCount)
 *
 * Algorithm:
 *  1. Sort events by start time (ties broken by id for stability).
 *  2. Sweep through events, building clusters of transitively overlapping events.
 *     A cluster is a maximal set where every event overlaps at least one other.
 *  3. Within each cluster, greedily assign column indices:
 *     - Maintain a list of "lanes", each tracking the latest end time seen.
 *     - For each event (sorted by start), place it in the first lane whose
 *       end time <= event's start time. If none, open a new lane.
 *  4. colCount for every event in the cluster = number of lanes used.
 */

/**
 * @param {Array<{id: number, start_at: string, end_at: string, title: string}>} events
 * @returns {Array<{event: object, colIndex: number, colCount: number}>}
 */
export function computeLayout(events) {
  if (events.length === 0) return [];

  // Work with numeric timestamps for speed
  const items = events.map(ev => ({
    event: ev,
    start: new Date(ev.start_at).getTime(),
    end:   new Date(ev.end_at).getTime(),
    colIndex: 0,
    colCount: 1,
  }));

  // Sort by start time, then by id for stability
  items.sort((a, b) => a.start - b.start || a.event.id - b.event.id);

  // ── Step 1: Build clusters ────────────────────────────────────────────────
  // A cluster is a contiguous (by start time) group where the running max-end
  // overlaps the next event's start.
  const clusters = [];
  let clusterStart = 0;

  for (let i = 1; i <= items.length; i++) {
    // Find the max end time of items[clusterStart..i-1]
    let maxEnd = 0;
    for (let j = clusterStart; j < i; j++) {
      if (items[j].end > maxEnd) maxEnd = items[j].end;
    }

    const isLast = i === items.length;
    const nextStartsAfterCluster = !isLast && items[i].start >= maxEnd;

    if (isLast || nextStartsAfterCluster) {
      clusters.push(items.slice(clusterStart, i));
      clusterStart = i;
    }
  }

  // ── Step 2: Assign columns within each cluster ────────────────────────────
  const result = [];

  for (const cluster of clusters) {
    // lanes[k] = the latest end time of events placed in lane k
    const lanes = [];

    for (const item of cluster) {
      // Find first lane where the last event ended <= this event's start
      let placed = false;
      for (let k = 0; k < lanes.length; k++) {
        if (lanes[k] <= item.start) {
          item.colIndex = k;
          lanes[k] = item.end;
          placed = true;
          break;
        }
      }
      if (!placed) {
        item.colIndex = lanes.length;
        lanes.push(item.end);
      }
    }

    const colCount = lanes.length;
    for (const item of cluster) {
      item.colCount = colCount;
      result.push({
        event:    item.event,
        colIndex: item.colIndex,
        colCount: item.colCount,
      });
    }
  }

  return result;
}

/**
 * Convert a time (as Date or ISO string) to a pixel offset from midnight.
 * Handles the special case where a Date representing 24:00 has rolled over
 * to 00:00 of the next day — we detect this by checking if the time is
 * exactly midnight and the caller passed a value that was meant to be 24:00.
 *
 * In practice we pass clamped dates; the clamping logic uses setHours(24)
 * which JS normalises to 00:00 next day. We therefore compute minutes from
 * the raw timestamp relative to the start of the *event's* day.
 *
 * @param {Date|string} time
 * @param {number} hourHeight  px per hour
 * @param {Date|null} [dayRef]  optional reference date for the day (used to
 *   detect cross-midnight roll-over); if omitted we use the time itself.
 * @returns {number}
 */
export function timeToPixel(time, hourHeight, dayRef) {
  const d = time instanceof Date ? time : new Date(time);
  const minutes = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  return (minutes / 60) * hourHeight;
}

/**
 * Compute pixel offset for a clamped end time that may have rolled over to
 * the next day's 00:00 when the original value was 24:00.
 * Pass the original (pre-clamp) end Date and the day's midnight Date.
 *
 * @param {Date} endDate   — the actual end time (may be next-day 00:00)
 * @param {Date} dayMidnight — 00:00 of the event's day
 * @param {number} hourHeight
 * @returns {number}
 */
export function endTimeToPixel(endDate, dayMidnight, hourHeight) {
  // Compute minutes elapsed since dayMidnight
  const diffMs = endDate.getTime() - dayMidnight.getTime();
  const diffMinutes = diffMs / 60000;
  // Clamp to [0, 1440] (0:00 – 24:00)
  const clamped = Math.max(0, Math.min(diffMinutes, 1440));
  return (clamped / 60) * hourHeight;
}

/**
 * Convert a pixel offset from midnight to a Date on the given day.
 * @param {number} px
 * @param {number} hourHeight
 * @param {Date} dayDate  — any Date whose date portion is the target day
 * @returns {Date}
 */
export function pixelToTime(px, hourHeight, dayDate) {
  const totalMinutes = Math.round((px / hourHeight) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const d = new Date(dayDate);
  d.setHours(h, m, 0, 0);
  return d;
}
