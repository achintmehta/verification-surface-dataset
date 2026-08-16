export function layoutDayEvents(events) {
  // Sort events by start time, then by end time (descending)
  const sorted = [...events].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.endMin - a.endMin;
  });

  const clusters = [];
  let currentCluster = [];
  let clusterEnd = -1;

  for (const ev of sorted) {
    if (currentCluster.length === 0) {
      currentCluster.push(ev);
      clusterEnd = ev.endMin;
    } else {
      if (ev.startMin < clusterEnd) {
        // Overlaps with the cluster
        currentCluster.push(ev);
        clusterEnd = Math.max(clusterEnd, ev.endMin);
      } else {
        // Does not overlap, start a new cluster
        clusters.push(currentCluster);
        currentCluster = [ev];
        clusterEnd = ev.endMin;
      }
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const positioned = [];

  for (const cluster of clusters) {
    const columns = []; // Array of arrays (columns)

    for (const ev of cluster) {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const lastEv = col[col.length - 1];
        if (lastEv.endMin <= ev.startMin) {
          col.push(ev);
          ev.colIdx = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        columns.push([ev]);
        ev.colIdx = columns.length - 1;
      }
    }

    const numCols = columns.length;
    for (const ev of cluster) {
      positioned.push({
        ...ev,
        leftPct: (ev.colIdx / numCols) * 100,
        widthPct: (1 / numCols) * 100
      });
    }
  }

  return positioned;
}