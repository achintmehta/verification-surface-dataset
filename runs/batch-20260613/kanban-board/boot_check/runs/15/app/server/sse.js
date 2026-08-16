// Manages active Server-Sent Events connections and broadcasting.

const clients = new Set();

/**
 * Register a new SSE client (an Express response object).
 * Returns an unregister function.
 */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast an event to every connected client.
 * @param {string} type - the event type.
 * @param {object} payload - JSON-serializable payload.
 */
export function broadcast(type, payload) {
  const data = JSON.stringify({ type, payload });
  for (const res of clients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
