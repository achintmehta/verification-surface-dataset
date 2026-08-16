export function layoutEvents(events) {
  // Sort events by start time, then by end time (descending) to place longer events first if they start at the same time
  const sorted = [...events].sort((a, b) => {
    const startDiff = new Date(a.start_at).getTime() - new Date(b.start_at).getTime();
    if (startDiff !== 0) return startDiff;
    return new Date(b.end_at).getTime() - new Date(a.end_at).getTime();
  });

  const clusters = [];
  let currentCluster = [];
  let clusterEnd = null;

  for (const event of sorted) {
    const start = new Date(event.start_at).getTime();
    const end = new Date(event.end_at).getTime();

    if (currentCluster.length === 0) {
      currentCluster.push(event);
      clusterEnd = end;
    } else {
      if (start < clusterEnd) {
        // Overlaps with the current cluster
        currentCluster.push(event);
        clusterEnd = Math.max(clusterEnd, end);
      } else {
        // Does not overlap, start a new cluster
        clusters.push(currentCluster);
        currentCluster = [event];
        clusterEnd = end;
      }
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const layoutedEvents = [];

  for (const cluster of clusters) {
    const columns = []; // Array of end times for each column

    for (const event of cluster) {
      const start = new Date(event.start_at).getTime();
      const end = new Date(event.end_at).getTime();

      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        if (start >= columns[i]) {
          columns[i] = end;
          event._col = i;
          placed = true;
          break;
        }
      }

      if (!placed) {
        event._col = columns.length;
        columns.push(end);
      }
    }

    const numCols = columns.length;
    for (const event of cluster) {
      layoutedEvents.push({
        ...event,
        _width: 100 / numCols,
        _left: (100 / numCols) * event._col
      });
    }
  }

  return layoutedEvents;
}
