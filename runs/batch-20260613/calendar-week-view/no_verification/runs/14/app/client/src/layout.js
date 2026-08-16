// Pure overlap-layout engine.
//
// Each input "item" represents the portion of an event that falls within a
// single day column, expressed in minutes-from-midnight:
//   { id, startMin, endMin, ...rest }
// where 0 <= startMin < endMin <= 1440.
//
// The engine groups items into overlap clusters (maximal sets of transitively
// overlapping items), assigns each item a column within its cluster greedily by
// start time, and computes a fractional horizontal layout:
//   { left, width } in [0, 1], where width = 1 / clusterColumns and
//   left = colIndex / clusterColumns.
//
// Guarantees:
//   - Two items that overlap in time never share the same (left, width) band.
//   - A cluster needing K columns gives every member width 1/K.
//   - An item that overlaps nothing occupies the full width (left 0, width 1),
//     even if other clusters exist earlier/later the same day.

function overlaps(a, b) {
  // Half-open intervals: touching edges (a.end === b.start) do NOT overlap.
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

// Group items into clusters of transitively-overlapping items.
// Returns an array of clusters; each cluster is an array of items.
export function buildClusters(items) {
  const sorted = [...items].sort(
    (a, b) => a.startMin - b.startMin || a.endMin - b.endMin
  );
  const clusters = [];
  let current = [];
  let clusterEnd = -Infinity;

  for (const item of sorted) {
    if (current.length === 0 || item.startMin < clusterEnd) {
      // Still overlaps the running cluster span -> same cluster.
      current.push(item);
      clusterEnd = Math.max(clusterEnd, item.endMin);
    } else {
      clusters.push(current);
      current = [item];
      clusterEnd = item.endMin;
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

// Assign each item in a cluster to a column greedily by start time.
// Returns { columns: Map<item, colIndex>, columnCount }.
function assignColumns(cluster) {
  const sorted = [...cluster].sort(
    (a, b) => a.startMin - b.startMin || a.endMin - b.endMin
  );
  // columnEnds[c] = endMin of the last item placed in column c.
  const columnEnds = [];
  const colByItem = new Map();

  for (const item of sorted) {
    let placed = false;
    for (let c = 0; c < columnEnds.length; c++) {
      // An item can reuse a column if it starts at or after that column's
      // current end (half-open: no overlap).
      if (item.startMin >= columnEnds[c]) {
        columnEnds[c] = item.endMin;
        colByItem.set(item, c);
        placed = true;
        break;
      }
    }
    if (!placed) {
      colByItem.set(item, columnEnds.length);
      columnEnds.push(item.endMin);
    }
  }

  return { colByItem, columnCount: columnEnds.length };
}

// Compute layout for a single day's items.
// Returns array of { ...item, left, width } with left/width in [0,1].
export function layoutDay(items) {
  const clusters = buildClusters(items);
  const out = [];
  for (const cluster of clusters) {
    const { colByItem, columnCount } = assignColumns(cluster);
    const width = 1 / columnCount;
    for (const item of cluster) {
      const col = colByItem.get(item);
      out.push({
        ...item,
        left: col * width,
        width,
      });
    }
  }
  return out;
}
