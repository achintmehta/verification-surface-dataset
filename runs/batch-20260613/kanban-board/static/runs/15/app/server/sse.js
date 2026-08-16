// Maintains the set of active Server-Sent Events connections and broadcasts
// canonical mutation events to every connected client.

const clients = new Set();

/**
 * Register a new SSE client. Returns a cleanup function to remove it.
 * @param {import('http').ServerResponse} res
 */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

/**
 * Broadcast an event to every connected client.
 * @param {string} type
 * @param {unknown} payload
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
