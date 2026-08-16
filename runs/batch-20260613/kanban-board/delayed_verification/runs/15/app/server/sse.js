// Simple SSE connection registry. Every connected client gets an entry; we
// broadcast canonical mutations to all of them.

const clients = new Set();

/**
 * Register a new SSE client (an Express response object already configured
 * with SSE headers). Returns a cleanup function to call on disconnect.
 */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast an event to every connected client.
 * @param {string} type - event name (e.g. "card:create", "card:move").
 * @param {object} data - JSON-serializable payload.
 */
export function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
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
