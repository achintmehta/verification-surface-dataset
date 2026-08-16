// Simple Server-Sent Events hub. Maintains the set of connected client
// responses and broadcasts JSON events to all of them.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast an event to every connected client.
 * @param {string} type - event name (e.g. "card:created", "card:moved")
 * @param {object} data - JSON-serializable payload
 */
export function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // If a write fails the connection is broken; drop it.
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
