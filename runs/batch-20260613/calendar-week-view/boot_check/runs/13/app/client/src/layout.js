// Cluster-based overlap layout engine.
//
// Given a list of events that fall (after clamping) within a single day, this
// module computes, for each event, a fractional horizontal { left, width }
// where left and width are in [0, 1] of the day-column width, and a vertical
// { top, height } in minutes-from-midnight units. The renderer maps these to
// pixels.
//
// Algorithm (per day):
//   1. Sort events by start time, then end time, then id.
//   2. Group into maximal "clusters" of transitively overlapping events.
//      A new event extends the current cluster if it starts before the
//      maximum end time seen so far in that cluster.
//   3. Within a cluster, greedily assign each event to the first column whose
//      last event has already ended (i.e. does not overlap). Track the number
//      of columns used by the whole cluster.
//   4. width = 1 / clusterColumns, left = assignedColumn / clusterColumns.
//
// This guarantees zero visual overlap and reclaims full width when there is no
// contention (a single-event cluster gets width 1).

const MINUTES_PER_DAY = 24 * 60;

// Two intervals [aStart,aEnd) and [bStart,bEnd) overlap (touching edges do not).
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Compute minute offsets (clamped to the given day) for an event.
// dayStartMs / dayEndMs are the millisecond bounds of the day.
// Returns { startMin, endMin } in [0, 1440], or null if no visible portion.
export function clampToDayMinutes(startMs, endMs, dayStartMs, dayEndMs) {
  const visibleStart = Math.max(startMs, dayStartMs);
  const visibleEnd = Math.min(endMs, dayEndMs);
  if (visibleEnd <= visibleStart) return null;
  const startMin = (visibleStart - dayStartMs) / 60000;
  const endMin = (visibleEnd - dayStartMs) / 60000;
  return {
    startMin: Math.max(0, Math.min(MINUTES_PER_DAY, startMin)),
    endMin: Math.max(0, Math.min(MINUTES_PER_DAY, endMin)),
  };
}

// items: array of { id, startMin, endMin, ...rest }
// Returns the same items augmented with { left, width } fractions.
export function layoutDay(items) {
  const sorted = [...items].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    if (a.endMin !== b.endMin) return a.endMin - b.endMin;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  const result = [];
  let cluster = [];
  let clusterMaxEnd = -Infinity;

  function flushCluster() {
    if (cluster.length === 0) return;
    // Greedy column assignment. columnsEnd[c] = end minute of last event in col c.
    const columnsEnd = [];
    const assigned = []; // column index per cluster event (parallel to cluster)

    for (const ev of cluster) {
      let placed = -1;
      for (let c = 0; c < columnsEnd.length; c++) {
        // Free if the column's previous event has ended at or before ev start.
        if (columnsEnd[c] <= ev.startMin) {
          placed = c;
          break;
        }
      }
      if (placed === -1) {
        placed = columnsEnd.length;
        columnsEnd.push(ev.endMin);
      } else {
        columnsEnd[placed] = ev.endMin;
      }
      assigned.push(placed);
    }

    const totalColumns = columnsEnd.length;
    cluster.forEach((ev, i) => {
      const col = assigned[i];
      result.push({
        ...ev,
        left: col / totalColumns,
        width: 1 / totalColumns,
      });
    });

    cluster = [];
    clusterMaxEnd = -Infinity;
  }

  for (const ev of sorted) {
    if (cluster.length === 0) {
      cluster.push(ev);
      clusterMaxEnd = ev.endMin;
      continue;
    }
    // The event belongs to the current cluster if it overlaps the cluster's
    // span [clusterStart, clusterMaxEnd). Since events are sorted by start,
    // it suffices to check ev.startMin < clusterMaxEnd.
    if (ev.startMin < clusterMaxEnd) {
      cluster.push(ev);
      clusterMaxEnd = Math.max(clusterMaxEnd, ev.endMin);
    } else {
      flushCluster();
      cluster.push(ev);
      clusterMaxEnd = ev.endMin;
    }
  }
  flushCluster();

  return result;
}

export { MINUTES_PER_DAY, overlaps };
