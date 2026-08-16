/**
 * Overlap Layout Engine
 *
 * Algorithm:
 * 1. Sort events by start time (ties broken by longer duration first).
 * 2. Group into clusters — maximal sets of transitively overlapping events.
 *    Two events overlap if one starts strictly before the other ends.
 * 3. Within each cluster, assign column indices greedily:
 *    - Maintain columnEndTimes[].
 *    - For each event find the first column whose end <= event.start.
 *    - If none, open a new column.
 * 4. width = 1/numCols, left = col/numCols.
 * 5. top/height from minutes-from-midnight × HOUR_HEIGHT/60.
 */

const HOUR_HEIGHT  = 60; // px per hour = 1 px per minute
const MINS_PER_DAY = 24 * 60;

/**
 * @param {Array}  evts     - event objects with start_at, end_at
 * @param {Date}   dayStart - midnight of the day
 * @returns {Array} - { event, top, height, left, width }
 */
export function computeLayout(evts, dayStart) {
  if (!evts || evts.length === 0) return [];

  const dayStartMs = dayStart.getTime();

  // Normalize to minute offsets within the day, clamped to [0, MINS_PER_DAY]
  const items = evts.map(ev => {
    const startMin = clamp(Math.round((new Date(ev.start_at) - dayStartMs) / 60000), 0, MINS_PER_DAY);
    const endMin   = clamp(Math.round((new Date(ev.end_at)   - dayStartMs) / 60000), 0, MINS_PER_DAY);
    return { ev, startMin, endMin: Math.max(endMin, startMin + 1) };
  }).filter(n => n.startMin < MINS_PER_DAY && n.endMin > 0);

  // Sort: earlier start first; longer duration first on ties
  items.sort((a, b) =>
    a.startMin !== b.startMin
      ? a.startMin - b.startMin
      : b.endMin - a.endMin
  );

  // ── Cluster: maximal transitive overlap groups ────────────────────────────
  const clusters = [];
  let cluster = null;
  let clusterEnd = 0;

  for (const item of items) {
    if (!cluster || item.startMin >= clusterEnd) {
      cluster = [item];
      clusterEnd = item.endMin;
      clusters.push(cluster);
    } else {
      cluster.push(item);
      clusterEnd = Math.max(clusterEnd, item.endMin);
    }
  }

  // ── Column assignment within each cluster ─────────────────────────────────
  const result = [];

  for (const cl of clusters) {
    const colEnds = []; // colEnds[i] = end minute of last event in column i

    const assignments = cl.map(item => {
      // Find first column that is free at item.startMin
      let col = -1;
      for (let i = 0; i < colEnds.length; i++) {
        if (colEnds[i] <= item.startMin) { col = i; break; }
      }
      if (col === -1) { col = colEnds.length; colEnds.push(item.endMin); }
      else colEnds[col] = item.endMin;
      return { item, col };
    });

    const numCols = colEnds.length;

    for (const { item, col } of assignments) {
      result.push({
        event:  item.ev,
        top:    item.startMin * HOUR_HEIGHT / 60,
        height: (item.endMin - item.startMin) * HOUR_HEIGHT / 60,
        left:   col / numCols,
        width:  1 / numCols,
      });
    }
  }

  return result;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
