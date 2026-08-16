// Simple in-memory registry of active SSE client connections.
const clients = new Set();

/**
 * Registers a new SSE connection (an Express response object configured for
 * text/event-stream). Returns an unsubscribe function.
 */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcasts an event to every connected SSE client.
 * @param {string} event - the SSE event name
 * @param {object} data - JSON-serializable payload
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

export function clientCount() {
  return clients.size;
}
