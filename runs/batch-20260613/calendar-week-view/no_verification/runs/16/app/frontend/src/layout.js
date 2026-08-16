export function layoutEvents(events) {
  // Sort events by start time, then by end time descending
  const sorted = [...events].sort((a, b) => {
    const startDiff = new Date(a.start_at) - new Date(b.start_at);
    if (startDiff !== 0) return startDiff;
    return new Date(b.end_at) - new Date(a.end_at);
  });

  const clusters = [];
  let currentCluster = [];
  let clusterMaxEnd = null;

  for (const ev of sorted) {
    const start = new Date(ev.start_at).getTime();
    const end = new Date(ev.end_at).getTime();

    if (currentCluster.length === 0) {
      currentCluster.push(ev);
      clusterMaxEnd = end;
    } else {
      if (start < clusterMaxEnd) {
        currentCluster.push(ev);
        clusterMaxEnd = Math.max(clusterMaxEnd, end);
      } else {
        clusters.push(currentCluster);
        currentCluster = [ev];
        clusterMaxEnd = end;
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
      const start = new Date(ev.start_at).getTime();
      let placed = false;

      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const lastEv = col[col.length - 1];
        if (start >= new Date(lastEv.end_at).getTime()) {
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
        ...ev,
        _width: 1 / numCols,
        _left: ev._col / numCols
      });
    }
  }

  return layouted;
}
