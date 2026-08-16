// Maintains the set of active Server-Sent Events connections and broadcasts
// canonical board mutations to every connected client.

const clients = new Set();

/**
 * Register a new SSE client. Returns a function to remove it.
 * @param {import('http').ServerResponse} res
 */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast an event to all connected clients.
 * @param {string} type  Event type (e.g. 'card:created', 'card:moved', 'column:reordered').
 * @param {object} payload  JSON-serializable payload.
 */
export function broadcast(type, payload) {
  const data = JSON.stringify({ type, payload });
  for (const res of clients) {
    try {
      res.write(`event: ${type}\n`);
      res.write(`data: ${data}\n\n`);
    } catch {
      // If a write fails the connection is dead; it will be cleaned up by
      // the 'close' handler. Defensive removal here too.
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
