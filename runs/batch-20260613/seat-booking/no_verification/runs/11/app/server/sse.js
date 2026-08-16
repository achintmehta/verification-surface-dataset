// Simple Server-Sent Events hub. Tracks active client connections and
// broadcasts seat-status transition events to every connected client.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
}

export function removeClient(res) {
  clients.delete(res);
}

export function clientCount() {
  return clients.size;
}

/**
 * Broadcast an event to all connected clients.
 * @param {string} type - event type (e.g. 'seats')
 * @param {object} payload - JSON-serializable payload
 */
export function broadcast(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}

/**
 * Broadcast a set of seat changes. Each change is { id, status, ... }.
 */
export function broadcastSeatChanges(changes) {
  if (!changes || changes.length === 0) return;
  broadcast('seats', { seats: changes });
}
