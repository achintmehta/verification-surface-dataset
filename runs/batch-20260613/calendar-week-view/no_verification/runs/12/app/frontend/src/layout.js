// Overlap layout engine.
//
// Given a list of events that fall (after clamping) within a single day, this
// module computes the horizontal placement of each event so that:
//   - events that overlap in time are placed side by side, never on top of one
//     another;
//   - N events sharing an identical range become N equal-width columns filling
//     the day width;
//   - an event that overlaps nothing occupies the full day width, even if other
//     clusters exist earlier in the same day;
//   - width is divided only while events are actually contended.
//
// The output gives each event a fractional `left` and `width` in [0, 1] relative
// to the day-column width. Vertical geometry (top/height) is computed separately
// from times against the time axis.

/**
 * Group events into maximal sets of transitively overlapping events (clusters).
 * Two events overlap iff a.start < b.end && b.start < a.end (touching endpoints
 * do not count as overlap, matching the half-open interval semantics).
 *
 * @param {Array<{startMin:number, endMin:number}>} events sorted by start time
 * @returns {Array<Array>} array of clusters (each an array of events)
 */
function buildClusters(events) {
  const clusters = [];
  let current = [];
  let clusterEnd = -Infinity;

  for (const ev of events) {
    if (current.length === 0 || ev.startMin < clusterEnd) {
      // Overlaps the running cluster extent: still part of this cluster.
      current.push(ev);
      clusterEnd = Math.max(clusterEnd, ev.endMin);
    } else {
      // No overlap with the cluster's furthest reach: start a new cluster.
      clusters.push(current);
      current = [ev];
      clusterEnd = ev.endMin;
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/**
 * Within a cluster, assign each event a column index greedily by start time.
 * An event reuses the lowest-indexed column whose last event has already ended
 * (end <= this event's start). Returns the number of columns used and mutates
 * each event with `_col`.
 */
function assignColumns(cluster) {
  // columnsEndAt[i] = end time of the last event placed in column i.
  const columnsEndAt = [];

  for (const ev of cluster) {
    let placed = false;
    for (let i = 0; i < columnsEndAt.length; i++) {
      if (columnsEndAt[i] <= ev.startMin) {
        ev._col = i;
        columnsEndAt[i] = ev.endMin;
        placed = true;
        break;
      }
    }
    if (!placed) {
      ev._col = columnsEndAt.length;
      columnsEndAt.push(ev.endMin);
    }
  }

  return columnsEndAt.length;
}

/**
 * For an event in a multi-column cluster, compute how many of the cluster's
 * columns this event can actually span to its right before bumping into a
 * concurrent event. This lets a non-contended event reclaim width even inside
 * a wide cluster (standard Google-Calendar-style expansion).
 */
function computeSpan(ev, cluster, totalCols) {
  let span = 1;
  for (let col = ev._col + 1; col < totalCols; col++) {
    // Can we expand into `col`? Only if no event in that column overlaps ev.
    const blocked = cluster.some(
      (other) =>
        other !== ev &&
        other._col === col &&
        other.startMin < ev.endMin &&
        ev.startMin < other.endMin
    );
    if (blocked) break;
    span++;
  }
  return span;
}

/**
 * Compute layout for a single day's worth of events.
 *
 * @param {Array<{id:any, startMin:number, endMin:number}>} dayEvents
 * @returns {Array<{id, startMin, endMin, left, width}>}
 *   left and width are fractions of the day-column width in [0, 1].
 */
export function layoutDay(dayEvents) {
  // Sort by start time, then by longer-first for stable greedy assignment.
  const events = [...dayEvents].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.endMin - a.endMin;
  });

  const clusters = buildClusters(events);
  const out = [];

  for (const cluster of clusters) {
    const totalCols = assignColumns(cluster);
    for (const ev of cluster) {
      const span = computeSpan(ev, cluster, totalCols);
      const colWidth = 1 / totalCols;
      out.push({
        id: ev.id,
        startMin: ev.startMin,
        endMin: ev.endMin,
        left: ev._col * colWidth,
        width: span * colWidth,
      });
    }
  }

  return out;
}
