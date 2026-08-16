// Minimal Server-Sent Events hub. Keeps track of connected clients and
// broadcasts seat-status transition events to all of them.

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
 * Broadcast an event to every connected SSE client.
 * @param {string} event - event name (e.g. 'seats')
 * @param {object} data  - JSON-serialisable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Drop broken connections silently.
      clients.delete(res);
    }
  }
}

/**
 * Broadcast a list of seat updates. Each item describes the new effective
 * state of a seat so all clients can patch their seat map live.
 */
export function broadcastSeatUpdates(seats) {
  if (!seats || seats.length === 0) return;
  broadcast('seats', { seats });
}
