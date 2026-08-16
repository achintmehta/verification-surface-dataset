// Simple Server-Sent Events hub. Keeps every connected client and
// broadcasts seat status transitions to all of them.

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
 * Broadcast an event to every connected client.
 * @param {string} event  the SSE event name
 * @param {object} data   JSON-serializable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

/**
 * Broadcast a batch of seat updates (each {id, status, ...}).
 */
export function broadcastSeatUpdates(seats) {
  if (!seats || seats.length === 0) return;
  broadcast('seats', { seats });
}
