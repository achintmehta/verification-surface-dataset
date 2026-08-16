export function layoutEvents(events, dayStart) {
  if (events.length === 0) return [];

  // Sort events by start time, then by end time
  const sortedEvents = [...events].sort((a, b) => {
    const startA = new Date(a.start_at).getTime();
    const startB = new Date(b.start_at).getTime();
    if (startA !== startB) return startA - startB;
    return new Date(a.end_at).getTime() - new Date(b.end_at).getTime();
  });

  const clusters = [];
  let currentCluster = [];
  let clusterEnd = null;

  sortedEvents.forEach(ev => {
    const start = new Date(ev.start_at).getTime();
    const end = new Date(ev.end_at).getTime();

    if (currentCluster.length === 0) {
      currentCluster.push(ev);
      clusterEnd = end;
    } else {
      if (start < clusterEnd) {
        currentCluster.push(ev);
        if (end > clusterEnd) {
          clusterEnd = end;
        }
      } else {
        clusters.push(currentCluster);
        currentCluster = [ev];
        clusterEnd = end;
      }
    }
  });

  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const layouted = [];

  clusters.forEach(cluster => {
    const columns = [];

    cluster.forEach(ev => {
      const start = new Date(ev.start_at).getTime();
      let placed = false;

      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const lastEventInCol = col[col.length - 1];
        if (new Date(lastEventInCol.end_at).getTime() <= start) {
          col.push(ev);
          placed = true;
          break;
        }
      }

      if (!placed) {
        columns.push([ev]);
      }
    });

    const numCols = columns.length;
    columns.forEach((col, colIndex) => {
      col.forEach(ev => {
        layouted.push({
          event: ev,
          left: (colIndex / numCols) * 100,
          width: (1 / numCols) * 100
        });
      });
    });
  });

  return layouted;
}
