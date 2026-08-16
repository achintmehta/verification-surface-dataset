export function layoutEvents(events) {
  // Sort events by start time, then by end time (descending)
  const sorted = [...events].sort((a, b) => {
    if (a.start_at.getTime() !== b.start_at.getTime()) {
      return a.start_at.getTime() - b.start_at.getTime();
    }
    return b.end_at.getTime() - a.end_at.getTime();
  });

  const clusters = [];
  let currentCluster = [];
  let clusterMaxEnd = null;

  for (const ev of sorted) {
    if (currentCluster.length === 0) {
      currentCluster.push(ev);
      clusterMaxEnd = ev.end_at.getTime();
    } else {
      if (ev.start_at.getTime() < clusterMaxEnd) {
        currentCluster.push(ev);
        clusterMaxEnd = Math.max(clusterMaxEnd, ev.end_at.getTime());
      } else {
        clusters.push(currentCluster);
        currentCluster = [ev];
        clusterMaxEnd = ev.end_at.getTime();
      }
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const layouted = [];

  for (const cluster of clusters) {
    const columns = [];

    for (const ev of cluster) {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const lastEv = col[col.length - 1];
        if (lastEv.end_at.getTime() <= ev.start_at.getTime()) {
          col.push(ev);
          ev._col = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        ev._col = columns.length;
        columns.push([ev]);
      }
    }

    const numCols = columns.length;
    for (const ev of cluster) {
      layouted.push({
        event: ev,
        width: 1 / numCols,
        left: ev._col / numCols
      });
    }
  }

  return layouted;
}
