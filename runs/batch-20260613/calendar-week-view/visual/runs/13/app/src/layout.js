// Cluster-based overlap layout engine.
//
// Input: an array of events for a single day, each with numeric `startMin`
// and `endMin` (minutes from midnight, clamped to [0, 1440]).
// Output: the same events annotated with `colIndex` and `colCount`, where the
// event's horizontal fraction is colIndex/colCount .. (colIndex+1)/colCount.
//
// Algorithm:
//  1. Sort events by start time (then end time).
//  2. Walk through events accumulating an active "cluster" — a maximal set of
//     transitively overlapping events. A cluster ends when an event starts at
//     or after the maximum end time of all events seen so far in the cluster.
//  3. Within a cluster, greedily assign each event to the first column whose
//     last event has already ended (no overlap). Track the number of columns
//     used by the cluster.
//  4. Every event in the cluster gets colCount = number of columns the cluster
//     used, so non-contended events in a cluster still reserve equal width.
//
// This guarantees zero visual overlap. An event that overlaps nothing forms a
// singleton cluster with colCount = 1 and thus fills the full day width.

export function layoutDay(events) {
  const sorted = events
    .slice()
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const result = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    assignColumns(cluster);
    for (const ev of cluster) result.push(ev);
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const ev of sorted) {
    if (cluster.length > 0 && ev.startMin >= clusterEnd) {
      // No overlap with anything in the current cluster -> close it.
      flush();
    }
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.endMin);
  }
  flush();

  return result;
}

function assignColumns(cluster) {
  // columns[i] holds the endMin of the last event placed in column i.
  const columns = [];
  for (const ev of cluster) {
    let placed = false;
    for (let i = 0; i < columns.length; i++) {
      if (ev.startMin >= columns[i]) {
        columns[i] = ev.endMin;
        ev.colIndex = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      ev.colIndex = columns.length;
      columns.push(ev.endMin);
    }
  }
  const colCount = columns.length;
  for (const ev of cluster) {
    ev.colCount = colCount;
  }
}
