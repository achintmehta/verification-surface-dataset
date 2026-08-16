// Simple SSE (Server-Sent Events) hub.
//
// Holds every active client response object and broadcasts JSON events to all
// of them. Each event is a named SSE event with a JSON data payload.

const clients = new Set();

/**
 * Register a new SSE client. Returns a cleanup function to call on disconnect.
 */
export function addClient(res) {
  clients.add(res);
  return () => {
    clients.delete(res);
  };
}

/**
 * Broadcast an event to all connected clients.
 * @param {string} event - the SSE event name (e.g. "card:created", "card:moved")
 * @param {object} data  - serialisable payload
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // If a write fails the connection is dead; drop it.
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
