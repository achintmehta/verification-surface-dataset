// Cluster-based overlap layout engine.
//
// Input: a list of events for a single day, each with numeric `startMin` and
// `endMin` (minutes from midnight, clamped to [0, 1440]).
//
// Output: the same events annotated with layout fields:
//   colIndex  - assigned column (0-based)
//   colCount  - number of columns the event's cluster needed
// From these the renderer derives width = 1/colCount and left = colIndex/colCount.

export function computeLayout(events) {
  // Sort by start, then by end (longer first as tiebreak), then id for stability.
  const sorted = [...events].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    if (a.endMin !== b.endMin) return b.endMin - a.endMin;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  // Group into maximal clusters of transitively overlapping events.
  // A cluster ends when the next event starts at/after the max end seen so far.
  const clusters = [];
  let current = [];
  let clusterMaxEnd = -Infinity;

  for (const ev of sorted) {
    if (current.length > 0 && ev.startMin >= clusterMaxEnd) {
      clusters.push(current);
      current = [];
      clusterMaxEnd = -Infinity;
    }
    current.push(ev);
    clusterMaxEnd = Math.max(clusterMaxEnd, ev.endMin);
  }
  if (current.length > 0) clusters.push(current);

  for (const cluster of clusters) {
    layoutCluster(cluster);
  }

  return sorted;
}

function eventsOverlap(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

function layoutCluster(cluster) {
  // Greedy column assignment by start time. columns[i] holds the events placed
  // in column i; an event goes into the first column whose last event does not
  // overlap it.
  const columns = [];

  for (const ev of cluster) {
    let placed = false;
    for (let i = 0; i < columns.length; i++) {
      const colEvents = columns[i];
      const last = colEvents[colEvents.length - 1];
      if (!eventsOverlap(last, ev)) {
        colEvents.push(ev);
        ev.colIndex = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      ev.colIndex = columns.length;
      columns.push([ev]);
    }
  }

  const colCount = columns.length;
  for (const ev of cluster) {
    ev.colCount = colCount;
  }
}
